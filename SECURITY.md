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
  named in `SECRETS` (`apps/server/src/core/secret.ts`), mode 600, and kept out of every export and backup. One is gog's keyring
  password (`bun life gog-keyring`), a file and not a Keychain item: the app blocks on the prompt a new item raises.

## Models

Model calls that read his data run with no tools and no instruction files, and return JSON checked by schemas, with
every quote checked against its source. One call is given tools, and only when a developer runs it: the question
cases' agent (`scripts/question-cases.ts`, his word of 10 Nov 2026), Codex on his subscription with Life's connector
as its only tools, serving its reads and none of its writes. It has no shell, no web and a read-only sandbox, so
recorded content it reads can steer it to read more, and to nothing else. The text goes to the provider the owner chose (his subscriptions, or
OpenRouter and allmodels.io with his keys, through the hosts he chose; OpenRouter's only when it lists them as keeping no data). Photos of his Photos library are described on the Mac by
a local model (llama.cpp, `describePhotos` setting): none of those images goes to a provider. A file inside a
message (a photo, a PDF's pages) is described by the provider's fast model: that image goes to the provider, once,
when its message arrives or at night (his word of 19 Nov 2026).

## Agents

The desk (off until his `desk` setting) starts and wakes his registered agents: with `desk.handOut` set it also starts one itself, on a running matter from the top of his ranking, within the pace he set (his word of 20 Nov 2026): Life picks the matter by its ranking, the brief is a constant, the agent reads the matter as data, and nothing outward goes without his yes on a card. A registered agent is started by
Life, unattended, on a message its wait names (by who wrote it, by chat or app, or by a pattern on its text, his word of 20 Nov 2026), a recorded call with them that ended, a payment its wait names (by amount, or by a pattern on the merchant, the category or his note; his word of 20 Nov 2026), an arrival at a place its wait names (by its coordinates, or a pattern on its name; his word of 20 Nov 2026), his answer or its deadline, and acts with his access. A wait on words is met by
anyone who writes them, a sender Life has never seen included. With the hand-out on, a message from anyone can become a matter that ranks first, but the desk starts an agent only on a matter involving someone he knows or holding a step he said himself (his word of 20 Nov 2026), so a stranger's words alone start none; one who writes to a person he knows, to whom he has replied, or whose words became an item of his to-do list, can still reach one, and the agent, unattended, reads that matter's words as data. His pace setting and the card gate (nothing outward without his yes) bound it. A wait on a merchant's words is met by anyone whose payment or transfer label carries them. An agent is woken by events at most once
per 10 minutes after its last turn. An
agent on a matter is also woken by anything new related to it (the wide net, his word of 18 Nov 2026): a message from
one of the matter's people, or a message or recording of his close to the matter in meaning, as the Mac's embedder
reads it (`desk/matter-net.ts`: no model call, nothing leaves the Mac). The wake hands it only the facts (which
message or recording, or which payment, with its amount, in EUR too, its currency, whether it is spending and the money app's category, or which arrival, with its time and coordinates, when, why), never the text, a matched one included; it reads the words itself, as data. On
his Mac and the web an agent of his own Life is free (his decision of 19 Nov 2026): the desk runs it in the runtime's
no-ask mode, approves every ask, and gives it his login environment. It can run any command, read, change or delete any
file, install software, browse, read his mail and messages, and read his secrets (his shell's keys, 1Password). Life's
own Keychain secrets are not handed to it. Its one gate is his rule: anything outward in his name waits for his yes on
the exact thing. One part of that gate is enforced, sending (his word of 20 Nov 2026, "yes you can add it"): Life's send
guard (`desk/send-guard.ts`, its rules in `SEND_RULES`) runs before each shell and MCP call of an agent of his own Life,
a hook of the session's own flags (nothing written into his `~/.claude` or `~/.codex`), and refuses: a connector's send,
reply or forward (mail, Beeper), an answer to an invitation, an event with attendees other than him (a connector's or `gog calendar`'s), `gog gmail`'s
send, reply or forward, `imsg send`, `osascript` telling Messages or Mail to send, `resend` to anyone but his own addresses, a browser or computer
use on a messaging site or app, and a `gh` post (an issue, a comment, a review) except on the repos he listed
(`desk.agentPostRepos`, his word of 20 Nov 2026) with the body ending with `AGENT_POST_SIGNATURE`: there an agent's
words reach other people in his name without his yes on the text, and the agent is told to post only facts and
questions and to put anything that commits him on a card. A failure of the guard refuses the call. The guard is
partial: it reads a call's text, so a tab already open on a messaging site, a script that builds an address or URL, `gh api`
or `curl` to a service's API, `node_repl`, `javascript_tool`, full-screen computer use (it names no app), a shell the agent starts and then types into
(Codex's `write_stdin`) or another program the agent starts get past it, and the agent can edit the guard's file in a
checkout. It also refuses a little too much: any call that names a messaging site, reading Gmail in a browser included. Submitting a form, booking, paying, `gh pr create` and pushes stay its
instruction only. A turn that fails keeps the adapter's last error lines in the desk's store; with his environment passed
in, those lines may hold whatever the adapter printed. Its door
is on loopback only; each agent's key is derived from the desk's key and reaches its session only in its environment.
Besides the desk, Life starts no agent, except an agent's own `onAsk` command, once per new ask, with no words and none of Life's
secrets (his OK, 3 Nov 2026), and the question cases' agent a developer's script starts to measure Life ("Models",
above; his word, 10 Nov 2026): each pulls its own asks through the connector. An agent run is outside Life's boundary: it has
the Mac's access (his files, his accounts). The risk that remains: an agent acting on text it read can do, alone, anything his keys allow but what the send guard
refuses, a send by a path the guard can't read included; past the guard, the gate is its instruction, not enforcement. Between that and harm stand the model's judgment, wakes
that hand facts and never words (a payment's category, the money app's own word, is a fact; a text can choose a wake, never ride on it), and Life's own send path (a card's draft, his answer). The risk is his, accepted.

A card that asks him to pay (`doneSeenBy: "payment"`) makes Life read his payments on the Mac, on his "I've paid" and every 5 minutes while the card is open, and match amounts only (money out of the card's amount in its currency, on or after the card's day; never a name or a merchant): its asker learns only which payment matched (its event id). Nothing of it leaves the Mac.

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
  photo; never an image, a face or a face print of the Photos source. The images of the files in his messages (a
  photo, a PDF's pages), once each, when the message arrives or at night (his word of 19 Nov 2026). The episodes call also sees the email addresses
  of the people its day involves (his directory and Contacts cards), so a legal name can be tied to a nickname (his yes
  of 20 Nov 2026). A voice note's words, as text, like the rest.
- A chat's voice note (a chat message's audio; mail's and Notes' audio stay tags) to lifelog's speech service on this Mac; the turns it hears as Thai or another
  language it routes, cut from the audio, to ElevenLabs Scribe, as the pendant's (his yes of 20 Nov 2026;
  [apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md)). Once per note: its file's sha256 is the claim.
- To a registered agent's runtime (his Claude subscription, or his Codex subscription: OpenAI): its brief and packet
  (his words, its notes, the facts of its queued events (for a payment: its amount, in EUR too, its currency, whether it is spending, the money app's category, and when; for an arrival at a place: when he arrived, and where: its coordinates), its open decision) (his yes to the desk, 18 Nov 2026; his
  yes to Codex as a runtime, 18 Nov 2026).
- To an assistant he connected, and to his agents: what they read through the connector or on the Mac; a wait's own
  coordinates (`near` in `wakesOn`) are in the reads `read_registered_agents` and `read_matter`. The question
  cases' agent is one: what it reads through the connector to answer a case goes to OpenAI through his Codex
  subscription (his word, 10 Nov 2026).
- By email to him (Resend), when `mail` is set: the nightly report and the alerts.
- Into one chat of his, through Life's own bridge for that network (WhatsApp, Instagram, Messenger, LinkedIn), or through the
  Messages app (iMessage, as he would send it himself: a file is written for a moment to `~/Pictures/Life sends`; the one
  macOS grant is Automation, Life → Messages, asked at the first send): a card's
  draft, its exact text and the one file he approved (it leaves the Mac for the network, through its bridge), once, on
  his answer to its outgoing option (his decision of 18 Nov 2026; AGENTS.md). Asking a
  card for a new WhatsApp chat sends the number to WhatsApp, through its bridge, to ask whether it has an account.
- By Gmail, through gog, as a mail from one of his accounts: a card's draft (from, to, cc, subject, text and one file he
  approved), once, on his answer to its outgoing option. It goes to Google's Gmail API, then to its recipients; a file is
  written for a moment to a private temporary folder for gog, and removed after.
- To GitHub, through `gh` as his account, with the `github` source on: requests for the issues and comments of the repos
  he listed in `githubRepos`, and nothing else; and a card's draft (a comment's text, or a new issue's title and text),
  once, on his answer to its outgoing option, into one of those repos (his yes of 19 Nov 2026).
- To Google, when he set it: the Past calendar, the appointments (`appointmentsCalendar` setting, his request of 8 Nov 2026),
  and the to-do items with Google Tasks as the backend.
- To his own lifelog server: his corrections about recordings, a "heard you" notice for each voice ask (the agent's
  name only, never his words), and, for each new card in his
  inbox, a push (his yes of 18 Nov 2026; every kind of card since 19 Nov 2026): the words "1 new card" or "N more new
  cards", the number of cards that block him (the badge), the push's level (passive, active or time-sensitive) and,
  for one card, an id of 16 hex characters made with a key that never leaves the Mac (never a ref, a name, a title or
  a question). Lifelog pushes it to his phone through Apple; his phone then reads the card from the connector and
  writes the notification's text itself, shown on his lock screen and his Watch.
- The encrypted backup, when `backup` is set, to the folder he chose.
- Life's brand (nothing of his), at its paths in the repo, so his agents can style what they make.

## Known risks

- The connector's `tell_life` appends his verbatim words to the memory. Only the owner's token may call it (an agent's is
  refused), but a page or message a chat client reads could steer it into calling it. The worst case is a wrong fact in
  the memory, undone by a correction.
- The connector's `change_directory_entry` writes his `truth/` (people, projects, areas, goals, what Life may keep) from his words as `said`; `answer_check` adds a person or an organization through the same code when he names one no one holds by that name (`addDirectoryEntryByHisWord`). Owner's token only; it adds or replaces one entry, never deletes, and refuses, changing nothing, a result that fails the checks of `bun life validate`. A steered call could add a wrong entry: it is committed in his data repo with his words, so it can be undone.
- A session in his own app (his token) asks a draft card (`request_decision`, as `owner`) and answers it with
  `answer_check` once he approved the exact text in its chat, which sends it (his word of 19 Nov 2026). A page or
  message the client reads could steer it into both: the gate is the client's honesty about his yes, policy not
  enforcement, as for any answer his token records; the card stamps the chat and text, and the send is logged.
- The phone's notification extension reads the app's tokens (Life's and lifelog's: one Keychain group), to read a card
  for its notification (`NotificationService`). A draft sent from a notification, on the phone or the Watch, rests on
  that device being unlocked, and on Face ID at that tap only when his setting asks for it (`NotificationContent`).
- Full Disk Access makes Life a high-value target on the Mac.
- Models misread: an observation is a model's reading with a checked quote, not a fact.
- His agents act with his access (above).

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
