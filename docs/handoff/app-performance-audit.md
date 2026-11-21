# Life for iPhone: performance, state and UX audit

20 Nov 2026. Read-only, from code only: nothing was run, built or measured on a device. Paths are relative to
`apps/lifelog/apps/ios/` unless they start with `apps/server/`.

## The short version

The app's shape is sound. There is one `@Observable` store per feature (`LifeStore` for Life), every read is a
`ReadState`, every action is an `ActionState`, and a JSON file cache (`ReadCache`) already fills the Inbox, Matters
and agents at launch. You don't need a new architecture. Four gaps cause what he feels:

1. **The flicker.** An answered card is hidden only while its answer is held or running. Once the answer succeeds,
   the card is visible again until the next inbox read lands. And when two reads overlap, the one that finishes last
   wins, even if it started earlier. So an older read can bring back a card he just answered.
2. **The empty screen after tapping a push.** The tap throws away what the app already holds (the cached inbox, and
   the card itself, which the notification extension stored in the notification). It shows a spinner until the
   network answers. No request has a timeout of its own, so that wait can last up to 60 s.
3. **Reloading all the time.** Every foreground, every card push and every answer reads the whole inbox (up to 500
   cards) and all the matters. Nothing merges reads that are already running, nothing skips a read made a moment ago,
   and nothing asks "has it changed?". On the Mac, `read_matters` is not cached and can wait up to 2 s on the
   embedder for icons.
4. **No offline mode for actions.** Reads fall back to the cache, but buttons stay live with no network. An answer
   is held 4 s, then tried 3 times (up to 60 s each, 2 s apart), then the card comes back with "Not sent to your Mac."

The fixes are mostly in `LifeStore` and Kit's `LifeConnector`, plus two small server changes. The fix plan at the
end cuts them into eight PRs, in order of how much they improve how the app feels.

---

## Findings, ranked by impact on feel

Severity: **Critical**: he sees it on most uses. **High**: often, or it costs seconds. **Medium**: occasional, or
frames. **Low**: hygiene.

### 1. An answered card comes back for a whole read after its answer succeeds — Critical

- **Where:** `Lifelog/Life/LifeStore.swift:43-48` (`answersUnderWay`), `:272-287` (`answer`, `refreshAfterAnswer`),
  `Kit/Sources/LifeConnector/Models/Inbox.swift:70-77` (`ordered(except:)`).
- **What happens:** the Inbox leaves out a card only while its answer is held (`holds.held`) or its action
  `isRunning`. `perform` ends with the action `.succeeded`. From then on the card is no longer excluded. But
  `inbox.value` still holds it until `refreshInbox()` returns: a round trip for up to 500 cards, then a decode on the
  main thread. The list re-adds the row (and animates it back: `CheckList.swift:31`). The pager may also get the
  card back to the left of the one on show. The same thing happens to a send or a start whose result was on show:
  `CardView.swift:99-103` leaves after 1.5 s, and if the read has not landed by then, the card is back.
