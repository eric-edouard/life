import LifeConnector
import SwiftUI

/// What a list row does on a swipe or a long press, all through the answers Life already takes (`answer_check`,
/// `correct_memory`): an ask's own options, and its matter's mark and Done. No answer of its own is no swipe.
@MainActor struct AskRowActions {
    let check: Check
    let life: LifeStore
    /// Opens the ask on its page: for an answer that needs his words or a person.
    let open: () -> Void

    private var matter: MatterRow? {
        check.matterID.flatMap { id in life.matters.value?.matters.first { $0.id == id } }
    }
    private func request(_ id: String) -> AnswerRequest? { check.options.first { $0.id == id }.flatMap(check.answer) }

    private func send(_ request: AnswerRequest, _ words: String) async {
        guard !life.saysOutOfReach() else { return }
        life.forget(.answer(ref: request.ref))
        await life.answerRows([request], as: words)
    }

    /// Right: the ask's first answer, when one tap gives it.
    var main: RowSwipe.Button? {
        guard let option = check.optionsInOrder.first(where: { $0.id != "drop" }),
            CardNotification.isOneTap(option, of: check),
            let request = check.answer(option), check.beingFixed == nil
        else { return nil }
        return .init(
            label: option.label, symbol: "checkmark", working: option.outgoing == true ? "Sending…" : "Saving…"
        ) {
            await send(request, option.label)
        }
    }

    /// Left: Drop, where the ask offers it.
    var drop: RowSwipe.Button? {
        guard let request = request("drop"), check.beingFixed == nil else { return nil }
        return .init(label: "Drop", symbol: "trash", working: "Dropping…") { await send(request, "Dropped") }
    }

    /// Long press: the question, every answer of the full ask, then Mark important, Done, Drop.
    @ViewBuilder var menu: some View {
        Section(check.question) {
            ForEach(check.optionsInOrder.filter { !["done", "drop"].contains($0.id) }, id: \.id) { option in
                Button(option.label) {
                    // Only a plain tap answers here: a send, a hand-over or his words open the ask, which shows what goes.
                    if CardNotification.isOneTap(option, of: check), let request = check.answer(option) {
                        Task { await send(request, option.label) }
                    } else {
                        open()
                    }
                }
            }
            if check.takesOwnWords { Button(check.ownWordsTitle, systemImage: "text.bubble", action: open) }
        }
        if let matter { Self.mark(matter, life) }
        if let done = request("done") {
            Button("Done", systemImage: "checkmark") { Task { await send(done, "Done") } }
        } else if let id = check.matterID {
            Button("Done", systemImage: "checkmark") { Task { await life.markDone(id) } }
        }
        if let request = request("drop") {
            Button("Drop", systemImage: "trash", role: .destructive) { Task { await send(request, "Dropped") } }
        }
    }

    /// Mark important (or not), the same on an ask's row and a matter's.
    @ViewBuilder static func mark(_ matter: MatterRow, _ life: LifeStore) -> some View {
        let isMarked = life.isImportant(matter.id, as: matter.important)
        Button(isMarked ? "Not important" : "Mark important", systemImage: isMarked ? "flag.slash" : "flag") {
            Task { await life.setImportant(matter.id, !isMarked) }
        }
    }
}
