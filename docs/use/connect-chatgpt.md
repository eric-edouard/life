# Connect ChatGPT

How-to: let ChatGPT read your Life. You need Life running, [Tailscale](https://tailscale.com) installed and signed in
on the same Mac, and a ChatGPT plan that allows custom connectors.

ChatGPT calls Life from OpenAI's servers, so Life's address has to be reachable from the internet. Tailscale Funnel does
that, and only Life's sign-in stands in front of it: nothing is served before a paired app signs in.

1. Open Life's settings from the menu bar. Under Reaching Life, press **Public, for ChatGPT and Claude.ai**. The first
   time, Tailscale may ask you to allow Funnel for this Mac; follow its link, then press the button again.
2. Copy the address Life shows, ending in `/mcp`.
3. In ChatGPT's settings, under Apps and Connectors, turn on developer mode and create a connector named Life with that
   address and OAuth sign-in. OpenAI moves these menus from time to time; its help page on custom connectors has the
   current path.
4. ChatGPT opens Life's approval page and asks for a pairing code. Open Life's menu, press **Pair an app**, and type
   the six characters it shows. A code lasts 5 minutes and works once.

Start a new chat with the Life connector turned on and ask about something from the last week to check it works.

From a checkout, the button is `bun life connect --public` and the pairing code is `bun life pair`.

Next: [set up your agent](agent.md), if you want ChatGPT to act on what you ask out loud.
