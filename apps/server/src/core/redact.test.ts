import { expect, test } from "bun:test";
import { parseIban, redact } from "./redact";

test("card numbers, IBANs, password lines and long tokens are removed", () => {
  const text = [
    "Carte 4970 1234 5678 9012 exp 09/28",
    "IBAN FR76 3000 4000 0312 3456 7890 143",
    "Mot de passe wifi: bakery2026!",
    "key sk_live_51HxYz0123456789abcdefghijklmnop",
    "Call Gaston at +33 6 00 00 00 02 tomorrow",
  ].join("\n");
  const out = redact(text);
  expect(out).not.toContain("4970 1234");
  expect(out).not.toContain("FR76");
  expect(out).not.toContain("bakery2026");
  expect(out).not.toContain("sk_live");
  expect(out).toContain("Call Gaston at +33 6 00 00 00 02 tomorrow");
});

test("PGP and PEM key blocks are removed whole", () => {
  const text = [
    "Keys at bottom",
    "-----BEGIN PGP PRIVATE KEY BLOCK-----",
    "lQdGBGXh+abc/def+ghi/jkl==",
    "-----END PGP PRIVATE KEY BLOCK-----",
    "Done",
  ].join("\n");
  const out = redact(text);
  expect(out).not.toContain("lQdGBGXh");
  expect(out).toContain("Keys at bottom");
  expect(out).toContain("Done");
});

test("the one IBAN a text holds, as written: a word after it cut back by its check digits; two, or a false one, give none", () => {
  expect(parseIban("IBAN FR76 3000 6000 0112 3456 7890 189 by 1 Dec")).toBe(
    "FR76 3000 6000 0112 3456 7890 189"
  );
  expect(parseIban("IBAN BE68 5390 0754 7034 BIC GKCCBEBB")).toBe(
    "BE68 5390 0754 7034"
  );
  expect(
    parseIban("BE68 5390 0754 7034 BIC, again BE68 5390 0754 7034 SEPA")
  ).toBe("BE68 5390 0754 7034");
  expect(
    parseIban("BE68 5390 0754 7034 or FR76 3000 6000 0112 3456 7890 189")
  ).toBeUndefined();
  expect(parseIban("IBAN BE69 5390 0754 7034")).toBeUndefined();
});
