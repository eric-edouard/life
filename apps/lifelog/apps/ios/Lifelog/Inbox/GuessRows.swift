import LifeConnector
import SwiftUI

/// Where a guess row stands: both answers on offer, its answer going to Life, or answered (and sent, or on its way).
enum GuessState: Equatable {
    case rest
    case sending(yes: Bool)
    case answered(yes: Bool)
}

/// One "Is this X?" row of the guesses' card: who Life guesses (the person, with their disc), who was seen, and Yes or
/// No at the right. An answered row keeps its answer, dimmed; a refused one is back at rest, Life's reason under it.
struct GuessRow: View {
    let check: Check
    let state: GuessState
    /// Why its last answer did not land, when it did not.
    let failure: String?
    let answer: (_ yes: Bool) -> Void
    let open: () -> Void

    var body: some View {
        HStack(spacing: Metrics.Spacing.m) {
            PartyDisc(name: check.guessedName, size: .row)
            VStack(alignment: .leading, spacing: 2) {
                Text("\(check.guessedName)?").font(.rowName).foregroundStyle(Palette.fg).lineLimit(1)
                Text(check.seenLine).font(.small).foregroundStyle(Palette.muted).lineLimit(1)
                if let failure { Text("Not saved: \(failure)").font(.small).foregroundStyle(Palette.flag) }
            }
            .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect).onTapGesture(perform: open)
            YesNo(state: state, answer: answer)
        }
        .frame(minHeight: Metrics.FlatRow.bulkRow)
        .opacity(isDimmed ? 0.6 : 1)
        .motion(Motion.standard, value: state)
    }

    private var isDimmed: Bool {
        if case .answered = state { true } else { false }
    }
}

/// The two chips of a row: Yes and No at rest; after a tap its answer alone (Yes with a check), or a ring while Life takes it.
struct YesNo: View {
    let state: GuessState
    let answer: (_ yes: Bool) -> Void

    var body: some View {
        switch state {
        case .rest:
            HStack(spacing: 6) {
                chip("Yes", fill: Color.fillTint) { answer(true) }
                chip("No", fill: Color.fillTint) { answer(false) }
            }
        case .sending:
            chip("Saving…", fill: Color.pick, isBusy: true) {}.disabled(true)
        case .answered(let yes):
            HStack(spacing: 6) {
                if yes {
                    Image(systemName: "checkmark").font(.smallStrong).foregroundStyle(Palette.ok)
                }
                Text(yes ? "Yes" : "No").font(.chip).foregroundStyle(yes ? Palette.fg : Palette.muted)
            }
            .padding(.horizontal, Metrics.Spacing.l)
        }
    }

    private func chip(_ label: String, fill: Color, isBusy: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if isBusy { Spinner(size: .small) }
                Text(label).font(.chip).foregroundStyle(Palette.fg)
            }
            .padding(.horizontal, Metrics.Spacing.l).padding(.vertical, Metrics.Spacing.s)
            .background(fill, in: .rect(cornerRadius: Metrics.Radius.passage))
            .frame(minHeight: Metrics.tapTarget).contentShape(.rect)
        }
        .buttonStyle(.plain)
    }
}

/// The same-person ask, at the top of the guesses' card: the person Life holds, then the second account that may be
/// theirs, with Yes or No on it.
struct SamePersonTile: View {
    let check: Check
    let state: GuessState
    let failure: String?
    let answer: (_ yes: Bool) -> Void
    let open: () -> Void

    /// The second account, as its network names it.
    private var account: String { check.networkIdentity?.shownName ?? check.guessedName }

    var body: some View {
        VStack(alignment: .leading, spacing: Metrics.Spacing.s) {
            Text("One person, a second account?").font(.small).foregroundStyle(Palette.muted)
            if let person = check.likelyPeople.first {
                PartyRow(person)
            }
            HStack(spacing: Metrics.Spacing.m) {
                PartyDisc(name: account, size: .row)
                VStack(alignment: .leading, spacing: 2) {
                    Text(account).font(.rowName).foregroundStyle(Palette.fg).lineLimit(1)
                    Text(check.seenLine).font(.small).foregroundStyle(Palette.muted).lineLimit(2)
                    if let failure { Text("Not saved: \(failure)").font(.small).foregroundStyle(Palette.flag) }
                }
                .frame(maxWidth: .infinity, alignment: .leading).contentShape(.rect).onTapGesture(perform: open)
                YesNo(state: state, answer: answer)
            }
            .opacity({ if case .answered = state { 0.6 } else { 1 } }())
        }
        .padding(Metrics.Spacing.m)
        .background(Palette.tile, in: .rect(cornerRadius: Metrics.Radius.passage))
        .motion(Motion.standard, value: state)
    }
}

extension Check {
    /// A guess row's muted line: who was seen as their network shows them, and where ("~ Idris B. · WhatsApp").
    var seenLine: String {
        [networkIdentity?.shownName, networkIdentity?.network].compactMap(\.self).joined(separator: " · ")
    }
}
