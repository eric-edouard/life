# What an agent on the Mac can reach, and what needs the user

Research note, 28 Nov 2026. Scope: Life.app (signed bundle with helpers) runs `pi` as a child process, which runs shell
commands and Bun scripts. First case: tidy an Apple Photos library (~10,000 photos, ~1,000 albums). Nothing on this
Mac was opened to write this (`osxphotos` and PhotoScript are not installed here). Uncited lines are marked *(uncited)*.

## 1. Apple Photos: three ways in

| Way | Reads | Writes | Permission it trips |
|---|---|---|---|
| **PhotoKit** (`PHPhotoLibrary`, Swift/ObjC, or PyObjC) | every asset, album, folder; image data, downloading from iCloud | create/delete assets and albums, add/remove assets in albums, favorite, edits | **Photos** (TCC), on the responsible app |
| **osxphotos** (Python, reads `Photos.sqlite` directly) | nearly everything incl. persons, labels, keywords, `ismissing`, `incloud` | through AppleScript (PhotoScript/py-applescript) or PhotoKit | Photos and/or Full Disk Access to read the library; **Automation → Photos** to write |
| **AppleScript/JXA** (Photos dictionary; PhotoScript wraps it) | albums, folders, media items, keywords, title, description, favorite | create/delete albums and folders, add to album, set keywords/title/description/favorite, import | **Automation → Photos** (Apple Events) |

