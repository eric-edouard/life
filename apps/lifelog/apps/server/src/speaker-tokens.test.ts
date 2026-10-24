import { expect, test } from "bun:test";
import { renderSpeakers } from "./speaker-tokens";

interface Case {
  case: string;
  names: Record<string, string>;
  rendered: string;
  text: string;
}

const cases = (await Bun.file(
  new URL("../fixtures/speaker-tokens.json", import.meta.url)
).json()) as Case[];

test.each(cases.map((c) => [c.case, c] as const))(
  "speaker tokens render: %s",
  (_, { names, rendered, text }) => {
    expect(renderSpeakers(text, names)).toBe(rendered);
  }
);
