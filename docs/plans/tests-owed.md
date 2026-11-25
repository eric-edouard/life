# Tests owed

Explanation: the tests Life v4 left for later. The owner's direction of 25 Nov 2026 for v4 ([the plan](2026-11-25-overhaul/README.md)):
tests only for what is critical (sends, memory writers, the owner's directory, the send guard, the desk's store); the
rest is checked by running it and owed here. Each bundle adds its rows when its PR opens; a row goes when its test lands.

| Bundle | What is untested | Where |
|---|---|---|
| C | Background turns pause on a failing provider: the runtime's `block` after a provider error, its doubling delay, a good run (an ask's too) lifting it | `desk/runtimes/provider-pause.ts` |
| C | A turn stops after five failed calls of one tool, its run ending failed with why | `desk/runtimes/pi-runtime.ts` (`runHeard`) |
| C | A long tool result is kept in a file with its start and where the rest is; a result from outside is wrapped as data, a closing tag inside it neutralised; old kept results pruned after a day | `desk/runtimes/pi-results.ts` |
| C | An ask thinks at `ASK_EFFORT` (a kept session's spawn), a background turn at the route's effort | `desk/runtimes/pi-runtime.ts`, `session-runtime.ts` |
| C | A silent model's request fails at 30 s and pi retries it (`httpIdleTimeoutMs`) | `desk/runtimes/pi-runtime.ts` (`settingsOf`) |
| C | What is in force reaches Claude and Codex ahead of each message (`promptOf`) | `desk/runtimes/session-runtime.ts` |
| C | The measures: an ask's timings, each tool call's time and size, the tool schemas' size, logged as `desk.runtime` | `desk/runtimes/session-runtime.ts`, `pi-runtime.ts`, `pi-extension.ts` |
