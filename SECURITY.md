# Security

Life is the owner's memory: it reads his most private data (voice, messages, mail, notes) and hands his asks to the
agents that act for him. This page says what it protects and what it does not.

## Where the data is

- Everything Life derives lives on the owner's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly refuses to commit to a repository that has one.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Notes, lifelog), opened read-only. The one copy Life
  keeps is the archive (`~/Library/Application Support/Life/archive/`): messages deleted for everyone and old note
  versions.
- Search by meaning embeds on the Mac: Life sends the texts it searches only to Lifelog Host's embedder on loopback
  (`EMBEDDER_URL`, a constant in `core/embedder.ts`, lifelog's too); their vectors are derived
  (`derived/memory/vectors.sqlite`), kept out of exports.
- Secrets are in the macOS Keychain (Life.app) or `.env` (a checkout, gitignored); the secret files Life writes are
  named in `SECRETS` (`apps/server/src/core/secret.ts`), mode 600, and kept out of every export and backup.

## Models

Model calls that read his data run with no tools and no instruction files, and return JSON checked by schemas, with
every quote checked against its source. The text goes to the provider the owner chose (his subscriptions, or
allmodels.io with his key, through the hosts he chose).

## Agents

Life starts no agent, except an agent's own `onAsk` command, once per new ask, with no words and none of Life's
secrets (his OK, 3 Nov 2026): each pulls its own asks through the connector. An agent run is outside Life's boundary: it has
the Mac's access (his files, his accounts). An agent sends as him only on his yes on the exact text, its own rule:
that is policy, not enforcement, and the risk is his, accepted.

## Network

The connector (`/mcp`), the web app and the legacy portrait are served by the Mac, behind Life's own OAuth (pairing codes,
PKCE) and his password; the app's local port needs a local key and is never exposed. Exposure is through his tailnet,
optionally a tunnel he controls.

## What leaves the Mac

The one list; nothing else leaves. lifelog (`apps/lifelog`), its own service, keeps its own in
[apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md).

- To the model provider he chose: the text Life reads, only through the hosts he chose and never one that keeps
  prompts (`docs/operations.md`, "Model engines").
- To an assistant he connected, and to his agents: what they read through the connector or on the Mac.
- By email to him (Resend), when `mail` is set: the nightly report and the alerts.
- To Google, when he set it: the Past calendar, and the to-do items with Google Tasks as the backend.
- To his own lifelog server: his corrections about recordings.
- The encrypted backup, when `backup` is set, to the folder he chose.
- Life's brand (nothing of his), at its paths in the repo, so his agents can style what they make.

## Known risks

- Full Disk Access makes Life a high-value target on the Mac.
- Models misread: an observation is a model's reading with a checked quote, not a fact.
- His agents act with his access (above).

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