- **Symptom:** "it changes, then snaps back", then corrects itself a second or two later.
- **Fix:** keep an **answered** set in `LifeStore` (ref → when it succeeded) and add it to `answersUnderWay`. Drop a
  ref from it only once an inbox read that was *started after* the success no longer lists it. If such a read still
  lists it, Life says it is still open (for example a new matter's goal edit, `staysOpen`), so show it. Also, on
  success, remove the card from `inbox.value` at once, lower the badge if it was `blocks`, and write that to the
  cache, so a cold start can't bring it back either. The same rule fits `answer_check` from a notification
  (`LifelogApp.swift:84-89`).

### 2. Overlapping reads: the last to finish wins, even when it is older — Critical

- **Where:** `Lifelog/Life/LifeStore.swift:192-211` (`load`), `:108-113` (`refresh`), `:126-144`.
- **What happens:** several things call `refreshInbox()` at the same moment: the foreground (`RootView.swift:70-86`), a
  card push in front (`RootView.swift:67-69`), each answer that ends (`:282-287`), a tapped push (`:360-379`) and the
  retry loop. Nothing orders them: each applies `.succeeded` whenever it returns. Here is a typical case. He answers
  A, then B. The read after A started before B's answer reached the Mac, but it returns after the read made after B.
  The inbox then shows B as open again, and it stays so until the next read. That could be the next time the app
  comes forward.
- **Symptom:** a card he answered is back and *stays* back. This is the worst form of the flicker.
- **Fix:** make the read *single-flight with one more pass*, the pattern `SyncStore.run` already uses (`again`):
  - if an inbox read is running, a new request sets `again = true` and returns;
  - when the read ends and `again` is set, it reads once more.
  
  This both orders the reads and removes duplicates. Do the same for `read_matters`, and for each matter id.
  Together with finding 1's "started after" rule, a stale answer can never overwrite a newer one. Put the counter
  in Kit next to `ReadState`, where it can be unit-tested.

### 3. Tapping a push shows a spinner instead of the card already in hand — Critical

The tap path, end to end:

1. `IncidentNotifier.swift:180`: the tap becomes `NotificationRoute.card(pushId)`. The card JSON the service
   extension stored in `userInfo["card"]` (`NotificationService.swift:60`, `CardNotification.userInfoKey`) is
   dropped here: `NotificationRoute` keeps only the `pushId` (`Kit/Sources/Incidents/NotificationRoute.swift:18-19`).
2. `CaptureStore.routeToOpen`, then `RootView.swift:61-65` and `:116-125`: any open sheet is dismissed first (its
   animation runs before anything else), then `Task { await life.open(pushId:) }`.
3. At the same moment, on a cold or background launch, `RootView.swift:70-78` starts `life.refresh()`: three more
   reads, the inbox at limit 500.
4. `LifeStore.swift:361-362`: `pushRead = (pushId, ReadState())`, an **empty** state. `inboxShown`
   (`:382-384`) then switches the whole Inbox to `.loading`. That is `InboxLoading`, "Reading your inbox…"
   (`InboxScreen.swift:157-166`), even when the cached inbox holds the card.
5. `read_inbox(pushId:)` goes to the Mac. If the token is near expiry, there is an OAuth refresh round trip first
   (`LifeSession.swift:25-29`). The URLSession has no timeout of its own (finding 4), so with the Mac asleep or the
   tunnel down, this waits up to **60 s**.
6. If the card was answered elsewhere, `pushRead` is reset to a new loading state (`:373-376`). Then a *second*
   round trip runs, the whole 500-card read, before anything shows.
7. If it worked, the Inbox shows a **one-card inbox** (the pushId read) until the whole read lands. Then the list and
   the pager jump from 1 card to N.

- **Symptom:** exactly what he reported: a long stare at a spinner. Then a jump when the full list arrives.
- **Fix:** show at once what is in hand, then correct it.
  - Carry the card: `NotificationRoute.card(pushId, card: String?)`, filled from `userInfo[CardNotification.userInfoKey]`.
  - In `open(pushId:)`, never start from an empty state. Use the first of these that holds the card: the cached
    `inbox.value`, else the notification's card inserted into the cached inbox (or as a one-card inbox when there is
    no cache). Set `openedCard` at once, so the screen shows the card in the first frame.
  - Then run only the *whole* read (single-flight, finding 2). Drop the extra `pushId` read: the service extension
    already made it. If the whole read no longer lists the card, show the existing "Already answered…" notice
    (`InboxScreen.swift:88-89`).
  - Only when nothing at all is in hand (no cache, and the extension failed): show a card-shaped skeleton (designer),
    never the full-screen spinner. Add a 10 s timeout (finding 4).
  - Don't wait for the sheet's dismissal animation before switching tab and showing the card. Set the route state
    first, dismiss in parallel.

### 4. No request timeout: reads and answers can hang for 60 s, answers for up to about 3 min — High

- **Where:** `Kit/Sources/LifeConnector/MCPClient.swift:12` (`URLSession(configuration: .ephemeral)`, no
  `timeoutIntervalForRequest`), `LifeActions.swift:18` (`tries = 3`), `:53` (2 s pause).
- **What happens:** URLSession's default request timeout is 60 s. A read with the Mac asleep, or a tunnel that
  accepts the connection but never answers, spins for a minute before `ReadScreen` can show "Your Mac is out of
  reach." An answer tries up to 3 times: up to 3 × 60 s + 4 s of "Saving…" before the card comes back.
- **Symptom:** long spinners, and "Saving…" that never ends, whenever the Mac or the tunnel is down.
- **Fix:**
  - Reads: `timeoutIntervalForRequest = 10` on the client's configuration.
  - Actions: a longer per-request timeout that covers the server's own limit. For a streaming answer, the timeout is
    an *idle* timeout, so steady progress events keep it alive; 15 s is plenty.
  - Keep the 3 tries only when the path is up. With no path, fail at once (finding 5).
  - Also add `waitsForConnectivity = false` explicitly, and reuse one URLSession for the whole app. The notification
    extension already shares one per process (`NotificationService.swift:11`).

