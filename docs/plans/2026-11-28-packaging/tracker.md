# Packaging tracker

Updated at every move. Plan: [README.md](README.md). Spec: [spec.md](spec.md).
Status: ⏳ waiting · 🔄 in progress · 👀 in review · ✅ merged.

| Bundle | Issue | PR | Needs | Runs beside | Status |
|---|---|---|---|---|---|
| D. Distribution and bundling | #1572 | #1594 | – | R, A1 | ✅ |
| R. Reach and push | #1573 | – | – | D, A1 | 🔄 |
| A1. The integration read | #1574 | – | #1561 | D, R | ⏳ |
| A2. Core with nothing of the owner's | #1575 | – | A1; R for voice files | G, T, M, I | ⏳ |
| G. Connect Google | #1576 | – | A1 | A2, T, M, I | ⏳ |
| H. History imports | #1583 | – | A1, A2; G for Gmail | G, T, M, I | ⏳ |
| T. Trust | #1577 | – | A1 | A2, G, M, I | ⏳ |
| M. Mac app | #1578 | – | A1, one-Mac-app bundle 4, onboarding design | A2, G, T, I | ⏳ |
| I. iPhone onboarding, day one | #1579 | – | A1, voice rename B2/B3, onboarding design | A2, G, T, M | ⏳ |
| D2. D's follow-up: uv on PATH, one tag table, signed and notarized release | #1596 | – | D | R | 🔄 |
| iPhone app id → com.ericedouard.life | #1597 | – | R | A1 | ⏳ |
| Pilots' release + rehearsal (fresh Mac account) | #1582 | – | A2, G, H, M, I, D, #1597 | – | ⏳ |
| I2. Getting to know you | #1580 | – | I, onboarding design | W | ⏳ |
| W. Windows host | #1581 | – | A1, A2, G, onboarding design | I2 | ⏳ |

Progress: 🟩⬜⬜⬜⬜⬜⬜⬜⬜⬜ 8% (1 of 12)

## Log

- 28 Nov: Apple side set up: Developer ID certificate in its own keychain (password in 1Password), notary profile `life-notary`, Paid Apps agreement accepted (owner's yes), App Store Connect record "Life: Your Memory" on com.ericedouard.life ("Life" is taken). D2 started (#1596). A1 waits on #1561 (access card: conflicting, "debt added"); its session asked.
- 28 Nov: D merged (#1594): git, gog and the bridges ship in Life.app, TestFlight script, dry release, install page. Leftovers in #1596 (uv not on the helper's PATH among them). Owner: Developer ID certificate and notary credentials, the App Store Connect app record, the pilots as users, a yes before the first public release.
- 28 Nov: onboarding design handed to a Designer sub-session; M, I, I2 and W wait for the owner's approved designs.
- 28 Nov: D (branch packaging-d) and R (branch packaging-r) started, one builder each.
- 28 Nov: H's failures: a card when the user can fix it, else a paused line that resumes after an update; never a matter.
- 28 Nov: history imports added as bundle H (#1583): code only, no agent; parsers mended upstream.
- 28 Nov: Windows setup ruled a local page in the browser.
- 28 Nov: issues #1572–#1582 filed; push through the relay and attested releases approved.
- 28 Nov: investigation done; game plan and spec written; Fable review reshaped them (A split into A1, A2, G).
