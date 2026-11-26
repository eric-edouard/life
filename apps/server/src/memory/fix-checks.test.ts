import { expect, test } from "bun:test";
import { checksOf } from "./checks";
import { inputs } from "./checks-test-inputs";
import { fixesOf } from "./fix-checks";

const budget = (spent: number, projected: number) => ({
  isPassed: spent >= 50,
  monthly: 50,
  projected,
  spent,
});

test("the fix list: a bridge to sign in (signed out, or never linked), and the month's amount only while its pace would pass it and it is not passed yet", () => {
  const signIns = [
    { label: "LINE", name: "line", state: "signed-out" as const },
    { label: "Telegram", name: "telegram", state: "never-linked" as const },
  ];
  expect(fixesOf(signIns, undefined, "2026-11")).toMatchObject([
    {
      context:
        "LINE signed Life out, so its messages stop reaching Life until you sign in again.",
      network: "line",
      options: ["sign-in", "later"],
      ref: "fix:signed-out/line",
      // The prototype's words for a signed-out network (`wafix`).
      title: "Sign LINE back in",
    },
    {
      network: "telegram",
      options: ["sign-in", "later"],
      question: "Connect Telegram?",
      ref: "fix:not-linked/telegram",
    },
  ]);
  expect(fixesOf([], budget(20, 60), "2026-11")).toMatchObject([
    {
      options: ["raise", "keep"],
      question: "Raise this month's amount to $100?",
      ref: "fix:budget/2026-11",
    },
  ]);
  expect(fixesOf([], budget(20, 45), "2026-11")).toEqual([]);
  expect(fixesOf([], budget(55, 80), "2026-11")).toEqual([]);
  expect(fixesOf([], undefined, "2026-11")).toEqual([]);
});

test("a sign-in fix's option names the network his app signs in", () => {
  const fixes = fixesOf(
    [{ label: "LINE", name: "line", state: "signed-out" }],
    undefined,
    "2026-11"
  );
  const [card] = checksOf({ ...inputs([]), fixes });
  expect(card?.options.map(({ id, signsIn }) => ({ id, signsIn }))).toEqual([
    { id: "sign-in", signsIn: "line" },
    { id: "later", signsIn: undefined },
  ]);
});
