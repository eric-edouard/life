import { z } from "zod";
import { isoDateTime } from "../records/fields";
import {
  ACCESS_CHECKS,
  type AccessStatuses,
  accessLineOf,
  accessStepsOf,
} from "./access";
import { oneLine } from "./draft";
import { nameKey } from "./units";

// What he needs in hand to do a card's step (`needs`, the asks contract): one registry of kinds, each its shape, its
// `line` (Life's plain words of it, which a phone that doesn't know the kind draws: worked out when read, never stored),
// its one line in the card's rules and its page (`fetch("ask/<kind>")`). A new kind is one entry here and one phone
// component; the tool's arguments never change for it.

const https = z.url({ protocol: /^https$/ });
const Access = z
  .object({
    kind: z.literal("access"),
    steps: z
      .array(
        z
          .object({
            check: z.enum(ACCESS_CHECKS),
            /** With `disk_free`: how much free space the step needs, in GB. */
            freeGb: z.number().positive().optional(),
            text: oneLine(120),
          })
          .strict()
          .refine(
            (s) => (s.check === "disk_free") === (s.freeGb !== undefined),
            {
              message: "`freeGb` goes with `disk_free`, and only with it",
            }
          )
      )
      .min(1)
      .max(8),
  })
  .strict();
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
const App = z
  .object({
    kind: z.literal("app"),
    name: oneLine(60),
    /** An https link into the app (a universal link or its store page), opened by his own tap. */
    url: https.optional(),
  })
  .strict();
/** The most one Apify run may be capped at, in dollars: a bigger job is several cards. */
export const APIFY_RUN_MAX_USD = 20;
/** The most of an actor's input a card holds, as JSON. */
const APIFY_INPUT_CHARS = 4000;
const Apify = z
  .object({
    /** The store's `username/name`. */
    actor: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
    /** The agent's estimate of what the run costs, from the actor's prices at his tier (`find_apify_actors`). */
    estimateUsd: z.number().positive(),
    /** The actor's input, exactly as the run gets it. */
    input: z
      .record(z.string(), z.unknown())
      .refine((i) => JSON.stringify(i).length <= APIFY_INPUT_CHARS, {
        message: `the input is ${APIFY_INPUT_CHARS} characters of JSON at most`,
      }),
    kind: z.literal("apify"),
    /** The cap Apify holds the run under: it never charges more. */
    maxUsd: z.number().positive().max(APIFY_RUN_MAX_USD),
    /** What the run gets him, in a few words: shown in the need's line. */
    what: oneLine(120),
  })
  .strict();
