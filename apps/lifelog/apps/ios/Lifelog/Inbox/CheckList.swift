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
    @Environment(LifeStore.self) private var life

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                // Two cards: what waits on him, then the rest.
                let split = min(order.canWaitFrom ?? order.checks.count, order.checks.count)
                ForEach(Array(order.checks.enumerated()), id: \.element.ref) { at, check in
                    if at == split {
                        ListLabel("The rest can wait")
                    }
                    let isRest = at >= split
                    row(check, at: isRest ? at - split : at, of: isRest ? order.checks.count - split : split)
                }
            }
            .padding(.bottom, 24).readingWidth()
        }
        .motion(Motion.standard, value: order.checks.map(\.ref))
    }

    private func row(_ check: Check, at index: Int, of count: Int) -> some View {
        let isChosen = check.ref == chosen
        return Button {
            choose(check.ref)
        } label: {
            Row(
                title: check.question, icon: symbol(of: check),
                detail: check.beingFixed == nil ? check.listLine() : "Being fixed", isInList: true
            ) {
                // The caretaker is at work on it: it no longer waits on him, so no deadline.
                if check.beingFixed != nil {
                    StateGlyph.busy
                } else if let deadline = check.deadline {
                    Text(DeadlineWords.when(deadline)).font(.small).foregroundStyle(Palette.flag)
                        .accessibilityLabel(DeadlineWords.spoken(deadline))
                }
            }
            .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
            .accessibilityElement(children: .combine)
        }
        .buttonStyle(.groupedRow(at: index, of: count, isChosen: isChosen))
        .appears()
    }

    /// An agent asks (its program's mark), or Life asks about its own reading (the kind's icon).
    private func symbol(of check: Check) -> String {
        check.agentMark(runtime: life.runtimeName(of: check)) ?? check.group.symbol
    }
}

extension CheckGroup {
    /// The line icon of a kind, in the rows and in the filter's menu.
    var symbol: String {
        switch self {
        case .decision: "questionmark.circle"
        case .voice: "waveform"
        case .name: "text.quote"
        case .guessedPerson: "person"
        case .contactsCard: "person.crop.rectangle"
        case .samePerson: "person.2"
        case .ending: "checkmark"
        case .newMatter: "plus"
        case .unknown: "circle"
        }
    }

    /// The kind's name in the filter's menu.
    var filterName: String {
        switch self {
        case .decision: "Decisions"
        case .voice: "Voices"
        case .name: "Names"
        case .guessedPerson: "People"
        case .contactsCard: "Contacts"
        case .samePerson: "Same person?"
        case .ending: "Is this done?"
        case .newMatter: "New matters"
        case .unknown: "Other"
        }
    }
}

/// The list's Filter: Everything and the kinds that wait, one row each.
extension View {
    func askFilterBar(kinds: [CheckGroup], kind: Binding<CheckGroup?>) -> some View {
        filterBar(isFiltered: kind.wrappedValue != nil, identifier: "inbox.filter", isResting: kinds.count < 2) {
            Picker("Show", selection: kind) {
                Label("Everything", systemImage: "list.bullet").tag(CheckGroup?.none)
                ForEach(kinds, id: \.self) { kind in
                    Label(kind.filterName, systemImage: kind.symbol).tag(CheckGroup?.some(kind))
                }
            }
            .pickerStyle(.inline)
        }
    }
}
