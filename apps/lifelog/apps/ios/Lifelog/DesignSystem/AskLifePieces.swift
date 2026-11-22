import SwiftUI

/// Life's voice mark: five rounded bars, the middle tallest. `isLive` moves them (his voice).
struct AskLifeMark: View {
    var size: CGFloat = 24
    var color = Palette.ai
    var isLive = false

    private static let heights: [CGFloat] = [0.4, 0.7, 1, 0.7, 0.4]

    var body: some View {
        HStack(spacing: size / 8) {
            ForEach(Self.heights.indices, id: \.self) { bar in
                Capsule().fill(color).frame(width: size / 8, height: size * Self.heights[bar])
                    .phaseAnimator([1, 0.5], trigger: isLive) { view, phase in
                        view.scaleEffect(y: isLive ? (bar.isMultiple(of: 2) ? phase : 1.5 - phase) : 1)
                    } animation: { _ in
                        .easeInOut(duration: 0.4)
                    }
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The line of light (the lit look): the stage's one drawing, which changes between states and never cuts. Ready: a
/// breathing hairline. Thinking: drawn into one dot, two rings leaving it. Answer: a short bar over the words. Error:
/// broken in `flag`. Offline: dots.
struct AskLifeLightLine: View {
    enum Kind { case ready, point, answer, broken, waiting }
    let kind: Kind

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @AppStorage(AskLifeLook.key) private var look = AskLifeLook.lit

    var body: some View {
        // The Grotesk look has no line: the words stand alone.
        if look == .lit { line }
    }

    private var line: some View {
        ZStack {
            switch kind {
            case .ready:
                hairline.phaseAnimator([0.45, 1]) {
                    $0.opacity(reduceMotion ? 1 : $1)
                } animation: { _ in
                    .easeInOut(duration: 1.6)
                }
            case .point: point
            case .answer:
                Capsule().fill(Palette.ai).frame(width: 36, height: 3).shadow(color: Palette.ai.opacity(0.6), radius: 8)
            case .broken:
                HStack(spacing: Metrics.Spacing.m) {
                    Capsule().fill(Palette.flag).frame(width: 90, height: 2)
                    Capsule().fill(Palette.flag).frame(width: 60, height: 2).offset(y: 3)
                }
            case .waiting:
                HStack(spacing: Metrics.Spacing.s) {
                    ForEach(0..<9, id: \.self) { _ in Circle().fill(Palette.muted).frame(width: 3, height: 3) }
                }
            }
        }
        .frame(height: 40)
        .motion(Motion.standard, value: kind)
        .accessibilityHidden(true)
    }

    /// Fading at its ends, with a soft bloom under it.
    private var hairline: some View {
        LinearGradient(colors: [.clear, Palette.ai, .clear], startPoint: .leading, endPoint: .trailing)
            .frame(height: 2).shadow(color: Palette.ai.opacity(0.5), radius: 10, y: 4)
    }

    private var point: some View {
        ZStack {
            Circle().fill(Palette.ai).frame(width: 8, height: 8).shadow(color: Palette.ai, radius: 8)
            if !reduceMotion {
                ForEach(0..<2, id: \.self) { ring in
                    Circle().stroke(Palette.ai.opacity(0.5), lineWidth: 1).frame(width: 8, height: 8)
                        .phaseAnimator([1, 6]) { view, scale in
                            view.scaleEffect(scale).opacity(scale == 1 ? 0.8 : 0)
                        } animation: { _ in
                            .easeOut(duration: 1.6).delay(Double(ring) * 0.5)
                        }
                }
            }
        }
    }
}

/// One piece of work: what it is above a hairline, a short run of `ai` moving along it while it runs; done, the
/// hairline full and still with a check.
struct AskLifeStrandRow: View {
    let title: String
    let isDone: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            HStack(spacing: Metrics.Spacing.s) {
                Text(title).font(.small).foregroundStyle(isDone ? Palette.muted : Palette.fg).lineLimit(1)
                if isDone { Image(systemName: "checkmark").font(.chip).foregroundStyle(Palette.ok) }
            }
            ZStack(alignment: .leading) {
                Capsule().fill(Color.fillTint)
                if isDone { Capsule().fill(Palette.ok.opacity(0.6)) } else { run }
            }
            .frame(height: 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityValue(isDone ? "done" : "working")
    }

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var run: some View {
        GeometryReader { proxy in
            Capsule().fill(Palette.ai).frame(width: proxy.size.width * 0.25)
                .phaseAnimator([0, 0.75]) { view, at in
                    view.offset(x: reduceMotion ? 0 : proxy.size.width * at)
                } animation: { _ in
                    .easeInOut(duration: 1.2)
                }
        }
    }
}

/// The Ask Life button: a round glass disc with Life's voice mark, always at the bottom right corner of the root, in every pose
/// (52 on the phone and open upright, 48 in the Duo's side column). It sinks under his thumb; a tap opens Ask Life.
struct AskLifeButton: View {
    @Environment(AppRouter.self) private var router
    /// Pieces of work running, shown as a ring in `ai` and their count.
    var running = 0
    var size: CGFloat = 52

    var body: some View {
        Button {
            withAnimation(Motion.standard) { router.isAskOpen = true }
        } label: {
            AskLifeMark(size: 22).frame(width: size, height: size)
                .overlay { if running > 0 { Circle().stroke(Palette.ai, lineWidth: 2) } }
                .overlay(alignment: .topTrailing) {
                    if running > 0 { Text("\(running)").font(.chip).foregroundStyle(Palette.ai).padding(4) }
                }
        }
        .buttonStyle(SinkStyle())
        .floatingGlass(in: Circle())
        .sensoryFeedback(.impact(weight: .medium), trigger: router.isAskOpen) { _, new in new }
        .accessibilityLabel("Ask Life")
        .accessibilityIdentifier("tell.life")
    }
}

/// Sinks a little under the thumb.
private struct SinkStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label.scaleEffect(configuration.isPressed && !reduceMotion ? 0.92 : 1)
            .animation(.spring(duration: 0.2), value: configuration.isPressed)
    }
}

/// What he said, waiting for the Mac: the mark and "Your words · waiting", in a quiet capsule.
struct AskLifeWaitingPill: View {
    let words: String

    var body: some View {
        HStack(spacing: Metrics.Spacing.s) {
            AskLifeMark(size: 16, color: Palette.muted)
            Text("Your words · waiting").font(.small)
        }
        .foregroundStyle(Palette.muted).padding(.horizontal, Metrics.Spacing.m).frame(height: 32)
        .background(Color.fillTint, in: .capsule)
        .accessibilityLabel("Your words are waiting: \(words)")
    }
}

/// The room Ask Life stands in: the page with a faint `ai` glow behind the stage.
struct AskLifeRoom: View {
    var body: some View {
        ZStack {
            Palette.bg
            RadialGradient(colors: [Palette.ai.opacity(0.12), .clear], center: .center, startRadius: 0, endRadius: 280)
        }
        .ignoresSafeArea()
    }
}

extension View {
    /// The composer: his words, the microphone and Send in one glass capsule (the Claude app's bar, his reference of 22
    /// Nov), the keys 4 in from its end. Ask Life's banner is the same.
    func askLifeComposer() -> some View {
        padding(.leading, Metrics.Spacing.l).padding(.trailing, Metrics.Spacing.xs).padding(
            .vertical, Metrics.Spacing.xs
        )
        .floatingGlass(in: .rect(cornerRadius: 28))
    }
}

/// An answer's words: Grotesk, large; in the Grotesk look their key words (marked `**`) are bold.
struct AskLifeHead: View {
    let words: String
    @AppStorage(AskLifeLook.key) private var look = AskLifeLook.lit

    var body: some View {
        Group {
            if look == .grotesk { bolded } else { Text(words.withoutMarks) }
        }
        .font(.askLifeAnswer).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
    }

    /// Only the `**` marks are read: words are data, never Markdown (no links).
    private var bolded: Text {
        var out = AttributedString()
        for (index, part) in words.components(separatedBy: "**").enumerated() {
            var run = AttributedString(part)
            if !index.isMultiple(of: 2) { run.inlinePresentationIntent = .stronglyEmphasized }
            out += run
        }
        return Text(out)
    }
}

/// A quiet line under the words.
struct AskLifeNote: View {
    let words: String

    var body: some View { Text(words).font(.note).foregroundStyle(Palette.muted) }
}

/// Ask Life made small: one line over the rail, the present answer or the work, tap to open, a cross to put it away.
struct AskLifeStrip: View {
    let line: String
    let open: () -> Void
    let close: () -> Void

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Button(action: open) {
                HStack(spacing: Metrics.Spacing.s) {
                    AskLifeMark(size: 16)
                    Text(line.withoutMarks).font(.small).foregroundStyle(Palette.fg).lineLimit(1)
                    Spacer(minLength: 0)
                }
            }
            .buttonStyle(.plain)
            Button(role: .close, action: close) {
                Image(systemName: "xmark").font(.chip).foregroundStyle(Palette.muted).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain).accessibilityLabel("Put away")
        }
        .padding(.horizontal, Metrics.Spacing.l).frame(height: 48)
        .floatingGlass(in: Capsule())
        // Above the rail.
        .padding(.horizontal, Metrics.gutter).padding(.bottom, 84)
        .accessibilityIdentifier("tell.strip")
    }
}

/// Makes Ask Life small: the chevron, where the cross is on the other side.
struct AskLifeSmallButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "chevron.down").font(.system(size: 17, weight: .light)).foregroundStyle(Palette.fg)
                .frame(width: 44, height: 44).background(Palette.tile, in: .circle)
        }
        .buttonStyle(.plain).accessibilityLabel("Make small").accessibilityIdentifier("tell.small")
    }
}
