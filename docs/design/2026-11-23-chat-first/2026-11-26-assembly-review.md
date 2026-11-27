# Assembly review, v4.1 (PR #1409, with A2 #1408), 26 Nov 2026

A fresh review of the assembly stage: the thread and its items (A1), profiles, the settings block, notices, pairing and
the person picker (A2). Worktree `~/Work/life-v41-a1` at `d382e0a4a`, Debug build, a fresh clone of the iPhone 18 Pro
simulator (iOS 27.2), driven with the e2e scenarios' launch arguments (C1, C3, C5, C10, C16, O2, S1, S2, plus two made-up
scenarios on a copy of the fixtures: a profile deep link and an ask with a person option) and the Debug catalog, at the
default text size and at accessibility XXXL. Judged against `2026-11-25-app-v4.html` (every side-panel scenario that
touches these screens clicked and shot at 390 × 844), the current spec, `docs/brand.md`, the owner's 11 answers and the
catalog, nav and layout reviews. Screens are in [`2026-11-26-screens-assembly-review/`](2026-11-26-screens-assembly-review/): `app-*` from
the simulator, `proto-*` from the prototype.

Not counted, as the brief says: the under-way pie's estimate, the Sent line's recipient, ask edits, and the card
evidence (needs, plan, context).

**Verdict: fail.** 10 must-fix, 10 should-fix, 5 nits.

## Must-fix

| # | Where | What | Seen | Fix |
|---|---|---|---|---|
| M1 | Every item row | No row has its line. The spec's state table gives each state a line, "row and card alike": Needs you "what · when" (coral for today), Later "Later · tomorrow 9:00", Waiting "Waiting on … · Thu", Settled a tick and how it ended, Queued "Goes when you're back", Outdated its reason. The app shows only the title and a trailing mark (`ThreadItemRow.lineView` draws a line for under way, undone and stopped only). The wire already carries `later`, `check.deadline` and `closed.line` / `closed.why`. Every row of the prototype has one. | `app-c1-count-default`, `app-c10-settled`, `app-c16-outdated`, `app-cat-items-0-default` vs `proto-count`, `proto-outdated` | Give `ThreadItemRow` a line per state, filled from the wire; "Sent" alone until the recipient comes |
| M2 | Answered or outdated item | It stays unfolded, showing its question as muted text, and its face changes from the chat bubble to a dashed circle. Spec: "each folds by its ⌃ or when answered"; outdated "unfolded, it folds". | `app-c1-settled-default`, `app-c5-dropped`, `app-c16-outdated` vs `proto-outdated` | Fold on a settled or outdated state; keep the face the item had |
| M3 | Not sent | The failure is said twice and in Life's raw words: "Not sent" with a clock under the draft, then a coral "not sent: someone wrote in Kit Moreau since this card was asked" (lowercase, and "card" is a system word the brand bans). The button still reads "Send it". Spec: the failure shows on the button itself, "Not sent", tap to try again. | `app-c3-not-sent` | Turn the button into "Not sent" (tap retries); one line of why in plain words, or none |
| M4 | Notice | Said twice: "Your Mac isn't answering" / "Your Mac cannot be reached." Spec and prototype: the line says what it means for him and since when ("Nothing is lost · since 14:10"). The title is also fixed, so a phone with no network would read "Your Mac isn't answering" too; the spec has "You're offline" ("What you do waits · since 15:40") with its own mark. | `app-o2-notice-default` vs `proto-macdown`, `proto-offline` | Two notices, each with its own mark, title and "what it means · since"; never the title repeated |
| M5 | Count button | With no thread read yet (paired, Life unreachable from the start) it shows a lone "·", which reads as the pendant's dot or a flag, not a count. The prototype keeps the count while offline. | `app-offline-from-start` vs `proto-offline` | Keep the last count read; with none ever read, show nothing in the circle (or a quiet mark that VoiceOver names), never a dot |
| M6 | Notice on a cold start | Relaunched while Life is unreachable (step 1 of O2, kept reads), the reads fail (`unreachable` in `calls.jsonl`, twice) and no notice ever shows: the thread looks fine. Reproduced twice, 12 and 15 s after launch. With no kept read (`-e2eReset`) the notice does show. | `app-relaunch-unreachable-2` | Find why `whyOutOfReach` stays nil after a failed read with a kept value; add the case to O2 |
| M7 | Question block | Answers are stacked full width, the recommended one on top. Owner, 24 Nov: two equal pills under the question, the likelier inverted on the right; a value is a row of equal round pills. | `app-cat-asks-2100-default` vs `proto-offer`, `proto-which`, `proto-value` | Lay the question's answers side by side as the prototype does |
| M8 | Largest text size | Clipped or broken: Settings rows break mid-word ("Recordi ng", "nothin g is"), squeezed by the Pair pill; the open notice truncates every line ("Your Mac isn…", "Face ID…", "Pair again…"); "Not paired"'s explanation sits under Try again and Cancel; the pendant sheet truncates "Not connect…" and "Un…" and its Asking row runs under Replace; an ask's answer breaks "Someo ne else". | `app-settings-ax`, `app-notice-open-ax`, `app-s2-notpaired-ax`, `app-pendant-ax`, `app-picker-ask-ax` | Let these wrap whole words: stack the trailing pill under the row's text at accessibility sizes, scroll the pairing sheet, give each answer the full width before it would break a word |
| M9 | Pairing failure | The failed step reads "The link is valid" in coral, next to "This link has expired". The label says the opposite of what happened. | `app-s2-notpaired-default` | Say the step as it failed ("The link has expired") |
| M10 | Profile | Ways to reach are a worded row, "WhatsApp · Ana B ›". Spec: round app buttons, no words; the prototype has three round marks under the name. | `app-profile-default`, `app-profile-ax` vs `proto-profile` | Round app buttons, the account in VoiceOver |

