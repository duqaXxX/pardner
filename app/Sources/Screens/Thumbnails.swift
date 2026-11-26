// The images a call returned, drawn under its line (step E2 design 3.1): one row of thumbnails, each fetched by its blob when its view first
// appears, decoded to a bounded thumbnail, kept in a cache by blob id (never the bytes), and opened in the file window by a click.
import Conversation
import DesignSystem
import Foundation
import ImageIO
import Relay
import SwiftUI
import UniformTypeIdentifiers

/// What a thumbnail says when its image cannot be drawn.
enum ThumbnailWords {
    static let unreadable = "This image can no longer be read."
}

/// A decoded thumbnail: the bytes it came from are not kept.
final class Thumbnail: @unchecked Sendable {
    let image: CGImage

    init(_ image: CGImage) { self.image = image }

    /// The longest side of a thumbnail, in pixels.
    static let longestSide = 320
    private static let types = Set([UTType.png, .jpeg, .gif, .webP].map(\.identifier))

    /// The thumbnail of `data`, nil for a type other than PNG, JPEG, GIF and WebP, and for bytes that do not decode. The type is the one the
    /// bytes say they are (`CGImageSourceGetType`), whatever the file was named or the bot said.
    static func make(from data: Data) -> Thumbnail? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil), let type = CGImageSourceGetType(source), types.contains(type as String) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceThumbnailMaxPixelSize: longestSide, kCGImageSourceCreateThumbnailFromImageAlways: true, kCGImageSourceCreateThumbnailWithTransform: true,
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary).map(Thumbnail.init)
    }

    /// What the cache counts it as.
    var cost: Int { image.bytesPerRow * image.height }
}

/// The fetches and thumbnails of a pairing, by blob id: a fetch runs from the first time a thumbnail is asked for, once, whoever asks and
/// whenever; the thumbnail is kept in a cache that may drop it (it is then fetched again), and a verdict that the image cannot be read is kept.
/// A fetch the connection could not make is asked again only while a view waits for the blob; when the last one leaves it stops, and a view
/// that comes back starts it again.
@MainActor
final class ThumbnailStore {
    private let cache = NSCache<NSData, Thumbnail>()
    private var unreadable: Set<Data> = []
    private var running: [Data: Task<Thumbnail?, Never>] = [:]
    /// The views waiting for each blob now.
    private var waiting: [Data: Int] = [:]

    init() { cache.totalCostLimit = 64 << 20 }

    /// The thumbnail of `blob` in `channel`; nil when it can no longer be read, or when the caller left (its task was cancelled) before the
    /// connection could fetch it. A fetch the connection could not make is asked again after `retryAfter` while a caller waits.
    func thumbnail(channel: Data, blob: Data, fetch: @escaping @Sendable (Data, Data) async -> FetchOutcome, retryAfter: Duration) async -> Thumbnail? {
        if let kept = cache.object(forKey: blob as NSData) { return kept }
        if unreadable.contains(blob) { return nil }
        waiting[blob, default: 0] += 1
        let leaving = Leaving { [weak self] in self?.leave(blob) }
        defer { leaving.now() }
        let task = running[blob] ?? start(channel: channel, blob: blob, fetch: fetch, retryAfter: retryAfter)
        return await withTaskCancellationHandler { await task.value } onCancel: { leaving.later() }
    }

    /// The task is the store's, not the asking view's: a row that scrolls away leaves it running while another view waits.
    private func start(channel: Data, blob: Data, fetch: @escaping @Sendable (Data, Data) async -> FetchOutcome, retryAfter: Duration) -> Task<Thumbnail?, Never> {
        let task = Task { [weak self] () -> Thumbnail? in
            var made: Thumbnail?
            var verdict = true
            ask: while let self {
                switch await fetch(channel, blob) {
                case .file(let data):
                    made = await Task.detached(priority: .userInitiated) { Thumbnail.make(from: data) }.value
                    break ask
                case .gone: break ask
                case .ended:
                    try? await Task.sleep(for: retryAfter)
                    if (self.waiting[blob] ?? 0) == 0 {
                        verdict = false // nobody waits: nothing was learned about the image
                        break ask
                    }
                }
            }
            self?.finished(blob, made, verdict: verdict)
            return made
        }
        running[blob] = task
        return task
    }

