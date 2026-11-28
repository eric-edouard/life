# Security

Life is the owner's memory: it reads his most private data (voice, messages, mail, notes) and hands his asks to the
agents that act for him. This page says what it protects and what it does not.

## Where the data is

- Everything Life derives lives on the owner's Mac: the data root (`truth/`, `memory/`) is a local git repository with
  no remote. The nightly refuses to commit to a repository that has one.
- Raw data stays in its own app (Messages, Mail, WhatsApp, Notes, the voice server), opened read-only. The one copy Life
  keeps is the archive (`~/Library/Application Support/Life/archive/`): phone call history, messages deleted for everyone and old note
  versions.
- The owner's claude.ai and ChatGPT exports are kept whole as export copies in `imports/` of his data (outside its
  git), the assistant's replies included; they are read as data, never as his words.
- A deletion he asks for (`delete_from_memory`) is a marker in `memory/corrections.jsonl`: what he deleted stops being
  read anywhere, but the words themselves stay where their sources hold them (the app's own store, the archive, the voice server)
  and in his data repo's git history and backups. Purging them needs code that does not exist yet: `withSources` records
  his word that those copies go too, nothing more.
- His thread with Life (`read_thread`) keeps a second copy of his own words to Life, and Life's answers to them, on the
  Mac, in the desk's store (`desk.sqlite`, `thread_entry`), outside `memory/` so Life never reads its own answers back
  as his life. A deletion names every entry whose words or answer hold the deleted words, or whose refs cite what it
  deletes or reaches (the preview lists them first): the thread hides it at once, and the desk blanks it in place on its
  next tick (words, answer and screen emptied, the row and its time kept); an answer never writes back onto it. An
  entry asked before this, citing what he deleted, is hidden at read. His instructions (`memory/instructions.jsonl`)
  quoting the deleted words go the same way as the rest of memory: one `deleted` marker naming them, applied at read;
  the file keeps their line, like his data repo's history and backups. What still holds the words: the voice server, the archive,
  the apps' own stores, the backups and the git history (life#1384's other steps).
