import { expect, test } from "bun:test";
import answers from "./answers.json";
import { openOf, type Reminder, unshared } from "./remctl";

// remctl's answers as Life reads them (answers.json): the shapes life-eventkit (app/Sources/LifeEventKit) answers too.

test("a reminder's due is local wall time, as `open_reminders` shows it", () => {
  const [r] = answers.show as Reminder[];
  expect(openOf(r as Reminder).due).toBe("2026-10-22 09:00");
});

const UUID = /^[0-9A-F-]{36}$/;

test("an add answers its number and its deep link's id, a list says whether it is shared", () => {
  expect(typeof answers.add.numericId).toBe("number");
  expect(answers.add.id).toMatch(UUID);
  expect(unshared(answers["list-info"])).toBe(true);
});
