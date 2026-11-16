import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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

// SHA-256 of each prompt's file before parts existed: with every part on, a prompt renders as these bytes, so the
// owner's cached outputs (keyed by prompt name) stay.
const BEFORE = {
  "memory-communication-style.v2":
    "4c6d6ded5ffe1926fa59c85afc319b01f8add0e27a4212a77dbac2b08b73dfe4",
  "memory-conflict.v2":
    "ae31ea8119759f99314d8a01b5dcf8149f4bf51cbef5261b28e1a27c27e06049",
  "memory-connection.v3":
    "0db3f35df7fd892563a4f4b7883fc1aa98d5ad793c274df2c2fe7891f1c663ee",
  "memory-conversation-summary.v1":
    "d8a0264f1efd9c8a965d1d5133f805c7c8ea61d346994d271cfb07cfa58b4873",
  "memory-episodes.v8":
    "e5e530726b7bc2cd4567e5931700765e420eb2b35fa45efb1dde24c943a65d09",
  "memory-extract.v5":
    "b29ffb3d1fcf65f99b0fe3c94745da307317aefe65494d5a10f4fe867f19bc64",
  "memory-history-month.v1":
    "add8736b1946ea52c49e5fc84cc20a815c4818c228da2c640b751ce3e9dd53d1",
  "memory-mentions.v1":
    "178bd474240fc8e269635e90add7cd963c0c5bc9a938d086a5ed867de42e45f2",
  "memory-pages.v6":
    "3bb7b39b010c25c3abbdc6f360781bf4bdf010ef9d6730ddc2b7f2ec97d059fa",
  "memory-persona.v2":
    "64a5617d637485ee2cd44632918ca66894c32e8de88b5206e471bb0982c416a9",
  "message-file-description.v1":
    "8b30676e3d4b57528c6bdb007f02135d2c1ceb226f760c86ac227741c8dd04b7",
};
const file = (p: string) =>
  readFileSync(join(LIFE_CODE_DIR, "prompts", `${p}.md`), "utf8");

test("with every part on, each prompt renders as its file did before parts, under its own name", () => {
  const was = settings().personal;
  try {
    setSettings({ personal: { aboutMe: {}, relationships: {} } });
    for (const [prompt, sha] of Object.entries(BEFORE)) {
      expect(
        new Bun.CryptoHasher("sha256").update(promptText(prompt)).digest("hex")
      ).toBe(sha);
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
    expect(promptNameOf("memory-extract.v5")).toBe(
      "memory-extract.v5-without-relationships"
    );
    expect(promptNameOf("memory-pages.v6")).toBe(
      "memory-pages.v6-without-aboutMe-relationships"
    );
    expect(promptText("memory-extract.v5")).not.toContain(
      "Between him and someone close"
    );
    // A prompt with no part keeps its name.
    expect(promptNameOf("memory-closeness.v1")).toBe("memory-closeness.v1");
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("every part of the prompts is an add-on, and an off part leaves no marker behind", () => {
  for (const prompt of Object.keys(BEFORE)) {
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
    for (const prompt of Object.keys(BEFORE)) {
      const held = file(prompt).includes("part:mayKeep");
      const text = promptText(prompt, true);
      expect(
        text.includes("the owner's own words on what Life must not keep")
      ).toBe(held);
      expect(promptNameOf(prompt, true)).toBe(
        held ? `${prompt}-with-mayKeep` : prompt
      );
      expect(text).not.toContain("<!--");
    }
    expect(promptNameOf("memory-extract.v5", true)).toBe(
      "memory-extract.v5-with-mayKeep"
    );
    expect(
      isPromptVersion("memory-extract.v5-with-mayKeep", "memory-extract.v5")
    ).toBe(true);
    expect(
      isPromptVersion(
        "memory-extract.v5-without-relationships-with-mayKeep",
        "memory-extract.v5"
      )
    ).toBe(true);
    setSettings({ personal: null });
    expect(promptNameOf("memory-extract.v5", true)).toBe(
      "memory-extract.v5-without-relationships-with-mayKeep"
    );
    expect(promptNameOf("memory-closeness.v1", true)).toBe(
      "memory-closeness.v1"
    );
  } finally {
    setSettings({ personal: was ?? null });
  }
});