## Should-fix

| # | Where | What | Seen | Fix |
|---|---|---|---|---|
| S1 | Unfolded ask header | The subject is said twice ("Ask Kit", then "Send Kit the message?"); the face is a generic glyph though the draft names Kit; the header does not grow (prototype: a 48 pt face with the person's initial, a 19 pt title, "Jade · today" under it). | `app-c1-unfold-default` vs `proto-draft` | One title (the question), the person's face, the row's line |
| S2 | Answers to the field | The last answer sits 33 pt above the field at the default size and 27 pt at AX XXXL; the prototype's draft ask leaves 52 pt. The field itself is 93 pt tall at rest (two rows, a Cancel × always shown), against the prototype's 52 pt pill, which crowds it further. The field predates this PR. | `app-c1-unfold-default`, `app-c1-unfold-ax` vs `proto-draft` | Bottom margin under the last item to the prototype's; take the field's resting shape to the prototype's (track it on the field if not here) |
| S3 | Notice placement | The notice is pinned above the thread, outside it; opened, its settings block lies over the thread's top. Prototype and spec: the notice is a line of the thread (under Today), its settings block in place below it. | `app-notice-open-default` vs `proto-macdown`, `proto-offline-settings` | Put the notice in the thread at its time |
| S4 | Notice, back | "Back" is plain words with no tick and vanishes after 4 s (gone by the screenshot). Spec: it settles like an item, a tick and "Back · caught up", and nothing vanishes. | `app-notice-back-default` | Settle it in place with its tick |
| S5 | Settings | Still the full-screen sheet: a prose "Settings" title, worded pills ("Pair", "Allow"), and "Server is not paired" under Needs you while Life is paired (it is the pendant's server). Prototype "What can I change?": the settings block in the thread, only real settings. | `app-settings-default` vs `proto-canchange` | Show the settings block in the thread; leave the sheet for what is not a setting, or say why it stays |
| S6 | Pairing | "Your thread reads, 1 card" ("card" is a banned word); "Try again" on an expired link cannot work (the text says to make a new one on the Mac); both a × and Cancel close it. | `app-s1-done-default`, `app-s2-notpaired-default` | "Your thread reads"; drop Try again when the link expired; one way to close |
| S7 | Profile face | The initial is about 13 pt in a 95 pt disc at the default size (it fills the disc at AX); the prototype's is about 36 pt on the face's hue. | `app-profile-default` vs `proto-profile` | Scale the initial with the disc; use the face's hue |
| S8 | Open WhatsApp pill | Not reachable: no fixture carries `networkIdentity.openUrl`, so the PR's "Open <network>" pill could not be seen live or in the catalog. | `app-c1-unfold-default`, `app-cat-asks-700-default` | Add it to `read_thread_draft.json` and to the catalog's draft |
| S9 | Notice, catalog vs live | The catalog's notice says "Not for 12 minutes", the live one "Your Mac cannot be reached." | `app-cat-thread-700-default`, `app-o2-notice-default` | One wording, from one place |
| S10 | Outdated | No reason shown and still unfolded (M1, M2); the prototype folds it with "Jade wrote since" and Life's line for the new draft. | `app-c16-outdated` vs `proto-outdated` | Covered by M1 and M2 |

## Nits

- N1: Queued is marked with an up-arrow circle and Later with a clock; the spec gives the small clock to Queued and the
  words to Later. (`app-cat-items-0-default`)
- N2: The WhatsApp mark by the chat's name stays small at AX while the name grows. (`app-c1-unfold-ax`)
- N3: "0" on the count when nothing waits: a number he cannot act on. (`app-c1-settled-default`)
- N4: The person picker is a sheet titled "Who?" with a search; fine for "anyone", but the prototype's known-candidates
  case is faces side by side in the thread. At AX the row's initial outgrows its disc. (`app-picker-default`,
  `app-picker-ax`, `proto-person`)
- N5: The day separator still reads "Wednesday, Nov 18" (layout review S2, carried).

## The three points raised

- **Said twice**: confirmed, M4 (and the same pattern in M3).
- **The count shows only a dot offline**: confirmed when no thread was ever read, M5; with a kept read it shows the
  count.
- **Answers tight to the field**: confirmed, 33 pt (27 at AX) against 52 in the prototype, S2.

## What holds

- The draft: the network mark, the chat's name, the dashed outline in the app's colour, the recommended answer full
  width with the others two to a row (`app-c1-unfold-default`).
- The open notice's settings block: cream switch, black knob, no worded button (`app-notice-open-default`).
- Pairing's steps read as a checklist with green ticks (`app-s1-done-default`).
- The profile pushes with the glass back and keeps the field (`app-profile-default`).
- The picker sheet has a Close, search and the dictation mark (`app-picker-default`).
