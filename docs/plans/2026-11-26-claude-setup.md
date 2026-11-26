# Claude setup without a terminal

Plan: how a person who never opens a terminal connects Life to Claude (the desktop app, claude.ai and the Claude
phone app) and approves it with a tap in Life's iPhone app instead of typing a pairing code. Tier: hard (auth, a trust
boundary). No code yet.

## What we know (26 Nov 2026)

- The plugin's connector (`"url": "${user_config.connector_url}"` in `apps/claude-plugin/.mcp.json`) is refused by the
  Claude desktop app (`verifyPluginMcpBinding … expected=<unparseable>`): it shows "Not connected" with no way out.
  Terminal Claude Code expands it and signs in.
- Terminal sign-in sends the browser back to `http://localhost:<port>/callback`; Safari failed to open it after Life
  had spent the code, so the retry failed too.
- An account connector added on claude.ai has an https callback (`claude.ai/api/mcp/auth_callback`, already in
  `REDIRECTS`) and reaches the desktop app, the web and the phone. The owner's account already has one; Claude Code
  sessions in the desktop app see it as `claude_ai_Life__*`, which the send guard already covers
  (`send-guard.test.ts`).
- claude.ai opens its **Add custom connector** dialog prefilled from a link:
  `https://claude.ai/customize/connectors?modal=add-custom-connector&connectorName=Life&connectorUrl=<url>`; the person
  still confirms. (Anthropic's [directory vs custom](https://claude.com/docs/connectors/building/directory-vs-custom)
  page; to check on a real account before building.)
- The plugin's hooks (`hooks/life.ts`, `hooks/door.ts`) talk only to the desk's door on loopback; nothing in them
  needs the connector. Its skill (`rebill`) names tools by their short names, which the account connector serves.
- Every plain token carries the same subject and scope (`auth.ts:36-46`). Only its `client_id` tells the phone's from a
  connected ChatGPT's or Claude's.

## Prerequisite: a public address

Claude calls Life from Anthropic's servers, so Life must be public: the Mac's **Public, for ChatGPT and Claude.ai**
button (Tailscale Funnel, `bun life connect --public`) sets `settings.connector.origin`. The issuer is bound to that one
origin, and the phone stored its `<origin>/mcp` as `LifeEndpoint.resource` when it paired. That stored value is the
address the phone shows; there is no new read. A Life on the tailnet only gives an address Claude can't reach. Making
that step the phone's is question 2.

## The flow, as the person sees it

1. In Life's iPhone app, **Settings › Use Life in Claude** shows the address with **Copy** and **Add to Claude** (the
   prefilled link above).
2. Claude opens **Add custom connector** with Life's name and address filled in. The person presses **Add**, then
   **Connect**. The account connector then shows in every Claude app, so this can be done on the phone even for use
   on the desktop.
3. Life's sign-in page asks "Connect Claude to Life? It goes back to claude.ai." On a phone it shows **Approve in
   Life**, the pairing link bound to this request. On a computer it shows the same link, and the typed code from the
   Mac's **Pair an app** as before.
4. Life's app opens its existing pairing sheet, which now names the app and where it goes back to, with **Approve** /
   **Not me**: "Approving…", then "Connected. Go back to Claude." The sign-in page checks every two seconds, turns to
   "Connected" and sends the browser back to Claude.

The plugin is optional: it adds skills and, for the desk's agents, the door and send guard. It installs from the Claude
app's plugin settings by adding the marketplace `eric-edouard/life`, with no terminal.

## Why not a pushed card, and why not a new door

- A pushed card ("Connect <app> to Life?") lets anyone who starts a sign-in on the public address put that question on
  his phone, as often as they like (MFA fatigue). It would also be a decision line in `memory/decisions.jsonl` for
  something that is not his life. A link opened from the page approves only the request on the screen in front of him.
- No `/auth/approve` route and no approval sheet beside the pairing ones. The phone already opens
  `lifelog://pair?life=<origin>&code=<code>` in its pairing sheet (`PairOffer`, `PairSheet`, `LinkAction.pair`). The
  same link with `request=<id>` instead of `code` is the request-bound one, and the issuer's one approval door stays
  `/auth/oauth2/authorize`. It takes two proofs: a typed code (today), or a token of the phone's own client.
- No connector tool: any plain-token app, a prompt-injected Claude chat included, could call one with an id an
  attacker gave it.

## The trust boundary

Registration is open (`register`, `oauth.ts:~385`) and `allowed` passes loopback (`oauth.ts:45`), so a client's
redirects or name prove nothing: anyone can register one that looks like the phone's. Approval therefore rests on a
stored marker that only the phone's own pairing can set.

