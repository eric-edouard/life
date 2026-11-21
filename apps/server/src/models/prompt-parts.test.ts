import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import { stamp } from "./llm";
import {
  IN_PERSON,
  isPromptVersion,
  MAY_KEEP,
  partsIn,
  promptNameOf,
  promptText,
  readOwnerName,
  renderedOf,
} from "./prompt-parts";

// The prompts with add-on parts: with every part on, each keeps its own name, so its cached outputs stay.
const WITH_PARTS = [
  "memory-communication-style.v2",
  "memory-conflict.v2",
  "memory-connection.v3",
  "memory-conversation-summary.v1",
  "memory-episodes.v10",
  "memory-extract.v8",
  "memory-history-month.v1",
  "memory-mentions.v1",
  "memory-pages.v6",
  "memory-persona.v2",
  "message-file-description.v1",
];
const file = (p: string) =>
  readFileSync(join(LIFE_CODE_DIR, "prompts", `${p}.md`), "utf8");

test("with every part on, each prompt keeps its own name", () => {
  const was = settings().personal;
  try {
    setSettings({ personal: { aboutMe: {}, relationships: {} } });
    for (const prompt of WITH_PARTS) {
      expect(promptNameOf(prompt)).toBe(prompt);
      expect(
        stamp({ effort: undefined, engine: "claude", model: "m" }, prompt, "r")
          .prompt
      ).toBe(prompt);
    }
  } finally {
    setSettings({ personal: was ?? null });
  }
});

