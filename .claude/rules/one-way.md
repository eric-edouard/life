---
paths:
  - "apps/server/src/**"
  - "scripts/**"
---

# Server conventions

Before adding a helper, use the one that exists: search `docs/helpers.md` (the helper for each job) for the need. The layers and the 800-line cap are checked by `.fallowrc.json` and `scripts/imports.test.ts`.

- **Dependencies point one way** between `apps/server/src`'s layers: nothing imports the desk. Order and enforcement (`.fallowrc.json`, `scripts/imports.test.ts`): `docs/architecture.md`, "The code".

- **Settings are one strict file, read once per process** (`apps/server/src/core/settings.ts`). A part left out is off (one exception: `desk.webSearch` left out takes Life's chain, `WEB_SEARCH_CHAIN`, his word of 22 Nov 2026); a new key lands
  in code first. Core steps have no switch; the only feature switches are the personal add-ons (`core/add-ons.ts`), beside the outputs (`core/outputs.ts`) and the voice naming's two flags; owner values are never defaults in code. Likewise **a new key in `truth/` lands in code first**: the
  schemas are `.strict()`, and a key the running code doesn't know stops the watcher, the nightly and the connector.

Only `schedule.ts`'s schedules and the status snapshot's waking hours (`waking`, `snapshot.ts`, given `systemZone()`) follow the Mac's clock.
Where he is (`zones.jsonl`) is the phone's latest zone, whatever its age (`readZoneHere`, his decision of 27 Oct): the
phone is the source of truth and the Life server may run anywhere. The Mac's zone only when no phone ever named one;
lifelog unreadable changes nothing. Life reads the newest heartbeat's zone (the phone app always sends one); lifelog's
own owner zone (`ownerTimeZone`) takes the newest heartbeat that names one.
