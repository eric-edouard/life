---
type: research
blocked_by: [18]
---

# Technical: shipping the playbook skill

## Question

How project agents on pi load Life's playbook skill.

## Answer

Paths are under `apps/server/src/` unless they start elsewhere; found by a code inventory of 28 Nov 2026.
- A `skills/` folder in Life's repo holding the playbook skill and its tools allowlist; copied into `Contents/Resources/life` by `scripts/helper.ts:81` (beside the pi extension, `:54`).
- `settingsOf` (`desk/runtimes/pi-runtime.ts:200`) adds `join(LIFE_CODE_DIR, "skills")` to pi's skills list.
- `find-skills` installs only well-proven skills into the project's own folder. A second Life on one Mac runs with `--no-skills` (`pi-runtime.ts:450`); a user's own Life.app is fine.

Built: https://github.com/eric-edouard/life/pull/1588
