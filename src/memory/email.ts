// The nightly report as an HTML email: tables and inline styles only (mail clients ignore the rest), a system font stack,
// no images, no links, no tracking. The one <style> block only holds the dark-mode palette, which Apple Mail and iOS
// Mail honor; clients that ignore it show the light palette, which is complete on its own.

/** Life's own mail: its sender, and how `compose` (report.ts) starts every subject. */
export const LIFE_MAIL = {
  from: "alerts@send.ericedouard.com",
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
  /** The small caps line above the date; "Life nightly" when absent. */
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

const SERIF = "Georgia,'Iowan Old Style','Palatino Linotype',serif";
const SANS =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
// Night turning to morning; the failed night never gets past dusk.
const DAWN = ["#16202b", "#2c3a52", "#5b4b6b", "#b4627a", "#e39a6b", "#f2cf91"];
const DUSK = ["#16202b", "#2a2128", "#47232a", "#7a2a26", "#a63a2a", "#d1604a"];

const DARK = `@media (prefers-color-scheme: dark){
.bg{background:#0e0f12!important}.card{background:#17191d!important}.ink{color:#ece7da!important}
.mu{color:#9a9588!important}.hr{border-color:#2a2d33!important}.st{background:#1f2227!important;border-color:#17191d!important}
.ac{color:#86c9a6!important}.fa{color:#ef8f7c!important}.fb{background:#2a1a18!important;border-color:#a63a2a!important}
.add{color:#86c9a6!important}.mv{color:#e0b36a!important}.rm{color:#ef8f7c!important}.dim{color:#5d5a52!important}}`;

const ESCAPES: Record<string, string> = {
  "'": "&#39;",
  '"': "&quot;",
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);

const row = (style: string, inner: string, cls = "card") =>
  `<tr><td class="${cls}" style="background:#fbf8f1;${style}">${inner}</td></tr>`;

/** A titled block on the card: small caps label, serif count, then the body. */
const section = (title: string, count: number, body: string) =>
  row(
    "padding:28px 22px 4px",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="mu" style="font:700 11px/1 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:#6f695c">${esc(title)}</td>
<td class="mu" align="right" style="font:italic 14px/1 ${SERIF};color:#6f695c">${count}</td></tr></table>${body}`
  );

const facts = (all: Fact[]) =>
  [...Map.groupBy(all, (f) => f.page)]
    .map(
      ([page, items]) =>
        `<div class="ac" style="margin-top:20px;font:600 13px/1.3 ${SANS};color:#2f6b4f">${esc(page)}</div>${items
          .map(
            (f) =>
              `<div class="hr ink" style="margin-top:8px;padding-top:8px;border-top:1px solid #e2dac9;font:15px/1.5 ${SANS};color:#1f1c16">${esc(f.text)}</div>`
          )
          .join("")}`
    )
    .join("");

/** Rows of a bold name and a muted line after it. */
const pairs = (items: Pair[]) =>
  items
    .map(
      (p) =>
        `<div class="hr ink" style="margin-top:10px;padding-top:10px;border-top:1px solid #e2dac9;font:15px/1.5 ${SANS};color:#1f1c16"><b>${esc(p.name)}</b> <span class="mu" style="color:#6f695c">${esc(p.relation)}</span></div>`
    )
    .join("");

const DELTA = { add: "#2f6b4f", mv: "#a36a14", rm: "#a63a2a" };
const delta = (cls: keyof typeof DELTA, sign: string, n: number) =>
  `<span class="${n > 0 ? cls : "dim"}" style="color:${n > 0 ? DELTA[cls] : "#b3ab9b"}">${sign}${n}</span>`;

const changes = (items: Change[]) =>
  `<div class="mu" style="margin-top:10px;font:12px/1.4 ${SANS};color:#6f695c">added&nbsp;&nbsp;→ moved to History&nbsp;&nbsp;− removed</div><div style="height:6px;line-height:6px">&nbsp;</div>${items
    .map(
      (c) =>
        `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
<td class="hr ink" style="padding:9px 0;border-top:1px solid #e2dac9;font:15px/1.4 ${SANS};color:#1f1c16">${esc(c.page)}</td>
<td class="hr" align="right" style="padding:9px 0;border-top:1px solid #e2dac9;font:13px/1.4 ${MONO};white-space:nowrap">${delta("add", "+", c.added)}&nbsp;&nbsp;${delta("mv", "→", c.moved)}&nbsp;&nbsp;${delta("rm", "−", c.removed)}</td></tr></table>`
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

/** The stats, three to a row, as blocks that wrap on a phone-width card. */
const stats = (d: Digest) => {
  const cell = (s?: { label: string; value: string }) =>
    `<td class="st" width="33%" valign="top" style="background:#f3eee2;padding:14px 12px 12px;border:3px solid #fbf8f1">${
      s
        ? `<div class="ink" style="font:400 30px/1 ${SERIF};letter-spacing:-.02em;color:#1f1c16">${esc(s.value)}</div><div class="mu" style="margin-top:7px;font:700 10px/1.3 ${SANS};letter-spacing:.12em;text-transform:uppercase;color:#6f695c">${esc(s.label)}</div>`
        : ""
    }</td>`;
  const rows: string[] = [];
  for (let i = 0; i < d.stats.length; i += 3) {
    const r = d.stats.slice(i, i + 3);
    rows.push(`<tr>${[0, 1, 2].map((k) => cell(r[k])).join("")}</tr>`);
  }
  return row(
    "padding:16px 19px 0",
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rows.join("")}</table>${
      d.models
        ? `<div class="mu" style="padding:10px 3px 0;font:12px/1.5 ${MONO};color:#6f695c">${esc(d.models)}</div>`
        : ""
    }`
  );
};