// About to be deleted with their reads; left as they are.
const UNTOUCHED = new Set([
  "memory-conflict.v2",
  "memory-connection.v3",
  "memory-voice-naming.v1",
]);
/** Double-quoted text: examples and words cited, where any pronoun may stand. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”/g;
const MD = /\.md$/;
const PRONOUN = /\b(he|him|his|himself)\b/i;
const THE_OWNER = /the owner\b/i;

test("no prompt names the owner by a pronoun or as the owner: {{owner}} is his name", () => {
  const prompts = readdirSync(join(LIFE_CODE_DIR, "prompts"))
    .map((f) => f.replace(MD, ""))
    .filter((p) => !UNTOUCHED.has(p));
  for (const prompt of prompts) {
    const prose = file(prompt).replace(QUOTED, "");
    expect([prompt, prose.match(PRONOUN)?.[0]]).toEqual([prompt, undefined]);
    expect([prompt, THE_OWNER.test(prose)]).toEqual([prompt, false]);
    const text = promptText(prompt);
    expect(text).not.toContain("{{");
    expect(text).toStartWith("Test is the person whose memory this is");
  }
});

test("{{language}} is the language his memory is written in", () => {
  const was = settings().memoryLanguage;
  try {
    expect(promptText("memory-extract.v8")).toContain("in English");
    setSettings({ memoryLanguage: "French" });
    expect(promptText("memory-extract.v8")).toContain("in French");
  } finally {
    setSettings({ memoryLanguage: was });
  }
});

test("a part that is off is cut out with its text and named in the prompt's name", () => {
  const was = settings().personal;
  try {
    setSettings({ personal: { aboutMe: {} } });
    const pages = promptText("memory-pages.v6");
    expect(file("memory-pages.v6")).toContain("## Between us");
    expect(pages).not.toContain("Between us");
    expect(pages).not.toContain("between_us");
    expect(pages).toContain("`views`");
    expect(pages).not.toContain("part:");
    expect(promptNameOf("memory-pages.v6")).toBe(
      "memory-pages.v6-without-relationships"
    );
    setSettings({ personal: null });
    expect(promptNameOf("memory-extract.v8")).toBe(
      "memory-extract.v8-without-relationships"
    );
    expect(promptNameOf("memory-pages.v6")).toBe(
      "memory-pages.v6-without-aboutMe-relationships"
    );
    expect(promptText("memory-extract.v8")).not.toContain(
      "Between Test and someone close"
    );
    // A prompt with no part keeps its name.
    expect(promptNameOf("memory-closeness.v1")).toBe("memory-closeness.v1");
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("every part of the prompts is an add-on, and an off part leaves no marker behind", () => {
  for (const prompt of WITH_PARTS) {
    for (const part of partsIn(file(prompt))) {
      expect(["aboutMe", "inPerson", "mayKeep", "relationships"]).toContain(
        part
      );
    }
    expect(renderedOf(file(prompt), () => false)).not.toContain("<!--");
  }
});

test("a stored name made under any variant of a prompt is its version", () => {
  expect(isPromptVersion("memory-pages.v6", "memory-pages.v6")).toBe(true);
  expect(
    isPromptVersion("memory-pages.v6-without-relationships", "memory-pages.v6")
  ).toBe(true);
  expect(isPromptVersion("memory-pages.v5", "memory-pages.v6")).toBe(false);
  expect(isPromptVersion("memory-pages.v60", "memory-pages.v6")).toBe(false);
});

test("his words on what Life may keep switch on one sentence per prompt, and a name that is still the prompt's version", () => {
  const was = settings().personal;
  try {
    setSettings({ personal: { aboutMe: {}, relationships: {} } });
    for (const prompt of WITH_PARTS) {
      const held = file(prompt).includes("part:mayKeep");
      const text = promptText(prompt, [MAY_KEEP]);
      expect(text.includes("own words on what Life must not keep")).toBe(held);
      expect(promptNameOf(prompt, [MAY_KEEP])).toBe(
        held ? `${prompt}-with-mayKeep` : prompt
      );
      expect(text).not.toContain("<!--");
    }
    expect(promptNameOf("memory-extract.v8", [MAY_KEEP])).toBe(
      "memory-extract.v8-with-mayKeep"
    );
    expect(
      isPromptVersion("memory-extract.v8-with-mayKeep", "memory-extract.v8")
    ).toBe(true);
    expect(
      isPromptVersion(
        "memory-extract.v8-without-relationships-with-mayKeep",
        "memory-extract.v8"
      )
    ).toBe(true);
    setSettings({ personal: null });
    expect(promptNameOf("memory-extract.v8", [MAY_KEEP])).toBe(
      "memory-extract.v8-without-relationships-with-mayKeep"
    );
    expect(promptNameOf("memory-closeness.v1", [MAY_KEEP])).toBe(
      "memory-closeness.v1"
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("the situation prompt has the mayKeep sentence only when it is given", () => {
  expect(promptText("memory-situation.v3")).not.toContain("must not keep");
  expect(promptText("memory-situation.v3", [MAY_KEEP])).toContain(
    "must not keep"
  );
});

test("a month's in-person paragraph shows only on a call that has it on: off, the prompt is the file it was", () => {
  const month = "memory-history-month.v1";
  const sha = (text: string) =>
    new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 16);
  // The render before the part existed, pinned: a month with no conversation in person is shown the same prompt.
  expect(sha(promptText(month))).toBe("1221ade54773bde2");
  expect(promptText(month, [IN_PERSON])).toContain("## In person");
  expect(promptNameOf(month)).toBe(month);
  expect(promptNameOf(month, [MAY_KEEP, IN_PERSON])).toBe(
    `${month}-with-inPerson-mayKeep`
  );
  expect(isPromptVersion(promptNameOf(month, [IN_PERSON]), month)).toBe(true);
});

test("the owner is called by their `called`, else their name's first word", () => {
  const data = mkdtempSync(join(tmpdir(), "life-owner-"));
  mkdirSync(join(data, "truth"));
  const write = (extra: string) =>
    writeFileSync(
      join(data, "truth", "people.yaml"),
      `schemaVersion: 1\npeople:\n  - id: me\n    name: Jean Paul Dupont\n${extra}`
    );
  write("");
  expect(readOwnerName(data)).toBe("Jean");
  write("    called: Jean Paul\n");
  expect(readOwnerName(data)).toBe("Jean Paul");
});
