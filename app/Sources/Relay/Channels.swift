// What the screens read of a new channel and the app's outbox, and what their acts answer (new channel design 3, 5). Values only: the
// logic is in PairingController.swift, and no view lives here.
import Foundation
import ProtocolHost

/// A message `send` queues: the draft the protocol's `queue` takes, without files (design 4: refused until a design seals their keys).
public struct OutboxDraft: Sendable, Equatable {
    public var kind: UInt8
    public var to: Data?
    public var re: MessageReference?
    public var name: Data?
    public var content: String

    public init(kind: UInt8, to: Data? = nil, re: MessageReference? = nil, name: Data? = nil, content: String) {
        (self.kind, self.to, self.re, self.name, self.content) = (kind, to, re, name, content)
    }
}

/// A message named by its sender and its name.
public struct MessageReference: Sendable, Equatable {
    public let device: Data
    public let name: Data

    public init(device: Data, name: Data) { (self.device, self.name) = (device, name) }
}

/// What `createChannel` came to.
public enum CreateOutcome: Sendable, Equatable {
    /// Entry 0 was made and queued with the `/bind` prompt; the channel's id is known at once.
    case created(channel: Data)
    /// The link's reason: `not-ready`, `busy` (a creation is pending), `bad-input`, or the platform's own.
    case refused(String)
    /// The connection was stopped, or is final: nothing was made.
    case ended
    /// The write that keeps the channel failed: nothing is sent, and the caller keeps what it typed. The connection reports `storeFailed`.
    case notSaved
}

/// What `send` came to.
public enum SendOutcome: Sendable, Equatable {
    /// The message is in the channel's outbox under this name.
    case queued(name: Data)
    /// The link's reason: `bad-input`, `not-member`, `fault` (the channel is stopped) or `not-ready`.
    case refused(String)
    /// The connection was stopped, or is final: nothing was queued.
    case ended
    /// The write that keeps the message failed: nothing is sent, and the caller keeps the draft. The connection reports `storeFailed`.
    case notSaved
}

/// Where a message of the outbox stands.
public enum OutboxItemState: String, Sendable, Equatable {
    /// Not at the relay yet.
    case waiting
    /// The relay holds it, and this device has not read it back.
    case sent
    /// Not delivered, and gone from the outbox: told once.
    case refused
}

/// One message of a channel's outbox, as the screen draws it before the log gives it back.
public struct OutboxItemRow: Sendable, Equatable {
    public let name: Data
    public let kind: Int
    public let to: Data?
    public let re: MessageReference?
    public let state: OutboxItemState

    package init(name: Data, kind: Int, to: Data?, re: MessageReference?, state: OutboxItemState) {
        (self.name, self.kind, self.to, self.re, self.state) = (name, kind, to, re, state)
    }
}

/// The channel being created: shown at once, until a message of it is read.
public struct PendingChannel: Sendable, Equatable {
    public let channel: Data
    public let bot: Data
    public let folder: String

    public init(channel: Data, bot: Data, folder: String) { (self.channel, self.bot, self.folder) = (channel, bot, folder) }
}

/// A new channel the relay refused: its code stands until the next creation.
public struct CreationRefusal: Sendable, Equatable {
    public let channel: Data
    public let code: Int

    public init(channel: Data, code: Int) { (self.channel, self.code) = (channel, code) }
}

/// What the new-channel sheet and the sidebar read: the creation in progress, each channel's outbox, the last refused creation and the
/// channels the link stopped sending in.
public struct ChannelsState: Sendable, Equatable {
    public var creating: PendingChannel?
    /// A channel with nothing in its outbox is absent.
    public var outboxes: [Data: [OutboxItemRow]] = [:]
    public var refusal: CreationRefusal?
    public var faulted: Set<Data> = []

    public init() {}
}
