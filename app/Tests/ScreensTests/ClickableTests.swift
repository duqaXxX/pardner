// The pointing hand comes from one place (#133): these tests read the screens' sources and fail where a clickable element would be
// drawn without it. A button takes the hand from `.clickable`; a menu, a picker and a toggle carry `.clickable(...)` in their modifiers.
import XCTest

final class ClickableTests: XCTestCase {
    private func screens() throws -> [(name: String, lines: [String])] {
        var app = URL(fileURLWithPath: #filePath)
        for _ in 0..<3 { app.deleteLastPathComponent() }
        let root = app.appendingPathComponent("Sources/Screens")
        let files = try XCTUnwrap(FileManager.default.enumerator(at: root, includingPropertiesForKeys: nil)).compactMap { $0 as? URL }
        return try files.filter { $0.pathExtension == "swift" && $0.lastPathComponent != "Clickable.swift" }.map {
            ($0.lastPathComponent, try String(contentsOf: $0, encoding: .utf8).components(separatedBy: "\n"))
        }
    }

    func testNoButtonIsPlainAndNoHandIsSetElsewhere() throws {
        let found = try screens()
        XCTAssertGreaterThan(found.count, 20, "the screens' sources are found")
        for (name, lines) in found {
            for (n, line) in lines.enumerated() where !line.trimmingCharacters(in: .whitespaces).hasPrefix("//") {
                for style in [".buttonStyle(.plain)", "PlainButtonStyle()", ".buttonStyle(.borderless)", ".buttonStyle(.link)"] {
                    XCTAssertFalse(line.contains(style), "\(name):\(n + 1): \(style) shows no hand; use .buttonStyle(.clickable)")
                }
                XCTAssertFalse(line.contains("pointerStyle("), "\(name):\(n + 1): the hand is set in Clickable.swift alone")
            }
        }
    }

    /// The statement opened at `start`: the lines up to where its brackets close, then the modifier lines that follow it.
    static func statement(_ lines: [String], from start: Int, at column: String.Index) -> String {
        var depth = 0, text = "", k = start, closed = false
        while k < lines.count {
            let line = k == start ? String(lines[k][column...]) : lines[k]
            if closed, !line.trimmingCharacters(in: .whitespaces).hasPrefix(".") { break }
            text += line + "\n"
            if !closed {
                for c in line {
                    if "({[".contains(c) { depth += 1 } else if ")}]".contains(c) { depth -= 1 }
                }
                closed = depth <= 0
            }
            k += 1
        }
        return text
    }

    func testEveryMenuPickerAndToggleCarriesTheHand() throws {
        var seen = 0
        for (name, lines) in try screens() {
            for (n, line) in lines.enumerated() {
                // A control's name standing alone (not `contextMenu {` or `showsBotPicker(`); `Menu("…")` is a submenu inside a menu, drawn by the system.
                guard let range = line.range(of: #"(?<![A-Za-z0-9_.])(Menu \{|Picker\(|Toggle\()"#, options: .regularExpression) else { continue }
                seen += 1
                XCTAssertTrue(Self.statement(lines, from: n, at: range.lowerBound).contains(".clickable("), "\(name):\(n + 1): \(line[range]) without .clickable(...)")
            }
        }
        XCTAssertGreaterThan(seen, 8, "the controls are found")
    }

    func testTheStatementReachesTheModifiersAfterTheBrackets() {
        let lines = ["Menu {", "    Button(\"A\") {}", "} label: { Text(\"x\") }", "    .menuStyle(.button)", "    .clickable()", "next()"]
        let text = Self.statement(lines, from: 0, at: lines[0].startIndex)
        XCTAssertTrue(text.contains(".clickable()"))
        XCTAssertFalse(text.contains("next()"))
    }
}
