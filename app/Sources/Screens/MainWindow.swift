// The main window (step-6 plan, screen 3.1; decisions in actions' app window design): the sidebar of channels,
// the channel as a conversation with its Sessions tab, and the thread panel. Text an agent wrote is drawn
// verbatim, never as markup (AD 4.4). Colours, radii and the gap come from the design system's tokens.
import Conversation
import DesignSystem
import SwiftUI

/// The window's content for a reading model; `channel` and `thread` start the selection.
public struct MainWindow: View {
    let model: ReadingModel
    /// The Devices sheet's model; nil in the samples, which have no pairing.
    let devices: DevicesModel?
    @State private var channel: Data?
    @State private var thread: String?
    @State private var tab: Tab = .conversation

    enum Tab: String, CaseIterable { case conversation = "Conversation", sessions = "Sessions" }

    /// The window over `model`, with a channel and a thread open when given.
    public init(model: ReadingModel, devices: DevicesModel? = nil, channel: Data? = nil, thread: String? = nil) {
        self.model = model
        self.devices = devices
        _channel = State(initialValue: channel)
        _thread = State(initialValue: thread)
    }

    /// The window's least width with a thread open: the sidebar, the conversation's least, the panel, two dividers.
    public static let minimumWidth: CGFloat = 248 + 420 + 380 + 2

    // The channel shown: the one chosen while the model holds it, else the first, so channels that arrive later
    // or a relay recreated never leave the window on a channel that is gone.
    private var shown: Channel? {
        channel.flatMap { model.channels[$0] } ?? Self.ordered(model).first.flatMap { model.channels[$0] }
    }

    static func ordered(_ model: ReadingModel) -> [Data] { model.channels.keys.sorted { $0.lexicographicallyPrecedes($1) } }

    public var body: some View {
        // Each bot's icon decoded once per drawing, not once per row; the protocol bounds it (PD 6.8: 65,536 bytes,
        // a PNG or a JPEG of at most 256 pixels a side, read from its own header).
        let icons = model.profiles.compactMapValues { $0.icon.flatMap(NSImage.init(data:)) }
        HStack(spacing: 0) {
            Sidebar(model: model, icons: icons, selected: shown?.id, choose: { channel = $0 }, openDevices: devices.map { devices in { devices.open() } })
                .frame(width: 248)
            Divider().overlay(PardnerColor.line)
            if let c = shown {
                ChannelView(model: model, icons: icons, channel: c, tab: $tab, thread: $thread)
                    .frame(minWidth: 420, maxWidth: .infinity)
                if let key = thread, let t = c.threads[key] {
                    Divider().overlay(PardnerColor.line)
                    ThreadPanel(model: model, icons: icons, thread: t, close: { thread = nil })
                        .frame(width: 380)
                }
            } else {
                Empty().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .onChange(of: shown?.id) { thread = nil }
        .sheet(isPresented: Binding(get: { devices?.isOpen ?? false }, set: { if !$0 { devices?.close() } })) {
            if let devices { DevicesSheet(model: devices) }
        }
        .font(PardnerFont.ui(size: 14, weight: .regular))
        .foregroundStyle(PardnerColor.text)
        .background(PardnerColor.bg)
    }
}

/// What the window shows before any channel is read: in this version, before the device is paired.
struct Empty: View {
    var body: some View {
        VStack(spacing: PardnerMetrics.gap) {
            Text("No channels yet").font(PardnerFont.ui(size: 17, weight: .semibold))
            Text("Channels come with a later version of Pardner.")
                .foregroundStyle(PardnerColor.muted)
        }
        .padding(PardnerMetrics.gap * 3)
    }
}

/// A sender's mark: the bot's icon when its profile has one, else the name's initial on the sender's colour.
struct Avatar: View {
    let name: String
    let isBot: Bool
    let icon: NSImage?
    var size: CGFloat = 32

    var body: some View {
        Group {
            if let icon {
                Image(nsImage: icon).resizable().interpolation(.high)
            } else {
                Text(Naming.initial(name))
                    .font(PardnerFont.display(size: size * 0.42, weight: .bold))
                    .foregroundStyle(isBot ? PardnerColor.agentInk : PardnerColor.brandInk)
                    .frame(width: size, height: size)
                    .background(isBot ? PardnerColor.agent : PardnerColor.brand)
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
    }
}

struct Sidebar: View {
    let model: ReadingModel
    let icons: [Data: NSImage]
    let selected: Data?
    let choose: (Data) -> Void
    /// Opens the Devices sheet; nil where the window has no pairing.
    var openDevices: (() -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: PardnerMetrics.gap * 1.5) {
            HStack(spacing: PardnerMetrics.gap) {
                Logo(size: 32)
                Text("Pardner").font(PardnerFont.display(size: 18, weight: .bold))
            }
            .padding(.horizontal, 4)
            Section("Channels") {
                ForEach(MainWindow.ordered(model), id: \.self) { id in
                    Button { choose(id) } label: {
                        Text(Naming.channel(id))
                            .font(PardnerFont.ui(size: 14, weight: selected == id ? .semibold : .regular))
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 6)
                            .background(selected == id ? PardnerColor.raised : .clear, in: RoundedRectangle(cornerRadius: PardnerMetrics.controlRadius))
                    }
                    .buttonStyle(.plain)
                }
            }
            Section("Bots") {
                // By name, the id breaking a tie: two bots may share a name.
                ForEach(model.profiles.keys.sorted { a, b in
                    let (x, y) = (model.profiles[a]?.name ?? "", model.profiles[b]?.name ?? "")
                    return x != y ? x < y : a.lexicographicallyPrecedes(b)
                }, id: \.self) { bot in
                    let p = model.profiles[bot]
                    HStack(spacing: PardnerMetrics.gap) {
                        Avatar(name: p?.name ?? Naming.short(bot), isBot: true, icon: icons[bot], size: 20)
                        VStack(alignment: .leading, spacing: 0) {
                            Text(p?.name ?? Naming.short(bot))
                            if let account = p?.account {
                                Text(account).font(PardnerFont.ui(size: 11, weight: .regular)).foregroundStyle(PardnerColor.muted)
                            }
                        }
                    }
                    .padding(.horizontal, PardnerMetrics.gap)
                }
            }
            Spacer()
            if let openDevices {
                Button(action: openDevices) {
                    Text("Devices…").frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, PardnerMetrics.gap).padding(.vertical, 6)
                }
                .buttonStyle(.plain).accessibilityLabel("Open the devices")
            }
        }
        .padding(PardnerMetrics.gap * 1.5)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(PardnerColor.side)
    }

    struct Section<Content: View>: View {
        let title: String
        @ViewBuilder let content: Content
        init(_ title: String, @ViewBuilder content: () -> Content) { (self.title, self.content) = (title, content()) }
        var body: some View {
            VStack(alignment: .leading, spacing: 2) {
                Text(title.uppercased())
                    .font(PardnerFont.ui(size: 11, weight: .semibold)).foregroundStyle(PardnerColor.muted)
                    .padding(.horizontal, PardnerMetrics.gap).padding(.bottom, 4)
                content
            }
        }
    }
}