- **Phone codes.** `pair(agent, { phone: true })` stores the pairing with `phone: true`. Only the link form makes one:
  `bun life pair --link`, and the Mac panel's new **Pair your iPhone**, which shows that link as a QR code for the
  iPhone's Camera. It uses CoreImage, as Lifelog Host's `PairingCode` does, so there is no dependency.
  `pair --link <agent>` is refused, because a phone is never an agent. The panel's **Pair an app** and plain
  `bun life pair` make plain codes.
- **Phone clients.** In `paired()`, a phone code is accepted only for a client whose redirects are exactly
  `[PHONE_REDIRECT]`. The client it approves is stored with `phone: true` (`Stored.clients[id].phone`, optional;
  absent is false, which is true of every client stored today, so no migration). A plain code never sets it, and a
  phone code never approves any other client. So terminal Claude Code, a DCR loopback client stored on a typed code,
  can never pass as the phone, even if it registered the phone's exact redirect.
- **Approving.** `POST /auth/oauth2/authorize` with `request` is accepted only with a bearer token that meets all of
  these:
  - It is verified by the issuer's own `jwks`, with this issuer and this resource as audience, so the approver is on
    the request's own origin.
  - Its `client_id` is a stored client with `phone: true`.
  - It has no agent claim.

  ChatGPT's and Claude's metadata-document clients are never stored, so they are always refused. The POST only marks
  the request approved and answers the app's name and return host. It never returns a redirect or issues a code; only
  the waiting page's next GET does. The phone also refuses a link whose `life` origin is not the one it is paired with.
- **A new client without a Mac code.** A phone approval stores the requesting client: `issueCode` moves a pending DCR
  client into `clients`, as a typed code does today. The phone's tap is now a pairing in its own right. That is the
  point, and it is tested.
- **The cap.** Requests are capped at 20, oldest dropped, as `pending` is. An attacker can fill it and push out the
  person's request; ids are 128-bit, so they cannot approve or steal one. Accepted: the person presses **Connect**
  again. There is no per-source cap, because behind the edge and Funnel there is no source Life can trust.
- PKCE still binds the code to the client that started the sign-in. A request lasts 5 minutes and is used once.

Re-pairing: the owner's phone was paired before phone codes existed, so its client has no marker. It approves nothing
until he pairs it again once, from **Pair your iPhone**.

Left open: a person tricked into approving a link an attacker sent them, or into giving away a phone code. The sheet
shows the app's name and return host and says "only if you started this just now". That is the same exposure as a
typed code read out to someone.

## The bundles

**B1. Server: request-bound approval** (strict path `host/http/`: full workflow, plan review, confirming round). About
+170 / −40.

- `apps/server/src/host/http/oauth.ts`:
  - A GET of authorize with no code keeps a **sign-in request** in the issuer's memory (`requests`, beside `pending`
    and `codes`: id, the parsed authorize parameters, the client's name, expiry, approved or not; at most 20, oldest
    dropped).
  - The page carries `request=<id>` in its form and its `<meta http-equiv="refresh" content="2">`, so no script and no
    CSP change. It shows `lifelog://pair?life=<origin>&request=<id>`.
  - A POST of authorize with `request` and a phone client's bearer token (the trust boundary above) marks it approved
    and answers the app's name and return host, never a redirect or a code. A later GET with that `request` (the
    page's refresh) issues the code. Expired or used: "start again in Claude".
  - `pair(agent, { phone })`, `Stored.pairing.phone` and `Stored.clients[id].phone`. `paired()` accepts a phone code
    only for a `[PHONE_REDIRECT]` client and hands the flag on.
- `host/cli.ts:383-400`: `--link` makes a phone code and refuses an agent name.
  - Code issuing moves out of `authorize` into `issueCode(request, agent)` (today `oauth.ts:318-341`: keep a registered
    client, make the code, build the redirect). The typed code and the phone both call it.
  - `paired()` is not reused. It still checks and spends the one global `pairing` for a typed code only. A pending
    request never touches `pairing`, and the phone's approval spends nothing of it, so a code shown on the Mac stays
    good for another app meanwhile. The phone's approval is always a plain app (no agent claim); pairing an agent stays
    the Mac's code.
- `oauth.test.ts`, the trust boundary:
  - A phone client (paired by a phone code) approves, then the refresh gets the code. The approving POST's answer holds
    no redirect and no code.
  - A DCR client registered with `[PHONE_REDIRECT]` and approved by a plain typed code is refused.
  - A DCR loopback client like Claude Code's is refused.
  - A phone code typed for a non-phone client is refused, and the code is not spent.
  - Metadata-document clients (`claude.ai` and `chatgpt.com` documents, stubbed `fetchDoc`) are refused.
  - An agent token, no token, and a token for another audience are refused.
  - Expired; used twice; a 21st request drops the oldest.
