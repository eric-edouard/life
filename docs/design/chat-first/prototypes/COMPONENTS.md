# The lab's components

Explanation: the parts every card in the design lab is drawn with (`card-blocks.js`), as a hierarchy, each with its
counterpart in the iPhone app's Swift design system (`apps/lifelog/apps/ios/Lifelog/DesignSystem`, and `Items`).

**The rule:** the lab and Swift share these names. A part is designed here once, under its Swift name, and the app
mirrors it; a card never hand-writes markup for something a part already draws (a switch, a source, Life's blue). When
a v2 or a variant needs something no part draws, add the part here first. Card data names a part by its block key
(`['hero', …]`), listed beside it.

Every part keeps three rules: no hairlines anywhere; one cream fill per card, on the right where answers sit side by
side; each fact once (a part drops what another part on the card already says).

```
Tokens        T (colours), APPS (each network's mark, colour, name)
└ Atoms       Icon · Face · NetworkMark · Button · Switch · Check · Spinner · StillRing · ReactionMark
              · LifesWords (blue) · Due (coral) · Saved (green tick) · Undo
  └ Molecules PartyLine · Row · Source · Quote · Markdown · Answers · LifesPick · Option · ReadAlong
              · DraftBlock · EditChips · HisBubble · RatingRow · SettingsBlock · RoundButton
    └ The ask the blocks B, drawn in order: PartyLine, why, a body, Answers
```

## Tokens

| Lab | Swift |
|---|---|
| `T`: fg, muted, tint, tile, card, ok, ai, flag | `Palette` (from `assets/brand/tokens.css`) |
| `APPS`: WhatsApp, Messages, Mail: mark, colour, name | `ChatLook` (`DraftBlock.swift`), `NetworkMark` |

## Atoms

| Lab | What it decides | Swift |
|---|---|---|
| Icon (`CB.I`) | the line glyphs | SF Symbols |
| Face (`CB.face`) | always a full circle: a person's initial on their hue; an organization's picture, else its initials (`org:Fern Way`); a mark only when no one is there to show | `Face` (`Items/Face.swift`); **differs**: it draws an organization as a rounded square, against the owner's answer 5 |
| NetworkMark | the app's own mark in its colour; a network with none keeps a muted line glyph | `NetworkMark` |
| Button | filled (cream) or quiet (tint) pill | `PillStyle` (`.filled`, `.quiet`) |
| Switch (`CB.sw`) | cream track and black knob when on | `RowSwitch` |
| Check (`CB.check`) | his tick on a step, a ring until done | `StateMark` |
| Spinner, StillRing (`CB.ring`) | Life at work; a long task's still pie | `Spinner`, `StillRing` |
| ReactionMark | an emoji in monotone | `ReactionMark` |
| LifesWords (`CB.ai`) | Life's own reading or pick, in blue | `Palette.ai`; no type |
| Due | "today" and "tonight" in coral, until settled | `Palette.flag`; no type |
| Saved (`CB.saved`) | the green tick of a change that went through | missing in Swift (inside `SettingsBlock`) |
| Undo (`CB.undo`) | "· Undo" in bold cream at a line's end, with its limit | `SentLine`'s Undo |

## Molecules

| Lab (block key) | What it decides | Swift |
|---|---|---|
| PartyLine (`hero`) | face, title, one line of who and when; a name the title already says leaves the line ("Reply to Jade" over "today") | `AskCard`'s header, `ThreadItemRow`'s header; no type of its own |
| Row (`row`) | a thread item in one state (ok, ring, spin, old); the same line rule | `ThreadItemRow`, `EarlierDraftRow` |
| Source (`source`) | where a message came from: the app's mark, who, when, "Open WhatsApp" in the app's colour; one part everywhere a message is quoted | `ChatHead` (private in `DraftBlock.swift`) |
| Quote (`quote`) | a message as its app shows it, under its Source; no face (the Source names them) | `DraftBlock`'s quote (private) |
| Markdown (`md`) | Life's words with `life:` links; a "> quote" and its "*who · app, when*" become a Quote | `MarkdownView` (`LifeWords.swift`) |
| Answers (`answers`) | stack: the cream one full width, the rest quiet; row: equal pills, cream on the right; marks: cream last | `AnswerPills`, `QuestionBlock` |
| LifesPick (`pick`) | "Life's pick" in blue, then the pick | missing in Swift |
| Option (`option`) | a pick's option: radio, name, Life's pick tag, one line | missing in Swift |
| ReadAlong (`readalong`) | a voice clip read, not drawn: dim words turn white as played; play loads first; no waveform, no duration | missing in Swift |
| DraftBlock (`chat`) | the chat a draft goes into, its Source on top, the draft dashed in the app's colour | `DraftBlock` |
| EditChips (`edits`) | quick edits under or inside the draft; `back` is the round way back | `EditChips` |
| HisBubble (`bm`) | his words, Life's mark on the corner, the tick's place, or a line under | `HisBubble` |
| RatingRow (`rate`) | "How am I doing?"; with a kept mark, the settled "Thanks" | `RatingRow` |
| SettingsBlock (`settings`) | rows spaced, no hairline: a switch, value pills or nothing; a face, a line, Saved, a cross for Life's wrong reading, his tick | `SettingsBlock`, `SettingSwitchRow`, `SettingValueRow` |
| RoundButton (`rounds`) | one mark on glass, no rim | `RoundButton` |

The card bodies (`box`, `copyrows`, `slip`, `qr`, `link`, `event`, `spend`, `plan`, `seen`, `people`, `pair`, `step`,
`swipe`, `mpage`, `follows`, `mhead`) are drawn from the atoms and molecules above; in Swift they are parts of
`AskCard` and the answer blocks (`DocumentBlock`, `PlaceBlock`, `TableBlock`). The old clip looks (`clip` wave, pill,
text) stay only for the A, B and C variants drawn before the 26 Nov rule.

## The ask

`B` draws a card from data, block by block (`CB.draw`): its PartyLine, one why, a body, its Answers. Swift: `AskCard`.
