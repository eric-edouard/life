# Sign in to a messaging network from the phone

Plan (26 Nov 2026), for developers: how the owner signs a messaging network back in from Life's iPhone app when its
bridge signs Life out, for every network in `NETWORKS`, and how that becomes part of adding a network. Nothing is built
yet. Tier: hard (credentials cross a trust boundary: phone, connector, bridge).

## What he sees

1. A card, as today, but it no longer sends him to the Mac: **LINE is signed out**. "LINE signed Life out, so its
   messages stop reaching Life until you sign in again." Buttons: **Sign in again**, **Later**.
2. **Sign in again** opens a sheet that runs the bridge's own login, one step at a time, each step drawn the way the
   phone does it best:
   - a web page (the network's own sign-in page, inside the app): he signs in as he would in Safari, 2FA and the
     site's own checks included; the sheet closes itself once he's in. He never sees a cookie.
   - a short form (email, password, phone number, a code the network sent him), with the phone's own autofill.
   - a code to type in the network's app ("Enter this PIN in LINE"), big, with **Copy** and **Open LINE**; the sheet
     waits while he switches apps, and goes on by itself when he comes back.
3. Doing: the sheet says what it waits for ("Signing in…", "Waiting for you in LINE"). Done: **Signed back in**, the
   card leaves his inbox. Failed, in plain words, the card staying: "LINE didn't accept that. Try again.", "That took
   too long. Try again.", "Life can't reach your Mac right now."
4. What came in while he was signed out is copied by the bridge's catch-up (below), then by the archive as usual.

The first link of a network uses the same card ("Connect LINE?") once its bridge is added on the Mac.

## Per network (bridges as built on this Mac, 26 Nov 2026)

| Network | Bridge, version | Flow the phone uses | Phone UI | Notes |
|---|---|---|---|---|
| LINE | beeper/line 1.2.0 | `dev.highest.matrix.line.email_login` | form (email, password), then a PIN to enter in LINE | The PIN is only in the step's `instructions` (Markdown, "click Continue below"): shown as given. |
| Instagram | mautrix/meta v0.2610.0 | `instagram` (cookies) | web page `instagram.com/accounts/login/` | Password flows exist (`instagram-password`, `android`) but go through Meta's private APIs: open question 3. |
| Messenger | mautrix/meta v0.2610.0 | `facebook` (cookies) | web page, the bridge's desktop user agent | `messenger` (messenger.com) is the other cookie flow: open question 2. |
| LinkedIn | mautrix/linkedin v0.2609.0 | `cookies` | web page `linkedin.com/login`, the bridge's user agent | Its fields are request headers (`Cookie`, `X-LI-Track`, `X-LI-Page-Instance`): the web view catches them with a script hooking the page's fetch and XHR; the riskiest of the six. |
| Telegram | mautrix/telegram v0.2611.0 | `phone` | form: phone number, the code Telegram sends to his app, his 2FA password if set | QR can't be scanned by the phone showing it. A first link needs his app keys (my.telegram.org): Mac only. |
| WhatsApp | mautrix/whatsapp (no source kept here) | `phone` (pairing code) | form: his number, then an 8-character code to enter in WhatsApp → Linked devices → Link with phone number | QR can't be scanned by the phone showing it. Its bridge only sends; reading stays the Mac app's. |

Nothing above is impossible from the phone once the bridge is added. What stays on the Mac: adding a bridge (a Go
build) and Telegram's app keys.

## How it works

### The network contract

Each `NETWORKS` entry gets one required field, `loginFlow`: the id of the bridge flow the phone (and the CLI) signs in with.
The entry type makes it required (`satisfies`), and `sources/networks.test.ts` fails on any network without a
non-empty `loginFlow`, so a new network can't ship without saying how it signs in from the phone. (Not `signIn`: that name is the CLI's Chrome cookie reader, `host/bridges.ts:391`, until bundle 3 deletes it.) The phone draws whatever
step types the flow returns; a network adds no phone code unless its bridge invents a new step type.

### Phone to bridge

One new connector tool, `sign_in_to_network`, a write, his token only (refused for any agent's grant, like
`delete_from_memory`; never on the reads-only servers). Life keeps no login of its own: the phone carries
`loginId`, `stepId` and the step type between calls, and each call is one provisioning call to the bridge on loopback.

- `{network}` starts the network's `loginFlow` (`login/start`). Refused while the network's login is connected: it
  only signs in a network that is signed out or never linked, so it can't swap a working login for another account.
- `{network, loginId, stepId, type, answers}` submits one step (`login/step`) and returns the next one, cut to what
  the phone draws: instructions, form fields, a cookie step's page, user agent, wait pattern, fields and their
  sources, `extract_js`, a display step's code or QR.
- A display-and-wait step blocks inside the bridge for minutes while he types the code in the other app, and iOS
  cuts a request when the app leaves the screen. So the connector holds that one wait itself (an in-process map by
  `loginId`, 10 minutes, holding no answers) and answers `waiting`; the phone asks again when it's back on screen,
  with progress pings every 10 s while it's open.
