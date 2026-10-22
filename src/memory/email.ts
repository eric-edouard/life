import { settings } from "../settings";
// The nightly report as an HTML email in Life's brand (docs/brand.md): a white page, one ruled panel, serif to read,
// mono to count; tables and inline styles only, no web fonts, no images, no links, no tracking. Light only.

/** Life's own mail: its sender (the `mail` setting; none set, no mail is Life's), and how `compose` (report.ts) starts every subject. */
export const LIFE_MAIL = {
  from: settings().mail?.from,
  subject: "Life · ",
};

interface Pair {
  name: string;
  relation: string;
}
interface Fact {
  page: string;
  text: string;
}
interface Change {
  added: number;
  moved: number;
  page: string;
  removed: number;
}

/** A titled list of the report: pairs (a name and a line), facts (by page) or page changes. Empty, it is left out. */
export type Section =
  | { kind: "pairs"; list: Pair[]; title: string }
  | { kind: "facts"; list: Fact[]; title: string }
  | { kind: "changes"; list: Change[]; title: string };

/** The complete report: both the text and the HTML are rendered from it. */
export interface Digest {
  date: string;
  failure: { error: string; step: string } | null;
  /** The label beside the weekday above the date; "Life nightly" when absent. */
  label?: string;
  models?: string;
  notes: string[];
  preheader: string;
  /** In order: Actions, Code yesterday, What it found, New people, What changed. */
  sections?: Section[];
  stats: { label: string; value: string }[];
  verdict: string;
  weekday: string;
}

const SERIF = "'Source Serif 4',Georgia,serif";
const MONO = "'IBM Plex Mono',ui-monospace,Menlo,monospace";
// Copied from assets/brand/tokens.css (email takes no CSS variables; brand.test.ts checks them). Status colours only
// mark (a dot), the words beside them stay ink.
export const C = {
  error: "#ef4444",
  ink: "#181818",
  muted: "#707070",
  rule: "#e4e4e4",
  surface: "#f3f3f3",
  synced: "#22c55e",
  white: "#ffffff",
};

const ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const TABLE = `role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"`;
const row = (style: string, inner: string) =>
  `<tr><td style="${style}">${inner}</td></tr>`;
/** A hairline-ruled line of the card. */
const ruled = (inner: string, font = `15px/1.5 ${SERIF}`) =>
  `<div style="padding:9px 0;border-top:1px solid ${C.rule};font:${font};color:${C.ink}">${inner}</div>`;

/** A titled block of the card: a ruled serif title with its count in mono, then the body. */
const section = (title: string, count: number, body: string) =>
  row(
    "padding:24px 24px 0",
    `<table ${TABLE}><tr>
<td style="font:600 21px/1.2 ${SERIF};color:${C.ink}">${esc(title)}</td>
<td align="right" style="font:500 13px/1 ${MONO};color:${C.muted}">${count}</td></tr></table><div style="height:8px;line-height:8px;font-size:0">&nbsp;</div>${body}`
  );

const facts = (all: Fact[]) =>
  [...Map.groupBy(all, (f) => f.page)]
    .map(
      ([page, items]) =>
        `<div style="padding:12px 0 2px;font:600 13px/1.3 ${SERIF};color:${C.muted}">${esc(page)}</div>${items
          .map((f) => ruled(esc(f.text)))
          .join("")}`
    )
    .join("");

/** Rows of a bold name and a muted line after it. */
const pairs = (items: Pair[]) =>
  items
    .map((p) =>
      ruled(
        `<b style="font-weight:600">${esc(p.name)}</b> <span style="color:${C.muted}">${esc(p.relation)}</span>`
      )
    )
    .join("");

const delta = (sign: string, n: number) =>
  `<span style="color:${n > 0 ? C.ink : C.muted}">${sign}${n}</span>`;

const changes = (items: Change[]) =>
  `<div style="padding-bottom:6px;font:13px/1.4 ${SERIF};color:${C.muted}">+ added&nbsp;&nbsp;→ moved to History&nbsp;&nbsp;− removed</div>${items
    .map(
      (c) =>
        `<table ${TABLE}><tr>