    private func leave(_ blob: Data) {
        let left = (waiting[blob] ?? 1) - 1
        waiting[blob] = left > 0 ? left : nil
    }

    private func finished(_ blob: Data, _ made: Thumbnail?, verdict: Bool) {
        running[blob] = nil
        if let made { cache.setObject(made, forKey: blob as NSData, cost: made.cost) } else if verdict { unreadable.insert(blob) }
    }

    /// The cache lets every thumbnail go, as it may under memory pressure: for the tests.
    func drop() { cache.removeAllObjects() }
}

/// A caller's departure from a blob's waiters, made once: when its task is cancelled (from any thread, hopping to the main actor) or when it returns.
private final class Leaving: @unchecked Sendable {
    private let lock = NSLock()
    private var done = false
    private let leave: @MainActor () -> Void

    init(_ leave: @escaping @MainActor () -> Void) { self.leave = leave }

    private func once() -> Bool { lock.lock(); defer { lock.unlock() }; defer { done = true }; return !done }

    @MainActor func now() { if once() { leave() } }

    func later() {
        guard once() else { return }
        let leave = leave
        Task { @MainActor in leave() }
    }
}

extension FileOpener {
    /// The thumbnail of an image a call returned, fetched through the pairing's connection; see `ThumbnailStore`.
    func thumbnail(channel: Data, blob: Data) async -> Thumbnail? {
        await thumbnails.thumbnail(channel: channel, blob: blob, fetch: fetchFile, retryAfter: retryAfter)
    }

    /// The cache drops what it holds: for the tests.
    func dropThumbnails() { thumbnails.drop() }
}

/// The row of thumbnails under a line's head.
struct ThumbnailRow: View {
    let files: [FileInfo]
    let place: FilePlace
    let opener: FileOpener
    /// The line's bot, which the file window names, and when the images came.
    let bot: Data
    let at: Date

    /// The most a thumbnail is high, in points.
    static let height: CGFloat = 160

    /// The file window a click on `file` opens: the image as a file the bot sent (#151 draws it there).
    static func content(of file: FileInfo, place: FilePlace, bot: Data, at: Date) -> FileWindowContent {
        FileWindowContent(channel: place.channel, thread: place.thread, bot: bot, source: .sent(blob: file.blob, name: file.name, size: file.size, type: file.type, at: at))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            ForEach(Array(files.enumerated()), id: \.offset) { _, file in
                ThumbnailView(content: Self.content(of: file, place: place, bot: bot, at: at), opener: opener)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// One thumbnail: a grey box while its image loads, the image once it has, and a sentence when it cannot be read.
struct ThumbnailView: View {
    private enum Phase { case loading, ready(Thumbnail), unreadable }

    let content: FileWindowContent
    let opener: FileOpener
    @State private var phase = Phase.loading
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Group {
            switch phase {
            case .loading:
                RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius).fill(PardnerColor.surface).frame(width: ThumbnailRow.height, height: ThumbnailRow.height)
            case .ready(let thumbnail):
                Button {
                    opener.open(content)
                    openWindow(id: WindowID.file, value: content)
                } label: {
                    Image(decorative: thumbnail.image, scale: 1).resizable().scaledToFit().frame(maxHeight: ThumbnailRow.height)
                        .clipShape(RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                }
                .buttonStyle(.clickable).help(content.name)
            case .unreadable:
                Text(verbatim: ThumbnailWords.unreadable).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.muted)
            }
        }
        // Started the first time the view appears; a view that comes back finds the fetch or the thumbnail the opener kept.
        .task(id: content.blob) {
            let thumbnail = await opener.thumbnail(channel: content.channel, blob: content.blob)
            phase = thumbnail.map(Phase.ready) ?? .unreadable
        }
    }
}

private extension FileWindowContent {
    var blob: Data {
        if case .sent(let blob, _, _, _, _) = source { blob } else { Data() }
    }

    var name: String {
        if case .sent(_, let name, _, _, _) = source { name } else { "" }
    }
}
