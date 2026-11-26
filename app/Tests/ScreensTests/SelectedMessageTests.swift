// The selected message and the thread summary row (visual pass, issue #174, unit D): which message stands on the band, the band's ground and reach,
// that it moves nothing, the summary's parts and its `Open in panel` label. Synthetic content.
import AppKit
import Conversation
import DesignSystem
import Foundation
import ProtocolHost
@testable import Screens
import SwiftUI
import XCTest

@MainActor
final class SelectedMessageTests: XCTestCase {
    // MARK: which message is selected

    func testOnlyTheMessageWhoseThreadIsOpenStandsOnTheBand() throws {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        let prompts = channel.messages.filter { $0.kind == 2 && channel.threads[$0.ref.hex]?.isSession == true }
        XCTAssertGreaterThan(prompts.count, 1)
        let selected = prompts.filter { ChannelView.opens($0, in: channel, thread: sample.thread) }
        XCTAssertEqual(selected.map { $0.ref.hex }, [sample.thread], "one message, the one whose thread the panel shows")
        XCTAssertTrue(channel.messages.allSatisfy { !ChannelView.opens($0, in: channel, thread: nil) }, "none once the panel is closed")
        XCTAssertTrue(channel.messages.allSatisfy { !ChannelView.opens($0, in: channel, thread: "no such thread") })
    }

    func testTheBandIsSelectOrHoverAndASelectedMessageKeepsSelectUnderThePointer() {
        XCTAssertEqual(MessageBand.ground(selected: true, hovered: false), PardnerColor.select)
        XCTAssertEqual(MessageBand.ground(selected: true, hovered: true), PardnerColor.select, "the selected one keeps its band on hover")
        XCTAssertEqual(MessageBand.ground(selected: false, hovered: true), PardnerColor.hover)
        XCTAssertEqual(MessageBand.ground(selected: false, hovered: false), .clear)
        XCTAssertNotEqual(PardnerColor.select, PardnerColor.hover, "selection and hover differ")
    }

    // MARK: the band's reach and what it moves

    private func render<V: View>(_ view: V, size: CGSize, dark: Bool = false) -> NSBitmapImageRep {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = NSHostingView(rootView: view.frame(width: size.width, height: size.height, alignment: .topLeading).environment(\.colorScheme, dark ? .dark : .light))
        hosting.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
        hosting.frame = NSRect(origin: .zero, size: size)
        hosting.layoutSubtreeIfNeeded()
        let rep = hosting.bitmapImageRepForCachingDisplay(in: hosting.bounds)!
        hosting.cacheDisplay(in: hosting.bounds, to: rep)
        return rep
    }

