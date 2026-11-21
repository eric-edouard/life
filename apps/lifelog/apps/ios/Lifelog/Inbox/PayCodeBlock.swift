import LifeConnector
import SwiftUI

/// The payment card (decision 98), one card: the amount large with its currency small, "to <payee>", the payee's QR on
/// white, the invoice's amount in `flag` when the code asks another, and where the code came from.
struct PayCodeBlock: View {
    let code: PayCode
    /// He saved it to Photos from this card: a check on the tile's corner.
    let isSaved: Bool
    /// The message holding the code, opened in a sheet when Life gave its ref.
    @State private var opened: LifeLinkTarget?

    var body: some View {
        VStack(spacing: Metrics.Spacing.xs) {
            if let figure = code.figure {
                HStack(alignment: .firstTextBaseline, spacing: Metrics.Spacing.xs) {
                    Text(figure.number).font(.tileFigure).foregroundStyle(Palette.fg)
                    if let currency = figure.currency { Text(currency).font(.small).foregroundStyle(Palette.muted) }
                }
                .accessibilityElement(children: .combine)
            }
            if let payee = code.payee {
                Text("to \(payee)").font(.bodyStrong).foregroundStyle(Palette.fg)
            }
            if let invoice = code.invoiceAmount {
                Text("The invoice says \(invoice)").font(.small).foregroundStyle(Palette.flag)
            }
            QRTile(payload: code.payload, isSaved: isSaved).padding(.vertical, Metrics.Spacing.m)
            if let ref = code.ref {
                QuietChip("From \(code.source)", symbol: "bubble") {
                    opened = LifeLinkTarget(ref: ref, words: code.source, kind: .message)
                }
            } else {
                Text("From \(code.source)").font(.small).foregroundStyle(Palette.muted)
            }
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .motion(Motion.standard, value: isSaved)
        .sheet(item: $opened) { target in
            NavigationStack { LifeLinkPage(target: target, isPushed: false) { opened = nil } }
                .presentationDetents([.medium, .large])
        }
    }
}
