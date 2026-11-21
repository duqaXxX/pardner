// The main window's three columns over AppKit's split view (resizable columns design, 4): the system keeps the widths across launches
// (`autosaveName`), the items' limits stop a drag, and a narrowed window takes its width from the conversation first. The panes are
// SwiftUI views, one hosting controller each; the selection and the sheets stay in `MainWindow`.
import AppKit
import SwiftUI

/// The columns' limits and first-launch widths, in points.
enum Columns {
    static let sidebarLeast: CGFloat = 200, sidebarMost: CGFloat = 360, sidebarDefault: CGFloat = 248
    static let conversationLeast: CGFloat = 420
    static let panelLeast: CGFloat = 320, panelMost: CGFloat = 640, panelDefault: CGFloat = 380
    /// The system's thin divider.
    static let divider: CGFloat = 1

    /// The window's least width: every column at its least, and a divider between two columns.
    static func leastWidth(threadOpen: Bool) -> CGFloat {
        sidebarLeast + divider + conversationLeast + (threadOpen ? divider + panelLeast : 0)
    }

    /// Where the panel's divider sits so that the panel is `panelDefault` wide in a split of `width`, but never left of where the conversation
    /// keeps its least width beside a sidebar `sidebarWidth` wide: a split too narrow for both keeps the sidebar and gives the panel less.
    static func panelDividerPosition(width: CGFloat, thickness: CGFloat, sidebarWidth: CGFloat) -> CGFloat {
        max(width - panelDefault - thickness, sidebarWidth + thickness + conversationLeast)
    }
}

/// The two first-launch moments, each done once. The flags are ours: AppKit's own autosave key is not documented.
struct FirstLaunch {
    static let sidebarKey = "columns.sidebarWidthSet", panelKey = "columns.panelWidthSet"
    let defaults: UserDefaults

    var sidebarPending: Bool { !defaults.bool(forKey: Self.sidebarKey) }
    var panelPending: Bool { !defaults.bool(forKey: Self.panelKey) }
    func sidebarDone() { defaults.set(true, forKey: Self.sidebarKey) }
    func panelDone() { defaults.set(true, forKey: Self.panelKey) }
}

/// A vertical split view whose dividers go back to their default width on a double click.
final class ColumnSplitView: NSSplitView {
    /// The divider's hit area, measured: two points either side of it.
    static let hitSlop: CGFloat = 2

    /// Sets divider `index` to its default width: the sidebar's, or the panel's.
    func resetDivider(_ index: Int) {
        setPosition(index == 0 ? Columns.sidebarDefault : Columns.panelDividerPosition(width: bounds.width, thickness: dividerThickness, sidebarWidth: arrangedSubviews[0].frame.width), ofDividerAt: index)
    }

    /// Told which divider a mouse-down landed on: the person has taken it over, so its first-launch width is never set again.
    var tookOver: ((Int) -> Void)?

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        for index in 0..<(arrangedSubviews.count - 1) where !arrangedSubviews[index + 1].isHidden {
            let divider = NSRect(x: arrangedSubviews[index].frame.maxX, y: 0, width: dividerThickness, height: bounds.height)
            guard divider.insetBy(dx: -Self.hitSlop, dy: 0).contains(point) else { continue }
            tookOver?(index)
            if event.clickCount == 2 {
                resetDivider(index)
                return
            }
            break
        }
        super.mouseDown(with: event)
    }
}

final class ColumnsController: NSSplitViewController {
    private let hosts = (0..<3).map { _ in NSHostingController(rootView: AnyView(EmptyView())) }
    private let firstLaunch: FirstLaunch
    private let autosaveName: String
    private var threadOpen = false
    private var applying = false
    private var panel: NSSplitViewItem { splitViewItems[2] }

    /// A controller whose first-launch flags live in `defaults`; `autosaveName` is the window's, and tests pass their own.
    init(defaults: UserDefaults, autosaveName: String = "MainWindow.columns") {
        firstLaunch = FirstLaunch(defaults: defaults)
        self.autosaveName = autosaveName
        super.init(nibName: nil, bundle: nil)
        let split = ColumnSplitView()
        let first = firstLaunch
        split.tookOver = { index in if index == 0 { first.sidebarDone() } else { first.panelDone() } }
        splitView = split
        splitView.isVertical = true // the subclass starts as a horizontal stack otherwise
        splitView.dividerStyle = .thin
    }

