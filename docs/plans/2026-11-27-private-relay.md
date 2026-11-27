# Reaching Life with no domain and no Tailscale

Plan: give every install a public address on Life's own domain, through a relay that can never read what passes
through it, so a user who has no domain, no Cloudflare and no Tailscale account can connect their phone and their
assistant in one step.

The test this plan must pass: a user asks their own AI agent to audit Life's public repository and answer "can my data
leak to Life's developer?", and the answer, read from the code alone, is no.

## Where things stand

Today a user reaches their Mac through Tailscale Funnel ([connect](../use/connect.md)). It works, but needs a
Tailscale account, a sign-in and an allowed Funnel: too much for someone who just installed an app. The owner's
own install adds a Cloudflare Worker in front (`apps/edge/`, a bridge until #137).

OpenTunnel, opencode's relay, shows the shape that removes the account: each server gets a random address like
`https://<16 hex>.<host>.opentunnel.xyz`, and the relay passes the encrypted connection through by its hostname
without opening it. This plan builds the same shape on Life's domain, with one difference that matters: each Mac makes
and keeps its own key (OpenTunnel says it uses a wildcard certificate; whoever holds a wildcard key can read the
traffic of every server under it).

The developer never runs anyone's Life or Voice server, now or later. Everything stays on the user's Mac; the relay
only carries encrypted bytes.

## The design

1. **The relay forwards, never decrypts.** A small open-source service on `*.hostedbyme.app` (bought 27 Nov 2026 at Porkbun) reads the
   hostname from the first packet of a TLS connection (SNI) and pipes the still-encrypted connection to the Mac that
   registered it, over one outbound connection the Mac keeps open. It holds no certificate for any user's address.
   Candidates before writing our own: sish, frp in TCP mode, or OpenTunnel's server if it is open source.
2. **Each Mac makes its own key.** On first run, Life makes a private key on the Mac (never written anywhere else, never
   sent) and picks a random id. It asks Let's Encrypt for a certificate for `<random id>.hostedbyme.app` with the
   TLS-ALPN-01 challenge, which arrives through the relay still encrypted, so the Mac answers it itself. Renewal is the
   same, every 60 days. The relay and the developer never see the key.
3. **Life's iPhone app pins the Mac's key.** Pairing happens next to the Mac (a QR code shown by the Mac, or the same
   network), and the code carries the key's fingerprint. From then on the app refuses any other key, even under a valid
   certificate. This closes the one real hole: the developer owns the domain's DNS and could get a second certificate
   for a user's address. With the pin, that certificate is useless against the app.
4. **The Mac watches the public certificate logs.** Every public certificate is published in Certificate Transparency
   logs. Life checks them for its own address and warns the user when a certificate it did not request appears. This
   protects what cannot pin: Claude.ai and ChatGPT connectors, which call from their makers' servers, and browsers.
5. **Shared artifacts are encrypted with a key in the link.** An artifact shared with someone else is encrypted on the
   Mac, and its key goes after the `#` in the link, which browsers never send to any server. The page that decrypts it
   is served by the Mac through the relay, so its code is the repository's.

Tailscale stays as an option for users who already have it.

## What an audit will find

From the repository alone, an agent can check that:

- TLS ends in Life's code on the Mac, and the relay's code has no certificate and no way to decrypt;
- the private key is made on the Mac and no code path sends it;
- the iPhone app accepts only the key it paired with;
- the Mac alerts on a certificate it did not request.

It cannot check what actually runs on the relay server, and does not need to: with points 3 and 4, a dishonest relay
can delay or drop traffic, never read it.

What the relay does see, and SECURITY.md must say once: the address used, the user's IP addresses, when they connect
and how much data moves. Addresses are random ids, never names, because the certificate logs are public.

## Open questions

- Where the relay runs. Users pay nothing: the developer runs one small VPS (about €4 a month at Hetzner, 20 TB of
  traffic included), which carries bytes and does no compute.
- Each user's address needs no DNS change at onboarding: one wildcard record points `*.hostedbyme.app` at the relay.
- Let's Encrypt issues at most 50 certificates a week per registered domain. Put the domain on the Public Suffix List
  before launch: each user's address then counts on its own, and browsers keep one user's address from setting
  cookies on another's.
- Write the relay or adopt an existing one (step 1's candidates).
- Whether the Claude.ai and ChatGPT connectors are worth a warning in the app that they rely on point 4 only.

## Milestones

- [x] Domain: hostedbyme.app.
- [ ] Pick the relay (adopt or write).
- [ ] Relay live, open source in this repository, with its own tests.
- [ ] Mac side: key, random id, outbound connection, TLS-ALPN-01 certificate and renewal.
- [ ] iPhone app: key fingerprint in the pairing code, pinning.
- [ ] Certificate log watch and its warning.
- [ ] Encrypted shared artifacts (with the artifacts work).
- [ ] SECURITY.md "Network" and "What leaves the Mac", architecture.md, use/connect.md updated; #137 closed by it.

## Debt plan

The relay replaces the owner's Cloudflare Worker (`apps/edge/`) and the Funnel setup becomes optional, so the
connector has one public path instead of two. Nothing new is stored in `memory/`; the key lives with Life's other
secrets (`SECRETS`, `secret.ts`).
