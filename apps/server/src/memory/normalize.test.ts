import { expect, test } from "bun:test";
import { normalize, normalizeLatin } from "./units";

test("normalize: Latin text as ever; names in Thai, Chinese and Cyrillic keep a distinct key", () => {
  expect(normalize("Zoé  Dupont-Çelik!")).toBe("zoe dupont celik");
  expect(normalize("  Hôtel d'Été, 12bis ")).toBe("hotel d ete 12bis");
  expect(normalize("Ça va?")).toBe("ca va");
  expect(normalize("...")).toBe("");
  expect(normalize("Jean (Me)")).toBe("jean me");
  const names = ["สมชาย ใจดี", "สมหญิง ใจงาม", "王小明", "Иван Петров"];
  const keys = names.map(normalize);
  expect(keys.every(Boolean)).toBe(true);
  expect(new Set(keys).size).toBe(names.length);
  // Thai tone marks tell words apart.
  expect(normalize("น้ำ")).not.toBe(normalize("นำ"));
  expect(normalize("Иван")).toBe("иван");
});

test("normalizeLatin keeps the recipe of stored ids: other scripts drop out", () => {
  expect(normalizeLatin("Zoé 王 Иван dîner")).toBe("zoe diner");
  expect(normalizeLatin("สมชาย")).toBe("");
});
