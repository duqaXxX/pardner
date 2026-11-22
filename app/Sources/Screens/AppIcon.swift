// The app's icon: the mark on a rounded tile, laid out on the macOS icon grid (1024 points square, the body 824
// points with a margin of 100, the corners of a continuous curve). `icon-render` draws it to the asset catalog.
import DesignSystem
import SwiftUI

public struct AppIcon: View {
    public var size: CGFloat

    public init(size: CGFloat) { self.size = size }

    public var body: some View {
        let u = size / 1024
        ZStack {
            RoundedRectangle(cornerRadius: 185.4 * u, style: .continuous)
                .fill(PardnerColor.side)
                .frame(width: 824 * u, height: 824 * u)
                .shadow(color: .black.opacity(0.25), radius: 12 * u, y: 10 * u)
            // The mark's drawing sits low in its 64 unit box: lifted to centre it.
            Logo(size: 800 * u)
                .offset(x: 34 * u, y: -31 * u)
        }
        .frame(width: size, height: size)
    }
}
