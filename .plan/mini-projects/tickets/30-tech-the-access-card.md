---
type: research
blocked_by: [06]
---

# Technical: the access card

## Question

How the access card's self-ticking steps and "I'm at my Mac" work.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- A need kind `access` in `memory/needs.ts` (`KINDS`, `:111`): steps, each with what Life checks silently; each step's done state worked out when read, never stored.
- A watcher `lookForAccessDone` beside `lookForPaymentsDone` (`host/done-seen.ts:110`) reads the statuses.
- Mac: the `life-eventkit` helper (`apps/mac/Sources/LifeEventKit/main.swift`) grows into a permissions helper: silent status reads (`PHPhotoLibrary.authorizationStatus`, `CNContactStore`, `EKEventStore`, `AXIsProcessTrusted`), firing a prompt, opening a System Settings pane (as `LifeApp.swift:161` does for Full Disk Access).
- "I'm at my Mac" is an option whose act (`actOfOption`, `memory/decisions.ts:106`) asks the helper to fire the next missing step.
- `scripts/app.ts:60`: `NSPhotoLibraryUsageDescription`, the photos-library entitlement, and `AssociatedBundleIdentifiers` for any launchd job that reaches a protected resource.