- `oauth.test.ts`, the rest:
  - A phone approval stores a pending DCR client in `clients` with no Mac code, and its tokens then work.
  - A typed code still works with a request pending, and `pairing` is unchanged by a phone approval.
- No QR code and no new dependency (see question 1).
- Docs:
  - AGENTS.md "Life signs its own tokens" (needs his yes) and SECURITY.md's OAuth line.
  - Glossary: `pairing` (`glossary.md:18`: a phone code, made only as the link, marks the phone's client; the link
    also carries `request` to approve another app's sign-in). A new line:
    `| sign-in request | An app's sign-in waiting on Life's page for approval (oauth.ts): its authorize parameters, kept
    in the issuer's memory for 5 minutes, used once, at most 20. Approved by a typed pairing code, or by his phone's
    own client (a client a phone code approved, phone: true) opening the pairing link with request=<id>; the page's
    next GET then issues the code. Not a pairing (the code), not a client (the app), never stored. |`
  - `docs/architecture.md` (the connector section near line 195): sign-in requests live in the issuer's memory only,
    and a restart drops them.
  - `docs/use/connect.md` rewritten to the flow above.

**B2. Phone: the request in the pairing sheet, and Use Life in Claude** (`apps/lifelog/apps/ios`). About +180 / −10.

- Kit `LifeConnector/LifePairing.swift`: `LifePairing(link:)` also reads `request` (32 hex) as an alternative to
  `code`, the same origin rule. Its `origin` must equal the paired Life's, or the sheet refuses it.
- Kit `LifeConnector/OAuth.swift`: `LifeOAuth.approve(origin:request:)`, a POST to authorize with the current access
  token through `LifeHTTP`, answering the app's name and return host. `redirect` becomes the shared `PHONE_REDIRECT`
  name.
- `Lifelog/Settings/PairSheet.swift`:
  - `PairOffer` gains a request connection beside `.life` and `.server`.
  - `PairSheet` asks "Connect <app> to Life? It goes back to <host>" with **Approve** / **Not me**, then its usual
    steps and result.
  - Not paired with Life yet: "Pair with your Mac first".
- `Kit/Sources/Incidents/LinkAction.swift` needs no new case: a request link is a pair link (`isPairLink`), so it rides
  `.pair` and its one-at-a-time rule. Its tests gain a request link, pairing and not.
- `apps/mac/Sources/LifeApp/Panel.swift`: **Pair your iPhone** beside **Pair an app**, showing the
  `Helper.run(["pair", "--link"])` link as a QR code (CoreImage), for 5 minutes. About +30 lines.
- `Lifelog/Settings/LiveSettingsBlock.swift`: a **Use Life in Claude** row with `LifeEndpoint.resource`, **Copy** and
  **Add to Claude**.
- Tests: the link parser (request, code, both refused), `approve`'s request, `LinkAction` with a request link (Kit
  tests, made-up origin).

**B3. Plugin: no bundled connector; installable from the app** (`apps/claude-plugin`, docs). About +10 / −20. These
change together:

- Delete `apps/claude-plugin/.mcp.json` and `userConfig` from `plugin.json`, and rewrite `plugin.json`'s description
  (it no longer carries the connector). Version 2.0.0, so installed copies update. The old `connector_url` value stays
  in Claude's own settings, unread and harmless, and nothing migrates it.
- Move `apps/claude-plugin/.claude-plugin/marketplace.json` (`source: "./"`) to the repository root
  `.claude-plugin/marketplace.json` with `source: "./apps/claude-plugin"`. The marketplace and plugin names stay
  `life`, so the `life@life` check (`host/claude-app-listing.ts:127`, `readIsLifePluginOn`) and agent health still
  hold. Its comment names the new place.
- `docs/use/connect.md:47`: the terminal `claude plugin marketplace add <checkout>/apps/claude-plugin` becomes the Claude
  app's plugin settings with `eric-edouard/life`. Terminal Claude Code uses the account connector (it comes with the
  claude.ai sign-in), or `claude mcp add` from a checkout.
- Glossary "Life plugin" line: it no longer bundles the connector.

Order: B3 first (small, ends the "Not connected" now), then B1, then B2. They meet only at the link's `request` and
`PHONE_REDIRECT`, each tested on its side.

## Needs the owner's yes

- AGENTS.md, invariant "Life signs its own tokens": "an app … is approved by a pairing code from the Mac" becomes "an
  app … is approved by a pairing code from the Mac, or by his phone's own client on the pairing link bound to that
  sign-in". SECURITY.md's OAuth line changes with it.
- Dropping the plugin's bundled connector: anyone who used only the plugin adds the account connector once.

## Questions only he can answer

1. No QR code in this plan. On a computer, the person either presses **Connect** on the phone instead (the account
   connector reaches every app), or types the Mac's code. A QR code would need a small dependency (`uqr`) and adds a
   third way. Add it only if the phone path fails in testing?