- On `complete`: one `afterLinked` (moved out of the CLI's `link`, `host/bridges.ts:441`, which then calls it) turns
  the network's source on and drops the fix asks' 5-minute bridge cache, so the card leaves at the next inbox read.
  Settings are read once per process, so a first link's source starts copying only when Life's processes restart:
  decided in bundle 1: the archive and the watcher end when the sources change (`readRunning`, beside new code), and the
  app starts them again within seconds. A re-sign-in needs none: its source is on already.

The CLI's `bun life bridge link` runs the same two calls in its loop (`sources/matrix.ts`: `linkBridge` split into
`startLogin` and `submitLoginStep`), with `loginFlow` replacing today's "first flow the bridge lists".

### Credentials

- On the phone: the web view uses a non-persistent data store (`WKWebsiteDataStore.nonPersistent()`), torn down with
  the sheet. Cookies (HttpOnly included, from `WKHTTPCookieStore`), local storage and `extract_js` results are read
  in memory, sent once, never written to disk, the Keychain or a log. Form values are the same.
- Over the wire: the connector's HTTPS on his tailnet, as every other call.
- On the Mac: the answers live only in the tool call's memory and are passed to the bridge's provisioning on loopback.
  `mcp.call` logs argument names, never values (`argNamesOf`); the tool's errors return the bridge's refusal class,
  never the answers. Nothing reaches `memory/`, the desk, an agent or a model. The bridge keeps its session in its
  own database, as it does when he links on the Mac today.
- To verify before merge: each bridge's own log (`logs/bridge.log`) does not print submitted values at its default
  level.

### Missed messages

Every bridge's config has `backfill.enabled: false` today, so messages sent while signed out may never reach Life.
One config writer, `withCatchUp` (`host/bridges.ts`), sets catch-up on (`backfill.enabled: true`,
`max_catchup_messages: 500`; built: the initial count stays the bridge's 50, since a chat begun while signed out would lose its messages at 0 and LINE's move from Beeper counts on them); `writeConfig` calls it for a new bridge, and `healBridges` calls it
on each added bridge's config before its restart (today it edits none). The archive only appends what the homeserver gets. Risk: caught-up
messages arrive late and old; the arrival reader reads by day, so a late one from yesterday is the night's.

### Words that change

- AGENTS.md, connector invariant: after "his monthly amount (`change_setting` …)", add "and signs a messaging
  network's bridge in on his sign-in from his app (`sign_in_to_network`, his token only: one bridge login step at a
  time, its answers passed to that bridge on loopback and kept nowhere by Life; only for a network signed out or never
  linked)".
- AGENTS.md, "One way to do each thing", bridges row: "set up, linked and removed only by `bun life bridge`" becomes
  "set up and removed only by `bun life bridge`; linked by it or by his app's sign-in (`sign_in_to_network`), both
  through `NETWORKS`' `loginFlow`".
- SECURITY.md, "What leaves the Mac", new line: "To a messaging network, through its bridge, on his sign-in from his
  app: the cookies, password and codes he gives there, once, from his phone over his tailnet to the bridge on loopback;
  Life stores none and logs none; the bridge keeps its session as when he links on the Mac." Known risks gains one: a
  client holding his token (a paired assistant) could be steered into signing a signed-out network in to another
  account.
- `apps/lifelog/SECURITY.md`: the app opens a network's sign-in page in a web view with no stored data.
- `docs/use/bridges.md`, the glossary (`loginFlow`, "sign in from the phone"), the fix ask's words in
  `memory/fix-checks.ts`, and the status hints that say `bun life bridge link` (`blockOf`, `messaging-status.ts`).

## PR bundles

Strict paths (`host/http/`), so full workflow, no fast mode.

1. Server (~+430 / −60).
   `sources/networks.ts` (`loginFlow` per entry) and `networks.test.ts` (new, ~25); `sources/matrix.ts` (split
   `linkBridge`; `LoginAsk` moves to the CLI); `host/bridges.ts` (loop over the split calls, `loginFlow`,
   `afterLinked` and `withCatchUp`, called from `writeConfig` and `healBridges`); `core/names.ts` (`sign_in_to_network` in `CONNECTOR_WRITES`, so the send guard refuses it to agents); `host/network-sign-in.ts` (new, ~140: gate, start, step, the
   wait map, step trimming, after-linked); `host/http/mcp-network-sign-in.ts` (new, ~50) and its registration in
   `mcp.ts`; `memory/fix-checks.ts` (words, a never-linked added bridge as a "Connect" ask, cache drop);
   `memory/life-checks.ts` and `memory/answer-check.ts` (`sign-in` option marked `signsIn: <network>`, refused through
   `answer_check`: the phone opens the sheet instead); `records/` option wire; tests (~120: agent refused, connected
   refused, answers never in the log line, step trimming, the wait answering `waiting` then the next step); docs above.
