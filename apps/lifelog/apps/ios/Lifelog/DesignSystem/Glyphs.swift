import SwiftUI

/// The prototype's own marks (`docs/design/2026-11-23-chat-first/2026-11-25-app-v4.html`), drawn from its SVG paths on a 24 grid:
/// the one place they live. A mark is stroked in the surrounding foreground style, `weight` as the prototype strokes it.
struct Glyph: View {
    enum Mark {
        case search, mic, send, close, fold, offline, mac, open, tick, bubble, calendar, pin, doc, person, undo, back,
            stop, clock, card, wave, life, bank

        fileprivate var path: (d: String, weight: CGFloat) {
            switch self {
            case .search: ("M16.5 16.5 21 21M17 11a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z", 1.8)
            case .mic: ("M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3ZM19 10v2a7 7 0 0 1-14 0v-2M12 19v3", 1.6)
            case .send: ("m6 14 6-6 6 6M12 8v10", 2)
            case .close: ("M6 6l12 12M18 6 6 18", 2)
            case .fold: ("m6 15 6-6 6 6", 2)
            case .offline:
                ("M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0M12 19h0M3 3l18 18", 1.8)
            case .mac:
                ("M5 4.5h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2ZM8 20h8M12 16.5V20", 1.8)
            case .open: ("M8 16 16 8M9.5 8H16v6.5", 1.8)
            case .tick: ("m5 12.5 4.5 4.5L19 7.5", 2.2)
            case .bubble: ("M4 5.5h16v10H9l-5 4z", 1.8)
            case .calendar:
                (
                    "M6.5 5.5h11a2.5 2.5 0 0 1 2.5 2.5v9a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 17V8a2.5 2.5 0 0 1 2.5-2.5ZM4 10h16M8.5 3.5v4M15.5 3.5v4",
                    1.8
                )
            case .pin:
                (
                    "M12 21C12 21 5.5 15 5.5 10a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11ZM14.3 10a2.3 2.3 0 1 1-4.6 0 2.3 2.3 0 0 1 4.6 0Z",
                    1.8
                )
            case .doc: ("M7 3h7l5 5v13H7zM14 3v5h5", 1.8)
            case .person: ("M15.5 8a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0ZM5 20a7 7 0 0 1 14 0", 1.8)
            case .clock: ("M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2", 1.8)
            case .undo: ("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11", 2)
            case .back: ("m14.5 5-7 7 7 7", 2.2)
            case .stop: ("M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Z", 0)
            case .card:
                (
                    "M5.5 5.5h13A2.5 2.5 0 0 1 21 8v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16V8a2.5 2.5 0 0 1 2.5-2.5ZM3 10h18M7 15h4",
                    1.8
                )
            case .bank: ("M3 10 12 4l9 6M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 20h18", 1.8)
            case .wave: ("M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2", 1.8)
            // Life's own mark (`assets/brand/life-l.svg`), filled: a fix of Life's.
            case .life:
                (
                    "M3.83 1C3.79 1 3.76 1.07 3.76 1.21C3.76 1.35 3.79 1.42 3.85 1.42C4.47 1.42 4.95 1.48 5.28 1.6C5.6 1.72 5.85 1.95 6.02 2.3C6.19 2.65 6.33 3.17 6.44 3.85L9.32 20.15C9.51 21.16 9.49 21.81 9.25 22.12C9.02 22.43 8.45 22.58 7.55 22.58C7.51 22.58 7.49 22.65 7.49 22.79C7.49 22.93 7.52 23 7.57 23C8.1 23 8.68 22.98 9.33 22.95C9.97 22.91 10.66 22.89 11.4 22.89C12.16 22.89 12.88 22.91 13.57 22.95C14.26 22.98 14.86 23 15.38 23C15.43 23 15.45 22.93 15.45 22.79C15.45 22.65 15.43 22.58 15.38 22.58C14.75 22.58 14.26 22.51 13.94 22.38C13.61 22.25 13.36 22.01 13.2 21.66C13.05 21.31 12.9 20.79 12.77 20.11L9.92 3.99C9.76 3.05 9.76 2.44 9.94 2.16C10.12 1.88 10.53 1.74 11.19 1.74L12.11 1.74C13.84 1.74 15.37 2.17 16.68 3.02C18 3.88 19.18 5.21 20.24 7.02C20.28 7.07 20.37 7.08 20.48 7.05C20.6 7.03 20.65 6.98 20.62 6.91C20.44 6.19 20.22 5.32 19.97 4.32C19.72 3.31 19.53 2.38 19.39 1.53C19.32 1.18 19.13 1 18.81 1Z",
                    0
                )
            }
        }
    }

    let mark: Mark
    var size: CGFloat = 18

    init(_ mark: Mark, size: CGFloat = 18) { (self.mark, self.size) = (mark, size) }

    var body: some View {
        let (d, weight) = mark.path
        let shape = SVGPath(d)
        Group {
            if weight == 0 {
                shape.fill()
            } else {
                shape.stroke(style: StrokeStyle(lineWidth: weight * size / 24, lineCap: .round, lineJoin: .round))
            }
        }
        .frame(width: size, height: size).accessibilityHidden(true)
    }
}