const failureBox = (f: NonNullable<Digest["failure"]>) =>
  row(
    "padding:22px 22px 0",
    `<div class="fb" style="padding:16px 18px;background:#fbeae6;border:1px solid #a63a2a;border-left:5px solid #a63a2a"><div class="fa" style="font:700 11px/1 ${SANS};letter-spacing:.16em;text-transform:uppercase;color:#a63a2a">Stopped at ${esc(f.step)}</div><div class="ink" style="margin-top:10px;font:13px/1.55 ${MONO};color:#1f1c16;word-break:break-word">${esc(f.error)}</div></div>`
  );

export function renderHtml(d: Digest) {
  const failed = d.failure !== null;
  const strip = (failed ? DUSK : DAWN)
    .map(
      (c) =>
        `<td height="6" style="height:6px;line-height:6px;font-size:0;background:${c}">&nbsp;</td>`
    )
    .join("");
  const body = [
    failed && d.failure ? failureBox(d.failure) : "",
    stats(d),
    ...(d.sections ?? []).map((s) =>
      s.list.length > 0 ? section(s.title, s.list.length, rowsOf(s)) : ""
    ),
    row(
      "padding:26px 22px 30px",
      d.notes
        .map(
          (n) =>
            `<div class="mu" style="margin-top:4px;font:13px/1.55 ${SANS};color:#6f695c">${esc(n)}</div>`
        )
        .join("")
    ),
  ].join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>Life ${esc(d.date)}</title><style>${DARK}</style></head>
<body class="bg" style="margin:0;padding:0;background:#e9e3d6">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;font-size:1px;line-height:1px;color:#e9e3d6">${esc(d.preheader)}${"&zwnj;&nbsp;".repeat(60)}</div>
<table role="presentation" class="bg" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#e9e3d6"><tr><td align="center" style="padding:0 0 24px">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px">
<tr><td style="background:#16202b;padding:30px 22px 28px">
<div style="font:700 11px/1 ${SANS};letter-spacing:.18em;text-transform:uppercase;color:#8fa3b5">${esc(d.weekday)} &middot; ${esc(d.label ?? "Life nightly")}</div>
<div style="margin-top:16px;font:400 58px/1 ${SERIF};letter-spacing:-.03em;color:#f5eedd">${esc(d.date)}</div>
<div style="margin-top:18px;font:600 15px/1.4 ${SANS};color:#f5eedd"><span style="color:${failed ? "#ef8f7c" : "#86c9a6"}">&#9679;</span>&nbsp; ${esc(d.verdict)}</div>
</td></tr>
<tr><td style="padding:0"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>${strip}</tr></table></td></tr>
${body}
</table></td></tr></table></body></html>`;
}