2. iPhone app (~+620 / −10).
   `Kit/.../Models/Check.swift` (`signsIn` on an option); `Kit/.../LifeAPI.swift` (`signInToNetwork`);
   `Lifelog/Life/NetworkSignIn.swift` (new, ~380: the sheet, web view step with cookie, local storage, `extract_js`
   and header catcher, form step, code or QR step, waiting, done and failed); `Lifelog/Items/ItemRow.swift` (the
   `signsIn` option opens the sheet); Kit tests (~120: step decoding, cookie fields matched by name and domain, header
   caught by URL pattern).
3. Once each cookie network (Instagram, Messenger, LinkedIn) has signed in from his phone, and no later than two
   weeks after bundle 2 merges (a LinkedIn that fails then keeps the Mac path for LinkedIn alone): delete the Mac's Chrome sign-in and pasted cURL (`host/sign-in-browser.ts`,
   `pastedValues`, `cookieValues`, the terminal's cookie ask: ~−420); `bun life bridge add` ends by saying the card is
   waiting on his phone. The CLI keeps form steps for a checkout without the app.

Trial order on his phone: LINE and Messenger (signed out now), then Instagram, Telegram, WhatsApp, LinkedIn last.

## Needs his yes

- The new connector write and the AGENTS.md invariant words above.
- The new "What leaves the Mac" line and the Known risks line.
- Catch-up on for every bridge (more of his messages copied into the homeserver and the archive).
- Bundle 3's deletion of the Mac's Chrome sign-in.
- Installing the app build on his phone, and each real sign-in (a network may sign out his other sessions: LINE allows
  one desktop session).

## Open questions only he can answer

1. Should any app holding his token (ChatGPT, Claude) be able to call `sign_in_to_network`, or only Life's iPhone app?
   Today the connector can't tell them apart; restricting it needs the app's pairing marked as the phone.
2. Messenger: sign in on facebook.com or messenger.com? Which does he use, and which shows his encrypted chats?
3. Instagram: the web page (recommended), or username and password, which Meta may flag as a bot?
4. WhatsApp and Telegram ask his phone number: type it each time, or fill it from his own Contacts card?
5. A card for a bridge he added but never linked ("Connect LINE?"): wanted, or only for one that signed out?

## Debt plan

Tier: hard: credentials cross a trust boundary (phone, connector, bridge); a new connector write.
Inventory: `sources/networks.ts:38` (`NETWORKS`, no sign-in field); `sources/matrix.ts:277` (`provision`), `:334`
(`LoginStep`), `:374` (`LoginAsk`), `:467` (`loginFlows`), `:507` (`linkBridge`, the step loop), `:302` (`blockOf`,
"bun life bridge link"); `host/bridges.ts:410` (`link`: `flows[0]` at `:429`, terminal answers, sources on), `:254`
(`writeConfig`, no backfill); `host/sign-in-browser.ts` (Chrome cookie reader, CLI only, 323 lines);
`core/names.ts:31` (`CONNECTOR_WRITES`); `core/settings.ts:229` (read once per process); `memory/fix-checks.ts:10` (`SIGNED_OUT`), `:44` ("on your Mac"), `:64` (5-minute cache); `memory/life-checks.ts:78`
(fix options); `memory/answer-check.ts:449` (fix handlers); `memory/checks.ts:208`; `host/messaging-status.ts:86,95`;
`host/http/mcp-tool.ts:65,169` (argument names only), `mcp-deletions.ts:14` (agent refusal); iOS
`Kit/.../Models/Check.swift:36` (option flags), `Lifelog/Items/ItemRow.swift:161` (option tap). rg run:
`loginFlows|linkBridge|CookieStep|fix:|signed-out|bridge link|on your Mac|WKWebView`.
Shape: the flow is decided once, in `NETWORKS[].loginFlow`; the bridge's provisioning is the only login state
(plus one in-process wait per display step); one step driver (`startLogin`, `submitLoginStep`) serves the CLI and the
connector; the phone draws steps by type, never by network.
State: the display-step wait map in `host/network-sign-in.ts`, per login, 10 minutes, no answers in it; the fix asks'
bridge cache gains a drop. Nothing stored.
Deletes: `flows[0]` guessing; "on your Mac" in the fix ask; `bun life bridge link` hints; then in bundle 3 the Chrome
sign-in, pasted cURL parsing and the terminal cookie ask.
Net lines: +1,050 / −70 for bundles 1 and 2; bundle 3 −420; about +560 in all. The growth is the phone's sheet (a
new capability with no Mac code to replace until bundle 3). The wait map stays (iOS cuts a request when he switches to
the network's app) and the step trimming stays on the Mac (the phone gets only what it draws).
Plan review: one fresh senior round. Changed: `sign_in_to_network` added to `CONNECTOR_WRITES`; one `afterLinked`
owns turning the source on, with the restart a first link needs; one `withCatchUp` writer shared by `writeConfig` and
`healBridges`; the field renamed `loginFlow` (clashed with the CLI's `signIn`); bundle 3 given its condition and date;
inventory gained `core/names.ts:31` (`CONNECTOR_WRITES`) and `core/settings.ts:229` (read once per process). Shape
unchanged, so no second round.

**Owner's yes (26 Nov 2026):** build it with the plan's defaults: the invariant and SECURITY.md wording, catch-up on every bridge, and PR 3's deletion after his trial.