    private func rgb(_ rep: NSBitmapImageRep, _ x: Int, _ y: Int) -> [CGFloat] {
        let pixel = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB)
        return [(pixel?.redComponent ?? 0) * 255, (pixel?.greenComponent ?? 0) * 255, (pixel?.blueComponent ?? 0) * 255]
    }

    /// Whether the pixel is not the window's ground, read at the top left corner, which the band never reaches.
    private func isBand(_ rep: NSBitmapImageRep, x: Int, y: Int) -> Bool {
        var distance: CGFloat = 0
        for (a, b) in zip(rgb(rep, x, y), rgb(rep, 0, 0)) { distance += abs(a - b) }
        return distance > 6
    }

    /// 20 points of margin on each side, 40 above, a 30 point block, and the band drawn over the dark `bg` or the light one.
    private func band(selected: Bool, dark: Bool, joins: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Color.red.frame(height: 30).modifier(MessageBand(selected: selected, joins: joins))
        }
        .padding(.horizontal, PardnerMetrics.margin).padding(.top, 40)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(dark ? Color(red: 0x1B / 255, green: 0x1B / 255, blue: 0x1B / 255) : Color(red: 0xF1 / 255, green: 0xF3 / 255, blue: 0xF7 / 255))
    }

    func testTheBandReachesBothEdgesAndEightPointsAboveAndBelow() {
        for dark in [false, true] {
            let size = CGSize(width: 300, height: 120)
            let rep = render(band(selected: true, dark: dark), size: size, dark: dark)
            XCTAssertTrue(isBand(rep, x: 0, y: 55), "the left edge, dark \(dark)")
            XCTAssertTrue(isBand(rep, x: 299, y: 55), "the right edge")
            XCTAssertTrue(isBand(rep, x: 150, y: 33), "8 points above the block (it starts at 40)")
            XCTAssertFalse(isBand(rep, x: 150, y: 31), "and no more")
            XCTAssertTrue(isBand(rep, x: 150, y: 77), "8 points below the block (it ends at 70)")
            XCTAssertFalse(isBand(rep, x: 150, y: 79), "and no more")
            XCTAssertFalse(isBand(render(band(selected: false, dark: dark), size: size, dark: dark), x: 0, y: 55), "no band unselected")
            if !dark { XCTAssertEqual(rgb(rep, 0, 55).map { $0.rounded() }, [223, 232, 246], "the light band is #DFE8F6") }
        }
    }

    func testTheBandOfAJoinedMessageReachesOnlyTheGapAbove() {
        for dark in [false, true] {
            let rep = render(band(selected: true, dark: dark, joins: true), size: CGSize(width: 300, height: 120), dark: dark)
            XCTAssertEqual(MessageBand.top(joins: true), PardnerMetrics.groupGap)
            XCTAssertTrue(isBand(rep, x: 150, y: 37), "4 points above the block (it starts at 40), the gap to the block above, dark \(dark)")
            XCTAssertFalse(isBand(rep, x: 150, y: 35), "and no more")
            XCTAssertTrue(isBand(rep, x: 150, y: 77), "8 points below, as for any message")
            XCTAssertFalse(isBand(rep, x: 150, y: 79))
        }
    }

    /// The frame of a message's row, in the hosting view's space, with the message on the band or not.
    private final class Frame { var value = CGRect.zero }

    private func rowFrame(selected: Bool) throws -> CGRect {
        let sample = Samples.model()
        let channel = try XCTUnwrap(sample.model.channels[sample.channel])
        let message = try XCTUnwrap(channel.messages.first { $0.ref.hex == sample.thread })
        let frame = Frame()
        let row = MessageRow(model: sample.model, icons: [:], message: message, tinted: selected)
            .background(GeometryReader { proxy in Color.clear.onAppear { frame.value = proxy.frame(in: .global) } })
            .modifier(MessageBand(selected: selected))
            .padding(.horizontal, PardnerMetrics.margin).padding(.vertical, 20)
        _ = render(row, size: CGSize(width: 600, height: 200))
        return frame.value
    }

    func testTheBandMovesNothing() throws {
        let plain = try rowFrame(selected: false)
        XCTAssertGreaterThan(plain.width, 100, "the row was measured")
        XCTAssertEqual(try rowFrame(selected: true), plain, "the avatar and the text stand where they do unselected")
    }

    // MARK: the summary row

    /// A session of a bot with a title (when given) and one reply.
    private func thread(title: String?) throws -> (model: ReadingModel, thread: MessageThread) {
        var s = ScrollFixture()
        let prompt = s.put(2, s.alice, ["text": "go"], to: s.bot)
        s.put(3, s.bot, [:], re: prompt)
        s.put(5, s.bot, ["thread": prompt.hex, "markdown": "Done."], re: prompt)
        if let title { s.put(1, s.bot, ["thread": prompt.hex, "say": "title", "markdown": title]) }
        return (s.model, try XCTUnwrap(s.model.channels[s.channel]?.threads[prompt.hex]))
    }

    private func summary(_ t: (model: ReadingModel, thread: MessageThread), isOpen: Bool) -> Summary {
        Summary(model: t.model, icons: [:], thread: t.thread, open: {}, isOpen: isOpen)
    }

    /// The row's size on a line of its own (`width` nil), or in a column `width` wide.
    private func size<V: View>(_ view: V, width: CGFloat? = nil) -> CGSize {
        _ = NSApplication.shared
        _ = PardnerFonts.register()
        let hosting = width.map { NSHostingView(rootView: view.frame(width: $0, alignment: .leading).fixedSize(horizontal: false, vertical: true)) }
            ?? NSHostingView(rootView: view.fixedSize())
        return hosting.fittingSize
    }

    /// Pixels of the `brand` label's ground (the only filled element of the row).
    private func brandPixels(_ view: some View) -> Int {
        let rep = render(view, size: CGSize(width: 520, height: 40))
        var count = 0
        for y in 0..<rep.pixelsHigh {
            for x in 0..<rep.pixelsWide {
                guard let p = rep.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                if abs(p.redComponent - 0x2F / 255) + abs(p.greenComponent - 0x5F / 255) + abs(p.blueComponent - 0xB3 / 255) < 0.03 { count += 1 }
            }
        }
        return count
    }

    func testTheOpenLabelIsOnlyInTheSelectedMessagesSummary() throws {
        let t = try thread(title: "ls -la command")
        XCTAssertEqual(brandPixels(summary(t, isOpen: false)), 0, "no filled element in a summary that is not open")
        XCTAssertGreaterThan(brandPixels(summary(t, isOpen: true)), 300, "the open one carries the filled label")
        XCTAssertGreaterThan(size(summary(t, isOpen: true)).width, size(summary(t, isOpen: false)).width, "the label takes room in the row")
    }

    func testTheSummaryRowHasNoBoxAndKeepsItsActionAndWords() throws {
        let t = try thread(title: "ls -la command")
        let rep = render(summary(t, isOpen: false), size: CGSize(width: 520, height: 40))
        XCTAssertEqual(rep.colorAt(x: 0, y: 0)?.alphaComponent ?? 1, 0, accuracy: 0.01, "no ground and no border at the corner")
        let spoken = Summary.spoken(model: t.model, thread: t.thread, showsTitle: false)
        XCTAssertTrue(spoken.contains("ls -la command") && spoken.contains("1 reply"), spoken)
    }

    func testTheTitleIsInTheRowOnlyWhenTheThreadHasOne() throws {
        let titled = try thread(title: "ls -la command")
        let bare = try thread(title: nil)
        XCTAssertNil(bare.thread.sessionTitle)
        XCTAssertGreaterThan(size(summary(titled, isOpen: false)).width, size(summary(bare, isOpen: false)).width)
    }

    func testALongTitleWrapsInsteadOfBeingCut() throws {
        let short = try thread(title: "ls -la command")
        let long = try thread(title: String(repeating: "Update the setup guide for the new store folder. ", count: 4))
        let narrow = size(summary(long, isOpen: true), width: 240)
        XCTAssertLessThanOrEqual(narrow.width, 240, "the row never goes past its column")
        XCTAssertGreaterThan(narrow.height, size(summary(short, isOpen: true), width: 240).height + 40, "the title takes as many lines as it needs, none cut")
    }

    func testTheSessionsTabKeepsItsCard() throws {
        let t = try thread(title: "ls -la command")
        let card = Summary(model: t.model, icons: [:], thread: t.thread, open: {}, showsTitle: true)
        let rep = render(card, size: CGSize(width: 400, height: 60))
        XCTAssertGreaterThan(rep.colorAt(x: 100, y: 30)?.alphaComponent ?? 0, 0.9, "the Sessions tab's summary is still a card on a ground")
    }

    // MARK: inside the band

    func testACodeSpanOnTheBandIsDrawnOnSurface() throws {
        let plain = CodeSpans.styled("a `b` c")
        XCTAssertEqual(plain.runs.compactMap(\.backgroundColor), [PardnerColor.raised])
        XCTAssertEqual(CodeSpans.styled("a `b` c", ground: PardnerColor.surface).runs.compactMap(\.backgroundColor), [PardnerColor.surface])
        let marked = try XCTUnwrap(try? AttributedString(markdown: "a `b` c", options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
        var coded = marked
        for run in marked.runs where (run.inlinePresentationIntent ?? []).contains(.code) { coded[run.range].backgroundColor = PardnerColor.raised }
        XCTAssertEqual(MarkdownView.grounded(coded, on: PardnerColor.surface).runs.compactMap(\.backgroundColor), [PardnerColor.surface], "only the code span's ground changes")
    }
}
