# pi as the agents' default runtime

Plan (explanation and reference): run the owner's registered agents on pi with DeepSeek V4.1 Flash, through
OpenRouter's zero-retention hosts, as the desk's default runtime. Claude Code and Codex stay as options. Nothing here
is built yet; the owner's decisions are in section 7.

```text
today     desk ─ACP─ claude-agent-acp ─ claude CLI ─ Anthropic (subscription)       guard: PreToolUse hook script
          desk ─ACP─ codex-acp        ─ codex CLI  ─ OpenAI (subscription)          guard: hook, trusted by hash
planned   desk ─RPC─ pi --mode rpc -e life-pi.ts ─ OpenRouter (zdr, fixed hosts)    guard: in the pi process, tool_call
```

pi is the open-source coding agent first published as `badlogic/pi-mono`, now `earendil-works/pi`, npm
`@earendil-works/pi-coding-agent` (MIT, v1.6.0 of 20 Nov 2026, Node 22.19+; its SDK also runs under Bun). It ships four
tools (`read`, `bash`, `edit`, `write`, with `grep`, `find`, `ls` on request), no permission prompts, built-in MCP
(stdio and streamable HTTP, OAuth), sessions as JSONL trees, automatic compaction, and TypeScript extensions loaded into
its own process that can block or rewrite any tool call, add tools, add MCP servers and rewrite the system prompt and
each provider request. It runs as a TUI, a print mode, a JSONL RPC mode on stdin and stdout, or an SDK
(`createAgentSession`). It does not speak ACP itself.

## 1. Parity map

Each row is something an agent of the owner's Life does on Claude Code today, and how pi does it. On par: the same
outcome. Better: pi does more or does it more cheaply. Gap: missing until the named fix lands.

