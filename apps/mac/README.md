# Life.app

The macOS menu-bar app (SwiftUI, macOS 14+) that installs and runs Life.

- `Sources/LifeApp`: the app. `Supervisor.swift` keeps the helper's `archive` and `watch` running and starts the
  nightly tick every 30 minutes; `Helper.swift` runs the helper with `LIFE_CODE_DIR`, `LIFE_OWNER_DATA_DIR`, `LIFE_STATE_DIR` and the
  Keychain's secrets; the panel (`Panel.swift`) and the status window (`StatusWindow.swift`) show the plate, in Life's brand (`Brand.swift`, `docs/brand.md`); `Remctl.swift` installs remctl for Reminders.
- `Sources/LifeEventKit`: `life-eventkit`, a one-shot tool for the Past calendar through EventKit.
- The app never reads Life's files: it asks the helper (`life app`, `life settings`, …).

Build it from the repository root with `bun scripts/app.ts [out]` (it fetches the pinned Sparkle, compiles the helper
and signs with `LIFE_SIGN_IDENTITY`, else ad hoc). Releases: `docs/releasing.md`.