const Event = z
  .object({
    end: isoDateTime,
    kind: z.literal("event"),
    place: oneLine(200).optional(),
    /** Popup minutes before it starts, 1 to 3: written with the event on his yes (never a mail). */
    reminders: z.array(z.int().min(0).max(40_320)).min(1).max(3),
    start: isoDateTime,
    title: oneLine(120),
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
const Place = z
  .object({
    address: oneLine(200).optional(),
    appleMapsUrl: https.optional(),
    boltUrl: https.optional(),
    googleMapsUrl: https.optional(),
    kind: z.literal("place"),
    name: oneLine(120),
  })
  .strict();
const Qr = z
  .object({
    kind: z.literal("qr"),
    payload: z.string().min(1).max(1000).optional(),
    /** The message holding the code, as a ref `fetch` opens: his card's source chip opens it. */
    ref: oneLine(300).optional(),
    source: oneLine(200),
  })
  .strict();

export const Need = z.discriminatedUnion("kind", [
  Access,
  Account,
  Amount,
  Apify,
  App,
  Event,
  Link,
  Place,
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
  access: {
    about: "Mac steps he grants",
    line: (n) => accessLineOf(n.steps),
    page: '`{kind: "access", steps: [{text, check, freeGb?}]}`: everything missing on his Mac in one card, 1 to 8 plain steps in order. `text` the step in his words ("Allow Life to see your photos"); `check` what Life checks silently: `photos`, `contacts`, `calendars` (Life\'s permission prompts), `accessibility`, `full_disk_access` (toggles in System Settings), or `disk_free` with `freeGb`, the free space needed. Life ticks each step itself as it sees it done; he never says "done". Give it with `doneSeenBy: "access"` and one option marked `looks: true` ("I\'m at my Mac"): his pick of it makes Life show the next missing step on his Mac (its prompt, or the right System Settings pane), and the card stays open until every step is done; then `decision.answered` carries `doneSeen`. A step he refuses or ignores leaves the card open until its deadline (`decision.lapsed`): then go on without it, or offer another way. Example: `{"kind":"access","steps":[{"text":"Allow Life to see your photos","check":"photos"},{"text":"Free 20 GB for the originals","check":"disk_free","freeGb":20}]}`.',
  },
  account: {
    about: "a bank account",
    line: (n) =>
      `${[n.bank, n.number].filter(Boolean).join(" ")}${n.holder ? `, ${n.holder}` : ""}${n.bic ? ` (BIC ${n.bic})` : ""}`,
    page: '`{kind: "account", number, bank?, holder?, scheme?, bic?}`: where he sends money. `number` as the payee wrote it (an account number, an IBAN, a PromptPay phone or id); `bank` its bank\'s name; `holder` the name the bank will show, for him to check (never copied) and for Life to see the payment by; `scheme` one of `th_account`, `promptpay`, `iban`, `swift`, `other` (his phone picks the bank app by it); `bic` when the payee gave one. Give it before the `amount`: the phone shows needs in your order. Example: `{"kind":"account","bank":"Kasikornbank","number":"012-3-45678-9","holder":"Blue Reef Diving Co., Ltd.","scheme":"th_account"}`.',
  },
  amount: {
    about: "what to pay (value, currency)",
    line: (n) => amountWordsOf(n.value, n.currency),
    page: '`{kind: "amount", value, currency}`: `value` a positive number, `currency` its ISO code (`THB`, `EUR`). He copies the plain number. With `doneSeenBy: "payment"`, Life looks for a payment of exactly this amount in this currency to the payee (`fetch("ask/payment")`). Example: `{"kind":"amount","value":4500,"currency":"THB"}`.',
  },
  apify: {
    about: "a paid Apify run",
    line: (n) =>
      `Apify: ${n.what}, by ${n.actor}, about $${n.estimateUsd}, at most $${n.maxUsd}. Input: ${JSON.stringify(n.input)}`,
    page: `\`{kind: "apify", actor, input, what, estimateUsd, maxUsd}\`: a run of an Apify actor (a paid scraper of the web) Life starts on his yes, on his Apify account. \`actor\` the store's \`username/name\` from \`find_apify_actors\`, only one it marks \`capped\` (paid per event: Apify holds its run under a dollar cap); \`input\` the actor's input exactly as it runs (its own input schema; keep the counts small); \`what\` what it gets him, in a few words; \`estimateUsd\` your estimate from its prices at his tier (each event's price times how many you expect, its start included), at most \`maxUsd\`; \`maxUsd\` the cap, at least the actor's \`minimalCapUsd\`, at most $${APIFY_RUN_MAX_USD}: Apify charges nothing past it. Say in \`context\` how you estimated it. Mark the one option that runs it \`runs: true\` ("Run it"); his pick of it alone makes Life start the run, once, never retried, and \`decision.answered\` carries \`ran\`, the run's id or its error: read the run with \`read_apify_run\`. Never run an actor any other way. Example: \`{"kind":"apify","actor":"compass/crawler-google-places","input":{"searchStringsArray":["laser clinic"],"locationQuery":"Bangkok","maxCrawledPlacesPerSearch":20},"what":"20 laser clinics in Bangkok with phones and hours","estimateUsd":0.09,"maxUsd":0.5}\`.`,
  },
  app: {
    about: "an app (name, link)",
    line: (n) => `In ${n.name}`,
    page: '`{kind: "app", name, url?}`: a step he does in another app (a bank app, a booking app). `name` as the app is called; `url` an `https` link into it (a universal link or its store page), opened by his own tap (his phone shows its host), never a custom scheme. Never guess a link. Example: `{"kind":"app","name":"Grab","url":"https://grab.example.com/open"}`.',
  },
  event: {
    about: "a calendar event (title, times)",
    line: (n) => `${n.title}, ${n.start.slice(0, 16).replace("T", " ")}`,
    page: '`{kind: "event", title, start, end, reminders, place?}`: an event he may add to his calendar. `start` and `end` RFC 3339 with an offset, `end` after `start`, ahead; `reminders` 1 to 3 popup times in minutes before the start (`[30, 1440]`); `place` where, as written somewhere. With one option marked `adds: true` ("Add to calendar"), his pick of it alone makes Life write this one event, with those reminders, into his calendar, once: never guests, never a mail; an event he deletes is never written again; the answer carries `added` (the event\'s id, or the error). The card is the ask: an agent\'s event is never one Life is sure of, so Life never adds it unasked (what Life itself reads as agreed reaches his calendar as an appointment). Give no `adds` option without this need, nor this need without it. Example: `{"kind":"event","title":"Dive course, day 1","start":"2026-12-01T08:00:00+07:00","end":"2026-12-01T12:00:00+07:00","reminders":[60,1440],"place":"Blue Reef Diving, Chalong"}`.',
  },
  link: {
    about: "a web page (url, vendor)",
    line: (n) => `${n.vendor ? `${n.vendor}: ` : ""}${new URL(n.url).host}`,
    page: '`{kind: "link", url, vendor?}`: a page he opens by his own tap (a checkout, a login, a form), `https` or `http` only; `vendor` who runs it. His phone shows the page\'s host in full and never opens it by itself. Example: `{"kind":"link","url":"https://pay.example.com/i/123","vendor":"Fibrenet"}`.',
  },
  place: {
    about: "a place (name, links)",
    line: (n) => (n.address ? `${n.name}, ${n.address}` : n.name),
    page: '`{kind: "place", name, address?, googleMapsUrl?, appleMapsUrl?, boltUrl?}`: where he goes to do the step. `name` as the place is known; `address` only as written somewhere; the links `https` only, each opened by his own tap: Google Maps, Apple Maps, and a Bolt ride there. Never guess one. Example: `{"kind":"place","name":"Chatuchak vehicle office","googleMapsUrl":"https://www.google.com/maps/search/?api=1&query=Chatuchak%20vehicle%20office"}`.',
  },
  qr: {
    about: "a payee's QR code (source)",
    line: (n) => `QR code from ${n.source}${n.payload ? `: ${n.payload}` : ""}`,
    page: '`{kind: "qr", source, ref?, payload?}`: a QR code the payee sent. `source` where it is, in a few words (`"Kit\'s WhatsApp of 20 Nov"`); `ref` the message holding it as `fetch` opens it (`msg:<source>|<message id>`, from `read_chats`), which must open: his card\'s source chip opens it; `payload` the code\'s text when you read it. His phone draws the code from `payload` (its amount too, for a PromptPay code) and saves it to his photos for his bank app; without `payload` it shows `source` as words. Give the `account` (its `scheme` picks the bank app, its `holder` is the name shown under the code) and the `amount` beside it.',
  },
  text: {
    about: "a reference or code",
    line: (n) => (n.label ? `${n.label}: ${n.text}` : n.text),
    page: '`{kind: "text", text, label?, copy?}`: a fact he needs in hand: a payment reference, an invoice number, a code, a point to say. `label` names it ("Reference"); `copy: true` gives it a copy button. Example: `{"kind":"text","label":"Reference","text":"INV-2041","copy":true}`.',
  },
};

/** Life's plain words of a need: what a phone that doesn't know its kind draws. */
export const needLineOf = (n: Need) =>
  (KINDS[n.kind].line as (x: Need) => string)(n);

/** The needs as a card shows them: each with its `line`, in the agent's order; an access need's steps with their status, from the Mac's statuses `access` (`readAccessStatuses`). */
export const needsShownOf = (
  needs: readonly Need[] = [],
  access: AccessStatuses = { statuses: {} }
) =>
  needs.map((n) => {
    if (n.kind !== "access") {
      return { ...n, line: needLineOf(n) };
    }
    const steps = accessStepsOf(n.steps, access);
    return { ...n, line: accessLineOf(steps), steps };
  });

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
/** A company's form at a name's end, as `nameKey` words ("Co., Ltd." is `co ltd`): dropped; a bare "Co" may be a surname. */
const COMPANY_FORMS = [
  "co ltd",
  "company limited",
  "limited",
  "ltd",
  "inc",
  "plc",
];

/** A name's words as names are compared (`nameKey`), less its leading titles and its company form; initials kept. */
const nameWordsOf = (name: string) => {
  const key = nameKey(name).trim();
  const form = COMPANY_FORMS.find((f) => key === f || key.endsWith(` ${f}`));
  const words = (form ? key.slice(0, -form.length) : key)
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

/** The refs a card's needs name (a QR's message): each must open, like its `context`'s links. */
export const needRefsOf = (needs: readonly Need[] = []) =>
  needs.flatMap((n) => (n.kind === "qr" && n.ref ? [n.ref] : []));

/** The run a card's `runs` option starts: its one `apify` need. */
export const apifyRunOf = (needs: readonly Need[] = []) =>
  needs.find((n): n is Of<"apify"> => n.kind === "apify");

/** The event a card's `adds` option writes: its one `event` need. */
export const eventOf = (needs: readonly Need[] = []) =>
  needs.find((n): n is Of<"event"> => n.kind === "event");

/** The steps an access card's look ticks: its one `access` need. */
export const accessOf = (needs: readonly Need[] = []) =>
  needs.find((n): n is Of<"access"> => n.kind === "access");

/** The amount a card's payment is looked for by: its one `amount` need. */
export const amountOf = (needs: readonly Need[] = []) =>
  needs.find((n): n is Of<"amount"> => n.kind === "amount");
