# Pi runtime: an outside gap audit (23 Nov 2026)

Explanation: an outside audit of Life's pi runtime against Oh My Pi (OMP), Claude Code and Codex, which the owner
brought in as input for the overhaul's plan (issue #1373). Not to be taken at face value: the benchmark is one small
third-party run, and the priorities are the audit's proposals, not measurements. Some code claims were spot-checked on
main (marked "checked"); the rest are unverified.

## What to optimize

Three metrics decide: time to first useful response, total cost per completed task, and task success rate. A feature
counts only when it improves one of them.

## The benchmark it cites

Composio, Sep 2026: the same model (DeepSeek V4 Flash), 30 agentic tool-use tasks.

| Metric | Pi | OMP |
|---|---|---|
| Tasks completed | 20/30 | 17/30 |
| Median task duration | 132 s | 272 s |
| Average tokens per task (cumulative) | 559k | 742k |
| Cost per successful task | $0.028 | $0.103 |

One small benchmark, not a controlled test on Life's tasks or the latest OMP release. It only challenges the assumption
that OMP's built-in tools make agents faster.

## Claims about Life's code

- One model per pi agent: Life's OpenRouter DeepSeek route (`piRouteOf`), no other model, no model roles, no fallback
  chain. `piRouteOf` takes the memory engine's high-effort route for every turn.
- A new pi process per background turn; Ask Life's session stays open between asks with an idle timeout.
- Compaction at 400k tokens, a threshold, not what each turn sends (checked: `PI_COMPACT_AT`, `desk/runtimes/pi-runtime.ts`).
- Ask Life takes one ask at a time and refuses a second with "Life is still answering your last words" (checked:
  `desk/main-session.ts:311`), though pi's RPC has `steer` and `follow_up`.
- Every MCP tool exposed directly (checked: `exposure: "direct"`, `desk/runtimes/pi-extension.ts`), with pi's tool
  search and codemode turned off (checked: `-builtin:tool-search`, `-builtin:codemode`, `pi-runtime.ts`).
- The main session's brief has it call `answer` before its final text: an extra round trip.
- No latency breakdown (process start, MCP ready, first token, tool calls).
- `pi-subagent.ts`: one task string, the parent's model, an in-memory child, a text answer.
- The send guard in pi intercepts `Bash|mcp__.*` only: a native browser or desktop tool added later would pass it
  unchecked unless covered.
- `MainSessionAsk` takes text and screen refs, no images or files; Ask Life has no cancel on its wire.

## Gaps, as the audit ranks them

| Priority | Gap | Aim |
|---|---|---|
| P0 | Tool schemas: keep the frequent tools direct (search, fetch, read_matter, the core desk actions), defer the rest through pi's tool search | fewer input tokens per turn |
| P0 | Model and effort by task: fast and low effort for simple asks, stronger for hard ones | latency and cost |
| P0 | Provider failover for pi agents | no failed task when one provider is down |
| P0 | Cold starts: reuse pi workers, a shared MCP host (OMP has a shared daemon, lazy start, cached discovery) | faster wakes |
| P0 | Steer, queue and cancel Ask Life mid-turn (pi already has the RPC; Life's runtime contract doesn't expose it) | a live chat |
| P1 | Web and document reading (PDFs: `web_fetch` returns none), structured, not whole pages | fewer failed reads |
| P1 | Browser and Mac desktop control as first-class tools, behind the guard | tasks on sites and apps with no API |
| P1 | Subagents with their own model and typed results, durable and steerable | complex research |

Lower: persistent Python/JS kernel, other file formats, an advisor model, image and speech tools, attachments in Ask
Life, live subagent inspection, richer streaming. Parity gaps with Claude and Codex: account connectors, plugin skills,
the full hook lifecycle, model choice, an OS sandbox.

Deliberately not to reproduce: LSP, debuggers, AST editing, worktree orchestration and code review, an agent memory
engine, agent scheduling, an agent approval UI, to-do or planning systems, a TUI, cloud coding tasks. Life owns
memory, scheduling (the desk), cards and matters already.

## The audit's order

1. Measure the tool schemas' input cost, then benchmark direct plus deferred.
2. Route model and effort by task.
3. Cut round trips: stream direct answers, prefetch small context, batch independent reads.
4. Reuse processes and the connector; benchmark against OMP.
5. Browser, desktop and documents, with concise results.
6. Delegation and live control: typed child results, specialist models, steering, cancellation.

Its conclusion: keep pi; most gains are in Life's configuration and request flow. Benchmark OMP on Life's real tasks
before adopting it.
