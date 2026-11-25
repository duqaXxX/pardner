// A file the relay holds, fetched whole (file-content design, 3.6): the link streams one `blob` frame at a time in order and
// resumes a drop from the last offset by itself; the driver gathers the frames and the package opens the whole.
import Foundation

/// What a fetch came to.
public enum FetchOutcome: Sendable, Equatable {
    /// The file's bytes, opened and checked by the package.
    case file(Data)
    /// The relay lacks the blob, or its hash, its key or its length fails: the file can no longer be read (security design 5.12, point 6).
    case gone
    /// The connection was stopped or is final, or its history is not read yet: nothing was learned about the file, so asking again is right.
    case ended
}

/// The frames of one get, in order. A frame whose offset is not the end of what is held is refused: the link orders them, so one out of order
/// is a fault and the fetch fails whole.
struct BlobGatherer {
    private(set) var data = Data()

    /// Whether `chunk` at `offset` followed what is held, and was added.
    mutating func take(offset: Int, chunk: Data) -> Bool {
        guard offset == data.count else { return false }
        data.append(chunk)
        return true
    }
}

/// The gets in flight, by the link's request: each holds what it gathered and the caller waiting for the file.
final class Fetches {
    final class Get {
        let channel: Data
        let blob: Data
        let continuation: CheckedContinuation<FetchOutcome, Never>
        var gathered = BlobGatherer()
        init(channel: Data, blob: Data, _ continuation: CheckedContinuation<FetchOutcome, Never>) { (self.channel, self.blob, self.continuation) = (channel, blob, continuation) }
    }

    private var gets: [Int: Get] = [:]

    func add(_ request: Int, _ get: Get) { gets[request] = get }

    /// A `blob` effect: the frame joins its get. A frame out of order ends the get as gone.
    func take(request: Int, offset: Int, chunk: Data) {
        guard let get = gets[request] else { return }
        if !get.gathered.take(offset: offset, chunk: chunk) { gets.removeValue(forKey: request)?.continuation.resume(returning: .gone) }
    }

    /// The get an `answer` ends, or nil when the request is not a get.
    func end(_ request: Int) -> Get? { gets.removeValue(forKey: request) }

    /// The connection ended: every get is over.
    func endAll() {
        for get in gets.values { get.continuation.resume(returning: .ended) }
        gets.removeAll()
    }
}
