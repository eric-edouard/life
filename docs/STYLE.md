# Writing Life's docs

Reference: the rules every page in this repository follows. Read them before you write or edit one.

1. Each page has one job, and its first line names it: tutorial, how-to, reference or explanation. User how-tos live
   in `docs/use/`; everything else in `docs/` is reference or explanation for developers.
2. In the README and `docs/`, user docs speak to the reader as "you" and reference docs say "the owner"; no page says
   "he". AGENTS.md and `docs/agent.md` (the agent's runtime playbook) are exempt.
3. Show before telling. A command, a screenshot or a short transcript comes first; the sentence about it after.
4. Say what is optional, and what it costs in money, time or access, where you first mention it.
5. Internal terms (unit, moment, status snapshot, observation) belong in reference docs. A user page says what the reader sees.
6. Lists are for parallel items: steps, options, files. Explanations go in prose, with sentences of different lengths.
7. No bolded lead-in on every bullet, no emoji in headings, no "Features" list of adjectives. Bold is for the names of
   buttons, menus and settings the reader sees on screen, always and only.
8. Avoid seamless, robust, powerful, effortless, and "not just X but Y". Say what the thing does.
9. State a limit plainly, once, where it applies. Don't apologise for it and don't repeat it.
10. No closing paragraph that restates the section. End on the next step or a link.
11. One fact, one place. When a fact moves, delete the old copy and link to the new one. The README links to how-tos;
    it does not repeat their steps.

## The playbook

`docs/agent.md` is not read by developers: the agent reads it on every call, so every line costs on every run. Rules
1 to 11 don't apply to it; these do. Changing it is "ask first" (AGENTS.md).

12. Write to the agent as "you", about the owner as "he": imperative, present tense.
13. Each rule once, in the section where the agent needs it. No section restates another.
14. Say what to do and the condition that changes it. Give a reason only where the agent would otherwise guess wrong.
15. Tools, fields and values exactly as the connector spells them. No code paths or developer detail.
16. Cut every word that changes nothing the agent does.

Next: the [docs index](../README.md#docs).
