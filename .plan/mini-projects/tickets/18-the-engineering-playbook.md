---
type: grilling
blocked_by: []
---

# The engineering playbook

## Question

Life's own variant of the owner's `work-on-code` skill, for project agents on the agent's model (today DeepSeek Flash):
which parts of `work-on-code` carry over, which go, and how each kept rule becomes a step the agent can't skip. Set by the
owner, never by the model. Frame he set on 27 Nov 2026:

- Quality means the output: how good it looks and feels to use (covered by the preview), and that it works with no
  bugs, or that any bug is surfaced to the user plainly. Technical debt and multi-provider tiering are stripped out:
  mini projects stay minimal and functional.
- One fixed stack: Bun and TypeScript. Anything else only on the owner's yes.
- Reviews are independent (a fresh session) but run on the agent's own selected model: no second, stronger model.

## Answer

Decided with the owner on 27 Nov 2026. The playbook is Life's own variant of `work-on-code`, written for the project
agent's model, with one aim: output that looks and feels right (the approved preview) and works, with any bug told
to the user plainly.

**Kept from `work-on-code`, rewritten for a weaker model:** read before building; a plan kept on disk; a fresh reviewer
that never reviews its own work; the stop signals; "check it by running it" and tests only where critical; small
command outputs, files read by range; minimal code.

**Dropped:** the debt verdict and debt plan, tiers and model ranks, other CLIs and optional picks, the watcher, trains,
landing, bundles, `debt` issues, the architecture naming rigour. Mini projects stay minimal and functional.

**The method:**

- **Code and history:** a local git repo in the project's folder, one commit per checked step. No GitHub, no PRs.
- **Plan:** one `PLAN.md` per project with checkboxes, read at every wake, ticked after each checked step.
- **Stack:** Bun and TypeScript; for anything with screens, React and Tailwind bundled by Bun (no Vite). The approved
  preview is built in the same stack, so it grows into the result instead of being thrown away.
- **Tools outside the stack:** an allowlist in the playbook of proven command-line tools (for photos: `osxphotos`,
  `exiftool`, ImageMagick), installed by the agent and called from Bun scripts. Adding one takes the owner's yes, as
  the playbook's author; the user is never asked.
- **Proof:** the agent uses the result as the user would (runs the script on a sample, opens the page and looks at a
  screenshot: the model sees images). Tests only where a mistake can't be undone: deletes and writes to the user's
  things.
- **Reviews:** a fresh session on the agent's own selected model, given the approved preview, `PLAN.md` and the running
  result: once on the plan before work starts, once on the result before "done". The reviewer judges against the
  user's intention, never taste: a finding must change whether the result does what the user asked, or it is dropped.
  A nitpick never reaches the user. Another round only when a finding justifies it.
- **Skills:** at the start, the agent looks for skills relevant to the project with the `find-skills` skill and uses
  them: only well-proven ones, with many downloads, never obscure ones.
- **Stuck:** revert each failed fix; after two, rethink and re-plan once; after that, stop and tell the user plainly
  what works, what doesn't, and what Life suggests (drop that part, or try another way). (Owner: no preference; this
  default stands.)
- **Home:** a skill in Life's repo, shipped in Life.app and loaded by every project agent; one source, versioned with
  Life. (Owner: no preference; this default stands.) Its name gets its `docs/glossary.md` line when it is built.
- **Previews and pages** use Life's own artifact skill, to be modelled on the owner's `artifact` skill (pages in git,
  dated, published at a link); that skill is part of the artifact system, planned elsewhere.
