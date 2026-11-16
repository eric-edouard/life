import { expect, test } from "bun:test";
import { setSettings, settings } from "../../core/settings";
import { personPageDescription } from "./mcp";

test("read_person_page tells only of the parts whose add-on is on", () => {
  const was = settings().personal ?? null;
  try {
    setSettings({ personal: null });
    const off = personPageDescription();
    expect(off).toContain("communication style");
    for (const word of ["persona", "story", "get along", "together or not"]) {
      expect(off).not.toContain(word);
    }
    setSettings({
      personal: {
        histories: { from: "2026-01" },
        personas: {},
        relationships: {},
      },
    });
    const on = personPageDescription();
    for (const word of ["`persona`", "`story`", "get along"]) {
      expect(on).toContain(word);
    }
  } finally {
    setSettings({ personal: was });
  }
});
