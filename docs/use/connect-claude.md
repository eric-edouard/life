# Connect Claude

How-to: let Claude read your Life, in Claude.ai and the Claude apps, or in Claude Code. You need Life running and
[Tailscale](https://tailscale.com) installed and signed in on the same Mac.

## Claude.ai and the Claude apps

Claude.ai calls Life from Anthropic's servers, so Life's address has to be reachable from the internet. Tailscale
Funnel does that, and only Life's sign-in stands in front of it: nothing is served before a paired app signs in.

1. Open Life's settings from the menu bar. Under Reaching Life, press **Public, for ChatGPT and Claude.ai**. The first
   time, Tailscale may ask you to allow Funnel for this Mac; follow its link, then press the button again.
2. Copy the address Life shows, ending in `/mcp`.
3. In Claude.ai, open Settings, then Connectors, and add a custom connector named Life with that address.
4. Press Connect. Claude opens Life's approval page and asks for a pairing code.
5. Open Life's menu and press **Pair an app**. Type the six characters it shows on the approval page. A code lasts
   5 minutes and works once.

The connector then shows in every Claude app on your account. Ask it something from the last week to check it works.

## Claude Code

Claude Code runs on your own devices, so the address can stay private to your tailnet. In Life's settings press **On
my tailnet** instead (or Public, if you already did). Then:

```sh
claude mcp add --transport http life https://your-mac.your-tailnet.ts.net/mcp
```

In Claude Code, run `/mcp`, pick life and authenticate: the same approval page opens in your browser and takes a
pairing code from Life's menu.

## From a checkout

For development, the app's two buttons are commands:

```sh
bun life connect            # on your tailnet
bun life connect --public   # through Funnel, for Claude.ai and ChatGPT
bun life pair               # prints a pairing code
```

Next: [connect ChatGPT](connect-chatgpt.md), or [set up your agent](agent.md).
