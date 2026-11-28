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
   The relay is OpenTunnel's server ([anomalyco/opentunnel](https://github.com/anomalyco/opentunnel), MIT; chosen
   28 Nov 2026), pinned to a reviewed commit, and the Mac talks to it with its TypeScript client
   (`@opentunnel/client`).
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

## Where the relay runs

On Fly.io (chosen 28 Nov 2026), the one developer-friendly host found that passes raw TCP on port 443 under our own
wildcard domain without holding a certificate: a raw TCP service (only Fly's `proxy_proto` handler, which adds the visitor's address) behind one dedicated anycast IPv4, so
a phone anywhere reaches the nearest region. About $9 a month for three regions (three 256 MB machines and the IPv4),
egress $0.02 per GB in Europe and North America, $0.04 in Asia. Users pay nothing. Railway, Render, Koyeb,
Northflank, Zeabur, DigitalOcean's App Platform and Cloudflare's proxy were ruled out: each decrypts, or allows only
HTTP, or gives a random port.

- A Mac connects to the nearest region; a visitor may arrive at another. The relay keeps its own registry of which
  machine holds each Mac and pipes across regions over Fly's private network (6PN). The Mac sends heartbeats: one
  report says long 6PN connections drop.
- Fly's removal of TCP idle timeouts is a forum post, not its docs: test a connection idle for hours before launch.
- A user who wants their own relay runs `fly launch --from <this repository>`, allocates a dedicated IPv4 and points
  their own wildcard record at it; the relay's `fly.toml` keeps passthrough. Fly has no one-click button.
- DNS stays at Porkbun, where the domain is registered; the relay edits only its ACME records, with a key limited to DNS on hostedbyme.app.

## The relay software

OpenTunnel already does what step 1 needs: blind SNI passthrough, a mesh over Fly's private network that forwards a
visitor to the machine holding the Mac's connection, WebSocket bridging with reconnects, per-tenant limits and
draining on deploy, running in 11 Fly regions. Its own setup is ours: raw TCP on 443 behind a dedicated IPv4.

What we change or check before launch:

- Ownership: it gives a Mac a bearer token for its id. Patch it so the Mac proves ownership with a signature from its
  own key.
- Certificates: it issues a certificate per tunnel over DNS-01 from the Mac's CSR, so it never holds the key but does
  hold our DNS. Prefer the Mac's own TLS-ALPN-01 (the server replays the ClientHello untouched, so it should pass;
  untested). Either way, steps 3 and 4 hold.
- Open creation: until creation is gated (#1545), tunnel creation is slowed in `apps/relay/fly.toml` (3 an hour per address).
- Its MySQL dependency (PlanetScale in its production): pick the smallest database Fly can run beside it.
- Size and age: about 18,000 lines of Rust, eight months old, one main maintainer. We pin a commit we reviewed and
  read each upgrade's diff before taking it.

Rejected: sish (one region; an offline Mac's name can be taken), frp (one region, large), piko (routes HTTP, not
TLS), rathole, bore and chisel (no SNI routing), and writing our own (1,000 to 2,000 lines, mostly rebuilding the
mesh and limits OpenTunnel has).

## Open questions

- Each user's address needs no DNS change at onboarding: one wildcard record points `*.hostedbyme.app` at the relay.
- Let's Encrypt issues at most 50 new certificates a week per registered domain; renewals don't count. When new
  installs near 40 a week, ask Let's Encrypt to raise it for hostedbyme.app (its rate limit adjustment form, by
  domain). The Public Suffix List comes after launch, at thousands of users: it declines smaller projects and entries
  made to get around rate limits. At that scale its reason is that browsers keep one user's address from setting
  cookies on another's.
- Whether the Claude.ai and ChatGPT connectors are worth a warning in the app that they rely on point 4 only.

## Milestones

- [x] Domain: hostedbyme.app.
- [x] Host: Fly.io.
- [x] Relay software: OpenTunnel.
- [x] OpenTunnel self-hosted on Fly (Singapore), a test tunnel served end to end (28 Nov 2026).
- [ ] Keypair ownership patch; TLS-ALPN-01 from the Mac tested; two more regions.
- [ ] Mac side: key, random id, outbound connection, TLS-ALPN-01 certificate and renewal.
- [ ] iPhone app: key fingerprint in the pairing code, pinning.
- [ ] Certificate log watch and its warning.
- [ ] Encrypted shared artifacts (with the artifacts work).
- [ ] SECURITY.md "Network" and "What leaves the Mac", architecture.md, use/connect.md updated; #137 closed by it.

## Debt plan

The relay replaces the owner's Cloudflare Worker (`apps/edge/`) and the Funnel setup becomes optional, so the
connector has one public path instead of two. Nothing new is stored in `memory/`; the key lives with Life's other
secrets (`SECRETS`, `secret.ts`).
