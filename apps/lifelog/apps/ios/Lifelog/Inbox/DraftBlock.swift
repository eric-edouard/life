import LifeConnector
import SwiftUI

/// The exact message he approves: who and where in its head (the network's mark, "Name, WhatsApp", and under it the
/// number when the name is only Life's guess), the message it answers in a small box, the words.
struct DraftBlock: View {
    let draft: Check.Draft
    /// The chat as its network shows it.
    var identity: Check.NetworkIdentity?
    /// The person is only Life's guess: the head shows the network's name for them, with a "~" and the number.
    var isGuess = false
    /// On paper of its own (after an answer); in an ask it sits on the thing's `tile` with no box.
    var isBoxed = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            head
            if let subject = draft.subject {
                Text(subject).font(.buttonLabel).foregroundStyle(Palette.fg)
            }
            if let quoted = draft.quoted {
                Text("“\(quoted.text)”").font(.body15).foregroundStyle(Palette.muted).lineLimit(3)
                    .padding(Metrics.Spacing.m).frame(maxWidth: .infinity, alignment: .leading)
                    .background(Palette.sheet, in: .rect(cornerRadius: Metrics.Radius.tile))
            }
            if let text = draft.text {
                Text(text).font(.quote).foregroundStyle(Palette.fg).fixedSize(
                    horizontal: false, vertical: true)
            }
            if let reaction = draft.reaction { Text(reaction).font(.system(size: 34)) }
            if let file = draft.file {
                Label("\(file.name) · \(file.size.formatted(.byteCount(style: .file)))", systemImage: "doc")
                    .font(.body15).foregroundStyle(Palette.fg)
            }
        }
        .padding(isBoxed ? Metrics.Spacing.l : 0)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isBoxed ? Palette.paper : .clear, in: .rect(cornerRadius: Metrics.Radius.passage))
        .accessibilityElement(children: .combine)
    }

    private var head: some View {
        let name = isGuess ? "~ " + (identity?.shownName ?? draft.to) : draft.to
        return HStack(alignment: .top, spacing: Metrics.Spacing.s) {
            NetworkMark(network: draft.channel)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(name), \(Channel.name(draft.channel))").font(.buttonLabel).foregroundStyle(Palette.fg)
                if isGuess, let handle = identity?.handle { Text(handle).font(.small).foregroundStyle(Palette.muted) }
            }
        }
    }
}
