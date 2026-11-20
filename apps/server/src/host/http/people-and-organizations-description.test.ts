import { expect, test } from "bun:test";
import { setSettings, settings } from "../../core/settings";
import { peopleAndOrganizationsDescription } from "./mcp";

test("read_people_and_organizations tells only of the parts whose add-on is on", () => {
  const was = settings().personal ?? null;
  try {
    setSettings({ personal: null });
    const off = peopleAndOrganizationsDescription();
    expect(off).toContain("communicationStyle");
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
    const on = peopleAndOrganizationsDescription();
    for (const word of ["`persona`", "`story`", "get along"]) {
      expect(on).toContain(word);
    }
  } finally {
    setSettings({ personal: was });
  }
});
