# Releasing Life.app

How-to for the maintainer: publish a signed release.

A release is Life.app signed with a Developer ID under the hardened runtime, notarized and stapled; a zip of it (what
Sparkle downloads, listed in `appcast.xml` with its EdDSA signature) and a DMG holding it; all three published as a
GitHub release (`scripts/release.ts`).

## Once, by the maintainer

- A **Developer ID Application** certificate in the Keychain (Apple Developer account): `LIFE_SIGN_IDENTITY`, set for
  the release command. Day-to-day builds can use an Apple Development certificate from `.env`: any Apple-issued
  certificate keeps the app's Keychain items and Full Disk Access across builds, and Sparkle loads only from the same
  team, so a self-signed one does not work.
- `xcrun notarytool store-credentials <profile>` with an app-specific password: `LIFE_NOTARY_PROFILE`.
- Sparkle's key pair: `apps/mac/Frameworks/bin/generate_keys` (after one `bun scripts/app.ts`). The private half stays in
  the maintainer's Keychain; the public one is `LIFE_SPARKLE_KEY`.
- The GitHub repository the releases go to: `LIFE_RELEASES_REPO` (`owner/name`). The app's update feed is its latest
  release's `appcast.xml`.

## Each release

```sh
LIFE_SIGN_IDENTITY="Developer ID Application: …" LIFE_NOTARY_PROFILE=<profile> \
LIFE_RELEASES_REPO=<owner/name> LIFE_SPARKLE_KEY=<public EdDSA key> LIFE_VERSION=x.y.z \
bun scripts/release.ts
```

Set `LIFELOG_HOST_APP` to also put lifelog's host app in the DMG.

A release whose lifelog contract changed (`apps/lifelog/apps/server/openapi.json`) updates Lifelog Host first, then
Life: Life reads lifelog only through that contract, and an older Host refuses the new calls.

## A release that migrates stored data

A release that ships a migration (`host/migrate.ts`, written fresh each time) runs it from Life.app at its next start: install the app first
and let it start, then pull the live checkout. A future migration brings its own guard
against a checkout running it on his data.

## A release that changes the connector's values or keys

An app that reads the connector (ChatGPT, Claude) keeps the descriptions it was given when it connected. After such a
release (`names-2026-11` renamed values and output keys, no tool or argument), remove the Life connector in each app
and add it again with a code from `bun life pair`. Until then an old description names values that now return nothing
(`types: ["identity"]`, `["rating"]`) and a saved changes cursor replays his fact-check answers once.