    required init?(coder: NSCoder) { fatalError("not decoded") }

    override func viewDidLoad() {
        // Before any item is added: set after them, a panel collapsed at quit came back at the wrong width (measured, macOS 27).
        splitView.autosaveName = autosaveName
        let sidebar = NSSplitViewItem(viewController: hosts[0])
        sidebar.minimumThickness = Columns.sidebarLeast
        sidebar.maximumThickness = Columns.sidebarMost
        sidebar.canCollapse = false
        sidebar.holdingPriority = NSLayoutConstraint.Priority(260)
        let conversation = NSSplitViewItem(viewController: hosts[1])
        conversation.minimumThickness = Columns.conversationLeast
        conversation.holdingPriority = NSLayoutConstraint.Priority(249) // the lowest: it gives way first
        let panel = NSSplitViewItem(viewController: hosts[2])
        panel.minimumThickness = Columns.panelLeast
        panel.maximumThickness = Columns.panelMost
        panel.canCollapse = false // the person cannot collapse it; the code does, when no thread is open
        panel.holdingPriority = NSLayoutConstraint.Priority(260)
        for item in [sidebar, conversation, panel] { addSplitViewItem(item) }
        super.viewDidLoad()
    }

    override func viewDidLayout() {
        super.viewDidLayout()
        // An autosave restored after the first update can open a panel no thread asked for.
        if !threadOpen, !panel.isCollapsed { panel.isCollapsed = true }
        applyFirstLaunch()
    }

    /// Hands the panes their views and opens or closes the panel. Writes no model state: a write here loops.
    func update(sidebar: AnyView, conversation: AnyView, panel content: AnyView, threadOpen: Bool) {
        loadViewIfNeeded() // SwiftUI may update before the view is loaded
        self.threadOpen = threadOpen
        hosts[0].rootView = sidebar
        hosts[1].rootView = conversation
        hosts[2].rootView = content
        if panel.isCollapsed == threadOpen {
            panel.isCollapsed = !threadOpen
            applyFirstLaunch()
        }
    }

    /// With nothing saved the items start at their least: the sidebar gets its default width when the split first has a width, the panel
    /// when it first opens. A flag is set only once the frame holds the width, so a call the split ignored is made again; the renderer calls
    /// this after its layout.
    func applyFirstLaunch() {
        // A split with no height is the early pass at the least size, before the window gives it its own.
        guard splitView.bounds.width > 0, splitView.bounds.height > 0, !applying else { return }
        applying = true
        defer { applying = false } // setPosition lays out, which comes back here
        if firstLaunch.sidebarPending {
            splitView.setPosition(Columns.sidebarDefault, ofDividerAt: 0)
            splitView.layoutSubtreeIfNeeded()
            if abs(splitView.arrangedSubviews[0].frame.width - Columns.sidebarDefault) < 1 { firstLaunch.sidebarDone() }
        }
        if !panel.isCollapsed, firstLaunch.panelPending {
            let position = Columns.panelDividerPosition(width: splitView.bounds.width, thickness: splitView.dividerThickness, sidebarWidth: splitView.arrangedSubviews[0].frame.width)
            splitView.setPosition(position, ofDividerAt: 1)
            splitView.layoutSubtreeIfNeeded()
            if abs(splitView.arrangedSubviews[1].frame.maxX - position) < 1 { firstLaunch.panelDone() }
        }
    }
}

/// The three columns of the main window; the panel is shown while `threadOpen`.
struct PaneSplit: NSViewControllerRepresentable {
    let threadOpen: Bool
    let sidebar: AnyView
    let conversation: AnyView
    let panel: AnyView

    func makeNSViewController(context: Context) -> ColumnsController { ColumnsController(defaults: .standard) }

    func updateNSViewController(_ controller: ColumnsController, context: Context) {
        controller.update(sidebar: sidebar, conversation: conversation, panel: panel, threadOpen: threadOpen)
    }
}
