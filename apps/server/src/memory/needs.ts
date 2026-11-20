import { z } from "zod";
import { oneLine } from "./draft";
import { nameKey } from "./units";

// What he needs in hand to do a card's step (`needs`, the asks contract): one registry of kinds, each its shape, its
// `line` (Life's plain words of it, which a phone that doesn't know the kind draws: worked out when read, never stored),
// its one line in the card's rules and its page (`fetch("ask/<kind>")`). A new kind is one entry here and one phone
// component; the tool's arguments never change for it.

const Account = z
  .object({
    bank: oneLine(80).optional(),
    bic: z
      .string()
      .regex(/^[A-Z0-9]{8,11}$/)
      .optional(),
    holder: oneLine(120).optional(),
    kind: z.literal("account"),
    number: oneLine(60),
    scheme: z
      .enum(["th_account", "promptpay", "iban", "swift", "other"])
      .optional(),
  })
  .strict();
const Amount = z
  .object({
    currency: z.string().regex(/^[A-Z]{3}$/, "an ISO code: THB, EUR"),
    kind: z.literal("amount"),
    value: z.number().positive(),
  })
  .strict();
const Link = z
  .object({
    kind: z.literal("link"),
    url: z.url({ protocol: /^https?$/ }),
    vendor: oneLine(60).optional(),
  })
  .strict();
const Text = z
  .object({
    copy: z.boolean().optional(),
    kind: z.literal("text"),
    label: oneLine(40).optional(),
    text: z.string().min(1).max(500),
  })
  .strict();
const Qr = z
  .object({
    kind: z.literal("qr"),
    payload: z.string().min(1).max(1000).optional(),
    source: oneLine(200),
  })
  .strict();

export const Need = z.discriminatedUnion("kind", [
  Account,
  Amount,
  Link,
  Text,
  Qr,
]);
export type Need = z.infer<typeof Need>;
type Kind = Need["kind"];
type Of<K extends Kind> = Extract<Need, { kind: K }>;

/** An amount as he reads it: grouped, two decimals only when it has cents, then its currency ("4,500 THB"). */
export const amountWordsOf = (value: number, currency: string) =>
  `${value.toLocaleString("en-US", {
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  })} ${currency}`;

/** Each kind: `about`, its one line in the card's rules; `line`, Life's plain words of one; `page`, what `fetch("ask/<kind>")` says. */
const KINDS: {
  [K in Kind]: { about: string; line: (n: Of<K>) => string; page: string };
} = {
  account: {
    about: "a bank account (number, bank, holder)",
    line: (n) =>
      `${[n.bank, n.number].filter(Boolean).join(" ")}${n.holder ? `, ${n.holder}` : ""}${n.bic ? ` (BIC ${n.bic})` : ""}`,
    page: '`{kind: "account", number, bank?, holder?, scheme?, bic?}`: where he sends money. `number` as the payee wrote it (an account number, an IBAN, a PromptPay phone or id); `bank` its bank\'s name; `holder` the name the bank will show, for him to check (never copied) and for Life to see the payment by; `scheme` one of `th_account`, `promptpay`, `iban`, `swift`, `other` (his phone picks the bank app by it); `bic` when the payee gave one. Give it before the `amount`: the phone shows needs in your order. Example: `{"kind":"account","bank":"Kasikornbank","number":"012-3-45678-9","holder":"Blue Reef Diving Co., Ltd.","scheme":"th_account"}`.',
  },
  amount: {
    about: "what to pay (value, currency)",
    line: (n) => amountWordsOf(n.value, n.currency),
    page: '`{kind: "amount", value, currency}`: `value` a positive number, `currency` its ISO code (`THB`, `EUR`). He copies the plain number. With `doneSeenBy: "payment"`, Life looks for a payment of exactly this amount in this currency to the payee (`fetch("ask/payment")`). Example: `{"kind":"amount","value":4500,"currency":"THB"}`.',
  },
  link: {
    about: "a web page to open (url, vendor)",
    line: (n) => `${n.vendor ? `${n.vendor}: ` : ""}${new URL(n.url).host}`,
    page: '`{kind: "link", url, vendor?}`: a page he opens by his own tap (a checkout, a login, a form), `https` or `http` only; `vendor` who runs it. His phone shows the page\'s host in full and never opens it by itself. Example: `{"kind":"link","url":"https://pay.example.com/i/123","vendor":"Fibrenet"}`.',
  },
  qr: {
    about: "a payee's QR code (source)",
    line: (n) => `QR code from ${n.source}${n.payload ? `: ${n.payload}` : ""}`,
    page: '`{kind: "qr", source, payload?}`: a QR code the payee sent. `source` where it is, in a few words with the message\'s id (`"Kit\'s WhatsApp of 20 Nov, <id>"`); `payload` the code\'s text when you read it. His phone shows it as words for now: give the `account` and `amount` beside it.',
  },
  text: {
    about: "a reference or code (text, label, copy)",
    line: (n) => (n.label ? `${n.label}: ${n.text}` : n.text),
    page: '`{kind: "text", text, label?, copy?}`: a fact he needs in hand: a payment reference, an invoice number, a code, a point to say. `label` names it ("Reference"); `copy: true` gives it a copy button. Example: `{"kind":"text","label":"Reference","text":"INV-2041","copy":true}`.',
  },
};

