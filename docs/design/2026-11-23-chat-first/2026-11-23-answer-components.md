# Answer components: a first reference

Reference: the components an answer of Life's is drawn from, and the JSON the main session writes for them, as
proposed on 23 Nov 2026 from three real questions. A proposal for the plan to weigh, not a decision: whether these are
fixed blocks or components the agent composes is the plan's
([`docs/plans/2026-11-23-chat-first-app.md`](../../plans/2026-11-23-chat-first-app.md), "Life's own catalog of
blocks"). The look is on the Answers page of the Chat design canvas (private to the owner). Examples use made-up
people.

## The answer

An answer is Life's message in the thread: an ordered list of blocks, streamed.

```json
{
  "answer": "ans_7f2c",
  "catalog": 1,
  "blocks": [
    { "id": "b1", "text": "Tomas has gone **silent** since his question yesterday at 9:42." },
    { "id": "b2", "items": ["life:step:obs_91ab", "life:step:todo_77c1"] }
  ]
}
```

| Field | Type | Rule |
|---|---|---|
| `answer` | string | The answer's id, given by Life when the turn starts. |
| `catalog` | integer | The catalog version the spec was written for. The app draws only the versions it knows; an unknown component in a known version is a miss (below). |
| `blocks` | array of blocks, 1 to 12 | In reading order. Each block is one object with `id` and exactly one component key. |
| `id` | string, unique in the answer | What a patch names. |

### Streaming

The session sends patches as it writes; the app draws each block once it is valid, in order, never a block ahead of
an invalid one.

| Patch | Shape | Effect |
|---|---|---|
| add | `{"op":"add","block":{…},"after":"b1"}` | Inserts a block (`after` absent: at the end). |
| text | `{"op":"text","id":"b1","append":"words"}` | Appends words to a `text` block: the word-by-word ink. |
| set | `{"op":"set","id":"b3","block":{…}}` | Replaces a block whole (a table filled in). |
| remove | `{"op":"remove","id":"b3"}` | Takes a block out before the answer ends. |
| end | `{"op":"end"}` | The answer is whole: checks run, then it settles. |

After `end` an answer never changes; a new fact is a new answer.

### What every block obeys

- **Refs, not copies.** Anything Life holds (a step, a person, a photo, a message, a place, a file) is a `life:` ref,
  the grammar of cards (`parseRef`, `memory/refs.ts`): the app reads it with his token and draws what it reads. A
  ref that does not resolve is dropped from its block with no error shown; a block left empty is dropped.
- **Checked values.** A value the session writes itself (a table's cells, a document's lines, a phrase's words) is
  data from a source; the block names that source in `from` (one ref or several), and Life checks each number and
  name against it at `end`. A block that fails is not shown, and the miss is recorded.
- **No style.** No colour, size, font, spacing or layout in any block; the component decides.
- **No acts.** Only `items` act, through Life's own answers on his token. Everything else can at most open a link on
  his tap (the host shown) or show something full screen.
- **Words for VoiceOver.** Each component reads aloud from its own fields; none takes a separate label.
- **Language.** Text is in the language he asked in, unless a field says otherwise (`phrase.lang`).

### When nothing fits

The session answers in `text` and adds `{"op":"miss","wanted":"a timeline of the build"}`; Life records it with what
was being answered. The catalog grows from those records.

## The components

### `text`: Life's words

```json
{ "id": "b1", "text": "Your last three calls with [Léa](life:person:lea) ran past **an hour**." }
```

| Field | Type | Rule |
|---|---|---|
| `text` | string, Markdown, ≤ 4,000 characters | Paragraphs, lists, bold, italic, headings (levels 2 and 3), quotes, inline code and code blocks, tables (≤ 4 columns, else use `table`), links. No HTML, no images (use `pictures`). |

- A `life:` link is a name he can tap; it unfolds what it names under the paragraph (a source, a person), in place.
- An `https:` link shows its host and opens only on his tap.
- Headings and quotes stay quiet: the type scale of a page, not a document's.

### `items`: things that wait (Life's own)

```json
{ "id": "b4", "items": ["life:step:obs_91ab", "life:check:dec_12", "life:matter:matter_405d"] }
```

| Field | Type | Rule |
|---|---|---|
| `items` | array of refs, 1 to 8 | An ask (a card), a matter, or one of its steps. Anything else is refused. |

- Each draws as a row in its state, live, and unfolds in place with its answers: the grid of the current spec
  ([`2026-11-23-current-spec.md`](2026-11-23-current-spec.md), "Items"). Its title and line are Life's, read from the
  ref; the session never writes them.
- Past 4, the rest fold behind "Show the other N".

### `pictures`: photos Life holds

```json
{ "id": "b3", "pictures": ["life:file:img_ab12", "life:file:img_ab13", "life:file:img_ab14", "life:file:img_ab15"] }
```

| Field | Type | Rule |
|---|---|---|
| `pictures` | array of file refs (images), 1 to 20 | Shown in the order given. |

- One shows wide; two or three in a strip; more, three in the strip and the third carries "+N".
- Each carries who sent it and when, read from its message.
- A tap shows it full screen, swiping through the rest, with "Open in WhatsApp ↗" (its chat) at the bottom.

### `table`: values in rows

```json
{ "id": "b2", "table": {
  "from": ["life:msg:messenger|1042"],
  "columns": [{ "label": "Bead" }, { "label": "Bags", "align": "end" }],
  "groups": [
    { "label": "First bag", "rows": [["#12", 3], ["#40", 3]] },
    { "label": "Second bag", "rows": [[{ "t": "#77", "note": "all they had" }, 3]] }
  ],
  "total": ["Total", 9],
  "unit": { "column": 1, "is": "bags" }
} }
```

| Field | Type | Rule |
|---|---|---|
| `from` | ref or array of refs | Required. The source the cells are checked against. |
| `columns` | array, 1 to 4, of `{label, align?}` | `align`: `start` (default) or `end`; numbers default to `end`. |
| `rows` or `groups` | rows: array of rows; groups: 1 to 6 of `{label, rows}` | One of the two. A row has one cell per column. ≤ 40 rows in all; past 12, the rest fold behind "Show all N". |
| cell | string, number, or `{t, note?, ref?, swatch?}` | `note`: a few muted words after the value. `ref`: the cell is a name he can tap. `swatch`: a colour, only when the source states it (a product's colour code it names), checked like any value. |
| `total` | a row, optional | Set apart; must add up when its column is numbers. |
| `unit` | `{column, is}`, optional | Read aloud and set in the header when a column holds one unit (bags, €, km). Money cells take `{t, amount, currency}` instead, written in his locale. |

### `phrase`: words for someone in front of him

```json
{ "id": "b1", "phrase": {
  "lang": "th",
  "text": "สวัสดีครับ มารับของที่สั่งไว้ครับ",
  "mine": "Hello, I'm here to pick up my order.",
  "to": "the shop"
} }
```

| Field | Type | Rule |
|---|---|---|
| `lang` | BCP 47 code | The language it is said in. |
| `text` | string, ≤ 280 characters | What to say, in that language. |
| `mine` | string | The same in his language, under it. Checked as a translation of `text`. |
| `to` | string, optional | Who it is for, read aloud. |

- Two round buttons: say it aloud (the system voice for `lang`), and show it full screen (large, the screen kept
  awake, turned to face the other person). Words of his to VoiceOver: "Say it", "Show it".

### `document`: a paper as it was sent

```json
{ "id": "b2", "document": {
  "from": "life:msg:messenger|1042",
  "title": "Bead House",
  "lines": ["R-1180-0042", "12 × 10 g glass beads"],
  "total": "4,820 ฿",
  "kind": "receipt"
} }
```

| Field | Type | Rule |
|---|---|---|
| `from` | ref | Required: the message, mail or file it is from. Its app and day are read from it. |
| `title` | string | Who issued it, as written on it. |
| `lines` | array of strings, 1 to 8 | Key lines copied as written (numbers, references, codes); checked against `from`. |
| `total` | string, optional | The amount due or paid, as written. |
| `kind` | `receipt`, `booking`, `ticket`, `invoice`, `other` | Changes its look a little (a ticket's tear, a booking's dates first). |

- Drawn on paper colour in a fixed-width face, its source and day in a corner. A tap opens the original (the photo,
  the PDF in the system's viewer, the message in its chat).

### `place`: somewhere to go

```json
{ "id": "b5", "place": { "ref": "life:place:pl_33a" } }
{ "id": "b5", "place": { "name": "Bead House", "address": "12 Sukhumvit 31, Bangkok" } }
```

| Field | Type | Rule |
|---|---|---|
| `ref` | place ref | A place Life holds (visited, or of an appointment). |
| `name`, `address` | strings | Otherwise, from the web; the address checked against the answer's sources. |

- A row: the pin, the name, the address; Google Maps and Apple Maps (his default first) open on his tap. Never a
  drawn map.

## What this reference still leaves out

- Components the three answers did not need: choices with links, key facts, a comparison, a chart, a person, a
  message, a voice clip, an event (the plan's outside-data shapes, and the sources work).
- How each component looks in light mode, at the largest text sizes, and under Reduce Motion: the canvas's
  system boards hold the rules; each component needs its own drawing.
- The exact limits above are first guesses, to be set from real answers.
