# Reopening a Codex agent chat

Reference for the Codex plugin experiment on 20 November 2026.

```text
Resume a thread in a fresh app-server process     same thread, unknown MCP server 'desk'
Install the test plugin, resume the same thread   read the new note and the agent wait
Change that wait from the reopened thread         the fixture recorded the new wait
Open an ordinary thread in the same folder        no assignment, original wait preserved
```

The experiment used a temporary Codex home, a local Responses API fixture, a local
marketplace and an MCP server with two synthetic tools. It used no Life credentials
or model quota. It passed with Codex CLI 0.167.0 and the Desktop app's bundled
0.169.0-alpha.11.1 runtime. The separate Desktop profile reached onboarding; a turn
typed into its window remains unverified.

## Repeating the experiment

1. Start a thread with a per-thread `mcp_servers.desk` entry. Have a test turn
   call `read_packet`. Store its thread ID in the fixture and close the app server.
2. Change the synthetic note and wait outside Codex. Start a fresh process with
   the same temporary home and call `thread/resume` with only the thread ID.
   Check the missing tool using `mcpServer/tool/call`.
3. Install the fixture through `codex plugin marketplace add` and `codex plugin add`.
   Resume in another fresh process. Drive `read_packet` and `set_wait` through
   normal turns. Check the new values at the fixture and the thread ID in MCP
   request metadata. Use a second thread in the same folder as the control.

## Applying the result to Life

A persistent plugin supplies the tools after a restart. The MCP thread ID identifies
the caller for routing. The fixture used synthetic records; its lookup grants no Life
authority. A production client still needs the desk's scoped permission for a turn,
the send guard on a typed turn, and coordination with an incoming wake.

The rules for a chat that holds several matters, and for binding a turn to its assignment, are in [docs/tasks.md](../tasks.md) ("Not built yet").
