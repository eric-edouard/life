import LifeConnector
import SwiftUI

/// The create sheet (`PersonCreate`, `OrgCreate`): who a name card's name is, ready to create in one press. Person or
/// Organization when the card offers both (switching keeps the name), the fields pre-filled and changed in place, what
/// will be attached, then Create, whose button says what the answer does: Creating…, Created (held 0.6 s, then `done`),
/// or back at rest with Life's reason above it. Life's guess of who they are is never sent as his words: a note goes
/// only when he wrote it.
struct CreateSheet: View {
    let check: Check
    let done: (AnswerRequest) -> Void

    private enum Kind: Hashable { case person, organization }

    @Environment(LifeStore.self) private var life
    @Environment(\.dismiss) private var dismiss
    @State private var kind = Kind.person
    @State private var name: String
    @State private var who: String
    @State private var what = ""
    /// His press, once made: the button shows its answer's state from then on, never an earlier one's.
    @State private var sent: AnswerRequest?
    @State private var fieldsHeight: CGFloat = 0

    init(check: Check, name: String, done: @escaping (AnswerRequest) -> Void) {
        (self.check, self.done) = (check, done)
        _name = State(initialValue: name)
        _who = State(initialValue: Self.guessOf(check))
    }

    /// Life's guess of who they are, from where the name was said: "Mentioned by Nora, about her quote".
    private static func guessOf(_ check: Check) -> String {
        let by = check.said?.by.flatMap { $0 == "You" ? nil : " by \($0)" } ?? ""
        let about = check.onMatters?.first.map { " about \($0.name)" } ?? ""
        return by.isEmpty && about.isEmpty ? "" : "Mentioned" + by + (by.isEmpty || about.isEmpty ? "" : ",") + about
    }

    private var isGuess: Bool { !who.isEmpty && who == Self.guessOf(check) }
    private var isOrganization: Bool { kind == .organization }
    private var state: ActionState<ActionProof> { sent == nil ? .idle : life.state(of: .answer(ref: check.ref)) }
    private var isDone: Bool { if case .succeeded = state { true } else { false } }
    private var isFailed: Bool { if case .failed = state { true } else { false } }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.l) {
            SheetHeader(title: isOrganization ? "New organization" : "New person") { dismiss() }
            if check.organizationOption != nil {
                SegmentedChoice(
                    choices: [Kind.person, .organization],
                    selection: Binding(get: { kind }, set: { if let chosen = $0 { kind = chosen } }),
                    title: { $0 == .person ? "Person" : "Organization" },
                    icon: { $0 == .person ? "person" : "building.2" })
            }
            // The fields hug what they hold; with the keyboard up they scroll under the title, the rest stays put.
            ScrollView {
                fields.onGeometryChange(for: CGFloat.self, of: { $0.size.height }) { fieldsHeight = $0 }
            }
            .frame(maxHeight: fieldsHeight == 0 ? nil : fieldsHeight)
            .scrollBounceBehavior(.basedOnSize)
            .scrollEdgeEffectStyle(.soft, for: .vertical)
            .clipShape(.rect(cornerRadius: Metrics.Radius.card))
            if let attached {
                Text(attached).font(.small).foregroundStyle(Palette.muted).padding(.horizontal, Metrics.Spacing.xs)
            }
            if case .failed(let failure, _) = state {
                Text(failure.isSameTap ? "Your Mac did not answer." : failure.reason).font(.small)
                    .foregroundStyle(Palette.flag).fixedSize(horizontal: false, vertical: true).appears()
            }
            button
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Metrics.gutter).padding(.bottom, Metrics.Spacing.s)
        .readingWidth()
        .background(Palette.sheet)
        .presentationDetents([.large])
        .presentationDragIndicator(.visible)
        .motion(Motion.standard, value: kind)
        .motion(Motion.standard, value: state)
        .task(id: isDone) {
            guard isDone, let sent else { return }
            #if DEBUG
                // `-fixtureSheet create`: Created stays on show, to be photographed.
                if LifeFixture.sheet == "create" { return }
            #endif
            try? await Task.sleep(for: .seconds(0.6))
            if !Task.isCancelled { done(sent) }
        }
    }

    private var fields: some View {
        VStack(spacing: 0) {
            FieldRow(label: "Name", text: $name)
            if isOrganization {
                FieldRow(label: "What it is", prompt: "A firm, a shop, a school…", text: $what).appears()
            } else {
                FieldRow(label: "Who they are", prompt: "Who they are to you", text: $who, isGuess: isGuess)
                    .appears()
            }
        }
        .padding(.vertical, Metrics.Spacing.xs)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.card))
        // Pressed: the fields stop taking words, which also puts the keyboard away.
        .disabled(sent != nil && !isFailed)
    }

    /// What his answer attaches, from what it rides on: "3 mentions and 1 matter will be attached"; nil when nothing.
    private var attached: String? {
        guard let ridesOn = check.ridesOn else { return nil }
        let parts = [(ridesOn.observations, "mention"), (ridesOn.matters, "matter")].filter { $0.0 > 0 }
            .map { count, word in "\(count) \(word)\(count == 1 ? "" : "s")" }
        return parts.isEmpty ? nil : parts.joined(separator: " and ") + " will be attached"
    }

    @ViewBuilder private var button: some View {
        switch state {
        case .running(let steps, _):
            // Life's step under way when it names one that passed (a retry), else what the press does.
            let passed = steps.last { $0.passedAt != nil }
            Button {
            } label: {
                Text(passed.map { ActionCopy.text(of: $0.id, .init(), detail: $0.detail) } ?? "Creating…")
            }
            .buttonStyle(.pill(.filled, isBusy: true))
        case .succeeded:
            Button {
            } label: {
                Label("Created", systemImage: "checkmark")
            }
            .buttonStyle(.pill(.done)).allowsHitTesting(false)
        case .idle, .failed:
            Button(action: create) {
                Label("Create", systemImage: isOrganization ? "building.2" : "person.badge.plus")
            }
            .buttonStyle(.pill(.filled))
            .disabled(trimmed(name) == nil)
        }
    }

    private func create() {
        guard let name = trimmed(name) else { return }
        let note = isOrganization ? trimmed(what) : isGuess ? nil : trimmed(who)
        guard let request = check.answer(creating: name, note: note, asOrganization: isOrganization) else { return }
        sent = request
        Task { await life.answer(request) }
    }

    private func trimmed(_ text: String) -> String? {
        let words = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return words.isEmpty ? nil : words
    }
}
