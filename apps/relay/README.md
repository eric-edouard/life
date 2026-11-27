# The relay

Reference: the service behind `*.hostedbyme.app`, OpenTunnel's server on Fly.io, which passes each Mac's TLS through
unopened ([plan](../../docs/plans/2026-11-27-private-relay.md)).

| File | |
|---|---|
| `Dockerfile` | OpenTunnel at a reviewed commit, our patches applied, the DNS hook |
| `*.patch` | our changes to upstream; `optional-eab.patch` lets it use Let's Encrypt, which needs no account binding |
| `website/` | the page at `https://hostedbyme.app`: what the domain is and its abuse contact, `abuse@hostedbyme.app` (forwarded at Porkbun) |
| `porkbun-dns-hook.sh` | creates and deletes the ACME TXT records at Porkbun, where the domain's DNS lives |
| `fly.toml` | the relay app, `hostedbyme`, raw TCP on 443 and 80, dedicated IPv4 |
| `db/fly.toml` | its MySQL, `hostedbyme-db`, on Fly's private network only |

Secrets live in Fly and in 1Password's Agents vault (`hostedbyme relay MySQL`, `hostedbyme relay Porkbun DNS`; the
Porkbun key may only edit DNS on hostedbyme.app). DNS at Porkbun: `@` and `*` point at the relay's IPs, and a CAA
record lets only Let's Encrypt issue.

```sh
fly deploy -a hostedbyme --remote-only     # from this folder
fly deploy -a hostedbyme-db                # from db/
```

A new upstream commit goes in `OPENTUNNEL_COMMIT` only after reading its diff, and each patch must still apply.
