// What the recovery sheet does, apart from drawing (device pairing design 3.5 step 5 and 3.8): the typed-back key, when Confirm is
// possible, and the wipe of every buffer the sheet owns when it closes. The secret is read only inside `withSecret`, never kept in a
// `String`; the characters shown and their glyphs live in two caller-owned buffers that `close()` zeroes.
import CoreText
import Observation
import Platform
import Relay

/// What the sheet shows and answers: the controller's `RecoverySheetRequest`, or a stand-in in a test and in the screenshot tool.
public protocol RecoverySource: AnyObject {
    /// The person id, the relay's address and key, as text.
    var context: String { get }
    /// Runs `body` on the 32 secret bytes; nil once the sheet is answered.
    func withSecret<T>(_ body: (UnsafeRawBufferPointer) -> T) -> T?
    /// True only for a typed-back match; the first answer stands.
    func answer(_ confirmed: Bool)
}

extension RecoverySheetRequest: RecoverySource {}

/// The characters of the key as laid out for display and their glyphs, in memory this object allocates and zeroes.
final class DrawBuffers {
    static let count = RecoveryText.displayCount
    let characters = UnsafeMutablePointer<UniChar>.allocate(capacity: count)
    let glyphs = UnsafeMutablePointer<CGGlyph>.allocate(capacity: count)
    var glyphsReady = false

    init() {
        characters.initialize(repeating: 0, count: Self.count)
        glyphs.initialize(repeating: 0, count: Self.count)
    }

    func wipe() {
        memset_s(characters, Self.count * MemoryLayout<UniChar>.size, 0, Self.count * MemoryLayout<UniChar>.size)
        memset_s(glyphs, Self.count * MemoryLayout<CGGlyph>.size, 0, Self.count * MemoryLayout<CGGlyph>.size)
        glyphsReady = false
    }

    var isZero: Bool {
        (0..<Self.count).allSatisfy { characters[$0] == 0 && glyphs[$0] == 0 }
    }

    deinit {
        wipe()
        characters.deallocate()
        glyphs.deallocate()
    }
}

@MainActor @Observable
public final class RecoverySheetModel: Identifiable {
    public let context: String
    let source: any RecoverySource
    let secureInput: SecureInputGuard
    let buffers = DrawBuffers()
    private let entry = RecoveryEntry()
    /// How many symbols the person has typed.
    public private(set) var typed = 0
    /// Whether the typed text reads back to the same 32 bytes.
    public private(set) var matches = false
    public private(set) var isClosed = false
    /// The sheet shows a new recovery key made in a recovery (recovery design 2.3 step 5): its words say when the key opens the history.
    public var isRecovery = false

    public static let symbolCount = RecoveryText.symbolCount

    init(source: any RecoverySource, secureInput: SecureInputGuard) {
        (self.source, self.secureInput, context) = (source, secureInput, source.context)
        // The secret passes through one `SecretBuffer` on its way to the display characters, wiped at once.
        let secret = SecretBuffer(count: 32)
        defer { secret.wipe() }
        let present: Bool = source.withSecret { bytes in secret.withUnsafeMutableBytes { $0.copyBytes(from: bytes) }; return true } ?? false
        if present {
            RecoveryText.write(secret, into: UnsafeMutableBufferPointer(start: buffers.characters, count: DrawBuffers.count))
        }
    }

    public convenience init(source: any RecoverySource) { self.init(source: source, secureInput: SecureInputGuard()) }

    /// The display characters and their glyph slots, valid inside `body`; nil once the sheet is closed.
    func withDrawing<T>(_ body: (_ characters: UnsafePointer<UniChar>, _ glyphs: UnsafeMutablePointer<CGGlyph>, _ ready: inout Bool) -> T) -> T? {
        guard !isClosed else { return nil }
        return body(buffers.characters, buffers.glyphs, &buffers.glyphsReady)
    }

    /// A typed key: a symbol is taken, a separator ignored, anything else refused. False when refused.
    @discardableResult
    public func key(_ character: UniChar) -> Bool {
        guard !isClosed else { return false }
        let taken = entry.append(character)
        refresh()
        return taken
    }

    public func deleteLast() {
        guard !isClosed else { return }
        entry.deleteLast()
        refresh()
    }

    /// Confirm: answers true when the typed text still reads back to the secret, from inside `withSecret`, then closes.
    public func confirm() {
        guard !isClosed, typed == Self.symbolCount else { return }
        let scratch = SecretBuffer(count: 32)
        defer { scratch.wipe() }
        guard (try? entry.read(into: scratch)) != nil else { return refresh() }
        let accepted = source.withSecret { secret in
            guard Self.equal(scratch, secret) else { return false }
            source.answer(true)
            return true
        }
        if accepted == true { close() } else { refresh() }
    }

    /// Cancel, and every other way the sheet goes away: a decline unless a match was answered, then the wipe. Safe to call again.
    public func close() {
        guard !isClosed else { return }
        isClosed = true
        source.answer(false)
        entry.wipe()
        buffers.wipe()
        secureInput.close()
        typed = 0
        matches = false
    }

    private func refresh() {
        typed = entry.count
        matches = typed == Self.symbolCount && readsBack()
    }

    private func readsBack() -> Bool {
        let scratch = SecretBuffer(count: 32)
        defer { scratch.wipe() }
        guard (try? entry.read(into: scratch)) != nil else { return false }
        return source.withSecret { Self.equal(scratch, $0) } ?? false
    }

    /// All 32 bytes compared without an early exit.
    private static func equal(_ a: SecretBuffer, _ b: UnsafeRawBufferPointer) -> Bool {
        a.withUnsafeBytes { a in
            guard a.count == b.count else { return false }
            var difference: UInt8 = 0
            for i in 0..<a.count { difference |= a[i] ^ b[i] }
            return difference == 0
        }
    }
}