<td style="padding:9px 0;border-top:1px solid ${C.rule};font:15px/1.4 ${SERIF};color:${C.ink}">${esc(c.page)}</td>
<td align="right" style="padding:9px 0;border-top:1px solid ${C.rule};font:500 13px/1.4 ${MONO};white-space:nowrap">${delta("+", c.added)}&nbsp;&nbsp;${delta("→", c.moved)}&nbsp;&nbsp;${delta("−", c.removed)}</td></tr></table>`
    )
    .join("")}`;

/** A section's body: its rows, as its kind shows them. */
const rowsOf = (s: Section) => {
  switch (s.kind) {
    case "facts":
      return facts(s.list);
    case "changes":
      return changes(s.list);
    default:
      return pairs(s.list);
  }
};

/** The stats, three to a row: a rule on top, a mono figure, a small label. */
const stats = (d: Digest) => {
  const cell = (s?: { label: string; value: string }) =>
    `<td width="33%" valign="top" style="padding:0 8px 16px">${
      s
        ? `<div style="padding-top:8px;border-top:1px solid ${C.rule};font:500 24px/1.1 ${MONO};color:${C.ink}">${esc(s.value)}</div><div style="margin-top:3px;font:13px/1.3 ${SERIF};color:${C.muted}">${esc(s.label)}</div>`
        : ""
    }</td>`;
  const rows: string[] = [];
  for (let i = 0; i < d.stats.length; i += 3) {
    const r = d.stats.slice(i, i + 3);
    rows.push(`<tr>${[0, 1, 2].map((k) => cell(r[k])).join("")}</tr>`);
  }
  return row(
    "padding:22px 16px 0",
    `<table ${TABLE}>${rows.join("")}</table>${
      d.models
        ? `<div style="padding:0 8px;font:12px/1.5 ${MONO};color:${C.muted}">${esc(d.models)}</div>`
        : ""
    }`
  );
};

const failureBox = (f: NonNullable<Digest["failure"]>) =>
  row(
    "padding:22px 24px 0",
    `<div style="font:600 15px/1.3 ${SERIF};color:${C.ink}"><span style="color:${C.error}">●</span> Stopped at ${esc(f.step)}</div><div style="margin-top:10px;padding:12px 14px;background:${C.surface};border-radius:12px;font:13px/1.55 ${MONO};color:${C.ink};word-break:break-word">${esc(f.error)}</div>`
  );

export function renderHtml(d: Digest) {
  const status = d.failure ? C.error : C.synced;
  const body = [
    d.failure ? failureBox(d.failure) : "",
    stats(d),
    ...(d.sections ?? []).map((s) =>
      s.list.length > 0 ? section(s.title, s.list.length, rowsOf(s)) : ""
    ),
    row(
      "padding:24px 24px 26px",
      d.notes
        .map(
          (n) =>
            `<div style="margin-top:4px;font:13px/1.55 ${SERIF};color:${C.muted}">${esc(n)}</div>`
        )
        .join("")
    ),
  ].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">
<title>Life ${esc(d.date)}</title></head>
<body style="margin:0;padding:0;background:${C.white}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:${C.white}">${esc(d.preheader.slice(0, 140))}${"&zwnj;&nbsp;".repeat(60)}</div>
<table ${TABLE} style="background:${C.white}"><tr><td align="center" style="padding:28px 12px 32px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="padding:0 4px 20px">
<div style="font:13px/1.3 ${SERIF};color:${C.muted}">${esc(d.weekday)} · ${esc(d.label ?? "Life nightly")}</div>
<div style="margin-top:6px;font:600 36px/1.1 ${SERIF};letter-spacing:-.01em;color:${C.ink}">${esc(d.date)}</div>
<div style="margin-top:12px"><span style="display:inline-block;padding:6px 10px;border-radius:12px;background:${C.surface};font:500 11.5px/1 ${MONO};color:${C.ink}"><span style="color:${status}">●</span> ${esc(d.verdict)}</span></div>
</td></tr>
<tr><td style="background:${C.white};border:1px solid ${C.rule};border-radius:18px">
<table ${TABLE}>
${body}
</table></td></tr></table></td></tr></table></body></html>`;
}
