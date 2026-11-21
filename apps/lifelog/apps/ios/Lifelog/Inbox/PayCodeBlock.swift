import LifeConnector
import SwiftUI

/// A payee's QR as the card's hero (`Check.payCode`): the code on white, then what the bank app will show (the amount,
/// the name), the invoice's amount in `flag` when the code asks another, and where it came from.
struct PayCodeBlock: View {
    let code: PayCode
    /// He saved it to Photos from this card: a check on the tile's corner.
    let isSaved: Bool

    var body: some View {
        VStack(spacing: Metrics.Spacing.xs / 2) {
            QRTile(payload: code.payload, isSaved: isSaved).padding(.bottom, Metrics.Spacing.m)
            if let amount = code.amount {
                Text(amount).font(.tileFigure).foregroundStyle(Palette.fg)
            }
            if let payee = code.payee {
                Text(payee).font(.note).foregroundStyle(Palette.muted)
            }
            if let invoice = code.invoiceAmount {
                Text("The invoice says \(invoice)").font(.small).foregroundStyle(Palette.flag).padding(
                    .top, Metrics.Spacing.xs)
            }
            Text("From \(code.source)").font(.small).foregroundStyle(Palette.muted).padding(.top, Metrics.Spacing.s)
        }
        .multilineTextAlignment(.center)
        .frame(maxWidth: .infinity)
        .motion(Motion.standard, value: isSaved)
    }
}