/// An SVG path's `d` on a 24 grid, scaled to the rect it is drawn in: M, L, H, V, C, A and Z, absolute and relative.
private nonisolated struct SVGPath: Shape {
    let d: String
    init(_ d: String) { self.d = d }

    func path(in rect: CGRect) -> Path {
        var path = Path()
        var tokens = Self.tokens(d)[...]
        var (point, start) = (CGPoint.zero, CGPoint.zero)
        var command: Character = "M"
        func number() -> CGFloat { CGFloat(Double(tokens.popFirst() ?? "0") ?? 0) }
        while let next = tokens.first {
            if let letter = next.first, letter.isLetter {
                command = letter
                tokens.removeFirst()
                if "zZ".contains(letter) {
                    path.closeSubpath()
                    point = start
                    continue
                }
            }
            let isRelative = command.isLowercase
            let base = isRelative ? point : .zero
            switch command.lowercased() {
            case "m":
                point = CGPoint(x: base.x + number(), y: base.y + number())
                start = point
                path.move(to: point)
                command = isRelative ? "l" : "L"
            case "l":
                point = CGPoint(x: base.x + number(), y: base.y + number())
                path.addLine(to: point)
            case "h":
                point.x = base.x + number()
                path.addLine(to: point)
            case "v":
                point.y = base.y + number()
                path.addLine(to: point)
            case "c":
                let a = CGPoint(x: base.x + number(), y: base.y + number())
                let b = CGPoint(x: base.x + number(), y: base.y + number())
                point = CGPoint(x: base.x + number(), y: base.y + number())
                path.addCurve(to: point, control1: a, control2: b)
            case "a":
                let (rx, ry, turn) = (number(), number(), number())
                let (large, sweep) = (number() != 0, number() != 0)
                let end = CGPoint(x: base.x + number(), y: base.y + number())
                Self.arc(&path, from: point, to: end, radii: (rx, ry), turn: turn, large: large, sweep: sweep)
                point = end
            default: return path
            }
        }
        return path.applying(CGAffineTransform(scaleX: rect.width / 24, y: rect.height / 24))
            .applying(CGAffineTransform(translationX: rect.minX, y: rect.minY))
    }

    /// "m6 14" and "0 0 0-3 3" split into commands and numbers.
    private static func tokens(_ d: String) -> [String] {
        var out: [String] = []
        var number = ""
        func flush() {
            if !number.isEmpty { out.append(number) }
            number = ""
        }
        for c in d {
            if c.isLetter {
                flush()
                out.append(String(c))
            } else if c == "-" {
                flush()
                number = "-"
            } else if c == " " || c == "," {
                flush()
            } else if c == ".", number.contains(".") {
                flush()
                number = "."
            } else {
                number.append(c)
            }
        }
        flush()
        return out
    }

    /// An SVG arc (endpoint form) as cubic curves of at most a quarter turn each (SVG implementation notes, F.6.5).
    private static func arc(
        _ path: inout Path, from p: CGPoint, to q: CGPoint, radii: (CGFloat, CGFloat), turn: CGFloat, large: Bool,
        sweep: Bool
    ) {
        guard p != q, radii.0 != 0, radii.1 != 0 else { return path.addLine(to: q) }
        var (rx, ry) = (abs(radii.0), abs(radii.1))
        let phi = turn * .pi / 180
        let (cosP, sinP) = (cos(phi), sin(phi))
        let (dx, dy) = ((p.x - q.x) / 2, (p.y - q.y) / 2)
        let (x1, y1) = (cosP * dx + sinP * dy, -sinP * dx + cosP * dy)
        let grow = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
        if grow > 1 { (rx, ry) = (rx * grow.squareRoot(), ry * grow.squareRoot()) }
        let top = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
        let scale = (large == sweep ? -1 : 1) * max(0, top / (rx * rx * y1 * y1 + ry * ry * x1 * x1)).squareRoot()
        let (cx1, cy1) = (scale * rx * y1 / ry, -scale * ry * x1 / rx)
        let (cx, cy) = (cosP * cx1 - sinP * cy1 + (p.x + q.x) / 2, sinP * cx1 + cosP * cy1 + (p.y + q.y) / 2)
        let start = atan2((y1 - cy1) / ry, (x1 - cx1) / rx)
        var sweepBy = atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx) - start
        if sweep, sweepBy < 0 { sweepBy += 2 * .pi } else if !sweep, sweepBy > 0 { sweepBy -= 2 * .pi }
        let pieces = Int((abs(sweepBy) / (.pi / 2)).rounded(.up))
        let step = sweepBy / CGFloat(pieces)
        let k = 4 / 3 * tan(step / 4)
        func at(_ a: CGFloat) -> (CGPoint, CGPoint) {
            let (c, s) = (cos(a), sin(a))
            let point = CGPoint(x: cx + rx * c * cosP - ry * s * sinP, y: cy + rx * c * sinP + ry * s * cosP)
            let slope = CGPoint(x: -rx * s * cosP - ry * c * sinP, y: -rx * s * sinP + ry * c * cosP)
            return (point, slope)
        }
        for i in 0..<pieces {
            let (a, b) = (start + step * CGFloat(i), start + step * CGFloat(i + 1))
            let ((p0, d0), (p1, d1)) = (at(a), at(b))
            path.addCurve(
                to: p1, control1: CGPoint(x: p0.x + k * d0.x, y: p0.y + k * d0.y),
                control2: CGPoint(x: p1.x - k * d1.x, y: p1.y - k * d1.y))
        }
    }
}
