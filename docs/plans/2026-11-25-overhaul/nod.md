# Life v4: what to take from Nod

Reference: every part of Nod worth weighing for Life, with its verdict for [the v4 plan](README.md): now (and in
which PR), later, or no. Read from Nod's source at `b51f38d` (github.com/n8n-io/nod, 25 Nov 2026) by three reading
passes over `src/`, not from the research page alone. Nod's code was read, never run. Line numbers were not kept
where the pass gave only a range; check the file before relying on one.

## What Nod is, next to Life

Nod runs pi in process through its SDK (pi 1.5.2 with two patches) and hangs most of its mechanisms on SDK hooks.
Life runs pi 1.6.0 as an RPC process with an extension loaded into it (`desk/runtimes/pi-extension.ts`). Almost
everything below that Life wants can live in that extension or in the desk, so nothing here argues for the SDK.
Nod's strongest idea is a split: a model proposes structured fields, and code decides. Its weakest parts, from
the owner's seat, are its dials: settings pages, free-text rules with no scope or end, and status lines that show
its insides.

## Licence

Apache-2.0 (`LICENSE`, `package.json`), with a `NOTICE` naming n8n GmbH. Files carry no headers of their own. To
adapt a file: keep a copy of the Apache licence in Life's repo, carry the attribution lines of Nod's `NOTICE` that
apply, say in the adapted file where it came from and that it was changed, and never use the names Nod or n8n.
One file is GPL-3.0-or-later and must not be touched: `src/providers/local-speech/phonemizer-worker.ts`. Its
`patches/` are under their upstreams' licences. v4 takes ideas and at most three small files' worth of logic
(marked "code" below); everything else is rewritten in Life's own shape.

## Now, in v4

| What | In Nod | In Life | PR |
|---|---|---|---|
| A model gives readings, code decides delivery | `src/server/proactivity.ts` (the gate near 938-1021), `src/shared/proactivity.ts:41-63` | The gate: four readings in, a pure function decides deliver, hold or send back | 7 |
| Reopen only on a real change | `proactivity.ts` (matter key, notified versions) | A replacing card names what changed; the same subject is never asked twice without it | 3 |
| Hold at night, except when the deadline falls first | `src/server/preferences.ts:34-60`, `proactivity.ts` `due()` | The gate's hold with its deadline limit. The quiet hours are a product default, not a setting the owner fills in | 7 |
| A failed read is never a change | `src/server/schedules.ts` (`schedule_record_observation`) | A failed health read is never a fix ask | 7 |
| A refusal beats a grant; a correction narrows only what it addresses | `src/server/owner-instructions.ts:40` | The instruction reader's precedence | 3 |
| Large tool results kept outside the context, with a preview and a reference (code) | `src/providers/pi/context-output.ts`, `context.ts` | In the pi extension, for shell and web results. Life's own reads already page (`PART_CHARS`, `nextReads`) | 4 |
| Tool results wrapped as data, the delimiter neutralised (code) | `src/shared/untrusted.ts`, `src/runtime/untrusted.ts` | In the pi extension, around every MCP and web result | 4 |
| A dangling tool call closed as "interrupted, outcome unknown" (code) | `src/providers/pi/checkpoint.ts` | Run on a session file before it is resumed; it matters most for the main session, which lives longest | 4 |
| Compaction numbers from the model's window | `src/providers/pi/context.ts` | Replaces the fixed 400k (`PI_COMPACT_AT`) | 4 |
| A rate limit is not an overflow | `patches/` (pi-ai) | Checked against pi 1.6.0; fixed in the extension if still true | 4 |
| Background work pauses on a failing provider, the owner's asks still try; a silent model times out | `src/server/models.ts` (`failureWindow`), `src/providers/pi/models.ts` | In the desk's wake: a growing delay per provider; 30 seconds of silence is a retry | 4 |
| A turn stops after five failed calls of one tool | `src/runtime/index.ts` (`toolProgress`) | In the pi extension | 4 |
| The guard around every tool, not a filter by name | `src/runtime/index.ts` (`guard`, near 470-700) | The extension's `tool_call` hook already sees every call; the `GUARDED` filter goes. This is what lets tool search come back | 4 |
| Queue a message that arrives mid-turn, with its wrapper sentence | `src/runtime/prompt.ts` (`steeredInstruction`), `src/server/thread.ts` | Ask Life's queue through pi's `follow_up` | 4 |
| Helpers lose the tools only the parent may use | `src/runtime/tools.ts` (`parentTools`) | Subagents already have no door; the list is checked and written down | 9 |
| `finish` refused while the owner's update is unread | `src/server/tasks.ts` (`revision`, `applied_revision`) | The door's `finish` and `set_wait` | 9 |
| A spend check per task, enforced in two strikes | `src/server/ledger.ts` (`checkIn`), `src/runtime/index.ts:282-300` | The 3-dollar stop on an assignment. Life's monthly amount stays soft; Nod's is a hard stop | 7 |
| The working line's rules: short, present tense, no tool names, nothing for a greeting, never repeating the answer | `src/server/activity.ts:11-33`, `src/shared/task-ack.ts` | Life's steps are written by code from the tool and its arguments, under the same rules | 4 |
| Suggested asks written as the owner's own request, hidden once sent, never on a sensitive subject | `src/server/schedule-ideas.ts:45-70` | The rules for a card's `follow` | 3 |