| What | Claude Code today | pi | Mark |
|---|---|---|---|
| Session resume | `session/resume` over ACP; one session per agent, kept forever | `pi --mode rpc --session <id>` on a session dir of Life's (`--session-dir`); the same file resumed each wake | on par |
| Compaction | Claude compacts when full, by its own rules | automatic at `contextWindow - reserveTokens`, settings per run; `session_before_compact` lets Life write the summary, keeping the matter record and the notes verbatim | better |
| No-ask mode | `bypassPermissions` set after every new and resume, since a resume takes the last mode | nothing asks: pi has no permission system, so there is no mode to reset and no ask to approve | on par |
| Send guard | `PreToolUse` command hook (`send-guard-hook.ts`) per shell and MCP call, a Bun process each time; Codex's needs its hash trusted | a `tool_call` handler in the pi process calling `sendRefusalOf` directly; a handler that throws blocks the call (pi's documented fail-safe) | better |
| Desk door | MCP server `desk` passed in `session/new` with its bearer | `pi.registerMcpServer("desk", {url, headers, exposure: "direct"})` from the extension, key from the spawn env (pi's default exposure is `codemode`, reachable only from scripts); tools keep the names `mcp__desk__<tool>` the guard reads | on par |
| The owner's Life connector (reads) | the Life plugin's MCP server, under the owner's token | not there: pi reaches no claude.ai connector. Fix: the desk pairs a read-only grant for pi (Life signs its own tokens) and writes it into `mcp.json` in Life's agent dir, `direct` exposure | gap |
| Other connectors (Gmail, Calendar, 1Password, Chrome) | claude.ai connectors and plugins of the owner's Claude account | none: they live in Anthropic's account. The CLIs in the owner's tool list (`gog`, `op`, Playwriter, `agent-desktop`) cover the same reach, through skills | gap |
| Instruction files | the global CLAUDE.md (an `@` import of the global AGENTS.md), each repo's AGENTS.md and CLAUDE.md | pi loads `AGENTS.md` and `CLAUDE.md` from the folder up and from its agent dir. Fix (PR 4): Life's agent dir carries an `AGENTS.md` written at each spawn from the global `CLAUDE.md`, its `@` imports followed (pi follows none); a repo's `CLAUDE.md` that only imports its `AGENTS.md` needs nothing, as pi reads that `AGENTS.md` itself | gap |
| Skills | `~/.claude/skills`, plugins' skills | pi reads `~/.agents/skills` (most of the owner's) and `skills` paths in settings; Life's settings add `~/.claude/skills`. Plugin-only skills (`work-on-code` from a plugin, if any) need a path each | on par |
| The owner's own Claude hooks (work-on-code gate, other `PreToolUse` scripts) | run on every Bash call | do not run. Fix (PR 4): the extension runs the `PreToolUse` command hooks of `~/.claude/settings.json` for `bash` calls, in Claude's hook JSON, exit 2 or a JSON deny blocks; his `Edit`, `Write` and MCP hooks stay unrun on pi | gap |
| Login environment | `readLoginEnv` less Anthropic's keys | the same `readLoginEnv`, plus the OpenRouter key Life's engine already uses (pi's `bash` inherits it, as it inherits every other key today) | on par |
| Session titles | `--name` through `_meta` | `--name` at the first run, `set_session_name` after a rename | on par |
| `isHeld`, a live process of the owner's | Claude's `~/.claude/sessions/<pid>.json`, then `pgrep` | the desk's own runs are in its `live` map; any other pi on the session is found by `pgrep -f "pi .*--session <id>"`. No app holds pi sessions open between turns, so wakes stop waiting on a forgotten window | better |
| Link to open a session | `claude://…/local_<ref>` opens it in the Claude app; `handOff` lists it there | no app. Life's app shows the session read-only (decision 2, PR 6) | gap |
| Model per agent | `modelOf`: Claude's aliases | `--provider openrouter --model <slug>` per run, `set_model` mid-session; any OpenRouter model on the same ZDR routing | better |
| Effort | Claude's effort config | `set_thinking_level` (DeepSeek's thinking through OpenRouter) | on par |
| Usage and context (decision 83) | prompt reply's tokens (unstable ACP field) and `usage_update` context; spend is an `equivalent` at list price | each `message_end` carries input, output, cache read and write and its cost in dollars; `get_session_stats` gives the turn's context. Spend becomes `billed`, exact | better |
| Subagents | the Task tool | none built in; pi's `examples/extensions/subagent/` spawns pi processes. Fix: ship it with the same extension loaded in each child, so the guard holds there too | gap |
| Web search and fetch | built-in WebSearch and WebFetch | none built in. Fix: two extension tools, `web_fetch` (Bun's fetch, a page as its text) and `web_search` (the SerpAPI key the owner keeps); never OpenRouter's web plugin, which ZDR does not cover | gap |
| Browser use | Claude in Chrome (a Claude feature) | Playwriter on the owner's Chrome, by shell and skill, as Codex agents do; the guard reads its command text like any shell call | on par |
| Computer use | Claude's computer-use MCP | `agent-desktop` by shell; the guard's rule already names it | on par |
| Images | pasted or read images | `images[]` on `prompt`; V4.1 Flash takes image input | on par |
| Plan mode, to-do tool | plan mode (unused by the desk), TodoWrite | pi's `plan-mode` and `todo` example extensions; the desk needs neither | on par |
| The Life plugin's hooks (a turn typed into an agent's session) | `session.start` looks up the door, `prompt.submit` adds the packet, `tool.call` asks `/guard` | the same three as one pi package (`session_start`, `input`, `tool_call`) for a pi the owner opens by hand; the desk's own runs load it with `-e` | on par |
| Main session (Tell Life) | one ACP process kept warm 5 minutes, prompt per ask | one `pi --mode rpc` kept warm the same way; a second ask while one runs goes in as `steer` instead of being refused | better |
| Moving an agent (`hand_over`) | `moveToOf` picks "the other runtime" | with three runtimes that pick is wrong. Fix (PR 3): the one move offered goes to the desk's default, and from the default to the first other; `hand_over` already names its target | gap |
| A second Life's agent (a demo) | Claude's `tools: []`, `strictMcpConfig`, door prefix approvals | `--no-builtin-tools --no-context-files --no-skills`, `--tools` limited to `mcp__desk__*`; no permission round trip to police | better |
| Stopping a run | ACP `session/cancel`, then kill | RPC `abort`, then kill | on par |
| Turn begun | first ACP answer update | first `message_update` | on par |

Counted: 14 on par, 7 better, 8 gap. The PRs below close seven, the link included; the claude.ai connectors stay out of reach and the CLIs stand in for them.

## 2. What owning the pipeline adds

Each item uses a hook or call pi documents today.

