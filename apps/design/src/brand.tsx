// The brand guide, drawn from tokens.css itself: every variable it declares shows here, so a new token appears
// without a line of this file changing. The mark is assets/brand's own drawing; the rules in words are docs/brand.md,
// linked, never copied.
import tokens from "../../../assets/brand/tokens.css?raw";

const declared = [...tokens.matchAll(/^\s*--([a-z0-9-]+):\s*([^;]+);/gm)].map(
  ([, name = "", value = ""]) => ({
    name,
    value: value.replace(/\s+/g, " "),
  })
);
const DARK_LIGHT = /^light-dark\((.+),\s*(.+)\)$/;

const colours = declared.filter(
  (t) => t.value.startsWith("light-dark") && !t.name.startsWith("aura-")
);
const fills = declared.filter((t) => t.value.startsWith("color-mix"));
const aura = declared.filter((t) => t.name.startsWith("aura-"));
const sizes = declared.filter((t) => t.name.startsWith("text-"));
const radii = declared.filter((t) => t.name.endsWith("-radius"));
const fonts = declared.filter(
  (t) => t.name === "sans" || t.name.startsWith("font-")
);

const NOTES = [
  [
    "Brand rules",
    "https://github.com/eric-edouard/life/blob/main/docs/brand.md",
  ],
  [
    "App v4 design system",
    "#/2026-11-23-chat-first/2026-11-25-app-v4-design-system.md",
  ],
  ["Philosophy and guidelines", "#/philosophy.md"],
];
const SAMPLE = "Did Jade answer about Saturday?";

/** A brand drawing in the page's text colour (the SVGs carry one fill; a mask lets the theme choose). */
function Drawn({ className, src }: { className: string; src: string }) {
  const mask = `url(${src}) center / contain no-repeat`;
  return (
    <span
      aria-label="Life"
      className={`block bg-fg ${className}`}
      role="img"
      style={{ mask, WebkitMask: mask }}
    />
  );
}

function Section({
  children,
  title,
}: {
  children: React.ReactNode;
  title: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 font-semibold text-heading text-muted">{title}</h2>
      {children}
    </section>
  );
}

function Value({ value }: { value: string }) {
  const [, light, dark] = DARK_LIGHT.exec(value) ?? [];
  return (
    <span className="font-mono text-faint text-meta">
      {light === undefined ? value : `${dark} dark · ${light} light`}
    </span>
  );
}

/** A colour as a chip: its dark value over its light one when it has both, else as it draws here. */
function Swatch({ name, value }: { name: string; value: string }) {
  const [, light, dark] = DARK_LIGHT.exec(value) ?? [];
  const background = light
    ? `linear-gradient(${dark} 50%, ${light} 50%)`
    : `var(--${name})`;
  return (
    <div className="flex items-center gap-3">
      <span
        className="size-11 shrink-0 rounded-control"
        style={{ background }}
      />
      <span className="flex min-w-0 flex-col">
        <span className="font-semibold text-row-line">{name}</span>
        <Value value={value} />
      </span>
    </div>
  );
}

function Swatches({ list }: { list: { name: string; value: string }[] }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-6 gap-y-4 rounded-panel bg-card p-6">
      {list.map((t) => (
        <Swatch key={t.name} {...t} />
      ))}
    </div>
  );
}

export function Brand() {
  return (
    <div className="flex max-w-5xl flex-col gap-12">
      <header className="flex flex-col gap-3">
        <h1 className="m-0 font-bold text-[clamp(2rem,5vw,3.25rem)] leading-none tracking-tight">
          Brand
        </h1>
        <p className="m-0 max-w-[60ch] text-muted">
          Drawn live from{" "}
          <code className="font-mono text-row-line">
            assets/brand/tokens.css
          </code>
          , the one source every design, the app and the emails take their
          values from. This page and every design here can only use these.
        </p>
        <div className="flex flex-wrap gap-2">
          {NOTES.map(([label, href]) => (
            <a
              className="rounded-full bg-tint px-3 py-1 text-fg text-meta no-underline hover:bg-glass"
              href={href}
              key={label}
            >
              {label}
            </a>
          ))}
        </div>
      </header>
      <Section title="The mark">
        <div className="flex flex-wrap items-end gap-10 rounded-panel bg-card p-8">
          <Drawn className="h-14 w-[6.4rem]" src="/assets/brand/life.svg" />
          <span className="grid size-24 place-items-center rounded-[22%] bg-bg">
            <Drawn className="h-12 w-[2.4rem]" src="/assets/brand/life-l.svg" />
          </span>
        </div>
        <p className="m-0 text-muted text-row-line">
          The wordmark, and the icon: the L on ink, 22% corners. Leave one
          x-height clear around it.
        </p>
      </Section>
      <Section title="Colours">
        <Swatches list={colours} />
      </Section>
      <Section title="Fills over anything">
        <Swatches list={fills} />
      </Section>
      <Section title="Aura">
        <div className="flex flex-wrap gap-4">
          {aura.map((t) => (
            <span
              className="flex items-center gap-2 text-row-line"
              key={t.name}
            >
              <span
                className="size-5 rounded-full"
                style={{ background: `var(--${t.name})` }}
              />
              {t.name.replace("aura-", "")}
            </span>
          ))}
        </div>
      </Section>
      <Section title="Type">
        <ul className="m-0 flex list-none flex-col p-0">
          {sizes.map((t) => (
            <li
              className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3 shadow-[inset_0_-1px_var(--line)]"
              key={t.name}
            >
              <span
                className="min-w-0 font-semibold"
                style={{ fontSize: `var(--${t.name})` }}
              >
                {SAMPLE}
              </span>
              <span className="font-mono text-faint text-meta">
                {t.name.replace("text-", "")} · {t.value}
              </span>
            </li>
          ))}
        </ul>
        <p className="m-0 text-muted text-row-line">
          Weights 450, 600 and 650 only.{" "}
          {fonts.map((f) => `${f.name}: ${f.value}`).join(" · ")}
        </p>
      </Section>
      <Section title="Shapes">
        <div className="flex flex-wrap items-end gap-6">
          {[...radii, { name: "pill", value: "9999px" }].map((t) => (
            <span className="flex flex-col gap-2" key={t.name}>
              <span
                className="h-16 w-28 bg-tint"
                style={{
                  borderRadius:
                    t.name === "pill" ? "9999px" : `var(--${t.name})`,
                }}
              />
              <span className="text-row-line">
                {t.name.replace("-radius", "")}
              </span>
              <span className="font-mono text-faint text-meta">{t.value}</span>
            </span>
          ))}
        </div>
      </Section>
    </div>
  );
}
