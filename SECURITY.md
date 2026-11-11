# Security

Life is the owner's memory: it reads his most private data (voice, messages, mail, notes) and hands his asks to the
agents that act for him. This page says what it protects and what it does not.

## Where the data is

- Everything Life derives lives on the owner's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly refuses to commit to a repository that has one.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Notes, lifelog), opened read-only. The one copy Life
  keeps is the archive (`~/Library/Application Support/Life/archive/`): phone call history, messages deleted for everyone and old note
  versions.
- The owner's claude.ai and ChatGPT exports are kept whole as export copies in `imports/` of his data (outside its
  git), the assistant's replies included; they are read as data, never as his words.
- Search by meaning embeds on the Mac: Life sends the texts it searches only to Lifelog Host's embedder on loopback
  (`EMBEDDER_URL`, a constant in `core/embedder.ts`, lifelog's too); their vectors are derived
  (`derived/memory/vectors.sqlite`), kept out of exports.
- Secrets are in the macOS Keychain (Life.app) or `.env` (a checkout, gitignored); the secret files Life writes are
  named in `SECRETS` (`apps/server/src/core/secret.ts`), mode 600, and kept out of every export and backup.

## Models

Model calls that read his data run with no tools and no instruction files, and return JSON checked by schemas, with
every quote checked against its source. One call is given tools, and only when a developer runs it: the question
cases' agent (`scripts/question-cases.ts`, his word of 10 Nov 2026), Codex on his subscription with Life's connector
as its only tools, serving its reads and none of its writes. It has no shell, no web and a read-only sandbox, so
recorded content it reads can steer it to read more, and to nothing else. The text goes to the provider the owner chose (his subscriptions, or
OpenRouter and allmodels.io with his keys, through the hosts he chose; OpenRouter's only when it lists them as keeping no data). Photo descriptions are written on
the Mac by a local model (llama.cpp, `describePhotos` setting); no image goes to a provider.

## Agents

Life starts no agent, except an agent's own `onAsk` command, once per new ask, with no words and none of Life's
secrets (his OK, 3 Nov 2026), and the question cases' agent a developer's script starts to measure Life ("Models",
above; his word, 10 Nov 2026): each pulls its own asks through the connector. An agent run is outside Life's boundary: it has
the Mac's access (his files, his accounts). An agent sends as him only on his yes on the exact text, its own rule:
that is policy, not enforcement, and the risk is his, accepted.

## Network

The connector (`/mcp`) is served by the Mac, behind Life's own OAuth (pairing codes,
PKCE); Life serves no page; the app's local port needs a local key and is never exposed. Exposure is through his tailnet,
optionally a tunnel he controls.

## What leaves the Mac

The one list; nothing else leaves. lifelog (`apps/lifelog`), its own service, keeps its own in
[apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md).

- To the model provider he chose: the text Life reads, only through the hosts he chose and never one that keeps
  prompts (`docs/operations.md`, "Model engines"); Phone & FaceTime call lines reach the model exactly as WhatsApp
  call lines do (who, when, how long; no content), so nothing new leaves the Mac. With the `apple-health` source on,
  that text includes each day's Apple Health lines (sleep and workouts). With the `photos` source on, it includes each
  day's photo lines: times, Apple's place and address, coordinates to 10 m, scene words, the words Apple found in the
  photos, the names Apple's People gives, his captions and, with `describePhotos` on, Life's own one-paragraph description of each
  photo; never an image, a face or a face print.
- To Modal's GPUs, each once and only with his OK (photos: his OK of 11 Nov 2026): lifelog audio for the speaker re-split (11 Nov 2026), and each photo's
  1024-pixel preview for the one-off backfill of photo descriptions (`scripts/describe-photos-cloud.ts`). Held in the container's memory for its call and kept nowhere: no Volume, logs print counts only.
- To an assistant he connected, and to his agents: what they read through the connector or on the Mac. The question
  cases' agent is one: what it reads through the connector to answer a case goes to OpenAI through his Codex
  subscription (his word, 10 Nov 2026).
- By email to him (Resend), when `mail` is set: the nightly report and the alerts.
- To Google, when he set it: the Past calendar, the appointments (`appointments` setting, his request of 8 Nov 2026),
  and the to-do items with Google Tasks as the backend.
- To his own lifelog server: his corrections about recordings, and a "heard you" notice for each voice ask (the agent's
  name only, never his words), which lifelog pushes to his phone through Apple.
- The encrypted backup, when `backup` is set, to the folder he chose.
- Life's brand (nothing of his), at its paths in the repo, so his agents can style what they make.

## Known risks

- The connector's `tell_life` appends his verbatim words to the memory. Only the owner's token may call it (an agent's is
  refused), but a page or message a chat client reads could steer it into calling it. The worst case is a wrong fact in
  the memory, undone by a correction.
- Full Disk Access makes Life a high-value target on the Mac.
- Models misread: an observation is a model's reading with a checked quote, not a fact.
- His agents act with his access (above).

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
