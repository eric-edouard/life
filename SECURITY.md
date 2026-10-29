# Security

Life is the owner's memory and the start of his agents: it reads his most private data (voice, messages, mail, notes)
and wakes the agents that act for him. This page says what it protects and what it does not.

## Where the data is

- Everything Life derives lives on the owner's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly refuses to commit to a repository that has one.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Beeper, Notes, lifelog), opened read-only. The one copy Life
  keeps is the archive (`~/Library/Application Support/Life/archive/`): messages deleted for everyone and old note
  versions.
- Secrets are in the macOS Keychain (Life.app) or `.env` (a checkout, gitignored); the secret files Life writes are
  named in `SECRETS` (`apps/server/src/core/secret.ts`), mode 600, and kept out of every export and backup.

## Models

Model calls that read his data run with no tools and no instruction files, and return JSON checked by schemas, with
every quote checked against its source. The text goes to the provider the owner chose (his subscriptions, or
allmodels.io with his key, through the hosts he chose).

## Agents

Life starts his agents: the asks loop on each ask, the loops on their schedule and on the events they wait on (a
message from someone, his words). An agent run is outside Life's boundary: it has the Mac's access (his files, his
accounts) and none of Life's secrets in its environment. What it may do is set by his grants and his answers to
his decisions (life-loops' protocol), and a send needs his yes on the exact text. Life's own send (`bun life send`,
`host/send.ts`) enforces that in code: only the draft of the option he answered, once, and never after a newer message
from them. An agent with the Mac's access can still send another way: that is policy, not enforcement, and the risk
is his, accepted.

## Network

The connector (`/mcp`) and the portrait are served by the Mac, behind Life's own OAuth (pairing codes, PKCE) and the
portrait's password; the app's local port needs a local key and is never exposed. Exposure is through his tailnet,
optionally a tunnel he controls.

## What leaves the Mac

The one list; nothing else leaves. lifelog (`apps/lifelog`), its own service, keeps its own in
[apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md).

- To the model provider he chose: the text Life reads, only through the hosts he chose and never one that keeps
  prompts (`docs/operations.md`, "Model engines").
- To an assistant he connected, and to his agents: what they read through the connector or on the Mac; to a pushed
  agent, one MCP event per ask with its words (callbacks on OpenAI's hosts only, verified first).
- By email to him (Resend), when `mail` is set: the nightly report and the alerts.
- To Google, when he set it: the Past calendar, and the to-do items with Google Tasks as the backend.
- To his own lifelog server: his corrections about recordings.
- To a chat, when `sends` is set: the reply he chose in a decision, as him, through that network (a bridge on his
  local Matrix homeserver for WhatsApp; `docs/use/bridges.md`).
- The encrypted backup, when `backup` is set, to the folder he chose.
- Life's brand (nothing of his), at its paths in the repo, so his agents can style what they make.

## Known risks

- Full Disk Access makes Life a high-value target on the Mac.
- Models misread: an observation is a model's reading with a checked quote, not a fact.
- His agents act with his access (above).

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