/** Life's plain words of a need: what a phone that doesn't know its kind draws. */
export const needLineOf = (n: Need) =>
  (KINDS[n.kind].line as (x: Need) => string)(n);

/** The needs as a card shows them: each with its `line`, in the agent's order. */
export const needsShownOf = (needs: readonly Need[] = []) =>
  needs.map((n) => ({ ...n, line: needLineOf(n) }));

/** Every kind's name. */
export const NEED_KINDS = Object.keys(KINDS) as Kind[];

/** The kinds in the card's rules, one line each. */
export const NEED_KINDS_LINE = NEED_KINDS.map(
  (k) => `\`${k}\` ${KINDS[k].about}`
).join(", ");

/** A kind's page (`fetch("ask/<kind>")`), or undefined for a name that is no kind. */
export const needPageOf = (name: string) =>
  Object.hasOwn(KINDS, name) ? KINDS[name as Kind].page : undefined;

/** Titles before a name: they say nothing of who it is. */
const TITLES = new Set(["mr", "mrs", "ms", "miss", "dr", "the"]);
/** A company's form written out at a name's end ("Co., Ltd.", "Limited", "Inc."): dropped; a bare "Co" may be a surname. */
const COMPANY_FORM =
  /[\s,]+(?:co\.?,?\s*ltd|company\s+limited|limited|ltd|inc|plc)\.?\s*$/i;

/** A name's words as names are compared (`nameKey`), less its leading titles and its company form; initials kept. */
const nameWordsOf = (name: string) => {
  const words = nameKey(` ${name}`.replace(COMPANY_FORM, ""))
    .split(" ")
    .filter(Boolean);
  const from = words.findIndex((w) => !TITLES.has(w));
  return from < 0 ? [] : words.slice(from);
};

/** The words of a card's payee: the account's `holder`, else the link's `vendor`, as the bank shows it. */
export const payeeWordsOf = (needs: readonly Need[] = []) =>
  nameWordsOf(
    needs.find((n): n is Of<"account"> => n.kind === "account")?.holder ??
      needs.find((n): n is Of<"link"> => n.kind === "link")?.vendor ??
      ""
  );

/**
 * Whether a bank's name of the payee holds the payee `words`: each a whole word of it, in any order, a word asked
 * twice there twice ("MS. LEE, ANN" for "Ann Lee"; "LI LI", never "BO LI", for "Li Li").
 */
export const isToPayee = (name: string, words: readonly string[]) => {
  const said = nameWordsOf(name);
  return (
    words.length > 0 &&
    words.every((w) => {
      const i = said.indexOf(w);
      return i >= 0 && said.splice(i, 1).length === 1;
    })
  );
};

/** The amount a card's payment is looked for by: its one `amount` need. */
export const amountOf = (needs: readonly Need[] = []) =>
  needs.find((n): n is Of<"amount"> => n.kind === "amount");
