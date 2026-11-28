import { expect, test } from "bun:test";
import { keyOf, keysOf, patternOf, ShapeReport, shapeOf } from "./shape-report";

// A shape report says an export's structure and nothing of what it holds: no name, no phone, no email, no word.

const NAMES = ["Jane", "Doe", "Ravi", "Kaur"];
const PHONE = "+44 7700 900123";
const MAIL = "jane.doe@example.com";
const SAID = "the boiler is broken again, call the plumber on Tuesday";
/** The words of it that only a line of his would say. */
const SAID_WORDS = ["boiler", "broken", "plumber", "Tuesday"];

test("a file name keeps its structure and loses its names, its phone and its email", () => {
  expect(patternOf("WhatsApp Chat with Jane Doe.txt")).toBe(
    "WhatsApp Chat with *.txt"
  );
  expect(patternOf("conversations-000.json")).toBe("conversations-000.json");
  expect(patternOf("_chat.txt")).toBe("_chat.txt");
  expect(patternOf(`WhatsApp Chat with ${PHONE}.txt`)).toBe(
    "WhatsApp Chat with *.txt"
  );
  expect(patternOf(`conversations.${MAIL}.json`)).toBe("conversations*.json");
});

test("a key or a column name is kept only when it is structure", () => {
  expect(keyOf("timestamp_ms")).toBe("timestamp_ms");
  expect(keyOf("_id")).toBe("_id");
  expect(keyOf("Jane Doe")).toBeUndefined();
  expect(keyOf(MAIL)).toBeUndefined();
  expect(keyOf("x".repeat(42))).toBeUndefined();
});

test("a report from a made-up export holds none of its names, phones or words", () => {
  const report = shapeOf("whatsapp", {
    counts: { lines: 1200, messages: 800 },
    files: [`WhatsApp Chat with ${NAMES.join(" ")}.txt`],
    keys: [
      "senderName",
      ...NAMES.map((n) => `${n}'s name`),
      `${PHONE}`,
      MAIL,
      SAID,
    ],
  });
  const said = JSON.stringify(report.message) + JSON.stringify(report.fields);
  for (const word of [...NAMES, PHONE, "900123", MAIL, ...SAID_WORDS]) {
    expect(said).not.toContain(word);
  }
  expect(report.fields).toEqual({
    counts: { lines: 1200, messages: 800 },
    files: ["WhatsApp Chat with *.txt"],
    format: "whatsapp",
    keys: ["senderName"],
  });
  expect(report).toBeInstanceOf(ShapeReport);
  expect(report).toBeInstanceOf(Error);
});

test("the keys of a parsed export are its structure, at a ceiling", () => {
  expect(
    keysOf({
      mapping: [{ message: { author: { role: "user" }, "Jane Doe": 1 } }],
      phone: PHONE,
    })
  ).toEqual(["author", "mapping", "message", "phone", "role"]);
});
