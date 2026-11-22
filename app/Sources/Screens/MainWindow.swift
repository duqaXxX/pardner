// The main window (step-6 plan, screen 3.1; decisions in actions' app window design): the sidebar of channels,
// the channel as a conversation with its Sessions tab, and the thread panel. Text an agent wrote is drawn
// verbatim, never as markup (AD 4.4). Colours, radii and the gap come from the design system's tokens.
import Conversation
import DesignSystem
import SwiftUI

/// The main window over the live conversation. It reads the model in its own body, so a delivery redraws this view and not the
/// scene that holds it (its menus included).
public struct LiveMainWindow: View {
    let conversation: ConversationModel
    let devices: DevicesModel
    let settings: SettingsModel
    let channels: ChannelsModel
    let composers: Composers

    public init(conversation: ConversationModel, devices: DevicesModel, settings: SettingsModel, channels: ChannelsModel, composers: Composers) {
        (self.conversation, self.devices, self.settings, self.channels, self.composers) = (conversation, devices, settings, channels, composers)
    }

    public var body: some View { MainWindow(model: conversation.reading, devices: devices, settings: settings, channels: channels, composers: composers) }
}

/// The window's content for a reading model; `channel` and `thread` start the selection.
public struct MainWindow: View {
    let model: ReadingModel
    /// The Devices pane's model; nil in the samples, which have no pairing.
    let devices: DevicesModel?
    /// The Settings panel's model; nil in the samples, which have no pairing.
    let settings: SettingsModel?
    /// The channel acts' model; nil in the samples, which have no pairing.
    let channels: ChannelsModel?
    /// The composers; nil in the samples.
    let composers: Composers?
    @State private var channel: Data?
    @State private var thread: String?
    @State private var tab: Tab = .conversation

    enum Tab: String, CaseIterable { case conversation = "Conversation", sessions = "Sessions" }

    /// The window over `model`, with a channel and a thread open when given.
    public init(model: ReadingModel, devices: DevicesModel? = nil, settings: SettingsModel? = nil, channels: ChannelsModel? = nil, composers: Composers? = nil, channel: Data? = nil, thread: String? = nil) {
        self.model = model
        self.devices = devices
        self.settings = settings
        self.channels = channels
        self.composers = composers
        _channel = State(initialValue: channel)
        _thread = State(initialValue: thread)
    }

    /// The window's least width: the columns' least widths and their dividers, the thread panel's too while a thread is open.
    static func leastWidth(threadOpen: Bool) -> CGFloat { Columns.leastWidth(threadOpen: threadOpen) }
    /// The window's least height, which the app's window sets and the columns' split answers SwiftUI's smallest-size probe with.
    public static let leastHeight = Columns.leastHeight

    // The panel shows a thread only while the channel shown holds it.
    private var openThread: MessageThread? { Self.openThread(in: shown, key: thread) }

    /// The thread the panel shows: `key` while `channel` holds it, else nil (the panel stays closed). A thread that settles as a word or
    /// as never run closes the panel: it has no composer to keep.
    static func openThread(in channel: Channel?, key: String?) -> MessageThread? {
        key.flatMap { channel?.threads[$0] }.flatMap { $0.isWord ? nil : $0 }
    }

    // The channel shown: the one chosen while the model holds it, else the first, so channels that arrive later
    // or a relay recreated never leave the window on a channel that is gone.
    private var shown: Channel? {
        channel.flatMap { model.channels[$0] } ?? Self.ordered(model).first.flatMap { model.channels[$0] }
    }

    static func ordered(_ model: ReadingModel) -> [Data] { model.channels.keys.sorted { $0.lexicographicallyPrecedes($1) } }

    /// The bots the Bots pane lists and the empty window's hint counts: the person's active bots from the device list. Until that list is
    /// read (and in the samples, which have no pairing), the bots whose profile a channel carries.
    static func listedBots(devices: DevicesModel?, profiles: [Data: BotProfile]) -> [DevicesModel.ListedBot] {
        if let devices, devices.ready { return devices.listedBots(profiles: profiles) }
        return profiles.map { DevicesModel.ListedBot(id: $0.key, profile: $0.value, label: nil) }
            .sorted { DevicesModel.precedes(($0.name, $0.id), ($1.name, $1.id)) }
    }

    /// What the empty window says to do next: nil while the device list is not read, when either line could be false, and while a channel
    /// is being made.
    static func emptyHint(devicesRead: Bool, hasBot: Bool, creating: Bool) -> String? {
        guard devicesRead, !creating else { return nil }
        return hasBot ? "Make one with + beside Channels: it binds a folder on your bot's machine."
            : "Add your bot first: in Devices…, Add a device takes the pairing string pardner setup printed on the bot's machine."
    }

