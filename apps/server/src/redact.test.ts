import { expect, test } from "bun:test";
import { redact } from "./redact";

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
