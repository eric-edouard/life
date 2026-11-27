---
type: research
blocked_by: []
assets: [.plan/mini-projects/assets/04-what-an-agent-can-reach.md]
---

# What an agent can reach on the Mac

## Question

Survey, with sources, what an agent of Life can reach on a user's Mac today and what needs the user: the Photos library (PhotoKit, osxphotos, iCloud Photos with Optimize Storage, originals, albums, edits), files and folders, other apps, and the macOS permissions (TCC) each needs. Note what can be checked without asking. Photos is the first case; list the general pattern.

## Answer

Researched on 28 Nov 2026; sources in the asset. Inputs for the first look, asking for access, safe work and privacy:

- **Every grant lands on Life.app.** macOS attributes a child process's access to its responsible app, so pi, bun,
  python and osascript all ask as Life.app. Life.app needs the matching Info.plist usage strings and the Apple Events
  entitlement, its helpers must stay launched from it, and a launchd job needs `AssociatedBundleIdentifiers`.
- **A grant is Life's whole power:** macOS cannot tell scripts apart, so once Life holds Photos, Automation or Full Disk
  Access, every agent's script has it.
- **Only the user can:** answer each first permission prompt (only in a logged-in desktop session), and turn on Full
  Disk Access and Accessibility in System Settings; code can only open the right pane.
- **Silent checks:** Photos, Calendar, Contacts and Accessibility have status calls that never prompt; Automation's
  check is unreliable; Full Disk Access is tested by a refused read.
- **Photos changes:** PhotoKit shows the user an allow alert per change batch, and deleting photos shows a system
  confirmation that can't be turned off: a large cleanup is a few big batches the user approves. Only PhotoKit can
  delete photos; osxphotos and AppleScript can't, and "remove from album" is faked by rebuilding the album (a new id).
- **Undo:** deleted photos stay in Recently Deleted for 30 days (with iCloud Photos, on every device); deleted albums
  and old keywords or titles are kept nowhere, so the agent keeps a restore log before changing anything.
- **Optimize Mac Storage:** no documented way to read the setting; it shows as originals missing once Life can read
  the library. Albums and keywords need no originals; comparing photo content does, and costs disk space.
- **osxphotos** is tested through macOS 15, lightly on 26; this Mac runs 27.2. The playbook trial must prove it here,
  or the agent uses PhotoKit through a small Swift helper.
