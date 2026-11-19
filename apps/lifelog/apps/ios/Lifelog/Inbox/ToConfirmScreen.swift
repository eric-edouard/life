import LifeConnector
import SwiftUI

/// Life's own questions (who someone is, whose voice, whether a thing is done), in one list he opens when he likes: no
/// badge, no push, nothing waits on it. A row with two plain answers is answered on the row, with four seconds to undo it;
/// a tap on the row opens the whole ask.
struct ToConfirmScreen: View {
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router

    var body: some View {
        ReadScreen(
            shown: life.toConfirm.shown(isEmpty: { $0.checks.isEmpty }), retry: { await life.refreshToConfirm() },
            loading: { ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity) },
            empty: { Notice(title: "Nothing to confirm.", detail: "Life asks here when it is unsure.") },
            content: { list in groups(list.checks) }
        )
        .background(Palette.bg)
        .navigationTitle("To confirm")
        .navigationBarTitleDisplayMode(.inline)
        .task { await life.refreshToConfirm() }
        // The ask he opens, or the screen he leaves, sends what is still held.
        .onDisappear { life.sendHeld() }
    }

    /// The kinds, in the order the spec draws them; a kind with no row has no group.
    private static let kinds: [(label: String, groups: [CheckGroup])] = [
        ("People", [.name, .guessedPerson, .contactsCard]), ("Voices", [.voice]), ("Done", [.ending]),
    ]

    private func groups(_ checks: [Check]) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ForEach(Self.kinds, id: \.label) { kind in
                    RowGroup(label: kind.label) {
                        ForEach(checks.filter { kind.groups.contains($0.group) }) { check in line(check) }
                    }
                }
            }
            .padding(.horizontal, Metrics.gutter).padding(.top, Metrics.Spacing.xs * 2).padding(
                .bottom, Metrics.Spacing.xs * 6
            ).readingWidth()
            .motion(Motion.standard, value: checks.map(\.ref))
            .motion(Motion.standard, value: life.held)
        }
        .scrollEdgeEffectStyle(.soft, for: .bottom)
    }

    @ViewBuilder private func line(_ check: Check) -> some View {
        ConfirmRow(check: check, open: { router.inboxPath.append(.ask(check.ref)) }) { option in
            if let request = check.answer(option) { life.hold(request, as: option.label) }
        }
        .transition(.opacity)
    }
}

/// An ask opened from "To confirm": back to the list once its result is read.
struct ToConfirmAsk: View {
    let ref: String
    @Environment(LifeStore.self) private var life
    @Environment(AppRouter.self) private var router
    @State private var notes = AskNotes()

    var body: some View {
        AskPage(ref: ref, source: life.toConfirm.value?.checks ?? [], notes: $notes) {
            life.forget(.answer(ref: ref))
            router.inboxPath.removeAll { $0 == .ask(ref) }
        }
    }
}
