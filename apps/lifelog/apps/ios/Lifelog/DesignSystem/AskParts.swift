import CoreImage.CIFilterBuiltins
import LifeConnector
import SwiftUI

// The parts an ask is drawn from beyond its answers (owner's lab picks, 26 Nov 2026): Life's sentence, a quote, people
// as chips, a box of rows, the payee's QR, an event's slot, a paid run's estimate, a plan as a sentence. Each is a pure
// view; `AskBody` picks them from the card's kind.

/// A sentence of Life's, `**bold**` honoured.
struct AskSentence: View {
    let markdown: String
    var isMuted = false

    var body: some View {
        Text((try? AttributedString(markdown: markdown)) ?? AttributedString(markdown))
            .font(.body15).foregroundStyle(isMuted ? Palette.muted : Palette.fg)
            .multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What a tap on a pill leads to, one muted line ("Yes: I list her under Fernway.").
struct AskFoot: View {
    let text: String
    var body: some View {
        Text(text).font(.line).foregroundStyle(Palette.muted).frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Someone's words, quoted, with who and when under them.
struct AskQuote: View {
    let text: String
    var source: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text("“\(text)”").font(.body15)
            if let source { Text(source).font(.meta).foregroundStyle(Palette.faint) }
        }
        .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

/// The people a voice or a card may be, as chips with their faces; a tap names one.
struct PersonChips: View {
    let people: [Party]
    var pick: (Party) -> Void = { _ in }

    var body: some View {
        FlowLayout(spacing: Metrics.Spacing.s) {
            ForEach(people, id: \.ref) { party in
                Button {
                    pick(party)
                } label: {
                    HStack(spacing: Metrics.Spacing.s) {
                        Face(party: party, size: 24)
                        Text(party.isOwner ? "It’s me" : party.name).font(.lineStrong).lineLimit(1)
                    }
                    .padding(.vertical, Metrics.Spacing.xs).padding(.leading, Metrics.Spacing.xs)
                    .padding(.trailing, Metrics.Spacing.m)
                    .background(Palette.tint, in: .capsule)
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// The people an answer may be, side by side (the prototype's `.xfaces`): a face, the name, their line; a tap answers.
struct PersonCards: View {
    let people: [Party]
    var pick: (Party) -> Void = { _ in }

    var body: some View {
        HStack(spacing: Metrics.Spacing.s + 2) {
            ForEach(people, id: \.ref) { party in
                Button {
                    pick(party)
                } label: {
                    VStack(spacing: Metrics.Spacing.xs + 2) {
                        Face(party: party)
                        // Wraps rather than cuts a name (a narrow card, larger text).
                        Text(party.name).font(.bodyBold).multilineTextAlignment(.center)
                        if let line = party.line {
                            Text(line).font(.meta).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Metrics.Spacing.m).padding(.horizontal, Metrics.Spacing.xs + 2)
                    .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

/// A box of rows: a glyph, a fact, a copy or open mark when it has one.
struct NeedRows: View {
    let rows: [NeedRow]

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                HStack(spacing: Metrics.Spacing.m) {
                    Image(systemName: symbol(row.glyph)).font(.line).foregroundStyle(Palette.muted)
                        .frame(width: 20).accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(row.text).font(row.isFigure ? .monoTime : .body15)
                        if let detail = row.detail { Text(detail).font(.meta).foregroundStyle(Palette.muted) }
                    }
                    Spacer(minLength: 0)
                    switch row.action {
                    case .copy(let text, let label)?:
                        Button {
                            UIPasteboard.general.string = text
                        } label: {
                            Image(systemName: "doc.on.doc").font(.line).foregroundStyle(Palette.muted)
                                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
                        }
                        .buttonStyle(.plain).accessibilityLabel(label)
                    case .open(let url, let label)?:
                        Link(destination: url) {
                            Glyph(.open, size: 16).foregroundStyle(Palette.muted)
                                .frame(width: Metrics.tapTarget, height: Metrics.tapTarget)
                        }
                        .accessibilityLabel(label)
                    case nil: EmptyView()
                    }
                }
            }
        }
        .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.s).frame(
            maxWidth: .infinity, alignment: .leading
        )
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }

    private func symbol(_ glyph: NeedRow.Glyph) -> String {
        switch glyph {
        case .bank: "building.columns"
        case .card: "creditcard"
        case .person: "person"
        case .amount: "eurosign"
        case .link: "link"
        case .note: "text.alignleft"
        }
    }
}

/// The amount to pay, large (the original prototype's payment box).
struct AmountBox: View {
    let text: String

    var body: some View {
        // "240 EUR": the number large, its currency small beside it.
        let parts = text.split(separator: " ", maxSplits: 1).map(String.init)
        HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.xs) {
            Text(parts.first ?? text).font(.profileName)
            if parts.count > 1 { Text(parts[1]).font(.line).foregroundStyle(Palette.muted) }
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

/// The payee's QR the phone draws: the code large on white, the amount, and where it came from.
struct PayCodeBox: View {
    let code: PayCode

    var body: some View {
        VStack(spacing: Metrics.Spacing.m) {
            QRImage(text: code.payload).frame(width: 168, height: 168).accessibilityLabel("Payment code")
            if let figure = code.figure {
                HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.xs) {
                    Text(figure.number).font(.profileName)
                    if let currency = figure.currency { Text(currency).font(.line).foregroundStyle(Palette.muted) }
                }
            }
            if let payee = code.payee { Text(payee).font(.line).foregroundStyle(Palette.muted) }
            Text(code.source).font(.meta).foregroundStyle(Palette.faint)
            if let invoice = code.invoiceAmount {
                Text("Its invoice says \(invoice)").font(.line).foregroundStyle(Palette.flag)
            }
        }
        .padding(Metrics.Spacing.l).frame(maxWidth: .infinity)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

struct QRImage: View {
    let text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(decorative: image, scale: 1).interpolation(.none).resizable().scaledToFit()
                .padding(Metrics.Spacing.s).background(Palette.qrPaper, in: .rect(cornerRadius: Metrics.Radius.control))
        }
    }

    private static func render(_ text: String) -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        guard let output = filter.outputImage?.transformed(by: .init(scaleX: 8, y: 8)) else { return nil }
        return CIContext().createCGImage(output, from: output.extent)
    }
}

/// An event as its slot: the title and when, where, and its reminders as pills.
struct EventBox: View {
    let rows: [NeedRow]

    var body: some View {
        // The need's rows: its title and time, its place, then "Reminders: 1 h before, at 17:30".
        let reminders =
            rows.first { $0.text.hasPrefix("Reminders: ") }
            .map { $0.text.dropFirst("Reminders: ".count).components(separatedBy: ", ") } ?? []
        // Every fact once: a line another line already says (the place in the time line) is not drawn again, and the
        // title carries no raw date.
        let lines = rows.filter { !$0.text.hasPrefix("Reminders: ") }
        let rest = lines.enumerated().filter { i, row in !lines[..<i].contains { $0.text.contains(row.text) } }
            .map { i, row in i == 0 ? NeedRow(glyph: row.glyph, text: row.text.withoutRawDate) : row }
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            ForEach(Array(rest.enumerated()), id: \.offset) { index, row in
                Text(row.text).font(index == 0 ? .rowTitle : .line).foregroundStyle(
                    index == 0 ? Palette.fg : Palette.muted)
            }
            if !reminders.isEmpty {
                FlowLayout(spacing: Metrics.Spacing.s) {
                    ForEach(reminders, id: \.self) { lead in
                        Label(lead, systemImage: "bell").font(.meta).foregroundStyle(Palette.muted)
                            .padding(.horizontal, Metrics.Spacing.m).padding(.vertical, Metrics.Spacing.xs)
                            .background(Palette.tint, in: .capsule)
                    }
                }
            }
        }
        .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

/// A paid run's estimate and its cap, as Life words them.
struct SpendLine: View {
    let line: String

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            Image(systemName: "magnifyingglass").font(.line).foregroundStyle(Palette.muted).accessibilityHidden(true)
            Text(line).font(.body15)
        }
        .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.block))
    }
}

/// A plan as one sentence: Life's steps in the first person, his own named as his (owner's pick: planned steps C v2).
struct PlanSentence: View {
    let steps: [Check.PlanStep]

    var body: some View {
        AskSentence(markdown: steps.map(sentence).joined(separator: " "))
    }

    private func sentence(_ step: Check.PlanStep) -> String {
        let text = step.text.prefix(1).lowercased() + step.text.dropFirst()
        let when = step.when.map { ", \($0)" } ?? ""
        return step.by == .owner ? "Your part: \(text)\(when)." : "I \(text)\(when)."
    }
}