Already Life's, so nothing to take: idempotent wakes (`unique (assignment_id, event_id)`, `desk/desk-store.ts:126`),
a stranded turn never replayed (`endLostTurns`, "may have gone"), an approval bound to the exact content and used
once (a card's stored draft), the owner's words as the only authority (`hisWordsIn`), a cheap sieve before the
model (the arrival reader), one endless thread, drafts in the owner's voice (communication styles).

## Later

| What | In Nod | Why not now |
|---|---|---|
| The trust check: a judge picks the owner's words that allow an action, code cuts the quote, unknown means ask, background work that is unsure does not run | `src/server/trust.ts`, `trust-basis.ts`, `trust-dimensions.ts`, `trust-review.ts` | It is the answer to what gets past the send guard and to other people's Lives. It deserves a security plan of its own, with measures, and must land before any second Life has agents. It never replaces the tap on the exact draft |
| A gate on what the owner started | `src/server/owner-started.ts` | Same plan. Cheap (the wake's origin is known), and the first rule for powerful tools |
| Learned procedures | `src/server/learned-skills.ts` (232 lines) | Useful once agents drive sites. The shape to keep: saved with placeholders, read as data, patched by exact passage, at most 40, never a permission, in the agent's own folder |
| Browser and desktop control with a refusal list in code and a recheck of the window before each input | `src/server/computer-use.ts`, `src/providers/agent-browser/` | A plan of its own, behind the guard |
| Credentials entered by code, matched to the page's origin, never in the model's context | `src/providers/agent-browser/vault-use.ts`, `src/providers/onepassword/` | With #981 |
| Secret-bearing mail kept from the agent | `src/server/mail-check.ts` | Security plan |
| Fall back to another model only before the first word | `src/providers/pi/fallback.ts` | Only once Life runs a second model |
| A lighter model for auxiliary calls | `src/shared/models.ts:60-160` | Life's tiers already vary effort; a second model waits for a bench case |
| Deferred tools | `src/providers/pi/index.ts` (near 760-900) | In PR 4 only if PR 1's measure asks for it |
| An emoji reaction in place of a reply | `src/server/agent-reactions.ts` | Additive UI after v4 |
| Onboarding that ends on one real small task | `src/runtime/skills/nod/SKILL.md` | With onboarding |

## No

| What | Why |
|---|---|
| pi's SDK in process | The extension reaches the same hooks, and a separate process keeps the guard and a crash apart from the desk |
| CodeMode | The guard must read every call; Nod patches pi to make that hold, and Life gains little from it |
| The Jev classifier and its 300 trees (`trust-jev*.ts`) | A vendor's model tuned to Nod's policy |
| The Docker sandbox and its network rules | Life's agents are the owner's own sessions on the owner's Mac. Another person's Life is the security plan's question |
| Free-text rules and a notification rule with no scope or end (`src/server/preferences.ts`) | Life's instructions are scoped, dated and partly enforced by code |
| Settings pages, a preparation switch, quiet-hours pickers | Dials the owner must set are load |
| Status lines that name the model, a list of recent steps, a task list with states | They show the insides |
| Nod's memory | Life's is deeper |

Next: [the plan](README.md).
