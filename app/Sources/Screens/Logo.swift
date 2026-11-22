// The Pardner mark, ported from the logo board's SVG (actions/data/2026-11-19-app-design.html, 64 by 64
// units): a speech bubble in `brand` with two eyes and a smile cut in the sidebar's colour, and a hat in
// `agent` tilted on its corner, with its band.
import DesignSystem
import SwiftUI

public struct Logo: View {
    public var size: CGFloat = 28

    public init(size: CGFloat = 28) { self.size = size }

    public var body: some View {
        Canvas { context, canvas in
            let s = canvas.width / 64
            context.scaleBy(x: s, y: s)
            context.fill(Self.bubble, with: .color(PardnerColor.brand))
            for x in [26.0, 38.0] {
                context.fill(Path(ellipseIn: CGRect(x: x - 2.2, y: 39.5 - 2.2, width: 4.4, height: 4.4)), with: .color(PardnerColor.side))
            }
            var smile = Path()
            smile.move(to: CGPoint(x: 27, y: 44.5))
            smile.addQuadCurve(to: CGPoint(x: 37, y: 44.5), control: CGPoint(x: 32, y: 48.7))
            context.stroke(smile, with: .color(PardnerColor.side), style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
            // rotate(-14 27 29) translate(4.6 -3.3) scale(0.7), as the board's `transform`.
            var hat = context
            hat.translateBy(x: 27, y: 29)
            hat.rotate(by: .degrees(-14))
            hat.translateBy(x: -27 + 4.6, y: -29 - 3.3)
            hat.scaleBy(x: 0.7, y: 0.7)
            hat.fill(Self.hat, with: .color(PardnerColor.agent))
            var band = Path()
            band.move(to: CGPoint(x: 18.8, y: 36.5))
            band.addCurve(to: CGPoint(x: 45.2, y: 36.5), control1: CGPoint(x: 27, y: 39), control2: CGPoint(x: 37, y: 39))
            hat.stroke(band, with: .color(Color(red: 0x8A / 255, green: 0x5A / 255, blue: 0x0B / 255)), lineWidth: 4)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("Pardner")
    }

    /// The bubble: a rounded rectangle from (12.5, 29) to (51.5, 53) with corners of 9, and its tail.
    private static let bubble: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 21.5, y: 29))
        p.addLine(to: CGPoint(x: 42.5, y: 29))
        p.addArc(center: CGPoint(x: 42.5, y: 38), radius: 9, startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
        p.addLine(to: CGPoint(x: 51.5, y: 44))
        p.addArc(center: CGPoint(x: 42.5, y: 44), radius: 9, startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
        p.addLine(to: CGPoint(x: 29, y: 53))
        p.addLine(to: CGPoint(x: 20.8, y: 59.5))
        p.addLine(to: CGPoint(x: 20.8, y: 52.7))
        p.addArc(center: CGPoint(x: 21.5, y: 44), radius: 9, startAngle: .degrees(94.6), endAngle: .degrees(180), clockwise: false)
        p.addLine(to: CGPoint(x: 12.5, y: 38))
        p.addArc(center: CGPoint(x: 21.5, y: 38), radius: 9, startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
        p.closeSubpath()
        return p
    }()

    /// The hat, before its transform.
    private static let hat: Path = {
        var p = Path()
        p.move(to: CGPoint(x: 4, y: 40))
        p.addCurve(to: CGPoint(x: 32, y: 49), control1: CGPoint(x: 10, y: 46), control2: CGPoint(x: 22, y: 49))
        p.addCurve(to: CGPoint(x: 60, y: 40), control1: CGPoint(x: 42, y: 49), control2: CGPoint(x: 54, y: 46))
        p.addCurve(to: CGPoint(x: 46, y: 42.5), control1: CGPoint(x: 56, y: 42), control2: CGPoint(x: 50, y: 43))
        p.addLine(to: CGPoint(x: 44, y: 26))
        p.addCurve(to: CGPoint(x: 36.5, y: 20), control1: CGPoint(x: 43.5, y: 21), control2: CGPoint(x: 40, y: 18.5))
        p.addLine(to: CGPoint(x: 32, y: 22))
        p.addLine(to: CGPoint(x: 27.5, y: 20))
        p.addCurve(to: CGPoint(x: 20, y: 26), control1: CGPoint(x: 24, y: 18.5), control2: CGPoint(x: 20.5, y: 21))
        p.addLine(to: CGPoint(x: 18, y: 42.5))
        p.addCurve(to: CGPoint(x: 4, y: 40), control1: CGPoint(x: 14, y: 43), control2: CGPoint(x: 8, y: 42))
        p.closeSubpath()
        return p
    }()
}
