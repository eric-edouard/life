# Connect your assistant

How-to: let Claude or ChatGPT read your Life. You need Life running and [Tailscale](https://tailscale.com) installed
and signed in on the same Mac.

Your assistant reaches Life at an address on your Mac's Tailscale name, like
`https://your-mac.your-tailnet.ts.net/mcp`. Claude.ai, the Claude apps and ChatGPT call from their makers' servers, so
for them that address has to be public, through Tailscale Funnel. Only Life's sign-in stands in front of it: nothing
is served before an app you paired signs in. Claude Code runs on your own devices and can keep the address private to
your tailnet.

## Put Life on your tailnet

1. Open Life's settings from the menu bar. Under **Reaching Life**, press **Public, for ChatGPT and Claude.ai**, or
   **On my tailnet** if you will only use Claude Code. The first time, Tailscale may ask you to allow Funnel for this
   Mac; follow its link, then press the button again.
2. Copy the address Life shows, ending in `/mcp`.

When your assistant asks for a pairing code, open Life's menu and press **Pair an app**, then type the six characters
it shows. A code lasts 5 minutes and works once.

## Claude.ai and the Claude apps

In Claude.ai, open **Settings**, then **Connectors**, and add a custom connector named Life with the address. Press
**Connect**: Life's approval page opens and asks for a pairing code. The connector then shows in every Claude app on
your account.

## ChatGPT

In ChatGPT's settings, under **Apps and Connectors**, turn on developer mode and create a connector named Life with the
address and OAuth sign-in. OpenAI moves these menus from time to time; its help page on custom connectors has the
current path. ChatGPT then opens Life's approval page and asks for a pairing code. Start a new chat with the connector
turned on.

## Claude Code

```sh
claude mcp add --transport http life https://your-mac.your-tailnet.ts.net/mcp
```

Run `/mcp` in Claude Code, pick life and authenticate: the approval page opens in your browser.

## Check it works

Ask about something from the last week.

## From a checkout

For development, the two buttons are commands. They act on the checkout's own state, not the app's: for an app
install, use the buttons.

```sh
bun life connect            # on your tailnet
bun life connect --public   # through Funnel
bun life pair               # prints a pairing code
```

Next: [set up your agent](agent.md).
