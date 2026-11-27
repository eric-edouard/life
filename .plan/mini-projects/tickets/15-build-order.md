---
type: grilling
blocked_by: [01, 02, 03, 05, 06, 07, 08, 09, 10, 11, 12, 13, 14, 18, 20, 21, 22, 23]
---

# Build order

## Question

Which PRs build the decided design, in what order, which touch strict paths, what each unblocks, and which screens the designer session must deliver first.

Agreed so far (owner, 28 Nov 2026): 1 the project record, threshold and handover (desk); 2 the playbook skill in Life.app; 3 the access card, "I'm at my Mac" and Life.app's permissions; 4 previews and the done page on the artifact system, with "Build it" and its cost cap; 5 the screens (designer session first); 6 SECURITY.md and docs; then the trial and the live runs. Results that live on and its siblings fold in once decided.

## Answer

Agreed with the owner on 28 Nov 2026, in this order:

1. The one-off project record (`goal`, `dropped`, glossary), the threshold in the main session's brief, and the
   handover in code: a one-off project's write registers its agent and hands it the ask; promotion at the door (desk:
   strict path).
2. The engineering playbook skill, shipped in Life.app and loaded by project agents, with its allowlist.
3. The access card with self-ticking steps, "I'm at my Mac", and Life.app's usage strings and Apple Events entitlement.
4. Previews, the done page and live results on Life's artifact system: "Build it" with its plan and cost cap; a
   result's events wake its agent.
5. The batch send card (strict path, its own PR, the send invariant updated).
6. The screens, from the designer session first: the project's quiet line, the cards, the done page.
7. `SECURITY.md` (project agents' reads, the known limit) and the docs.

Then the playbook trial, the live run on the owner's Photos library, the party invite system, and a second user's
library.
