# Nod and Life's pi agents: outside research of 24 Nov 2026

Explanation: outside research the owner brought in on 24 Nov 2026, comparing Nod (an open personal-agent system built
on pi, Apache 2.0 as the research says) with Life's own pi runtime, and ranking what Life could port from it. It is
input for the overhaul's plan (issue #1373), to be weighed like the pi audit: not taken at face value. The review
against Life's code at `bc73af16` comes first; the research follows, condensed. Nod's code was not read for this
review.

## Review

**Checked against the code (true at `bc73af16`):**

- Life runs `@earendil-works/pi-coding-agent` 1.6.0 (`apps/server/package.json`).
- A background turn spawns a pi process in RPC mode that resumes the agent's session (`desk/runtimes/pi-runtime.ts`,
  `openOf`, `--mode rpc`); Ask Life's session stays open between asks (the gap audit). Nod uses pi's SDK in process.
- The send guard is partial on purpose and says so: a tab already open on a messaging site, a script that builds an
  address, `gh api` or `curl` to an API, or another program the agent starts get past it (`desk/send-guard.ts`, its
  header; `SECURITY.md`).
- Old tool answers are cut to one-line notes in the model's context while the session file keeps them whole
  (`desk/runtimes/pi-extension.ts`).
- Life's own agents run with no sandbox, by the owner's decision: an agent of his own Life is one of his sessions in
  full, held back only by the send guard (`AGENTS.md`, the registered agents invariant). A second Life's agent gets
  its door alone (`isOwnLife`).

**Wrong in the research:**

- "CodeMode: not identified" and "Dynamic tool discovery: Nod". Life switches both of pi's built-ins off on purpose
  (`-builtin:codemode`, `-builtin:tool-search`, `pi-runtime.ts`): every MCP server is direct so the guard reads each
  call by the name the model gave it, not inside a script (`docs/plans/pi-runtime.md`). Turning them on is a decision
  about the guard first, then about tokens. Life's own gap audit already ranks deferring the rarely used tools through
  tool search as P0 (`docs/handoff/2026-11-23-current-state/pi-runtime-gap-audit.md`), keeping the frequent ones
  direct.

**Not checked:** everything about Nod itself (its trust engine, sandbox, learned skills, context limits, spending
check-ins, proactivity classifier, licence and notice terms), and every claimed saving. The research says itself that
no latency or token saving was measured.

**Worth taking into the plan** (now in issue #1373, to weigh):

1. **What gets past the send guard.** This is where Nod could help most. Life's rule for sends stays as it is: his tap
   on the exact draft, enforced in code. An LLM's judgement never replaces it. Nod's split of reasoning,
   authorization and sandboxed execution is worth reading for what the guard can't see today: `curl` and `gh api`
   to a service, a browser tab, a program the agent starts. It matters most for distributing Life to other people,
   whose agents should not have full power by default. The owner's note in #1373 already asks for an LLM check on
   sudo in an auto mode; a trust engine is the same idea, made general.
2. **Learned procedures.** An agent that worked out how to do something on a website saves the steps as a skill, and
   updates it when the site changes. Life improves today only through his complaints and audits. Learned skills
   would complement that, kept in the agent's own folder of his agents repo, never in `memory/`, and never run by
   Life's own code (content never runs Life's code).
3. **Tool search and CodeMode, guard first.** Take the gap audit's P0 (defer the rare tools) once the guard can read
   a deferred call by its name. CodeMode only if the guard can read every call a script makes; otherwise it stays off.
4. **Bounded tool outputs with references.** A large output is kept outside the context and the model gets a
   reference to read from, instead of a note. Cheap, close to what `pi-extension.ts` already does.
5. **A spending limit per task.** Life measures spending by turn and by matter (decision 83, `read_spending`) but
   nothing here showed a cap on an assignment. Nod's spending check-ins would ask before a task goes over. Pairs with
   the monthly budget in #1373.
6. **The SDK instead of RPC.** Benchmark first: the gap audit already notes there is no latency breakdown (process
   start, MCP ready, first token). Life's subagents already run in process through the SDK (`pi-subagent.ts`); the
   RPC process keeps the guard in its own process, a reason to keep it unless the numbers say otherwise.

**Not for now:** Nod's memory system (Life's is deeper); the proactivity classifier (Life's arrival reader already
sieves on Apple's on-device model before the engine confirms); replacing Life's agents with Nod (the research says no
too).

## The research, condensed

Both are opinionated personal-agent systems on pi; the question is which surrounding architecture makes the agent
more effective, cheaper, safer and more autonomous.

| Capability | Life | Nod | Advantage (the research's) |
|---|---|---|---|
| Pi integration | RPC subprocess per turn | SDK in process | Nod |
| Persistent specialized agents | Native | Task delegation | Life |
| Event-driven execution | Yes | Yes | Even |
| Subagents | Same-model child sessions | Delegated tasks | Depends |
| Context compaction | Keeps the assignment's record | Adapts to the model's window | Both |
| Old tool output pruning | Yes | Yes, with references to the output | Nod |
| Dynamic tool discovery | MCP and custom tools | pi's tool search | Nod (see the review) |
| CodeMode | Not identified | Integrated | Nod (see the review) |
| Cost tracking | Detailed | Detailed, with spending check-ins | Nod |
| Action authorization | Send guard and cards | A trust engine | Nod |
| Execution sandbox | Limited for his own agents | A sandbox | Nod |
| Procedural learning | Corrections and audits | Learned reusable skills | Nod |
| Long-term personal memory | Deep, many sources | Mostly from the user's messages | Life |
| Model routing | OpenRouter and runtime fallback | Model choice and provider fallback | Both |

Its claims:

- **SDK integration** gives finer control over execution, tools, context and model requests, and maybe less start-up
  time (not measured).
- **Security is the biggest difference.** Nod separates reasoning, authorization and sandboxed execution: a better
  start for distributing Life to other users, though an LLM's authorization is not infallible.
- **Tokens:** CodeMode, tool search, adaptive context limits, bounded outputs and references to large outputs.
- **Learned skills:** working procedures saved as skills (site navigation, selectors, required options, verified
  steps), updated when sites change.
- **Where Life is ahead:** agents with lasting responsibilities, assignments, event queues, waits and project
  context. Life is closer to an operating system for a life, the assistant being one interface to it. Nod is mainly
  an assistant that finds work and delegates it.

What it would port, ranked: the trust and authorization engine (critical), sandboxed execution (critical), tool
discovery (very high), CodeMode (very high), the SDK (high), learned skills (high), adaptive context (high),
per-task spending limits (medium), the proactivity batch classifier (medium), Nod's memory (low). Its verdict: don't
replace Life's agents with Nod; port its strongest parts selectively. Directories it points to: `src/providers/pi`
(runtime and tokens), `src/runtime` (execution and tool orchestration), `src/server` (trust, learning, proactivity).
It is a targeted source review, not an audit or a benchmark.