    public var body: some View {
        // Each bot's icon decoded once per drawing, not once per row; the protocol bounds it (PD 6.8: 65,536 bytes,
        // a PNG or a JPEG of at most 256 pixels a side, read from its own header).
        let icons = model.profiles.compactMapValues { $0.icon.flatMap(NSImage.init(data:)) }
        let bots = Self.listedBots(devices: devices, profiles: model.profiles)
        let threadOpen = openThread != nil
        // The panes are hosted apart, so each one carries the window's font, colour and background itself.
        PaneSplit(
            threadOpen: threadOpen,
            sidebar: pane(Sidebar(model: model, selected: shown?.id, choose: { channel = $0 }, openSettings: settings.map { settings in { settings.open(.general) } },
                                  channels: channels), background: PardnerColor.side),
            conversation: pane(Group {
                if let c = shown {
                    ChannelView(model: model, icons: icons, channel: c, channels: channels, composers: composers, tab: $tab, thread: $thread)
                } else {
                    Empty(hint: Self.emptyHint(devicesRead: devices?.ready ?? false, hasBot: !bots.isEmpty,
                                               creating: channels?.creatingRow(known: Set(model.channels.keys)) != nil)).frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }),
            panel: pane(Group {
                if let c = shown, let key = thread, let t = openThread {
                    ThreadPanel(model: model, icons: icons, thread: t, close: { thread = nil }, composer: composers?.composer(channel: c.id, thread: key))
                }
            }))
        .frame(minWidth: Self.leastWidth(threadOpen: threadOpen))
        .onChange(of: shown?.id) { thread = nil }
        .sheet(isPresented: Binding(get: { settings?.pane != nil }, set: { if !$0 { settings?.close() } }), onDismiss: {
            guard let settings, settings.takeRename() else { return }
            let this = settings.devices.rows.first(where: \.isThisMac)
            channels?.openRename(.device, current: this.flatMap { model.names.devices[$0.id] ?? $0.label })
        }) {
            if let settings {
                SettingsPanel(model: settings, bots: bots, icons: icons, renameThisMac: channels == nil ? nil : { settings.closeForRename() })
            }
        }
        .background(Color.clear.sheet(isPresented: Binding(get: { channels?.sheet != nil }, set: { if !$0 { channels?.close() } })) {
            if let channels {
                if case .rename? = channels.sheet { NameSheet(model: channels, channelNames: model.names.channels) } else { ChannelSheet(model: channels, names: model.profiles.mapValues(\.name), channelNames: model.names.channels) }
            }
        })
        .background(PardnerColor.bg)
    }

    private func pane<Content: View>(_ content: Content, background: Color = PardnerColor.bg) -> AnyView {
        AnyView(content.font(PardnerFont.ui(size: 14, weight: .regular)).foregroundStyle(PardnerColor.text).background(background))
    }
}

/// What the window shows while no channel is read, with the next step when one is known.
struct Empty: View {
    let hint: String?

    var body: some View {
        VStack(spacing: PardnerMetrics.gap) {
            Text("No channels yet").font(PardnerFont.ui(size: 17, weight: .semibold))
            if let hint {
                Text(hint).foregroundStyle(PardnerColor.muted).multilineTextAlignment(.center).frame(maxWidth: 420)
            }
        }
        .padding(PardnerMetrics.gap * 3)
    }
}

/// A sender's mark: a person's a circle, a bot's a rounded square; the bot's icon when its profile has one, else the name's initial.
struct Avatar: View {
    enum Mark { case circle, roundedSquare }

    let name: String
    let isBot: Bool
    let icon: NSImage?
    var size: CGFloat = 32

    /// The shape of a sender's mark by its kind.
    static func shape(isBot: Bool) -> Mark { isBot ? .roundedSquare : .circle }