- Search by meaning embeds on the Mac: Life sends the texts it searches only to Lifelog Host's embedder on loopback
  (`EMBEDDER_URL`, a constant in `core/embedder.ts`, the voice server's too); their vectors are derived
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
a local model (llama.cpp, `describePhotos` setting): none of those images goes to a provider. Today's arriving mail is sieved first by Apple's on-device model (Foundation Models, never Private Cloud Compute): nothing leaves the Mac for it, and a mail it calls automated goes no further by day. The rest (a person's mail, any it refuses, Thai mail, every mail when this Mac has no Apple model) and today's arriving chat lines, mail and chat alike with their sitting (the thread's earlier lines that day), and the turns of a closed voice conversation he spoke in go to his provider, like the night's. A file inside a
message (a photo, a PDF's pages) is described by the provider's fast model: that image goes to the provider, once,
when its message arrives or at night (his word of 19 Nov 2026).

Every read of message, mail, note and file text that a model or a reader sees goes through `redact` (`core/redact.ts`):
card numbers, IBANs, key blocks, lines that look like a password or code, long tokens. One exception (his yes of 28 Nov
2026): on Life's own payment card (a your move card whose step names an amount), the payee's IBAN, exactly as the
payee wrote it in that step's message or its file, sits in the card's `account` need, and only when his own app reads
it (`read_inbox` and `read_matter` on his token: `withPayeeAccountsOf`). The checks every other reader shares (agents,
the reads-only connector, complaints, the nightly, pushes, the CLI) never hold it. An app on his token that is a chat
with a model (his Claude or ChatGPT) passes it to that model's provider. Life never pays: he does, in his bank's app.

## Agents

The desk (off until his `desk` setting) starts and wakes his registered agents, created only on his word (a project's, or the Personal agent; the desk registers the Personal agent itself, one at most, for a confirmed arrival no matter's agent takes, Direction's ruling of 21 Nov 2026, and the caretaker on his complaint): with `desk.handOut` set it also gives one a matter itself, from the top of his ranking, within the pace he set (his word of 20 Nov 2026): Life picks the matter by its ranking and the agent that takes it by code (`agentForOf`), the agent reads the matter as data, and nothing outward goes without his yes on a card. A registered agent is started by
Life, unattended, on a message its wait names (by who wrote it, by chat or app, or by a pattern on its text, his word of 20 Nov 2026), a recorded call with them that ended, a payment its wait names (by amount, or by a pattern on the merchant, the category or his note; his word of 20 Nov 2026), an arrival at a place its wait names (by its coordinates, or a pattern on its name; his word of 20 Nov 2026), his answer or its deadline, and acts with his access. A wait on words is met by
anyone who writes them, a sender Life has never seen included. With the hand-out on, a message from anyone can become a matter that ranks first, but the desk gives an agent only a matter involving someone he knows or holding a step he said himself (his word of 20 Nov 2026), so a stranger's words alone hand out none; one who writes to a person he knows, to whom he has replied, or whose words became an item of his to-do list, can still reach one, and the agent, unattended, reads that matter's words as data. His pace setting and the card gate (nothing outward without his yes) bound it. A wait on a merchant's words is met by anyone whose payment or transfer label carries them. An agent is woken by events at most once
per 10 minutes after its last turn. An
agent on a matter is also woken by anything new related to it (the wide net, his word of 18 Nov 2026): a message from
one of the matter's people, or a message or recording of his close to the matter in meaning, as the Mac's embedder
reads it (`desk/matter-net.ts`: no model call, nothing leaves the Mac). His words through Ask Life, and his spoken ask ("hey Life", `desk/spoken-ask-intake.ts`: words heard with low confidence, a
misheard wake or another voice, run no turn), go to the main session alone (`desk/main-session.ts`), as his own prompt, by the connector over the door's loopback with the local key; it acts with full power on his word (his yes of 21 Nov 2026), through its door alone: `answer` (why, sources or likely answers added to its words), `request_decision` (a card asked as his own), `change_registered_agent` (his word about his agents, `hand_over` included, never on itself), `tell_agent` (his words to one agent, read by it as data), `correct_memory` (a fact or a matter), `complain` (to the caretaker), and the connector's own writers for his to-do list (`change_todo_item`), his calendar's appointments (`change_appointment`), what he tells Life (`tell_life`), his monthly amount (`change_setting`, his yes of 25 Nov 2026) and his directory (`change_directory_entry`, checked on a copy first) (his rulings of 22 Nov 2026: "Ask Life should have everything"), each only on a turn of his words and only with `said`, words the door finds in what he sent that turn: recorded text it reads can supply no `said`, though `said` proves only that the words are his, not that the act matches them. The guard still refuses its sends and his connector's writes, as any agent's, so anything outward in his name stays a card he taps; beyond that it is one of his own sessions like any agent. The wake hands it only the facts (which
message or recording, or which payment, with its amount, in EUR too, its currency, whether it is spending and the money app's category, or which arrival, with its time and coordinates, when, why), never the text, a matched one included; it reads the words itself, as data. A wake on a matter also opens with Life's own record of it (its steps as Life derived them, its goal and next step, the assignment's notes; never a quote): Life's reading, never an event's text. On
his Mac and the web an agent of his own Life is free (his decision of 19 Nov 2026): the desk runs it in the runtime's
no-ask mode, approves every ask, and gives it his login environment. It can run any command, read, change or delete any
file, install software, browse, read his mail and messages, and read his secrets (his shell's keys, 1Password). Life's
own Keychain secrets are not handed to it. His "Continue on your Mac" runs pi's own interface on an agent's session in Terminal with Life's extension, so the guard below holds there too; its launch file (Life's part of the run's environment: the engine's key, the door's key) is written only he reads and deleted by the launcher as it reads it, or by the desk when the Mac does not answer (`desk/runtimes/pi-terminal.ts`). Its one gate is his rule: anything outward in his name waits for his yes on
the exact thing. One part of that gate is enforced, sending (his word of 20 Nov 2026, "yes you can add it"): Life's send
guard (`desk/send-guard.ts`, its rules in `SEND_RULES`) runs before every tool call of an agent of his own Life,
a hook of the session's own flags (nothing written into his `~/.claude` or `~/.codex`), and refuses: a connector's send,
reply or forward (mail, Beeper), an answer to an invitation, an event with attendees other than him (a connector's or `gog calendar`'s), `gog gmail`'s
send, reply or forward, `imsg send`, `osascript` telling Messages or Mail to send, `resend` to anyone but his own addresses, a browser or computer
use on a messaging site or app, and a `gh` post (an issue, a comment, a review) except on the repos he listed
(`desk.agentPostRepos`, his word of 20 Nov 2026) with the body ending with `AGENT_POST_SIGNATURE`: there an agent's
words reach other people in his name without his yes on the text, and the agent is told to post only facts and
questions and to put anything that commits him on a card. An agent of his own Life on pi reaches the connector's reads only (`life connector-reads`, its reads-only server over stdio, no token: no write tool is registered there); its reader process holds Life's paths and the secrets its reads use (`LIFELOG_TOKEN` among them), which a process of his can read from its starting environment (`ps -E`), as it can the desk's. A pi agent's session (its tool calls and what they answered, whatever a command printed) stays in pi's own session file on the Mac; no tool reads it. A pi agent's `subagent` is a session inside the same pi process, under the same guard, with no door and no connector. It also refuses an agent's writes through his own Life connector, which its session carries with his token: `answer_check`, `ask_main_session` (his words to the main session), `request_decision`, `change_directory_entry`, `change_registered_agent`, `change_todo_item`, `correct_memory` and `tell_life`, on any server but its own `desk` door, named whole, and any name Codex shortened that could be one of them (the direction session's ruling, under his word of 20 Nov 2026); the reads stay free. A failure of the guard refuses the call. The guard is
partial: it reads a call's text, so a tab already open on a messaging site, a script that builds an address or URL, `gh api`
or `curl` to a service's API (the door's `/main-session` too, with the local key read from Life's state), `node_repl`, `javascript_tool`, full-screen computer use (it names no app), a shell the agent starts and then types into
(Codex's `write_stdin`) or another program the agent starts get past it, a turn he types himself into an agent's session runs without the guard unless the Life plugin is installed (it asks the desk's guard before every tool call there, and refuses all but the file tools when the guard fails; there it also approves every permission ask the guard lets through, as the desk's no-ask mode does, never a deny or an organization's ceiling; a session of an agent it never looked up, first opened while Life is down, runs unguarded), and the agent can edit the guard's file in a
checkout. It also refuses a little too much: any call that names a messaging site, reading Gmail in a browser included. Submitting a form, booking, paying, `gh pr create` and pushes stay its
instruction only, as does a one-off project's first look staying read-only on his things until he approves a preview (the owner's decision of 28 Nov 2026): the guard cannot tell a read from a change on his Mac. A turn that fails keeps the adapter's last error lines in the desk's store; with his environment passed
in, those lines may hold whatever the adapter printed. Its door
is on loopback only; each agent's key is derived from the desk's key and reaches the sessions the desk starts in their environment, and the Life plugin's module (never the model) for a session he opens himself: the door's `/session/<ref>` gives it to any process of his that knows the session's id, as `desk.key` already does. The key names an agent; it is no wall between his own processes.
His complaint (his words through Ask Life; "Wrong…" on a card of Life's opens it) is his hand-over to the caretaker, a
registered agent like the others, which the desk keeps standing from its start: it reads his words and the card on
his screen as Life read it through its door,
only a complaint its own assignment received, as data; the complaint is never listed, fed to the change feed or pulled
by another agent, and his tick on the anonymized report only asks the caretaker for a card with its exact text.
It corrects Life's memory itself (`correct_memory`), only with `said` found in the words of a complaint at work on its
assignment: recorded text it reads can supply none (his ruling of 22 Nov 2026).
Besides the desk, Life starts no agent, except the question cases' agent a developer's script starts to measure Life
("Models", above; his word, 10 Nov 2026), which reads through the connector. An agent run is outside Life's boundary: it has
the Mac's access (his files, his accounts). The risk that remains: an agent acting on text it read can do, alone, anything his keys allow but what the send guard
refuses, a send by a path the guard can't read included; past the guard, the gate is its instruction, not enforcement. Between that and harm stand the model's judgment, wakes
that hand facts and never words (a payment's category, the money app's own word, is a fact; a text can choose a wake, never ride on it), and Life's own send path (a card's draft, his answer). The risk is his, accepted.

A card that asks him to pay (`doneSeenBy: "payment"`) makes Life read his payments on the Mac, on his "I've paid" and every 5 minutes while the card is open, and match by code (money out of the card's amount in its currency, on or after the card's day, whose merchant holds every word of the card's payee): its asker learns only which payment matched (its event id). Nothing of it leaves the Mac.

## Network

The connector (`/mcp`) is served by the Mac, behind Life's own OAuth (pairing codes,
PKCE). Its origin also forwards `/voice/…` to the voice server on loopback, as it came, behind the voice server's own tokens
(never its map page). Life serves no page; the app's local port needs a local key and is never exposed. Exposure is through his tailnet,
optionally a tunnel he controls.

Life's helper reads voice's `secrets.json` (owner-only; `host/voice.ts` its one writer): to start voice's launchd jobs
with their keys and to read voice with the phone's device token. His own Life.app's "Pair an app" QR (never a checkout's or a second
Life's: `pairTokenOf`) carries that device token and voice's address beside Life's pairing code, so one scan pairs both: anyone who sees the QR in its 5 minutes holds
the whole voice archive (his yes of 28 Nov 2026). Life.app writes voice's keys only through the helper (`life voice
key`, on stdin, never an argument).

## What leaves the Mac

The one list; nothing else leaves. The voice server (`apps/lifelog`), its own process, keeps its own in
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
  of 20 Nov 2026). A voice note's words, as text, like the rest. With payments on, the matter directions call also sees,
  for each matter it drafts that holds an open step, at most 5 of his payments in its window sharing a word of its name:
  amount, currency, merchant, the money app's category and his note (matter evidence; on his yes to this line).
  The voice naming also sees, for a part of a spoken conversation, the events of his calendar (`appointmentsCalendar`'s,
  read only, Life's own left out) that overlap it: each guest it offers as a possible speaker (a name, or an address no
  one is known by), with the event's title and time in their brief (his yes of 22 Nov 2026: that provider already gets his
  messages).
- A chat's voice note (a chat message's audio; mail's and Notes' audio stay tags) to the voice server's speech service on this Mac; the turns it hears as Thai or another
  language it routes, cut from the audio, to ElevenLabs Scribe, as the pendant's (his yes of 20 Nov 2026;
  [apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md)). Once per note: its file's sha256 is the claim.
- A field's dictation on his phone (`POST /dictation/transcript`) to the voice server's speech service on this Mac; the turns it
  hears as Thai, or all of it when mostly Thai, with vocabulary hints that can name people, to ElevenLabs Scribe under
  its ordinary retention (his decision, 21 Nov 2026; [apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md)). Once per
  dictation; the voice server keeps no audio and no words.
- Instant dictation, only while his `dictationHeard` switch is `instant` (Settings, Dictation: "Instant (ElevenLabs)"; off by default): the phone streams a field's dictation straight to ElevenLabs Scribe (realtime) with a single-use token this Mac mints only then (`POST /live-words/token`); the ElevenLabs key never leaves the Mac, and the voice server keeps no audio and no words. A run whose stream fails is heard on the Mac as above, so its Thai turns may reach Scribe a second time (his ask, 22 Nov 2026; [apps/lifelog/SECURITY.md](apps/lifelog/SECURITY.md)).
- To a registered agent's runtime (his Claude subscription, his Codex subscription: OpenAI, or pi on OpenRouter with Life's key, to the memory's hosts that keep nothing only, DeepInfra and Morph: the owner's yes of 22 Nov 2026, relayed by the orchestrator session, `docs/plans/pi-runtime.md`): its brief and packet
  (his words, its notes, the facts of its queued events (for a payment: its amount, in EUR too, its currency, whether it is spending, the money app's category, and when; for an arrival at a place: when he arrived, and where: its coordinates), its open decision) (his yes to the desk, 18 Nov 2026; his
  yes to Codex as a runtime, 18 Nov 2026).
- From an agent of his own Life on pi, its `web_search` queries, with his key, to the providers his `desk.webSearch`
  names, else in Life's order (the owner's yes of 22 Nov 2026, relayed by the orchestrator session): Tavily (1,000 free
  credits a month; the account's terms, not reviewed here), Serper (Google's
  results; its privacy policy, reviewed 5 Nov 2025, keeps access and activity logs while the account exists and names
  no shorter term for queries), the Brave Search API, then Perplexity's Search API; SerpAPI only when he names it. Each
  paid search's price counts in the agent's turn.
- To Apify (apify.com), with the token he gave Life's Mac app: his agents' store searches (`find_apify_actors`,
  a query), and, only on his pick of a card's `runs` option alone, that card's actor and input exactly as he saw
  them, held under the card's dollar cap by Apify (his word of 22 Nov 2026: "don't waste his credits without him
  knowing"). The token stays in the Keychain and the helper; Life strips `APIFY_TOKEN` from the login environment its
  agents get. An agent of his own Life that finds a token elsewhere (a skill, an MCP server, 1Password) is held only
  by its brief.
- To an assistant he connected, and to his agents: what they read through the connector or on the Mac; a wait's own
  coordinates (`near` in `wakesOn`) are in the reads `read_registered_agents` and `read_matter`. The question
  cases' agent is one: what it reads through the connector to answer a case goes to OpenAI through his Codex
  subscription (his word, 10 Nov 2026). People's pictures, to any app he paired, never to a paired agent
  (`read_person_pictures`; his word of 20 Nov 2026).
- By email to him (Resend), when `mail` is set: the nightly report and the alerts.
- Into one chat of his, through Life's own bridge for that network (WhatsApp, Instagram, Messenger, LinkedIn), or through the
  Messages app (iMessage, as he would send it himself: a file is written for a moment to `~/Pictures/Life sends`; the one
  macOS grant is Automation, Life → Messages, asked at the first send): a card's
  draft, its exact text and the one file he approved (it leaves the Mac for the network, through its bridge), once, on
  his answer to its outgoing option (his decision of 18 Nov 2026; .claude/rules/acts-and-sends.md); a batch card's
  drafts, each into its own chat, each exactly as shown and checked on its own, on his one answer (the owner's decision
  of 28 Nov 2026; refused until his app shows every draft). Asking a
  card for a new WhatsApp chat sends the number to WhatsApp, through its bridge, to ask whether it has an account.
- By Gmail, through gog, as a mail from one of his accounts: a card's draft (from, to, cc, subject, text and one file he
  approved), once, on his answer to its outgoing option. It goes to Google's Gmail API, then to its recipients; a file is
  written for a moment to a private temporary folder for gog, and removed after. One such card is the caretaker's
  feedback: its audit of something Life's code got wrong, anonymized by the caretaker (no names, places, messages or
  handles of his), as a mail to Life's developer (`DEVELOPER_CONTACT`, the alias `feedback@ericedouard.com`), sent only on his Send of that exact text (his
  ruling of 22 Nov 2026: "Bug reports should be an email to me. It just writes an email through their usual gate").
- To GitHub, through `gh` as his account, with the `github` source on: requests for the issues and comments of the repos
  he listed in `githubRepos`; and a card's draft (a comment's text, or a new issue's title and text),
  once, on his answer to its outgoing option, into one of those repos (his yes of 19 Nov 2026). And, while an agent's wait names one (`github_activity`), requests for the events of the repos the open waits name (`owner/name`, or an owner's repos listed with `gh repo list`), read for a wake and never kept (his direction of 20 Nov 2026, life#774).
- On his Undo of a sent card (his yes of 25 Nov 2026): a delete for everyone of that one message, a redaction through
  its bridge where the room's own features allow it then, or his GitHub comment deleted through `gh`; never iMessage or mail.
- To Google, when he set it: the Past calendar (its episodes, and its screen blocks: a device, its time span and its top apps by name; his yes of 22 Nov 2026), the appointments (`appointmentsCalendar` setting, his request of 8 Nov 2026), an agent's event he said yes to on its card (its title, times, reminders and place, once, into the same calendar; his word of 21 Nov 2026),
  and the to-do items with Google Tasks as the backend.
- To his own voice server: his corrections about recordings, for each voice ask a "Life heard you" notice, then its outcome
  under the same id ("Life answered" or "Life couldn't do it"), never his words or Life's, and, for each new card in his
  inbox, a push (his yes of 18 Nov 2026; every kind of card since 19 Nov 2026): the words "1 new card" or "N more new
  cards", the number of cards that block him (the badge), the push's level (passive, active or time-sensitive) and,
  for one card, an id of 16 hex characters made with a key that never leaves the Mac (never a ref, a name, a title or
  a question). The voice server pushes it to his phone through Apple; his phone then reads the card from the connector and
  writes the notification's text itself, shown on his lock screen and his Watch. When cards leave his inbox (answered,
  withdrawn, lapsed), a background push carries their same opaque ids alone, and the phone removes their notifications.
  An appointment Life added to his calendar is pushed the same way (his word of 21 Nov 2026): the words "Added to
  your calendar", its kind `calendar.added`, its level and its opaque id alone; the phone reads the event from the
  connector (`read_appointments`).
- The encrypted backup, when `backup` is set, to the folder he chose.
- Life's brand (nothing of his), at its paths in the repo, so his agents can style what they make.
- To a messaging network, through its bridge, on his sign-in from his app (`sign_in_to_network`): the cookies, password
  and codes he gives there, once, from his phone over his tailnet to the bridge on loopback; Life stores none and logs
  none; the bridge keeps its session as when he links on the Mac (his yes of 26 Nov 2026).

## Known risks

- The connector's `tell_life` appends his verbatim words to the memory. Only the owner's token may call it (an agent's is
  refused), but a page or message a chat client reads could steer it into calling it. The worst case is a wrong fact in
  the memory, undone by a correction.
- The connector's `change_directory_entry` writes his `truth/` (people, projects, areas, goals, what Life may keep) from his words as `said`; `answer_check` adds a person or an organization through the same code when he names one no one holds by that name (`addDirectoryEntryByHisWord`). Owner's token only; it adds or replaces one entry, never deletes, and refuses, changing nothing, a result that fails the checks of `bun life validate`. A steered call could add a wrong entry: it is committed in his data repo with his words, so it can be undone.
- A session in his own app (his token) asks a draft card (`request_decision`, as `owner`) and answers it with
  `answer_check` once he approved the exact text in its chat, which sends it (his word of 19 Nov 2026). A page or
  message the client reads could steer it into both: the gate is the client's honesty about his yes, policy not
  enforcement, as for any answer his token records; the card stamps the chat and text, and the send is logged.
- The phone's notification extension reads the app's tokens (Life's and the voice server's: one Keychain group), to read a card
  for its notification (`NotificationService`). A draft sent from a notification, on the phone or the Watch, rests on
  that device being unlocked, and on Face ID at that tap only when his setting asks for it (`NotificationContent`).
- The connector's `sign_in_to_network` signs a messaging network's bridge in, owner's token only, and only while it is
  signed out or never linked. A client holding his token (a paired assistant) could be steered into signing a
  signed-out network in to another account.
- The iroh relay (planned, `docs/plans/2026-11-27-private-relay.md`; Life doesn't use it yet) forwards the iPhone
  app's traffic when a direct path fails. It is encrypted end to end between the Mac's and the phone's keys, so the
  relay can't read it. It sees metadata: the devices' IP addresses, when they connect and how much data moves.
  n0's public relays during development, Life's own before launch.
- Full Disk Access makes Life a high-value target on the Mac.
- A grant he gives through an access card (Photos, Contacts, Calendars, Accessibility, Full Disk Access) is Life.app's, so
  every agent's: macOS can't tell Life's scripts apart (his decision of 28 Nov 2026, mini projects ticket 04). Accessibility
  lets a script drive any app's interface, past the send guard; an agent asks for it only on a card, and he turns it on
  himself in System Settings.
- Models misread: an observation is a model's reading with a checked quote, not a fact.
- His agents act with his access (above).

## Reporting a vulnerability

Report it privately through GitHub's "Report a vulnerability" (Security tab), not in a public issue.
