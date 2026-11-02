# Set up your agent

How-to: give your requests to an assistant that acts on them. This is optional. Without an agent, Life still answers
every question; it just never hands work to anyone.

Your agent is a ChatGPT or Claude chat you have connected to Life. You give it a name, say "Orbit". When you say "hey
Orbit, book a table for Friday" near your phone (with [voice](voice.md) on), Life records your words as an ask. The
agent reads its asks from Life and keeps its own list of what it has done; Life does not follow up on it.

The agent runs outside Life's boundary. It acts with whatever access its own app gives it, and Life cannot hold it to
any rule: [SECURITY.md](../../SECURITY.md) explains the risk.

1. [Connect ChatGPT or Claude](connect.md) first.
2. In Life's settings, under **Your agent**, enter its name and the wake word as your phone hears it (usually the name
   in lowercase). Press **Save**. A word your phone mishears goes under `misheard` in the agent's entry of
   `settings.json`.
3. Pair the agent's app as that agent: `bun life pair Orbit` prints a code to type on the app's approval page. An app
   paired without a name can read your memory but receives no asks.
4. Tell the agent, in its instructions, to call Life's `read_agent_asks` tool and to pass back the `cursor` it returned
   last time. Each ask has your words, when you spoke, and how sure Life is that the wake was you.

Next: [voice](voice.md) says what Life records when you say "hey Orbit".
