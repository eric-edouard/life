# Navigation review, PR #1402 (v4.1 NAV)

26 Nov 2026, a fresh reviewer. Built the PR's head (`615e4e35b`) for a clone of the iPhone 18 Pro simulator (iOS 27.2),
paired it with the made-up demo Life (`scripts/demo.ts`, loopback, its watcher only), and drove it with agent-device.
Judged against `2026-11-25-app-v4.html` (side-panel scenarios clicked), `2026-11-23-current-spec.md`, `docs/brand.md` and
Apple's navigation patterns. Screenshots are in `2026-11-26-screens-nav-review/`.

**Verdict: fail**, on three must-fix items. The base holds: the thread is the root of a `NavigationStack`, a person link
pushes a profile with the system's glass Back, one `RootView.Sheet` replaces another, the field rides the keyboard,
and the edge overlays the stack.

## Must-fix

1. **A pushed profile has no field.** `AskField` is the root's `safeAreaInset`, so the profile pushed over it shows
   none. The spec says "On every screen: the edge, the field at the bottom". The prototype's profile keeps the field
   ("What has he…") under the profile, with the glass back in place of the two round buttons. Put the field (and the
   inset) outside the `NavigationStack`, or on the destination too, so it stays.
   `2026-11-26-screens-nav-review/03-deeplink-profile-pushed.png` against `2026-11-26-screens-nav-review/00-prototype-profile.jpg`.
2. **A face in a `pictures` block still opens the profile as its own sheet.** `PicturesBlock` (`Items/ItemsBlock.swift`)
   keeps `@State opened` and `.sheet { ProfileView(ref:).sheetStack() }`. So one person opens two ways: a `life:` link
   pushes, a face presents. That breaks "one sheet at a time" (this sheet sits outside `RootView.Sheet`) and the spec's
   "a tap opens their profile over the thread". Route the face's tap through the same `open(ref)` (`openURL` with
   `life-open:`, as `[Inline].attributed` does). Code only: no Life answer with a pictures block could be made without
   a live agent. Compare `2026-11-26-screens-nav-review/03-deeplink-profile-pushed.png`.
3. **A notification tap or an ask link lands on nothing when the ask isn't already a row in the thread.** `open(ref)`
   and the notification route both end in `life.focus`, which only sets `focused`. An `ItemRow` unfolds only if it is
   on screen (`ItemRow.onChange(of: life.focused)`), and nothing scrolls to it either. The spec says "Opened without
   answering, Life brings the ask to the bottom with its answers." On the demo, `lifelog://open?ref=matter_…` (an ask
   ref in the demo's inbox) closed the open Settings sheet and then showed nothing, from the thread too. Bring the ask to
   the bottom (or at least scroll to it and unfold it) when it is focused.
   `2026-11-26-screens-nav-review/09-matter-link-over-settings-shows-nothing.png`,
   `2026-11-26-screens-nav-review/10-matter-link-from-thread-shows-nothing.png`.

## Should-fix

1. **Settings has no Close; the Pendant sheet does.** Both are `RootView.Sheet`s, but only `PendantView` has a
   `CloseItem`. A drag-down still closes Settings. Give every full-height sheet the same Close, so each sheet closes the
   same way. `2026-11-26-screens-nav-review/08-settings-sheet.png`, `2026-11-26-screens-nav-review/07-pendant-sheet.png`.
2. **A non-person `life:` link opens a page sheet**: an observation shows Life's raw text, refs and "its evidence:
   read_observation …" included. The spec says `life:` names unfold, and "nothing of Life's opens a screen but a picture
   or a phrase", "No page of its own". The behaviour was already there; this PR moves it to the root, so the decision is
   now in one place. Decide what a matter or fact link does in the thread (unfold, or Life's answer as his ask), or at
   least hide the refs. `2026-11-26-screens-nav-review/11-observation-link-sheet.png`.
3. **The phrase screen is a `fullScreenCover` inside a block**, outside `RootView.Sheet`, and it covers the edge. The
   spec allows full screen there, but the comment "one sheet at a time" is then not quite true. Either name it as the
   exception in `apps/lifelog/apps/ios/AGENTS.md`, or route it through the root. (Not reached: no phrase block without a
   live agent.)

## Nit

1. `LinkSheet`'s `person:` branch (`ProfileView(...).sheetStack()`) can no longer be reached, since `open(ref)` pushes
   every `person:` ref. Delete it. `2026-11-26-screens-nav-review/12-person-link-over-sheet.png`.

## Seen working

- Thread root, field pinned at the bottom, two round buttons: `01-thread-root.png`, `02-count-answer.png`.
- A person deep link pushes the profile with the system's glass Back; Back returns to the thread:
  `03-deeplink-profile-pushed.png`, `05-back-to-thread.png`.
- A person link with a sheet up closes the sheet and pushes the profile: `12-person-link-over-sheet.png`.
- The Pendant context menu, then Settings: `06-pendant-context-menu.png`, `08-settings-sheet.png`.
- The keyboard: the field rides it, the thread's bottom stays above the field, and a drag on the thread puts it away:
  `14-keyboard-up.png`, `15-keyboard-down-by-drag.png`.

## Not reached

- **A long thread, a `life:` link in Life's words, faces in a pictures block, the phrase screen and its Close.** Each
  needs an answer from Life's main session, a real agent turn. The count's tap tried one, the demo's desk started a
  Claude session for it, and it answered "I couldn't answer that." I stopped the desk instead of spending more turns.
- **The edge swipe and drag-to-dismiss.** agent-device's swipes, `left-edge` and slow pans moved in-app scroll views
  (the keyboard drag worked) but no system gesture: the edge pan left the profile up (`04-edge-swipe-not-driven.png`)
  and a pan down left the Pendant sheet up. So this is unverified, not failed. The profile shows the system navigation
  bar, so the interactive pop should be there.
- **A notification tap.** `simctl push` was refused on the fresh clone ("Source is not authorized"), and simctl can't
  grant notifications. The code clears the sheet and the stack (`toThread`) before `focus(pushId:)`; must-fix 3 applies
  to it as well.
