import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { LIFE_CODE_DIR } from "../core/paths";
import { setSettings, settings } from "../core/settings";
import { stamp } from "./llm";
import {
  isPromptVersion,
  partsIn,
  promptNameOf,
  promptText,
  renderedOf,
} from "./prompt-parts";

// The prompts with add-on parts: with every part on, each keeps its own name, so its cached outputs stay.
const WITH_PARTS = [
  "memory-communication-style.v2",
  "memory-conflict.v2",
  "memory-connection.v3",
  "memory-conversation-summary.v1",
  "memory-episodes.v8",
  "memory-extract.v6",
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
    expect(promptText("memory-extract.v6")).toContain("in English");
    setSettings({ memoryLanguage: "French" });
    expect(promptText("memory-extract.v6")).toContain("in French");
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
    expect(promptNameOf("memory-extract.v6")).toBe(
      "memory-extract.v6-without-relationships"
    );
    expect(promptNameOf("memory-pages.v6")).toBe(
      "memory-pages.v6-without-aboutMe-relationships"
    );
    expect(promptText("memory-extract.v6")).not.toContain(
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
      expect(["aboutMe", "mayKeep", "relationships"]).toContain(part);
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
      const text = promptText(prompt, true);
      expect(text.includes("own words on what Life must not keep")).toBe(held);
      expect(promptNameOf(prompt, true)).toBe(
        held ? `${prompt}-with-mayKeep` : prompt
      );
      expect(text).not.toContain("<!--");
    }
    expect(promptNameOf("memory-extract.v6", true)).toBe(
      "memory-extract.v6-with-mayKeep"
    );
    expect(
      isPromptVersion("memory-extract.v6-with-mayKeep", "memory-extract.v6")
    ).toBe(true);
    expect(
      isPromptVersion(
        "memory-extract.v6-without-relationships-with-mayKeep",
        "memory-extract.v6"
      )
    ).toBe(true);
    setSettings({ personal: null });
    expect(promptNameOf("memory-extract.v6", true)).toBe(
      "memory-extract.v6-without-relationships-with-mayKeep"
    );
    expect(promptNameOf("memory-closeness.v1", true)).toBe(
      "memory-closeness.v1"
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("the situation prompt has the mayKeep sentence only when it is given", () => {
  expect(promptText("memory-situation.v3")).not.toContain("must not keep");
  expect(promptText("memory-situation.v3", true)).toContain("must not keep");
});
