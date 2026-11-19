import LifeConnector
import SwiftUI

// What each ask is about, one body per field Life sends (`said`, `since`, `goal`, `networkIdentity`, `contactsCard`,
// `draft`, `evidence`), drawn on the Ask panel's `tile`. `CheckCard` picks them by what the check holds, never by its
// group's wording. A sentence's who-and-when is never dimmed; a sentence may be.

/// A sentence as it was said: who, to whom, where and when above, its words under.
struct SaidBlock: View {
    let said: Check.Said

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            let line = said.line(channelName: ActionCopy.channel)
            if !line.isEmpty { Text(line).font(.small).foregroundStyle(Palette.muted) }
            Text("“\(said.text)”").font(.quote).foregroundStyle(Palette.fg).fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// An ending: the step said, then what came since.
struct EndingBlock: View {
    let said: Check.Said?
    let since: Check.Said?

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let said { SaidBlock(said: said) }
            if let since {
                VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
                    Text("Since then").font(.smallStrong).foregroundStyle(Palette.fg)
                    SaidBlock(said: since)
                }
            }
        }
    }
}

/// A new matter: the goal Start hands the agent, with a pencil that opens it as his words, and the sentence that started it.
struct NewMatterBlock: View {
    let goal: String?
    let said: Check.Said?
    let edit: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            if let goal {
                HStack(alignment: .top, spacing: Metrics.Spacing.m) {
                    VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                        Text("Goal").font(.small).foregroundStyle(Palette.muted)
                        Text(goal).font(.leadBold).foregroundStyle(Palette.fg)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                    Spacer(minLength: 0)
                    RoundIconButton(symbol: "pencil", label: "Edit the goal", action: edit)
                }
            }
            if let said { SaidBlock(said: said) }
        }
    }
}

/// Who a guessed person is as their network shows them: initials with the network's mark, the name it shows (a "~":
/// only Life's guess), the number, the network, their newest message with its time, and the way into the chat.
struct PersonIdentityBlock: View {
    let identity: Check.NetworkIdentity

    @Environment(\.openURL) private var openURL

    var body: some View {
        let name = identity.shownName ?? identity.handle ?? ""
        let network = identity.network.map { ActionCopy.channel($0.lowercased()) }
        VStack(alignment: .leading, spacing: Metrics.Spacing.m) {
            HStack(spacing: Metrics.Spacing.m) {
                Avatar(name: name, network: identity.network?.lowercased())
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    Text("~ \(name)").font(.leadBold).foregroundStyle(Palette.fg)
                    if let handle = identity.handle { Text(handle).font(.monoTime).foregroundStyle(Palette.muted) }
                    if let network { Text(network).font(.smallStrong).foregroundStyle(Palette.fg) }
                }
            }
            .accessibilityElement(children: .combine)
            if let newest = identity.newest, let text = newest.text {
                VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
                    if let at = newest.at { Text(SaidWords.moment(at)).font(.small).foregroundStyle(Palette.muted) }
                    Text("“\(text)”").font(.quote).foregroundStyle(Palette.fg)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .accessibilityElement(children: .combine)
            }
            if let url = identity.openUrl {
                TextLink("Open in \(network ?? "its app")", isOutward: true) { openURL(url) }
            }
        }
    }
}

/// A Contacts card Life cannot place: its name and numbers, and that it is from Contacts.
struct ContactsCardBlock: View {
    let card: Check.ContactsCard

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(card.name).font(.leadBold).foregroundStyle(Palette.fg)
            ForEach(card.handles, id: \.self) { Text($0).font(.monoTime).foregroundStyle(Palette.muted) }
            Text("Contacts").font(.smallStrong).foregroundStyle(Palette.fg)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

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
                Text("\(name), \(ActionCopy.channel(draft.channel))").font(.buttonLabel).foregroundStyle(Palette.fg)
                if isGuess, let handle = identity?.handle { Text(handle).font(.small).foregroundStyle(Palette.muted) }
            }
        }
    }
}

/// The words a card rests on, and where they came from.
struct EvidenceBlock: View {
    let evidence: Check.Evidence

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.xs) {
            Text(evidence.from).font(.small).foregroundStyle(Palette.muted)
            Text("“\(evidence.quote)”").font(.quote).foregroundStyle(Palette.fg)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}
