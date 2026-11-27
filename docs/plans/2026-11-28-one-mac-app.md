# Merge Lifelog Host into Life.app (owner's decision, 28 Nov 2026)

Life.app is the one Mac app; Lifelog Host.app goes; skip renaming Host. The voice server stays its own process (only copy of pendant audio; a Life crash must never stop it). A later part renames lifelog → voice. Done already: life#1521 (/voice on Life's origin).

Chosen shape B: launchd keeps the voice children; Life's helper installs them.
Rejected: A (voice children in Life.app's Swift Supervisor: they die with Life on quit/swap/Sparkle relaunch; orphan locks), C (import Host's package into Life.app: two supervisors in one process, same lifetime flaw).

## Debt plan
Tier: hard: trust boundary (device and reader tokens), the process holding the only copy of pendant audio, a live cut-over.
Inventory: Host children and env apps/lifelog/apps/mac-quiet/Sources/LifelogHost/{Supervisor,HostModel}.swift, QuietCore/Host.swift:8-136; secrets QuietCore/Secrets.swift:6-60; Life.app apps/mac/Sources/LifeApp/{Supervisor,Helper,LifeApp}.swift; apps/server/src/core/service.ts:21-59 (keepRunning; caller host/bridges.ts:100); host/cli.ts:385-399 (pair link); ios Kit/Sources/LifeConnector/LifePairing.swift:4; core/settings.ts:193-194; host/http/tailscale.ts:53; tools/build-and-swap.sh; package.json:29; tools/host-build-and-swap.sh; tools/conveyor.sh:53; scripts/release.ts:67-69; scripts/check.ts:14,88-90,134; resource-sample.ts:37-62; embedder.test.ts:46-50; nightly.ts:361-373; apps/server/scripts/voices.ts:30-35. rg: keepRunning|LaunchAgents, lifelog://pair, LIFELOG_TOKEN, Lifelog Host, 47615, process.execve.
Shape: host/voice.ts holds one table of children (server, quiet, identity, embedder), each with binary, args, env from secrets.json, server.env and settings. `life voice run <child>` execs into the child (process.execve; never stays a parent). `life voice start|stop` writes/removes launchd jobs com.ericedouard.life.voice-<child>. keepRunning stays as it is (the bridges' nightly heal needs its restart); voice's `start` compares its own plist and calls keepRunning only when it changed (the build SHA is a plist argument, so only a new build restarts voice). voice.ts is the only code that mints and writes secrets.json, keeping keys it doesn't own (macToken, claudeToken, which lifelog-quiet reads); Life.app writes voice settings and keys only through the helper (`life voice …`), never Swift Secrets. Life.app calls `voice start` at launch and on Save; its Supervisor untouched.
State: optional settings key `voice: { speakers, backups }`; four launchd plists (paths and SHA only, no secret). Derived: token hashes, PUBLIC_BASE_URL (connector origin + /voice), child status (launchctl print + /status/live). UserDefaults com.lifelog.host read by nothing afterwards.
Deletes: Sources/LifelogHost/ (1,123), QuietCore/Host.swift + HostStatus.swift + tests (~840), host-app.ts (178), tools/host-build-and-swap.sh, conveyor.sh:53, release.ts:67-69, package.json:29, Secrets.cloudflareToken, Keychain LIFELOG_TOKEN, LifeApp.swift:165-166, resource-sample Host rules, Host docs; features: cloudflared tunnel, tailscale serve :443, reach modes, "Copy Life's lifelog settings", lifelog address/token fields, Host status window, the second llama bundle.
Net lines: about −1,900 (adds ~600).
Plan review: reshaped. keepRunning keeps its restart (bridges' nightly heal, bridges.ts:100, nightly.ts:284-287); log names move with launchd's (events.ts:3,55, service.test.ts:29-61, service.ts:55); secrets.json gets one writer (voice.ts); a glossary line for voice now, AGENTS.md:7 in bundle 4; old com.lifelog.quiet plist and README steps go in bundle 4.

## Bundles
1. [x] Voice under launchd (strict; ~900 lines): service.ts stopRunning (keepRunning unchanged); events.ts and service.test/comment log names; glossary line `voice`; host/voice.ts + test (env equals today's HostTests cases; hashes never tokens; RESTIC_*/IDENTITY_* not overridable by server.env); cli.ts voice run|start|stop; pair link carries url+token (one QR); reader token read from secrets.json; settings `voice` key; embedder.ts/test read voice.ts; resource-sample, nightly, voices.ts.
2. Life.app bundles and shows voice (~700): scripts/app.ts adds lifelog-server, lifelog-quiet, restic, codex, uv, identity files, embedder model, one llama; apps/mac Voice settings section (ElevenLabs key, speakers, backups, summaries sign-ins, export/import, Start fresh), QR in Panel, Voice status row; check.ts gates apps/mac.
3. Cut-over on his Mac (runbook, his yes): disable Host login item, quit Host, pkill its helpers, tailscale serve :443 off, `life voice start`; gap < 30 s (phone holds pages unACKed). Proofs: /health local and via /voice; a pendant page after the cut; migration count unchanged; kill -9 Life leaves server pid; launchd restarts a killed server; reboot with Life closed; embedder, summary, restic nightly. Rollback: `life voice stop`, open Host (untouched, same data).
4. Delete Host (~−2,400) after 48 h, with com.lifelog.quiet.plist and its README steps, AGENTS.md:7 rewritten.

Owner's yeses: `voice` settings key; secrets.json read by Life's helper and device token in Life's QR (SECURITY wording); lifelog.ericedouard.com ending; the cut-over time; deleting Keychain LIFELOG_TOKEN.

## The owner's yeses

28 Nov 2026, "Yes, all four": the phone re-pairs before the cut (done 28 Nov); lifelog.ericedouard.com ends at the cut; Life reads secrets.json and its QR carries the device token (SECURITY wording to follow in bundle 2); a gap under 30 s at the cut.

Life reads voice with the device token, as it does today (the reader token opens none of apple-health, notifications, the naming queue).
