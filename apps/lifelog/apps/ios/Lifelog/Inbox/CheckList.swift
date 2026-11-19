import LifeConnector
import SwiftUI

/// The asks as a list, in the order he meets them: a line icon for who or what asks, the question, one line of context,
/// and a running deadline as its words at the right in `flag` (no dot: a dot means an ask waits, and every row here
/// does). What can wait sits under its own heading. The chosen row is the ask on show. The Inbox's sidebar on the iPhone
/// Duo, its own screen on a phone.
struct CheckList: View {
    let order: InboxOrder
    /// The ref of the ask on show.
    let chosen: String?
    let choose: (String) -> Void

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(Array(order.checks.enumerated()), id: \.element.ref) { at, check in
                    if at == order.canWaitFrom {
                        Text("The rest can wait").font(.small).foregroundStyle(Palette.muted)
                            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 6)
                            .accessibilityAddTraits(.isHeader)
                    }
                    row(check)
                }
            }
            .padding(.bottom, 24).readingWidth()
        }
        .motion(Motion.standard, value: order.checks.map(\.ref))
    }

    private func row(_ check: Check) -> some View {
        let isChosen = check.ref == chosen
        return Button {
            choose(check.ref)
        } label: {
            Row(
                title: check.question, icon: symbol(of: check), iconTint: isAgent(check) ? Palette.ai : Palette.icon,
                detail: check.listLine()
            ) {
                if let deadline = check.deadline {
                    Text(DeadlineWords.when(deadline)).font(.small).foregroundStyle(Palette.flag)
                        .accessibilityLabel(DeadlineWords.spoken(deadline))
                }
            }
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            .background(isChosen ? Palette.card : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
            .padding(.horizontal, 8)
            .motion(Motion.standard, value: isChosen)
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.plain)
        .appears()
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }

    /// An agent asks (a star in `ai`), or Life asks about its own reading.
    private func isAgent(_ check: Check) -> Bool { check.group == .decision && check.agentName(runtime: nil) != nil }

    private func symbol(of check: Check) -> String {
        switch check.group {
        case .decision: isAgent(check) ? "sparkle" : "questionmark.circle"
        case .voice: "waveform"
        case .name: "text.quote"
        case .guessedPerson: "person"
        case .contactsCard: "person.crop.rectangle"
        case .ending: "checkmark"
        case .newMatter: "plus"
        case .unknown: "circle"
        }
    }
}
