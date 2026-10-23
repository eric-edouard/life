import SwiftUI

/// Today's spend over this month's transcription, or why there is no figure yet.
struct SpendingFigure: View {
    let spending: TranscriptionFacts.Spending?
    let isPaired: Bool

    var body: some View {
        if let spending {
            TileFigure(
                value: Text(Spend.usd(spending.today)),
                caption: "\(Spend.usd(spending.monthTranscription)) transcription this month")
        } else {
            TileFigure(value: Text("—"), caption: isPaired ? "Waiting for the server" : "Not paired")
        }
    }
}