- The guard runs where the call happens. `tool_call` runs inside the pi process before every tool, MCP and extension
  tools included, and `ctx.executeTool` calls (codemode scripts' too) pass through it. No hook script, no Bun spawn
  per call, no Codex hash. The extension is bundled read-only in Life.app, so an agent editing a checkout no longer
  edits its own guard.
- The provider boundary is set in code. `before_provider_request` sees every request body and may replace it, though
  it cannot refuse one (a handler's error is logged and the request goes on). The extension writes Life's `provider`
  block (`zdr: true`, `data_collection: "deny"`, `allow_fallbacks: false`, `only` the hosts of `models/llm.ts`) over
  whatever a setting or a model switch put there, on every request.
- The door could become native tools. Later, `pi.registerTool` puts `set_wait`, `request_decision` and the rest in the
  process with typed schemas, calling the door over loopback: no MCP session per run, no tool listing round trip.
- A wake the model cannot miss. `before_agent_start` puts the packet (`read_packet`'s text) and the wake's facts
  into the turn itself. Today the agent spends a tool call reading its packet, and can skip it.
- Compaction keeps Life's record. `session_before_compact` writes the summary with the matter record, the open card
  and the notes intact, so a compacted agent never forgets its plan.
- Spending is exact. Each turn's dollars come from the provider's reported cost, so `read_spending` shows `billed`
  money, not an estimate at list price.
- A model per task. The desk can run hand-out turns and wakes on Flash and switch a turn to a stronger model
  (`set_model`) when it drafts a card, by code, with the switch logged on the turn.
- Caching stays warm. pi's system prompt is about a thousand tokens and stable; Claude Code's tool listing is far
  larger. pi sends OpenRouter's session affinity header (`x-session-id`), and DeepSeek's hosts cache prefixes
  implicitly.
- A tool list per agent. `--tools` and `setActiveTools` give each role its own list: the caretaker without web
  tools, a demo agent with its door alone.
- The owner's next words mid-turn. RPC `steer` and `follow_up` let Tell Life take a correction while the main
  session works.

## 3. Model and provider

Read from OpenRouter's public catalog on 22 Nov 2026 (`/api/v1/models`, `/models/<slug>/endpoints`,
`/api/v1/endpoints/zdr`). Latency and throughput were blank in the catalog; the trial measures them.

| Model | Context | Tools | ZDR hosts (in / out / cache read, $ per million) |
|---|---|---|---|
| `deepseek/deepseek-v4.1-flash-1017` (Life's memory model) | 1,048,576 | yes, every listed host | DeepInfra 0.098 / 0.294 (flex 0.078 / 0.235 / 0.0024); Morph fp8 0.059 / 0.52 / 0.005; about 25 more |
| `deepseek/deepseek-v4-pro`, fallback | 1,048,576 | yes | Relace 0.90 / 1.50 / 0.20; DeepInfra 1.04 / 2.08 |
| `z-ai/glm-5.2`, second fallback | 1,048,576 | yes | DeepInfra flex 0.45 / 1.44; CoreWeave 0.62 / 2.42 |
| Claude Opus 5.5, today's agents | 1,000,000 | yes | the subscription; list 4 / 20 / 0.20 (`core/prices.ts`) |

The first-party DeepSeek endpoint is not on the ZDR list and is never used. The hosts are Life's memory engine's own
(`models/llm.ts`'s route, `deepinfra/fp8` then `morph/fp8`; `models/routers.ts` sends one host per request with
`allow_fallbacks: false`, `data_collection: "deny"`, `zdr: true`). pi gets both in one block, `only: ["deepinfra/fp8",
"morph/fp8"]` with the same three fields, written into pi's `models.json` as `openRouterRouting` and written again over
every request (section 2). OpenRouter screens every
request for abuse since 27 Oct 2026 and may keep what it flags, ZDR included; that holds for Life's memory calls today.

The fallback is decided, not asked: a turn that fails on Flash for a model reason (refusal, malformed tool calls twice)
retries once on V4 Pro, logged on the turn. GLM 5.2 is the spare if V4 Pro's hosts go.

Cost per agent-day, from the desk's store (`turn`, 189 turns from 18 to 21 Nov 2026, 173 of them with tokens). The
busiest day, 20 Nov, ran 101 turns over 14 agents: per agent-day 339,000 tokens in (cache writes included), 4.39
million cached, 12,300 out; a turn's context (`context_used`) averaged 141,000 tokens, from 48,000 to 427,000.

| Runtime | Per agent-day | That day's 14 agents | Paid by |
|---|---|---|---|
| Claude Opus 5.5 | $2.48 at list price | $34.73 | the subscription (its quota) |
| Flash on Morph, cache hits as Claude's | $0.05 | $0.68 | OpenRouter, billed |
| Flash on Morph, no cache at all | $0.29 | $3.99 | OpenRouter, billed |

Flash costs a fiftieth of Opus's list price with caching and a ninth without. Token counts will not carry over one for
one: pi's prompt is smaller, and a weaker model may take more steps. The trial measures both.

## 4. Architecture

A new runtime, `desk/runtimes/pi-runtime.ts`, implements `contract.ts` over `pi --mode rpc`, beside
`acp-runtime.ts`. It does not go through ACP. The one adapter, `svkozak/pi-acp`, does not pass MCP servers to pi,
resumes through a map file under `~/.pi`, and reports context but not tokens: the desk would lose the door, the
session's place and the spending at once, and pin a fourth package for it. pi's RPC is a documented, versioned JSONL
protocol, so the runtime talks to it directly. AGENTS.md's line "implemented once (`acp-runtime.ts`)" changes to name
both; the warm-session bookkeeping (`kept`, `live`, `KEEP_WARM_MS`) moves to a shared module only if the two copies
would otherwise duplicate it.

| Contract call | pi |
|---|---|
| `start` | spawn `pi --mode rpc --session-dir <state>/desk/pi/sessions/<agent> --name <title> -e <life-pi.ts>`; `prompt` the brief; ref is the session id from `get_state` |
| `send` | spawn with `--session <ref>`, `prompt`; `begun` at the first `message_update`, `ended` at `agent_settled`, usage summed from the turn's `message_end`s, context from `get_session_stats` |
| `talk`, `keep` | the same process kept warm; a prompt while one runs goes in as `steer` |
| `state` | `running` while in `live` or `pgrep` finds a pi on the session; `idle` while its file exists; else `gone` |
| `stop` | `abort`, then kill after `EXIT_WITHIN_MS` |
| `block` | `pi --version` fails, or the OpenRouter key is missing |

What the extension (`desk/life-pi.ts`, bundled like `send-guard-hook.ts`) does, all from the spawn env:

- registers the door as MCP server `desk` with the agent's key, `exposure: "direct"`;
- on `tool_call`, maps pi's `bash` to the guard's `Bash` and passes MCP names as they are, and returns
  `{block: true, reason}` on `sendRefusalOf`'s refusal;
- on `before_provider_request`, writes Life's routing over the request's `provider` block;
- on `project_trust`, declines, so a repo's `.pi` extensions, settings and MCP servers never load into the guard's
  process (`--no-approve` at spawn does the same);
- keeps `codemode` and `tool_search` off: every MCP server is `direct`, so the guard reads each call by the name the
  model gave it, not inside a script (nested calls would still pass `tool_call`).

`runtime-rows.ts` keeps the ACP rows. pi's facts (its program, agent dir, env, routing) live in the pi runtime's own
row type, built the same way for the owner's Life and a second Life (`isOwnLife`). Life's agent dir
(`PI_CODING_AGENT_DIR=<state>/desk/pi/agent`) holds `settings.json` (skill paths, compaction, `quietStartup`),
`models.json` (the routing), `mcp.json` (the connector grant) and the `AGENTS.md` link: nothing is written into
`~/.pi`. pi is pinned in `package.json` and bundled for the helper as the adapters are. pi's CLI declares Node
22.19+ and Life.app has no Node: PR 2 proves pi runs under the helper's Bun (`BUN_BE_BUN`), else ships pi's own
compiled binary (its `build:binary`).

Code that names runtimes changes with the new name: `RuntimeName` and `RUNTIME_WORDS` (`core/names.ts`), the Kit's
`RuntimeName` and `offered`, `moveToOf` (`host/move-read.ts`), `spendOfTurn`'s provider and basis (`memory/spends.ts`)
and the spending read's provider (`host/spending-read.ts`). A billed turn needs its dollars stored: `Run.ended`'s
usage gains the cost, and the turn table a column, which is a desk store step (`desk/store-step.ts`, its dated copy
and check), asked like the earlier ones.

Docs that name ACP as the one runtime change in the same PRs: AGENTS.md's "One way" line for a registered agent's
wait ("implemented once (`acp-runtime.ts`)") and the invariant's description of the send guard as "a hook of the
session's own flags"; `docs/glossary.md`'s runtime, runtime row, kept session and start stage ("as the ACP runtime
saw it"), and a line for pi; SECURITY.md's "Agents" (the guard as a hook, the agent able to edit the guard's file).

## 5. Risks and invariants

- The guard must never be bypassable. It holds by three checks: pi blocks a call whose handler throws; the runtime
  refuses to start when the extension is not loaded (it asks the extension for a token at start, and a missing answer is
  a failed launch, as `guardEnv` throws today); and a test runs every `SEND_RULES` case through a real pi process with a
  fake provider. pi's MCP renames names with characters outside `[A-Za-z0-9_]` and adds a hash on a collision; the
  guard's `isConnectorWrite` learns that shape before the first run, and an MCP name it cannot read is refused.
- A weaker model with full power. Flash acting unattended on what it reads is the risk the owner accepted for
  Claude, with less judgment behind it. The guard covers sending only; paying, submitting a form or booking stay the
  model's instruction. The guard stays as it is (decision 4).
- Nothing leaves the Mac beyond SECURITY.md. Today the agents' line names the Claude and Codex subscriptions. An
  agent on pi sends its brief, its packet and everything it reads (files, mail, shell output) to OpenRouter and its
  ZDR hosts. SECURITY.md's "What leaves the Mac" gains that destination, and AGENTS.md's model provider invariant names
  agents, both on the owner's yes (decision 3). OpenRouter's web plugin stays off: ZDR does not cover it.
- Keys in the process. The OpenRouter key sits in the agent's env, readable by its shell, like every other key the
  owner's agents already hold. A spend cap on that key bounds a runaway loop.
- The owner's own hooks stop running until the hook shim lands (PR 4); work-on-code's gate is one of them.

## 6. The PRs

| PR | What | Tier |
|---|---|---|
| 1 | `pi-extension.ts`: the guard in `tool_call`, the door, Life's provider with its routing on every request, a repo's `.pi` never trusted; tests in a real pi (#1173) | hard (strict path) |
| 2 | `pi-runtime.ts` over RPC behind the one runtime (`session-runtime.ts`, split from ACP's), pi pinned and bundled, `pi` in `RuntimeName` and the phone's list, SECURITY.md's and AGENTS.md's lines (decision 3) | hard (strict path) |
| 3 | the move offered goes to the desk's default runtime, from it to the first other (`moveTargetOf`; `hand_over` already takes any runtime); a pi turn's spending `billed` from OpenRouter's cost, kept in `turn.cost_usd` by its store step (`stepTurnCost`, the owner's yes of 22 Nov 2026) | hard (strict path: a store step) |
| 4 | parity in the extension (`claude-hooks.ts`, `web-tools.ts`), his own Life only: his Claude `PreToolUse` hooks on each shell call, `web_fetch`, `web_search` (SerpAPI, his key), his global instructions (`CLAUDE.md`, imports followed) as the agent folder's `AGENTS.md` | standard |
| 4b | subagents (the extension loaded in each child) and the Life connector's read grant in `mcp.json` (strict path: `host/http/`) | hard |
| 5 | folded into PR 2 | |
| 6 | the read-only view of a pi agent's session in Life's app (decision 2) | standard |
| 7 | `desk.defaultRuntime: "pi"` in the owner's settings, once PRs 1 to 4b have landed and their tests pass | small |

Existing agents keep their runtime: only agents started after PR 7 run on pi by default.

Measuring the first day, after PR 7 (no gate before it, decision 1): the first pi agents' turns, failed turns, time
to begun, cards asked, cards answered against withdrawn or marked "Wrong…", guard refusals, context and dollars, set
against the Claude agents' same day. A replay of 10 past wake turns on pi in a second Life (door only, cards recorded,
never shown), judged by one fresh reviewer against the cards Claude asked, adds a side-by-side for about $1.

## 7. The owner's decisions

Answered on 22 Nov 2026, relayed by the orchestrator session.

1. The default: now. pi with DeepSeek V4.1 Flash becomes the default for new agents as soon as it is built and its
   tests pass; no trial gate, the first day measured.
2. An agent's chat: read-only in Life's app.
3. Agents' data through OpenRouter: yes, on the memory's zero-retention hosts only (DeepInfra, Morph). This is the
   yes for SECURITY.md's line (PR 5).
4. The send guard: unchanged; revisited after watching pi agents.

Next: PR 1.
