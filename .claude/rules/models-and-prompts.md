---
paths:
  - "prompts/**"
  - "apps/server/src/models/**"
---

# Prompts and model calls

Moved from the root `AGENTS.md`. `apps/server/src/models/prompt-parts.test.ts` checks the pronoun rule; `scripts/imports.test.ts` lists every model-calling file.

- **Prompts and what they write name the owner, never a pronoun** (his words of 16 Nov 2026): a prompt says `{{owner}}`, which
  `promptText` fills with `readOwnerName` (`models/prompt-parts.ts`, from `truth/`), and states the rule first; never he, him, his,
  she, her or "the owner" for him (`prompt-parts.test.ts` checks). A reading written for his own screen (the situations: a person's, a
  project's, a matter's) addresses him as "you" (his answer of 26 Nov 2026), its prompt still saying `{{owner}}`; every other stored line keeps his name. Anyone else is named in a prompt's own words by their name or who they
  are to him, never by a family word from his notes or a ref's id (the same shared rule, his pass of 21 Nov 2026). Memory is written in his `memoryLanguage` (`{{language}}`);
  quotes stay as said, topic tags English. A label digested with stored work (`him` in the persona and style inputs) changes
  with its prompt's next version.

- **Model calls go through the provider the owner chose**: his subscriptions, or with his keys allmodels.io (his decision
  of 28 Oct 2026) and OpenRouter, only on hosts it lists as keeping no data (his decision of 8 Nov 2026); never another provider. The bench uses the same providers, on a copy of the data; the question cases' agent runs on his Codex subscription, reading his own data through the connector
  (`docs/operations.md`, "Model engines"). One model runs on the Mac instead of a provider: photo descriptions, Qwen3.5-9B
  under llama.cpp (`models/describer.ts`), his decision of 11 Nov 2026. The image never leaves the Mac; the description
  then reaches his provider inside the photo lines like the rest of the line. A second: the arrival reader's trigger,
  Apple's on-device model (Foundation Models, `SystemLanguageModel.default`, never Private Cloud Compute) through the
  app's helper (`models/foundation-model.ts`), his decision of 20 Nov 2026; since his decision of 21 Nov 2026 it only
  sieves mail: a mail it calls a person's (or a meeting, or one it refuses) goes to his engine; chats, voice and Thai
  go to his engine straight.

- Codex is pinned in `apps/server/package.json` and runs with its own `CODEX_HOME` (`docs/operations.md`).
