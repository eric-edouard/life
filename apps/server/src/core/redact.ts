// Strips secrets from source text before any model sees it. Notes, reminders and mail sometimes hold card
// numbers, IBANs, codes, passwords or PGP/PEM key blocks; none of that is ever needed to remember something.

const KEY_BLOCK =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(?:-----END [A-Z0-9 ]+-----|$)/g;
const CARD = /\b(?:\d[ -]?){13,19}\b/g;
const IBAN = /\b[A-Z]{2}\d{2}(?:[ ]?[A-Z0-9]{4}){3,7}(?:[ ]?[A-Z0-9]{1,4})?\b/g;
const SECRET_LINE =
  /^.*\b(?:password|passwd|mot de passe|mdp|pin|cvv|cvc|code secret|otp|passcode|api[ _-]?key|token|seed phrase|recovery (?:key|phrase))\b.*$/gim;
const LONG_TOKEN =
  /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;

export function redact(text: string): string {
  return text
    .replace(KEY_BLOCK, "[key block removed]")
    .replace(SECRET_LINE, "[line removed: looked like a secret]")
    .replace(IBAN, "[IBAN removed]")
    .replace(CARD, (m) =>
      m.replace(/\D/g, "").length >= 13 ? "[number removed]" : m
    )
    .replace(LONG_TOKEN, "[token removed]");
}

/** Whether an IBAN's characters (no spaces) pass its mod-97 check (ISO 13616). */
const isValidIban = (iban: string) =>
  BigInt(
    [...`${iban.slice(4)}${iban.slice(0, 4)}`]
      .map((c) => Number.parseInt(c, 36))
      .join("")
  ) %
    97n ===
  1n;

/**
 * The one IBAN a text holds, exactly as written (spaces kept), else none: two different ones, or none, give none. A
 * match `IBAN` over-reads (a word after it, "… 7034 BIC") is cut back, group by group, until its mod-97 check passes.
 * Only for the payee's account on his own payment card (`withPayeeAccountsOf`); every other read goes through `redact`.
 */
export function parseIban(text: string) {
  const found = new Map<string, string>();
  for (const m of text.match(IBAN) ?? []) {
    const groups = m.split(" ");
    for (let n = groups.length; n > 0; n -= 1) {
      const written = groups.slice(0, n).join(" ");
      const iban = written.replaceAll(" ", "");
      if (iban.length >= 15 && isValidIban(iban)) {
        found.set(iban, written);
        break;
      }
    }
  }
  return found.size === 1 ? [...found.values()][0] : undefined;
}