**PhotoKit.** Status is read without a prompt by `PHPhotoLibrary.authorizationStatus(for:)` with level `.readWrite`
or `.addOnly` ([Apple](https://developer.apple.com/documentation/photos/phphotolibrary/authorizationstatus(for:)));
only `requestAuthorization(for:)` prompts. The app needs `NSPhotoLibraryUsageDescription` in its Info.plist *(uncited,
standard)*. Every change goes through a change block; Apple: "For each call to the `performChanges` ... Photos shows an
alert asking the user for permission to edit the contents of the photo library. If your app needs to submit several
changes at once, combine them into a single change block"
([Requesting changes](https://developer.apple.com/documentation/photokit/requesting-changes-to-the-photo-library)).
Deletion is `PHAssetChangeRequest.deleteAssets(_:)`
([Apple](https://developer.apple.com/documentation/photos/phassetchangerequest/deleteassets(_:))); the delete confirm
is system UI with no documented opt-out ([SO, old](https://kiwix.lema.org/stackoverflow.com_en_all_2023-11/questions/31922796/disable-confirmation-on-delete-request-in-phphotolibrary)),
and forum reports describe it hanging ([forum 806349](https://developer.apple.com/forums/thread/806349)). Removing an
asset from an album is `PHAssetCollectionChangeRequest.removeAssets`; DTS says use `deleteAssets` to remove from the
*library* ([forum 768492](https://developer.apple.com/forums/thread/768492)). There is no API to read Recently Deleted
*(DTS forum reply, seen only in a search summary; unverified)*.
**So: one batched change block per step = one user "Allow" per step.** A 10,000-photo cleanup should be a handful of
batched, user-confirmed blocks, not one per photo.

**osxphotos** ([README](https://github.com/RhetTbull/osxphotos), [API](https://rhettbull.github.io/osxphotos/API_README.html)):
reads the database; writes via `batch-edit` (title, description, keywords...), `query --add-to-album` (creates the album
if needed), `import`, `timewarp`, `add-locations`, `sync`, `push-exif`. **No command deletes photos**; `keywords` and
`albums` only list. It warns against writing EXIF into library originals. Tested through macOS 15; macOS 26 "limited
testing"; "cannot read shared albums on macOS 26.x". Its author's PhotoKit gist says the *terminal app* must have Photos
access ([gist](https://gist.github.com/RhetTbull/41cc85e5bdeb30f761147ce32fba5c94)) — i.e. the grant lands on whatever
app is responsible for the Python process.

**AppleScript / PhotoScript** ([PhotoScript](https://github.com/RhetTbull/PhotoScript), source checked):
`create_album`, `delete_album`, `create_folder`, `delete_folder`, `Album.add`, set `title`, `keywords`, `favorite`.
Photos' AppleScript "cannot access information on faces ... nor can it delete a photo", and "does not provide a way to
remove a photo from an album": PhotoScript's `Album.remove` and `Album.move` **recreate the album under the same name
and delete the old one** (new album id; anything keyed on the old id breaks). Slow (Python→ObjC→AppleScript per call);
osxphotos notes Photos' AppleScript "is somewhat buggy and you may find that Photos crashes".

**What each operation needs**

| Operation | Best path | Permission | Undo |
|---|---|---|---|
| Read library, albums, keywords, faces | osxphotos (DB) or PhotoKit | Photos (or FDA for the raw DB) | n/a |
| Create album / folder, add photos to album | PhotoKit or AppleScript | Photos `.readWrite` + per-block alert, or Automation | delete the album |
| Remove photo from album | PhotoKit `removeAssets` (AppleScript can't; PhotoScript recreates) | Photos + alert | re-add (keep a log) |
| Rename/delete album, move album to folder | PhotoKit or AppleScript | as above | **album deletion has no trash** *(uncited)*; photos stay in library; log contents first |
| Set title, keywords, favorite, description | AppleScript/osxphotos `batch-edit`, or PhotoKit (favorite) | Automation or Photos | log old values to restore |
| Delete photos | **PhotoKit only** | Photos + system delete confirm | Recently Deleted, **30 days**, then gone; with iCloud Photos the delete propagates to every device ([Apple 124460](https://support.apple.com/124460)) |

## 2. iCloud Photos with "Optimize Mac Storage"

- With Optimize on, many originals are not on disk; local reads get thumbnails/previews *(uncited, Apple's setting
  description)*. osxphotos reports per photo `ismissing` (original not on disk, computed from the DB, file not
  checked), `iscloudasset`, `incloud` ([API](https://rhettbull.github.io/osxphotos/API_README.html)).
- Downloading originals: PhotoKit `PHImageRequestOptions.isNetworkAccessAllowed = true`; with `false` the result's
  `PHImageResultIsInCloudKey` says it is in the cloud ([Apple](https://developer.apple.com/documentation/photos/phimagerequestoptions/isnetworkaccessallowed)).
  osxphotos `export --download-missing` tells Photos via AppleScript to download (fails on burst extras), or
  `--use-photokit` (experimental) ([README](https://github.com/RhetTbull/osxphotos)). Mind disk space: originals land
  in the library.
- **Detecting the setting:** no documented key or API found. Infer it silently from the library itself: share of
  `ismissing` photos among `iscloudasset` ones (osxphotos) or `PHImageResultIsInCloudKey` on a sample. Both need the
  Photos/FDA grant first. Organising albums and metadata does **not** need originals; only content analysis
  (duplicates by pixels, blur) does.

## 3. macOS permissions (TCC)

- **Who gets the grant:** TCC attributes a request to the *responsible code*, normally the nearest app the user knows
  in the process tree, so the prompt shows the app's name and the decision is recorded for the whole app
  ([Quinn, On File System Permissions](https://developer.apple.com/forums/thread/678819),
  [What is a responsible process?](https://developer.apple.com/forums/thread/731504)). A child spawned by Life.app
  (pi → bun → osascript/python) therefore asks **as Life.app**. Runs from Terminal ask as Terminal; Life's grant does
  not carry over and vice versa. The link breaks if the child daemonises or is spawned by launchd; a launchd job needs
  `AssociatedBundleIdentifiers` ([678819](https://developer.apple.com/forums/thread/678819)); reports of children not
  inheriting ([805245](https://developer.apple.com/forums/thread/805245), [Qt write-up](https://www.qt.io/blog/the-curious-case-of-the-responsible-process)).
  Grants need a stable code-signing identity, and TCC expects a native main executable ([678819](https://developer.apple.com/forums/thread/678819)).
- **Consequence:** "the system can't distinguish file system operations done by the interpreter from those done by the
  script" ([678819](https://developer.apple.com/forums/thread/678819)). Once Life.app holds Photos, Automation or FDA,
  **every script any agent runs under Life inherits it**. Only Life's own send guard / brief stands between an agent and
  that power.
- **Requesting:** Photos, Contacts, Calendar, Reminders, Automation and Files & Folders can be *prompted* by the app
  (once; the answer is remembered, re-prompt only after `tccutil reset`). Prompts show only in a GUI login session;
  otherwise "the operation is denied by default" ([678819](https://developer.apple.com/forums/thread/678819)). **Full
  Disk Access and Accessibility can't be granted by code**: the user toggles them in System Settings; the app can only
  open the pane *(uncited; standard `x-apple.systempreferences:` links)*. Nothing grants itself silently.
- **Automation (Apple Events):** a hardened-runtime app needs `com.apple.security.automation.apple-events` and
  `NSAppleEventsUsageDescription` ([Apple](https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.security.automation.apple-events));
  one grant per target app (Photos, Finder, Mail ... each separately).
- **Checking without a prompt:**
  - Photos: `PHPhotoLibrary.authorizationStatus(for:)` (no prompt; must run *in* Life's attribution).
  - Calendar/Reminders: `EKEventStore.authorizationStatus(for:)` ([Apple](https://developer.apple.com/documentation/eventkit/ekeventstore/authorizationstatus(for:))); Contacts: `CNContactStore.authorizationStatus(for:)` *(uncited)*.
  - Accessibility: `AXIsProcessTrustedWithOptions` with prompt off ([forum](https://developer.apple.com/forums/thread/24288); can read stale).
  - Automation: `AEDeterminePermissionToAutomateTarget(..., askUserIfNeeded: false)`; target must be running and
    reports describe hangs ([mjtsai](https://mjtsai.com/blog/2018/08/31/aedeterminepermissiontoautomatetarget-added-but-aepocalyse-still-looms), [forum 666528](https://developer.apple.com/forums/thread/666528)): run with a timeout.
  - FDA / Files & Folders: try a read of a known protected path; FDA never prompts, a block fails with `EPERM`
    ([678819](https://developer.apple.com/forums/thread/678819)). Reading TCC.db itself needs FDA.
  - Best done by a small Swift check in Life.app's helper, so the answer is Life's, not bun's or Terminal's.

## 4. Other things a project might touch (one line each)

- **Files and folders:** home outside Desktop/Documents/Downloads/iCloud Drive/removable volumes is open; those folders
  prompt once per app (Files & Folders); app data under `~/Library` (Mail, Messages, Safari) needs FDA ([678819](https://developer.apple.com/forums/thread/678819)). Undo: `rm` is final; move to `~/.Trash` (or Finder via Automation) instead.
- **Mail:** no public API; AppleScript to Mail (Automation→Mail) or read `~/Library/Mail` (FDA). Deletes go to the
  mailbox's Trash *(uncited)*.
- **Calendar / Reminders:** EventKit, full-access prompt; deletes are final unless the account's web trash keeps them *(uncited)*.
- **Contacts:** Contacts framework, Contacts prompt; deletes final (iCloud.com can restore an earlier archive) *(uncited)*.
- **Notes:** AppleScript only (Automation→Notes); deleted notes go to Recently Deleted for 30 days *(uncited)*; the
  store itself needs FDA.
- **Music:** AppleScript (Automation→Music) for playlists/metadata; `iTunesLibrary` framework read-only *(uncited)*.

## 5. The general pattern

| Resource | How to reach it | Permission | Life can check silently? | Undo |
|---|---|---|---|---|
| Photos library (read) | osxphotos DB / PhotoKit | Photos (or FDA) on Life.app | yes, `authorizationStatus` | n/a |
| Photos albums, keywords, titles | PhotoKit / AppleScript | Photos + alert per change block, or Automation→Photos | Photos yes; Automation partly (flaky) | only by Life's own log of prior state |
| Photos deletes | PhotoKit `deleteAssets` | Photos + system delete confirm | yes | Recently Deleted 30 days, synced to all devices |
| iCloud originals | PhotoKit network access / osxphotos `--download-missing` | Photos | Optimize: infer from `ismissing` | n/a (uses disk) |
| Plain files outside protected folders | shell, Bun | none | n/a | Trash if moved there; `rm` final |
| Desktop / Documents / Downloads | shell, Bun | Files & Folders on Life.app (prompt) | yes, try and catch `EPERM` | Trash |
| App data (Mail, Messages, Notes stores) | read files | FDA, user-only toggle | yes, try a read | read-only is safest |
| Other apps (Mail, Notes, Music, Finder) | AppleScript/JXA | Automation per target app | partly, `AEDetermine...` with timeout | app-specific trash |
| Calendar, Reminders, Contacts | EventKit, Contacts | own prompt each | yes, `authorizationStatus` | mostly final |
| UI driving (any app) | Accessibility / `agent-desktop` | Accessibility, user-only toggle | yes, `AXIsProcessTrusted` | none |

**Takeaways for Life:** grants must attach to Life.app (Info.plist usage strings, Apple Events entitlement, helpers
kept in Life's responsibility chain), and any grant is then every agent's. The user must click each first prompt,
each PhotoKit change block's alert, and must toggle FDA/Accessibility himself. Before changing albums or metadata the
agent should write a restore log (album ids → photo ids, old titles/keywords), since only photo deletes have a trash.