### 5. Offline, the app is not read-only: answers are accepted, then bounce back — High

- **Where:** `LifeStore` takes no network input at all. `SyncStore.swift:101-111` follows `NWPathMonitor` for the
  pendant's server only. `ReadScreen.swift:27-31` shows a `StaleNote` only after a read *fails*. Every answer button
  stays enabled (`CheckActions.swift`).
- **What happens:**
  - With no internet, he can answer. The answer is held 4 s and hidden, then tried 3 times. It fails, and then
    `InboxScreen.swift:82` (`refusedRef`) jumps back to it with "Not sent to your Mac."
  - When the network returns, nothing re-reads Life. Only the pendant's sync runs (`SyncStore.swift:108-109`).
  - On launch with no network, the cached inbox shows as `.loaded`, with no sign that it is old, until the first
    read fails. Today that is up to 60 s later.
- **Symptom:** in a lift, on a plane, or with the Mac asleep: answers that look accepted, then pop back a minute
  later. No clear word that the connection is the problem.
- **Fix:**
  - Add `LifeStore.isReachable`, computed from two things: the path (move `network` to a small shared
    `NetworkPath` observable that both stores read; don't run a second monitor), and Life's last read outcome
    (`.unreachable` sets it false; any success sets it true).
  - While it is false:
    - every action control is disabled: answers, Undo-held answers, edits, Start, Mark as done;
    - `hold` refuses;
    - one **permanent banner** says the connection is the problem, with when the shown data was read. The banner is
      for the designer to draw.
  - When the path comes back, run `life.refresh()` (single-flight) beside `sync.run()`.
  - On a cold launch with no path, show the banner from the first frame, from the path alone, without waiting for
    a read to fail.
  - The reconcile rules are below, under "Offline: storage and reconcile rules".

### 6. Too many whole reads, and one of them is slow on the Mac — High

- **Where (app):** `LifeAPI.swift:97` asks `limit: 500` every time. The reads are triggered from:
  - `RootView.swift:70-78`: every `scenePhase` change to `.active`, which includes pulling down Control Center or
    the notification shade and letting go. Each runs all three reads.
  - `RootView.swift:67-69`: every card push while the app is in front. All three reads.
  - `LifeStore.swift:282-287`: every answer that ends. Inbox and matters, so five held answers make five pairs.
  - `MatterPage.swift:27`: the matter on show, again on every answer anywhere (`answersEnded`).
  - `LifeStore.swift:304-306`, `:319-321`, `:352-354`: starts, agent changes and edits.
  
  Nothing skips a read made seconds ago, and nothing merges two reads (finding 2).
- **Where (server):**
  - `read_inbox` is cheap when nothing changed: `checksNow` keeps one list per key (`apps/server/src/memory/checks.ts:698-718`).
    But a `pushId` read still builds the whole list and filters it (`apps/server/src/host/inbox.ts:38-45`).
  - `read_matters` is **not** cached. Each call rebuilds the matter book (`apps/server/src/host/matter-rows.ts:28-37`)
    and may wait up to `ICON_WAIT_MS = 2000` on the Mac's embedder for icons
    (`apps/server/src/memory/matter-icons.ts:20`, `:117`).
- **Payload:** each card is about 1–3 KB in the wire fixtures (`fixtures/wire/life/read_inbox.json`: 8 cards,
  17.6 KB). A voice card carries every clip with per-word timings. With no cap on checks, a large inbox can be several
  hundred KB. It is then re-escaped as a string inside JSON-RPC, parsed twice, and the second parse runs on the main
  thread (finding 8).
- **Symptom:**
  - "It reloads the whole inbox all the time."
  - Battery and data use.
  - Slow Matters after each foreground, because of the embedder wait.
  - More chances for finding 2's stale overwrite.
- **Fix, app side:**
  - Single-flight (finding 2).
  - On foreground, read only if the last read is more than ~30 s old. Pushes already say when cards change, and
    `removed` pushes say when they leave.
  - A card push reads the inbox only, not matters and agents.
  - An answer reads the inbox, and reads matters only when the card had a `matter`.
  - Drop `MatterPage`'s `answersEnded` re-read, except for an answer whose card belongs to that matter.
- **Fix, server side (two small changes):**
  1. Return a `version` with `read_inbox`, a hash of `checksKeyOf`'s key, and accept `ifNot: <version>` that answers
     `{unchanged: true}`. Do the same for `read_matters`.
  2. Cache `read_matters` by the same kind of key, and never make it wait on the embedder: return the icons it has,
     and let the next read carry the rest.
  
  Then lower the default limit to 50 and page the rest (finding 10).

### 7. Editing a goal or next step shows the old text after Save, then the new one — Medium-High

- **Where:** `Lifelog/Matters/MatterPage.swift:179` (`isEditing = false` on `.succeeded`), `LifeStore.swift:347-355`
  (the refresh runs *after* the action has succeeded).
- **What happens:** Save succeeds, and the field closes onto `matter.row.goal?.text`, which is still the old value
  until `refreshMatter` returns.
- **Symptom:** his new words disappear, the old ones flash, then the new ones come back. The same flicker he
  reported.
- **Fix:** an optimistic overlay. `LifeStore` keeps `pendingEdits[matterId] = (goal/next, text, at)`, applied on top
  of the read when shown. Clear it when a read started after the save shows that text, or drop it with the failure
  reason if the save fails. The view keeps showing `draft` until then.

### 8. Main-thread work on every read — Medium

- **Where:**
  - `LifeStore.swift:199`: the inbox is decoded on the main actor. The class is `@MainActor`, and the app target
    builds with `SWIFT_DEFAULT_ACTOR_ISOLATION: MainActor`.
  - `:200`: the cache file is written on the main actor, an atomic write of the whole JSON.
  - `:152-162`: `deliveredNotifications()`, then `removeDeliveredNotifications`, a **synchronous IPC on the main
    actor** after every whole read. `IncidentNotifier.swift:103-104` already notes that these calls once froze a cold
    launch, and moves them off the main actor.
  - `:85-88`: three cache files are read and decoded synchronously in `init`, on the first frame.
- **Symptom:** dropped frames when a read lands, sometimes in the middle of a swipe or an animation. A slower first
  frame on a cold launch from a push.
- **Fix:**
  - Decode in a `@concurrent nonisolated` helper and hand back the value. Write the cache from the same helper.
  - Move notification removal into a `@concurrent nonisolated static` function, as `IncidentNotifier.remove` does.
  - Keep the launch restore synchronous: a blank first frame is worse. But it only stays cheap if the payload stays
    small (findings 6 and 10).

### 9. Observation is too broad: every progress event re-sorts the whole inbox — Medium

- **Where:**
  - `InboxScreen.swift:128-132`: `all` re-runs `Inbox.ordered` (filter, deferred lookups, two passes) on every body
    evaluation, and then again in `.only(kind)` and `.kinds`.
  - `InboxScreen.swift:104-109` (`refusedRef`) reads `life.state(of:)` for every card. So `InboxScreen`, and every
    `CheckCard` (`isBusy`), depends on the whole `actions` dictionary. Each streamed step of any action (`perform`,
    `LifeStore.swift:224-229`) invalidates them all.
  - `ReadState` is one struct. A read's `.started` and its `.succeeded` both invalidate every reader, even when the
    value is the same: `ReadState.swift:50-53` sets it with no equality check. `loadedAt` changes every time.
  - `RootView.swift:36` reads `life.inbox.value?.badge`, so the root `TabView` re-runs on every inbox read.
- **Symptom:** small hitches while an answer streams its steps, and on each read. These grow with the inbox's size.
- **Fix:**
  - Compute the `InboxOrder` once in the store, when the inbox, the held refs or the answered refs change, and store
    it.
  - Pass `isBusy` and `refusal` from a leaf that reads `state(of:)` for its own card only.
  - In `ReadState.apply(.succeeded)`, skip assigning `value` when it is equal: `Inbox` and `MatterList` are already
    `Equatable`.
  - Give the badge a stored `badge: Int` that is set only when it changes.

### 10. The inbox payload is the whole inbox, with clip words, for a list that shows one line per card — Medium

- **Where:** `LifeAPI.swift:97` (500), and `Check` decodes every clip's `words` for every voice card.
- **Symptom:** slower reads, decodes and cache writes as the inbox grows. Finding 8's hitches get worse.
- **Fix:**
  - Read `limit: 50`. When the list or the pager nears its end, read the next page. That needs an `after` cursor on
    the server: the order is stable for one `version`.
  - The counts and the badge already come whole (`counts`, `total`, `blocking`).
  - Optionally, the server could send `words` only for the first clip, and full clips only when the card is read
    alone. Measure first; do this only if voice cards dominate.

### 11. A matter's page shows a skeleton even when its row is in hand — Medium

- **Where:** `MatterPage.swift:18-23`. `life.matter[id]` is nil until the first read, or until its cache file is
  read (`LifeStore.swift:175`). But the row from `read_matters` is already in hand: name, goal, next step, people,
  `needsYou` and agent.
- **Symptom:** the page opens to grey bars, with no cache, on the first visit and on every matter not opened before.
- **Fix:** while there is no matter read and no cached one, draw the page from its `MatterRow`: header, goal and next
  step, people. Show a skeleton only for steps and asks. Do the same in `ContextRegion`
  (`CardArrangement.swift:88`), which shows nothing until the matter is read.

### 12. Possible one-frame flash when a held answer is released — Medium-Low

- **Where:** `Kit/Sources/LifeConnector/HeldAnswers.swift:55-60`. `release` removes the ref from `held` at once, but
  the `answer` that marks it running starts in a new `Task`. In between, the ref is neither held nor running.
- **Symptom:** the card can flash back for one frame, four seconds after he answered.
- **Fix:** mark the ref as sending in the same synchronous step. For example, `LifeStore` adds it to the answered or
  in-flight set before `holds` lets it go. Or have `HeldAnswers` keep it until `send` has started.

### 13. A matter's steps are drawn all at once — Low

- **Where:** `MatterPage.swift:203-227`: a `VStack` with a `ForEach` over every step, inside a `ScrollView`.
- **Symptom:** a long matter (hundreds of steps) opens and scrolls slower.
- **Fix:** use `LazyVStack`. The ids are stable already.

### 14. A cancelled read can restore the wrong phase when reads overlap — Low

- **Where:** `ReadState.swift:45-49`. `settled` keeps one phase, so with two reads at once, a cancel can restore the
  phase of the other read.
- **Fix:** this disappears with single-flight (finding 2).

### What is already right (keep it)

- **Stable ids everywhere.** `ForEach` keys on `ref` and `id`, never an index. The pager's ids come from the card.
- **Lazy containers** for the Inbox list, the pager (`LazyHStack`) and the matter list.
- **`ReadState` never blanks a screen that has a value.** A failed read shows the value as stale. It never goes
  back to loading.
- **Cache-first launch** for the inbox, matters and agents (`LifeStore.swift:85-88`). Matter pages read their cache
  on first open.
- **One store, one `perform`, one `ActionState` per key.** This is the right place for the optimistic layer below.
- **No pictures are loaded yet.** `Party.picture` is decoded but never fetched. When they arrive: fetch
  `read_person_pictures` in batches of the ids on screen, keep them as files keyed by picture id (they are
  immutable), and never put base64 in the list payload.

---

## Recommended state model, for this app's shape

This keeps today's structure and adds three rules.

1. **Server state plus a local overlay equals what is shown.**
   - The read stays the truth.
   - A small overlay in `LifeStore` holds what he did that the read does not show yet: answered refs, refs that are
     sending or held, and pending matter edits.
   - The shown inbox and matter are the read with the overlay applied, computed once in the store when either one
     changes.
   - An overlay entry ends when a read **started after** it confirms it. If Life disagrees, the entry ends and the
     read wins.
   
   This is the usual optimistic-update pattern. It is what removes every "snap back".
2. **One read of each kind at a time, plus one more pass.** Requests arriving during a read set a flag; never two
   overlapping reads of the same thing.
3. **Narrow observation.**
   - Screens read stored, derived values (`inboxOrder`, `badge`, `isReachable`), never whole dictionaries.
   - Leaves read their own action state.
   - Values are assigned only when they change.

`@Observable` with `@Environment` injection is the right tool here, and it is what you already use. You don't need
TCA, Combine or a new library.

## Offline: storage and reconcile rules

**Storage: keep the JSON files (`ReadCache`).** Don't move to SwiftData or GRDB. Each cached read is one wire
answer, decoded by the same code that decodes the live one. There are no local queries or relations, and the files
are small once paged. SwiftData would add migrations and main-context pitfalls and buy nothing here. Revisit GRDB
only if he needs offline search over thousands of items.

Add four things:

- **What he did since the last read.** After his answer succeeds, write the inbox to the cache without that card.
  Otherwise a cold start shows the answered card again.
- **The `version` per read** (finding 6), so the first read after launch can be `ifNot: version`.
- **Pruning:** remove the file of a matter that has left `read_matters`.
- **Writes off the main actor** (finding 8).

**Reconcile rules:**

1. Launch:
   - draw from the cache in the first frame;
   - then read, single-flight;
   - mark the screen as cached (banner) only when there is no path or a read failed, not while a read is running.
2. A read applies only if it started after the last read applied.
3. The overlay wins over a read that started before the overlay entry. A read started after the entry wins over the
   overlay.
4. `notPaired` clears the cache and the overlay. This already happens on a new pairing (`LifeStore.swift:401-403`).
5. With no path, or with Life unreachable:
   - read-only: actions disabled, the permanent banner on;
   - held answers are not accepted;
   - one that was already held when the path dropped is sent by the background path as today (`RootView.swift:97-104`),
     and on failure it goes back to his inbox, visibly marked as not sent.
6. When the path comes back, read once (single-flight). The banner goes once a read succeeds.

---

## Fix plan, in PR-sized pieces, in order

1. **Answers never come back** (findings 1, 2, 12, 14).
   - Single-flight reads with one more pass, in Kit next to `ReadState`.
   - The answered and sending overlay in `LifeStore`, folded into `answersUnderWay`.
   - The answered card is removed from `inbox.value` and from the cache.
   - Kit tests:
     - two overlapping reads, the older one finishing last;
     - an answer's success before the read lands;
     - the release gap.
2. **A push opens on its card at once** (finding 3).
   - `NotificationRoute.card(pushId, card:)`.
   - `open(pushId:)` seeds from the cache or the notification's card and never sets an empty state.
   - The extra `pushId` read is dropped.
   - A card skeleton only when nothing is in hand.
3. **Timeouts** (finding 4).
   - One configured URLSession: reads 10 s; actions a 15 s idle timeout.
   - No retries when the path is down.
4. **Read-only offline** (finding 5).
   - A shared `NetworkPath` observable.
   - `LifeStore.isReachable`.
   - Actions and `hold` disabled.
   - The permanent banner.
   - A refresh when the path comes back.
   - Needs the designer's banner first, or ship it with a placeholder `StaleNote`-like row.
5. **Fewer reads** (finding 6, app side).
   - A trigger table: foreground only if older than 30 s; a push reads the inbox only; answers read matters only
     when the card has one.
   - Drop `MatterPage`'s `answersEnded` re-read.
6. **Cheaper reads** (finding 6 server side, finding 10). A server PR, then an app PR.
   - `version` and `ifNot` on `read_inbox` and `read_matters`.
   - `read_matters` cached by key, and never waits on the embedder.
   - `limit: 50` with paging.
7. **Main thread and observation** (findings 8, 9).
   - Off-main decode, cache write and notification removal.
   - A stored `inboxOrder` and `badge`.
   - Equality-guarded `ReadState`.
   - Leaf-level action reads.
8. **Matter page** (findings 7, 11, 13).
   - Prefill from `MatterRow`.
   - Optimistic goal and next-step edits.
   - `LazyVStack` for steps.

Each PR is small enough for one debt verdict. 1 to 3 fix all three of his reports. Each one changes a screen's
behaviour, so each gets the design review `AGENTS.md` asks for.

## For the designer to draw

1. **The offline banner.**
   - Permanent while there is no connection, and not dismissable.
   - It says the connection is the problem, in a few words. For example "No connection to your Mac. Showing what was
     read at 14:32."
   - Two variants: "no internet on the phone" and "the Mac doesn't answer".
   - Where it sits: above the content in Inbox and Matters, and in a matter's page and a pushed ask. On the closed
     Duo's side column too.
   - How it comes and goes: no jump, per the "nothing jumps" rule.
2. **Disabled answers.**
   - How a card's answers, Send, Start, Mark as done and the edit pencils look while offline.
   - Whether a tap on one says why: a short line, or the banner pulsing.
3. **The Inbox's first-load skeleton.** A card-shaped placeholder (question lines, a tile, two answer pills) to
   replace the "Reading your inbox…" spinner. It is used only with no cache and no notification card.
4. **A pushed card that is being checked.** The card drawn from the notification while the whole read runs: whether
   it shows any sign that it is being checked (a quiet line or a small spinner) or none.
5. **The partly-known matter page.** Header, goal and next step drawn from the list's row, with a skeleton only for
   steps and asks.
6. **An answer that didn't go because the connection dropped.** How the card looks back in the inbox, marked as not
   sent. Today it reuses "Not sent to your Mac."