2. The **Public** step is still the Mac's button. Move it to the phone as part of this, or keep it for now?
3. A plugin marketplace at the public repository's root makes the plugin findable by anyone with the link. Fine, or
   keep it in `apps/claude-plugin` until there are other users (then the app can't add it by repo name)?

To check while building: the prefilled link on a real account, and whether the Claude phone app's sign-in window opens
a `lifelog://` link (if not, the person copies the page's link into Life's Settings paste, which goes the same way).

## Debt plan

- Tier: hard (auth, a trust boundary, the public sign-in page).
- Inventory:
  - Server: approval by code `oauth.ts:105-117` (`paired`), the page `oauth.ts:296-317`, code issuing
    `oauth.ts:318-341`, `pair()` `oauth.ts:91-103` and `host/cli.ts:383-400` (`--link`), plain tokens `auth.ts:36-51`.
  - Mac: the panel's button `apps/mac/Sources/LifeApp/Panel.swift:93-107`.
  - Phone: link handling `Lifelog/RootView.swift:167-182`, `Kit/Sources/Incidents/LinkAction.swift`,
    `Lifelog/Settings/PairSheet.swift` (`PairOffer`, `PairSheet`),
    `Kit/Sources/LifeConnector/LifePairing.swift`, `LifeConnector/OAuth.swift` (`LifeOAuth`, its `redirect`),
    `LifeConnector/Credentials.swift` (`LifeEndpoint.resource`), and the lifelog server's own `ServerAPI/Pairing.swift`,
    which is untouched.
  - Plugin: `apps/claude-plugin/.mcp.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, and the
    check at `host/claude-app-listing.ts:122-130`.
  - Docs: `docs/use/connect.md`, `docs/glossary.md:18,113`, `docs/architecture.md:195`.
- Shape:
  - One approval door, authorize, with two proofs (the typed code, the phone's own client), both ending in
    `issueCode(request, agent)`.
  - One pairing link and one pairing sheet on the phone, extended with `request`.
  - No card, push, connector tool, new route, new dependency, or anything in `memory/`.
- State: sign-in requests in the issuer's memory only. The global `pairing` keeps its one meaning (the one live code),
  now with an optional `phone`; stored clients gain an optional `phone` (absent means false, so no migration).
- Deletes: the plugin's `.mcp.json` and `userConfig`, its nested marketplace file, the doc steps for
  `claude plugin marketplace add <checkout>`, and the code-only page as the main path.
- Net lines: about +290 (B1 +130, B2 +170 with the Mac panel's QR code, B3 −10). It adds a feature that replaces typing a code, with no second rule
  of approval.
- Plan review: reshaped after a fresh review (26 Nov).
  - One approval door: the existing `lifelog://pair` link and sheet carry `request`; no `/auth/approve`, no
    `ApproveSheet`.
  - Approval is bound to the phone's own stored client (`PHONE_REDIRECT`), not only "no agent claim".
  - `issueCode(request, agent)` is extracted; `paired()` and the global `pairing` are untouched by requests.
  - The public origin is a stated prerequisite, and the address comes from `LifeEndpoint.resource`.
  - B3 lists the marketplace move, `connect.md:47`, the `life@life` check and `plugin.json`'s description together.
  - Glossary and architecture lines added.
  - `uqr` and the QR code dropped (question 1).
  - Phone names re-inventoried. `LifePairing`, `LifeOAuth` (`OAuth.swift`) and `LifeHTTP` do exist in
    `Kit/Sources/LifeConnector`; `LifeApproval` was a proposed name and is now gone; `LinkAction` needs tests but no
    new case.
- Second review (26 Nov), on the trust boundary:
  - The redirect check could be forged, since registration is open. It is replaced by a stored `phone: true` that only
    a phone code (made only as the link, never for an agent, accepted only for a `[PHONE_REDIRECT]` client) sets.
  - The Mac panel gains **Pair your iPhone** (a QR code via CoreImage). The owner pairs his phone again once.
  - Tests are planned for these refusals: a DCR client with the phone's redirects on a plain code, a Claude Code-like
    loopback client, and metadata-document clients.
  - The approving POST never returns a redirect or a code. The approver's token must be this issuer's, for this
    audience, so it comes from the same origin.
  - It is stated and tested that a phone approval stores a new client with no Mac code.
  - The 20-request cap is accepted as a known denial of service (no trustworthy source to cap by).
  - The `sign-in request` glossary line is written out.

**Owner's yes (26 Nov 2026):** the new wording of "Life signs its own tokens" and its security line, dropping the plugin's bundled connector, and the QR library (since dropped from the plan). Open questions default to the plan's picks.