    var body: some View {
        // A circle is a rounded square whose radius is half its side.
        let radius = Self.shape(isBot: isBot) == .circle ? size / 2 : size * 0.28
        Group {
            if let icon {
                Image(nsImage: icon).resizable().interpolation(.high)
            } else {
                Text(Naming.initial(name))
                    .font(PardnerFont.display(size: size * 0.42, weight: .bold))
                    .foregroundStyle(isBot ? PardnerColor.agentInk : PardnerColor.brandText)
                    .frame(width: size, height: size)
                    .background(isBot ? PardnerColor.agent : PardnerColor.brandSoft)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: radius))
    }
}

struct Sidebar: View {
    let model: ReadingModel
    let selected: Data?
    let choose: (Data) -> Void
    /// Opens the Settings panel; nil where the window has no pairing.
    var openSettings: (() -> Void)?
    /// The channel acts; nil where the window has no pairing.
    var channels: ChannelsModel?

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 1.5) {
            HStack(spacing: PardnerMetrics.gap) {
                Logo(size: 32)
                Text("Pardner").font(PardnerFont.display(size: 18, weight: .bold))
            }
            .padding(.horizontal, 4)
            Section("Channels", trailing: channels.map { channels in
                AnyView(Button { channels.openNew() } label: { Image(systemName: "plus").font(.system(size: 12, weight: .semibold)).frame(width: 22, height: 22) }
                    .buttonStyle(.plain).pointerStyle(channels.ready ? .link : nil).disabled(!channels.ready).help("New channel").accessibilityLabel("New channel"))
            }) {
                if let row = channels?.creatingRow(known: Set(model.channels.keys)) {
                    Text(row)
                        .font(PardnerFont.ui(size: 14, weight: .regular)).foregroundStyle(PardnerColor.muted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 6)
                }
                if let line = channels?.refusalLine {
                    Text(line).font(PardnerFont.ui(size: 12, weight: .regular)).foregroundStyle(PardnerColor.delText)
                        .fixedSize(horizontal: false, vertical: true).padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 4)
                }
                ForEach(MainWindow.ordered(model), id: \.self) { id in
                    ChannelRow(name: Naming.bareChannel(id, in: model), chosen: selected == id, waiting: model.channels[id].flatMap(Self.waitingCount)) { choose(id) }
                        .contextMenu { if let channels, let channel = model.channels[id] { ChannelActions(model: model, channels: channels, channel: channel) } }
                }
            }
            Spacer()
            // The person's row and the Settings button, under a rule.
            HStack(spacing: 4) {
                if let channels {
                    Button { channels.openRename(.person, current: model.personName) } label: {
                        HStack(spacing: PardnerMetrics.gap) {
                            Avatar(name: model.personName ?? "You", isBot: false, icon: nil, size: 28)
                            Text(model.personName ?? "Set your name").font(PardnerFont.ui(size: 14, weight: model.personName == nil ? .regular : .semibold))
                                .foregroundStyle(model.personName == nil ? PardnerColor.muted : PardnerColor.text).lineLimit(1)
                            Spacer()
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).pointerStyle(channels.ready ? .link : nil).disabled(!channels.ready).help("Change your name").accessibilityLabel("Change your name")
                } else {
                    Spacer()
                }
                if let openSettings {
                    Button(action: openSettings) { Image(systemName: "gearshape").foregroundStyle(PardnerColor.muted).frame(width: 30, height: 30).contentShape(Rectangle()) }
                        .buttonStyle(.plain).pointerStyle(.link).help("Settings…").accessibilityLabel("Settings…")
                }
            }
            .padding(.top, PardnerMetrics.gap + 2)
            .overlay(alignment: .top) { Rectangle().fill(PardnerColor.line).frame(height: 1) }
        }
        .padding(PardnerMetrics.gap * 1.5)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(PardnerColor.side)
    }

    /// The count a channel's row carries: its threads that wait for the person, nil while none does.
    static func waitingCount(_ channel: Channel) -> Int? {
        let count = channel.threads.values.filter { $0.state == .waiting }.count
        return count > 0 ? count : nil
    }

    struct Section<Content: View>: View {
        let title: String
        let trailing: AnyView?
        @ViewBuilder let content: Content
        init(_ title: String, trailing: AnyView? = nil, @ViewBuilder content: () -> Content) { (self.title, self.trailing, self.content) = (title, trailing, content()) }
        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(title.uppercased()).font(PardnerFont.ui(size: 11, weight: .semibold))
                    Spacer()
                    trailing
                }
                .foregroundStyle(PardnerColor.muted)
                .padding(.horizontal, PardnerMetrics.gap).padding(.bottom, 4)
                content
            }
        }
    }
}

/// A channel's row: `#` and the bare name, the chosen row on `raised` and semibold, a row under the pointer on `raised` at half strength,
/// and the count of threads waiting for the person in a pill.
struct ChannelRow: View {
    let name: String
    let chosen: Bool
    let waiting: Int?
    let choose: () -> Void
    @State private var hovered = false

    var body: some View {
        Button(action: choose) {
            HStack(spacing: PardnerMetrics.gap) {
                Text("#").foregroundStyle(chosen ? PardnerColor.brandText : PardnerColor.muted).frame(width: 12)
                Text(name).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                if let waiting {
                    Text("\(waiting)").font(PardnerFont.ui(size: 11, weight: .bold)).foregroundStyle(PardnerColor.badgeInk)
                        .padding(.horizontal, 5).frame(minWidth: 18, minHeight: 18).background(PardnerColor.badge, in: Capsule())
                        .accessibilityLabel("\(waiting) waiting for you")
                }
            }
            .font(PardnerFont.ui(size: 14, weight: chosen ? .semibold : .regular))
            .padding(.horizontal, PardnerMetrics.gap + 2).frame(height: 30)
            .background(chosen ? PardnerColor.raised : hovered ? PardnerColor.raised.opacity(0.5) : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerStyle(.link).onHover { hovered = $0 }
        .accessibilityAddTraits(chosen ? .isSelected : [])
    }
}
