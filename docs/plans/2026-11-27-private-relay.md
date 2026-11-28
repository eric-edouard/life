# Reaching Life with no domain and no Tailscale

Plan: Life's iPhone app reaches the user's Mac from anywhere with nothing to set up (no domain, no Tailscale, no
account), through nothing that can read what passes.

The test this plan must pass: a user asks their own AI agent to audit Life's public repository and answer "can my data
leak to Life's developer?", and the answer, read from the code alone, is no.

## Where things stand

Today a user reaches their Mac through Tailscale Funnel ([connect](../use/connect.md)). It works, but needs a
Tailscale account, a sign-in and an allowed Funnel: too much for someone who just installed an app. The owner's
own install adds a Cloudflare Worker in front (`apps/edge/`, a bridge until #137).

## The design: iroh in both apps (chosen 28 Nov 2026)

[iroh](https://github.com/n0-computer/iroh) (Apache-2.0, 1.0, official Swift bindings) is a library inside the Mac app
and the iPhone app. No extra app, no account, no VPN prompt.

1. **The Mac makes its own key.** On first run, Life makes a keypair on the Mac (never written anywhere else, never
   sent). Its public key is the Mac's address.
2. **Pairing carries the key.** The Mac shows a QR code with its public key and its relay; the iPhone app keeps them.
   From then on the app dials that key and nothing else: no certificate authority, no domain, so nobody, the developer
   included, can stand in for the Mac.
3. **Direct first.** iroh punches through the home router and connects the phone straight to the Mac (iroh reports
   about 95% of data direct); at home it stays on the local network. Voice audio, the heavy part, mostly never leaves
   the two devices' path.
4. **A relay only when direct fails.** It forwards bytes encrypted end to end between the two keys, so it can't read
   them. Development uses n0's free public relays; before launch Life runs its own iroh relay (open source, one small
   machine; TLS there can end at the host, since what it carries is already encrypted end to end), so no third party
   sees even metadata.
5. **No public discovery.** iroh's lookup service stays off: pairing already says where the Mac is.

Tailscale stays as an option for users who already have it, and for Claude.ai and ChatGPT connectors, which need a
public web address that iroh doesn't give.

## What an audit will find

From the repository alone, an agent can check that the key is made on the Mac and no code path sends it, that the
iPhone app dials only the key it paired with, and that discovery is off. A relay, honest or not, can delay or drop
traffic, never read it. What it sees, and SECURITY.md says: the devices' IP addresses, when they connect and how much
data moves.

## Parked: a public web address (#1610)

Shared artifacts and assistant connectors need an address a browser can open. That was `*.hostedbyme.app` through an
SNI-passthrough relay (OpenTunnel on Fly), built and tested end to end on 28 Nov 2026, then parked to save its cost
while neither exists. #1610 holds the design, what was built, its caveats, the costs and how to bring it back.

## Milestones

- [x] Choice: iroh (28 Nov 2026).
- [ ] Mac side: keypair, iroh endpoint, the pairing QR with key and relay, discovery off.
- [ ] iPhone app: iroh endpoint, dial the paired key, the voice and connector traffic over it.
- [ ] Our own iroh relay before launch.
- [ ] SECURITY.md "Network" and "What leaves the Mac", architecture.md, use/connect.md updated; #137 closed by it.

## Debt plan

iroh replaces the owner's Cloudflare Worker (`apps/edge/`) for the app, and the Funnel setup becomes optional.
Nothing new is stored in `memory/`; the key lives with Life's other secrets (`SECRETS`, `secret.ts`).
