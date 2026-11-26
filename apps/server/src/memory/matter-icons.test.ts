import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as models from "../models/llm";
import {
  iconInputsOf,
  iconNow,
  MATTER_ICON_PICKS,
  pickMatterIcons,
  readLifeIcons,
} from "./matter-icons";
import type { MatterView } from "./matter-read";

// Life's pick of a matter's icon, on a made-up model: each matter's name says the key it means ("Matter n: key"), a
// name naming none gets null.

afterEach(() => rmSync(MATTER_ICON_PICKS, { force: true }));

const view = (name: string, more: Partial<MatterView> = {}) =>
  ({ id: `matter_${name.length}`, name, ...more }) as MatterView;

/** A made-up model: one pick per matter shown, from its name; the asks recorded. */
function fakeModel() {
  return spyOn(models, "askOnce").mockImplementation((async (o: {
    input: { matters: { id: string; name: string }[] };
  }) => ({
    icons: o.input.matters.map((m) => ({
      icon: m.name.split(": ")[1] ?? null,
      matter: m.id,
    })),
  })) as never);
}

test("a matter's text is asked once: picks and nones are stored and read back; his pick is never asked and wins", async () => {
  const ask = fakeModel();
  try {
    const lease = view("Matter 1: key", {
      goal: { at: "", by: "life", text: "A new lease" },
    });
    const vague = view("Follow up");
    const his = view("Matter 2: gift", { ownerIcon: "tools" });
    const twin = { ...lease, id: "matter_twin" } as MatterView;
    expect((await pickMatterIcons([lease, vague, his, twin])).picked).toBe(2);
    expect(ask).toHaveBeenCalledTimes(1);
    // One call, his matter and the second of one text never shown; the fallback never offered.
    const shown = JSON.stringify(ask.mock.calls[0]);
    expect(shown).not.toContain("Matter 2");
    expect(shown).not.toContain('"key":"folder"');
    const picks = readLifeIcons();
    expect(iconNow(lease, picks)).toEqual({ by: "life", key: "key" });
    expect(iconNow(twin, picks)).toEqual({ by: "life", key: "key" });
    expect(iconNow(vague, picks)).toBeUndefined();
    expect(picks.get(iconInputsOf(vague))).toBeNull();
    expect(iconNow(his, picks)).toEqual({ by: "owner", key: "tools" });
    // Asked again only when its text changes.
    await pickMatterIcons([lease, vague]);
    expect(ask).toHaveBeenCalledTimes(1);
    const renamed = { ...lease, name: "Matter 1: home" } as MatterView;
    expect(iconNow(renamed, readLifeIcons())).toBeUndefined();
    await pickMatterIcons([renamed]);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(iconNow(renamed, readLifeIcons())).toEqual({
      by: "life",
      key: "home",
    });
  } finally {
    ask.mockRestore();
  }
});

test("a key not offered, an id not asked and a matter the reply leaves out store nothing: the next pass asks again", async () => {
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    icons: [
      { icon: "folder", matter: "m1" },
      { icon: "key", matter: "m9" },
    ],
  });
  try {
    const one = view("Matter 1: folder");
    const two = view("Matter 22: key");
    expect((await pickMatterIcons([one, two])).picked).toBe(0);
    expect(readLifeIcons().size).toBe(0);
    await pickMatterIcons([one, two], 1);
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});

test("a pass makes at most `calls` calls of 40 matters", async () => {
  const ask = fakeModel();
  try {
    const many = Array.from({ length: 90 }, (_, i) => view(`Matter ${i}: key`));
    expect((await pickMatterIcons(many, 2)).picked).toBe(80);
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});
