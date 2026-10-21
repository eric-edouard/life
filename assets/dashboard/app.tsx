import {
  AnimatePresence,
  MotionConfig,
  motion,
  useAnimationControls,
} from "motion/react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import type { Card, Fact, Plate, Tick, Tone } from "../../src/plate";
import type { detail, Entry, runDetail } from "../../src/plate-detail";

// The status page (src/dashboard.ts serves it, src/plate.ts makes its data): the plate of groups, a group opened to
// its cards, a card opened to its detail. It only reads.

const PRIVACY = "life-status-privacy";
const SPRING = { damping: 32, stiffness: 320, type: "spring" } as const;

const stored = (key: string) => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A private window: the choice lasts for this visit.
  }
};

function useNow(ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

const UNITS: [string, number, number][] = [
  ["min", 60_000, 3_600_000],
  ["h", 3_600_000, 172_800_000],
  ["d", 86_400_000, Number.POSITIVE_INFINITY],
];

/** "just now", "4 min ago", "3 h ago", "in 20 min". */
export function ago(at: string | null | undefined, now: number) {
  if (!at) {
    return "never";
  }
  const d = now - Date.parse(at);
  if (Number.isNaN(d)) {
    return at;
  }
  const a = Math.abs(d);
  if (a < 45_000) {
    return d >= 0 ? "just now" : "in a moment";
  }
  const [unit, size] = UNITS.find(([, , below]) => a < below) ??
    UNITS.at(-1) ?? ["d", 86_400_000];
  const text = `${Math.round(a / size)} ${unit}`;
  return d >= 0 ? `${text} ago` : `in ${text}`;
}

const clock = (at: string) =>
  new Date(at).toLocaleString(undefined, {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  });

type Link =
  | { kind: "live" }
  | { kind: "offline"; since: number }
  | { kind: "stale"; pushedAt: string; since: number };

/** The plate, live from the Mac's stream; when the Mac can't be reached, the last snapshot the always-on page holds. */
function usePlate() {
  const [plate, setPlate] = useState<Plate | null>(null);
  const [link, setLink] = useState<Link>({ kind: "live" });
  useEffect(() => {
    let poll: ReturnType<typeof setInterval> | undefined;
    let source: EventSource;
    /** The Mac's live stream. A browser gives up on a stream that answered an error (the Worker's, while the Mac was
     * away), so it is opened again as soon as the Mac answers a plain read. */
    const listen = () => {
      source = new EventSource("/status/stream");
      source.onmessage = (e) => {
        clearInterval(poll);
        poll = undefined;
        setPlate(JSON.parse(e.data));
        setLink({ kind: "live" });
      };
      source.onerror = () => {
        setLink((l) =>
          l.kind === "live" ? { kind: "offline", since: Date.now() } : l
        );
        if (!poll) {
          fallback();
          poll = setInterval(fallback, 20_000);
        }
      };
    };
    const fallback = async () => {
      try {
        const res = await fetch("/status/snapshot", { cache: "no-store" });
        if (!res.ok) {
          return;
        }
        const pushedAt = res.headers.get("x-life-pushed-at");
        setPlate(await res.json());
        if (pushedAt) {
          setLink((l) => ({
            kind: "stale",
            pushedAt,
            since: "since" in l ? l.since : Date.now(),
          }));
        } else if (source.readyState === EventSource.CLOSED) {
          listen();
        }
      } catch {
        // Nothing reachable: the page keeps what it last showed.
      }
    };
    listen();
    return () => {
      source.close();
      clearInterval(poll);
    };
  }, []);
  return { link, plate };
}

function summary(cards: Card[]) {
  const bad = cards.filter((c) => c.tone === "bad").length;
  const warn = cards.filter((c) => c.tone === "warn").length;
  if (bad) {
    return `${bad} failing`;
  }
  if (warn) {
    return `${warn} to look at`;
  }
  if (cards.some((c) => c.tone === "busy")) {
    return "working";
  }
  return "all fine";
}

const titleOf = (problems: number) => {
  if (!problems) {
    return "Life";
  }
  return `● ${problems} problem${problems === 1 ? "" : "s"} · Life`;
};

/** Life's icon with its dot in the worst state's colour, and the title counting the problems. */
function useTab(plate: Plate | null, link: Link) {
  useEffect(() => {
    const tone: Tone = link.kind === "live" ? (plate?.worst ?? "idle") : "idle";
    let icon = document.querySelector<HTMLLinkElement>("link[rel=icon]");
    if (!icon) {
      icon = Object.assign(document.createElement("link"), {
        rel: "icon",
        type: "image/svg+xml",
      });
      document.head.append(icon);
    }
    icon.href = `/status/icon.svg?tone=${tone}`;
    const n = plate?.problems ?? 0;
    document.title = link.kind === "live" ? titleOf(n) : "○ Mac offline · Life";
  }, [plate, link]);
}

/** The groups' icons: drawn, one stroke, one weight. */
const GLYPHS: Record<string, string> = {
  capture: "M4 6h16l-6 7v5l-4 2v-7z",
  mac: "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5V15H4zM2 18h20",
  memory:
    "M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13H7.5A2.5 2.5 0 0 1 5 17.5zM5 17.5A2.5 2.5 0 0 1 7.5 15H17M9 8.5h4.5M9 11.5h3",
  outputs:
    "M14 5h5v5M19 5l-8 8M17 14v4a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4",
  pipeline:
    "M5 7a2 2 0 1 0 0-.01M19 17a2 2 0 1 0 0-.01M7 7h4a3 3 0 0 1 3 3v4a3 3 0 0 0 3 3",
  sources:
    "M12 13a1.5 1.5 0 1 0 0-.01M8.5 16.5a5 5 0 0 1 0-7M15.5 9.5a5 5 0 0 1 0 7M5.5 19.5a9 9 0 0 1 0-13M18.5 6.5a9 9 0 0 1 0 13",
};

function Glyph({ id }: { id: string }) {
  return (
    <span aria-hidden="true" className="glyph">
      <svg aria-hidden="true" viewBox="0 0 24 24">
        <path d={GLYPHS[id] ?? GLYPHS.sources} />
      </svg>
    </span>
  );
}

function Cross() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16">
      <path d="M3 3l10 10M13 3L3 13" />
    </svg>
  );
}

function Wave() {
  return (
    <span aria-label="recording" className="wave" role="img">
      {[0.0, 0.18, 0.36, 0.1, 0.5, 0.28, 0.06, 0.42].map((d) => (
        <i key={d} style={{ animationDelay: `${-d * 2}s` }} />
      ))}
    </span>
  );
}

function Beat({ ms }: { ms: number }) {
  return (
    <span
      aria-hidden="true"
      className="beat"
      style={{ "--beat": `${ms}ms` } as CSSProperties}
    />
  );
}

function Pill({ tone, word }: { tone: Tone; word: string }) {
  return <span className={`pill ${tone}`}>{word}</span>;
}

function Content({ lines, privacy }: { lines?: string[]; privacy: boolean }) {
  if (!lines?.length) {
    return null;
  }
  if (privacy) {
    return <div className="redacted">hidden · privacy mode</div>;
  }
  return (
    <div className="content">
      {lines.map((l) => (
        <p key={l}>{l}</p>
      ))}
    </div>
  );
}

function Facts({ facts, now }: { facts: Fact[]; now: number }) {
  return (
    <dl className="facts">
      {facts.map((f) => (
        <div className="fact" key={f.label}>
          <dt>{f.label}</dt>
          <dd title={f.at ?? undefined}>
            {f.value === undefined
              ? ago(f.at, now)
              : `${f.value}${f.at ? ` ${ago(f.at, now)}` : ""}`}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Stations({ list }: { list: NonNullable<Card["stations"]> }) {
  const reached = list.findLastIndex((s) => s.state !== "todo");
  const n = list.length;
  return (
    <div className="stations" title="its steps">
      <i
        className="fill"
        style={{
          left: `calc(100% / ${2 * n})`,
          width: `calc(100% * ${Math.max(0, reached)} / ${n})`,
        }}
      />
      {list.map((s) => (
        <span className={`station ${s.state}`} key={s.name}>
          {s.name}
        </span>
      ))}
    </div>
  );
}

/** A card's face: in its group's grid, or full height in its detail. */
function Face({
  card,
  full,
  now,
  privacy,
}: {
  card: Card;
  full?: boolean;
  now: number;
  privacy: boolean;
}) {
  return (
    <>
      <header className="card-head">
        <h3>{card.name}</h3>
        <span className="badges">
          {card.listening && <Wave />}
          {card.beat && card.tone === "ok" && <Beat ms={card.beat} />}
          <Pill tone={card.tone} word={card.word} />
        </span>
      </header>
      <p className="headline">
        {card.headline}
        {card.at && <span> {ago(card.at, now)}</span>}
      </p>
      {card.stations && <Stations list={card.stations} />}
      <Facts facts={full ? card.facts : card.facts.slice(0, 4)} now={now} />
      <Content
        lines={full ? card.content : card.content?.slice(0, 1)}
        privacy={privacy}
      />
    </>
  );
}

/** A card in its group: shakes once when it turns red. */
function Tile({
  card,
  now,
  onOpen,
  privacy,
}: {
  card: Card;
  now: number;
  onOpen: () => void;
  privacy: boolean;
}) {
  const shake = useAnimationControls();
  const was = useRef(card.tone);
  useEffect(() => {
    if (card.tone === "bad" && was.current !== "bad") {
      shake.start({ transition: { duration: 0.5 }, x: [0, -6, 6, -4, 4, 0] });
    }
    was.current = card.tone;
  }, [card.tone, shake]);
  return (
    <motion.button
      animate={shake}
      className={`card ${card.tone}`}
      layoutId={`card-${card.id}`}
      onClick={onOpen}
      transition={SPRING}
      type="button"
    >
      <Face card={card} now={now} privacy={privacy} />
    </motion.button>
  );
}

/** A folded group on the plate: its parts as ruled rows with their state. */
function Group({
  cards,
  hub,
  id,
  name,
  onOpen,
  order = 0,
  refFor,
}: {
  cards: Card[];
  hub?: boolean;
  id: string;
  name: string;
  onOpen: () => void;
  order?: number;
  refFor: (el: HTMLElement | null) => void;
}) {
  const lead = hub ? cards[0] : undefined;
  return (
    <motion.button
      animate={{ opacity: 1, y: 0 }}
      className={`group${hub ? "hub" : ""}`}
      initial={{ opacity: 0, y: 14 }}
      layoutId={`group-${id}`}
      onClick={onOpen}
      ref={refFor}
      transition={{ ...SPRING, delay: order * 0.06 }}
      type="button"
    >
      <header className="group-head">
        <Glyph id={id} />
        <h2>{name}</h2>
        <span className="count">
          {cards.length} part{cards.length === 1 ? "" : "s"} · {summary(cards)}
        </span>
      </header>
      {lead && (
        <>
          <motion.span
            animate={{ scale: [1.06, 1] }}
            className="figure"
            key={lead.headline}
            transition={{ duration: 0.6 }}
          >
            {lead.headline.split(" ")[0]}
          </motion.span>
          <span className="figure-label">
            {lead.headline.split(" ").slice(1).join(" ")} held
          </span>
        </>
      )}
      <ul className="parts">
        {cards.map((c) => (
          <li className={`part ${c.tone}`} key={c.id}>
            {c.beat && c.tone === "ok" ? (
              <Beat ms={c.beat} />
            ) : (
              <span className="dotmark" />
            )}
            <span>{c.name}</span>
            <span className="word">{c.listening ? <Wave /> : c.word}</span>
          </li>
        ))}
      </ul>
    </motion.button>
  );
}

interface Wire {
  d: string;
  from: string;
  to: string;
}

/** The plate's edges between its groups, measured from where the groups sit (left to right, or top down). */
function useWires(
  box: React.RefObject<HTMLDivElement | null>,
  edges: readonly (readonly [string, string])[]
) {
  const els = useRef(new Map<string, HTMLElement>());
  const [wires, setWires] = useState<Wire[]>([]);
  const measure = useCallback(() => {
    const root = box.current?.getBoundingClientRect();
    if (!root) {
      return;
    }
    const across = root.width > 900;
    setWires(
      edges.flatMap(([from, to]) => {
        const a = els.current.get(from)?.getBoundingClientRect();
        const b = els.current.get(to)?.getBoundingClientRect();
        if (!(a && b)) {
          return [];
        }
        if (across) {
          const [x1, y1, x2, y2] = [
            a.right - root.left,
            a.top + 46 - root.top,
            b.left - root.left,
            b.top + 46 - root.top,
          ];
          const m = (x1 + x2) / 2;
          return [
            { d: `M${x1} ${y1} C${m} ${y1} ${m} ${y2} ${x2} ${y2}`, from, to },
          ];
        }
        const [x1, y1, x2, y2] = [
          a.left + a.width / 2 - root.left,
          a.bottom - root.top,
          b.left + b.width / 2 - root.left,
          b.top - root.top,
        ];
        return [{ d: `M${x1} ${y1} L${x2} ${y2}`, from, to }];
      })
    );
  }, [box, edges]);
  useLayoutEffect(() => {
    measure();
    const ro = new ResizeObserver(measure);
    if (box.current) {
      ro.observe(box.current);
    }
    return () => ro.disconnect();
  }, [measure, box]);
  const refFor = useCallback(
    (id: string) => (el: HTMLElement | null) => {
      if (el) {
        els.current.set(id, el);
      }
    },
    []
  );
  return { measure, refFor, wires };
}

/** Dots that travel an edge each time the data at either end of it moved. */
function useDots(plate: Plate | null) {
  const last = useRef(new Map<string, number>());
  const [dots, setDots] = useState<{ edge: string; key: number }[]>([]);
  useEffect(() => {
    if (!plate) {
      return;
    }
    const flow = new Map<string, number>();
    for (const c of plate.cards) {
      flow.set(c.group, (flow.get(c.group) ?? 0) + (c.flow ?? 0));
    }
    const moved = new Set(
      [...flow]
        .filter(
          ([g, n]) => last.current.has(g) && n > (last.current.get(g) ?? 0)
        )
        .map(([g]) => g)
    );
    last.current = flow;
    const fresh = plate.edges
      .filter(([a, b]) => moved.has(a) || moved.has(b))
      .flatMap(([a, b]) =>
        [0, 1, 2].map((i) => ({
          edge: `${a}>${b}`,
          key: Date.now() + i + Math.random(),
        }))
      );
    if (fresh.length) {
      setDots((d) => [...d, ...fresh]);
      setTimeout(
        () => setDots((d) => d.filter((x) => !fresh.includes(x))),
        2400
      );
    }
  }, [plate]);
  return dots;
}

function Diagram({
  link,
  onOpen,
  plate,
}: {
  link: Link;
  onOpen: (group: string) => void;
  plate: Plate;
}) {
  const box = useRef<HTMLDivElement>(null);
  const { refFor, wires } = useWires(box, plate.edges);
  const dots = useDots(plate);
  const byGroup = useMemo(
    () => Map.groupBy(plate.cards, (c) => c.group),
    [plate.cards]
  );
  const lanes = plate.groups.filter((g) => g.id !== "mac");
  return (
    <section
      aria-label="Life's parts"
      className={`plate${link.kind === "live" ? "" : "stale"}`}
    >
      <div ref={box} style={{ position: "relative" }}>
        <svg aria-hidden="true" className="wires">
          {wires.map((w) => (
            <g key={`${w.from}>${w.to}`}>
              <path className="rail" d={w.d} />
              <path className="flow" d={w.d} />
            </g>
          ))}
        </svg>
        {dots.map((dot, i) => {
          const w = wires.find((x) => `${x.from}>${x.to}` === dot.edge);
          return w ? (
            <span
              className="dot"
              key={dot.key}
              style={{
                animationDelay: `${(i % 3) * 0.28}s`,
                offsetPath: `path('${w.d}')`,
              }}
            />
          ) : null;
        })}
        <div className="lanes">
          {lanes.map((g, i) => (
            <Group
              cards={byGroup.get(g.id) ?? []}
              hub={g.id === "memory"}
              id={g.id}
              key={g.id}
              name={g.name}
              onOpen={() => onOpen(g.id)}
              order={i}
              refFor={refFor(g.id)}
            />
          ))}
        </div>
      </div>
      <div className="mac-strip">
        <Group
          cards={byGroup.get("mac") ?? []}
          id="mac"
          name="The Mac"
          onOpen={() => onOpen("mac")}
          order={5}
          refFor={refFor("mac")}
        />
      </div>
    </section>
  );
}

/** The last 24 h: runs as spans, failures and sends as ticks, the Mac's sleeps as hatched bands. */
function Today({
  now,
  privacy,
  ticks,
}: {
  now: number;
  privacy: boolean;
  ticks: Tick[];
}) {
  /** A tick's tooltip: what and when, and an error's text unless privacy is on. */
  const tip = (t: Tick) =>
    `${t.label}, ${clock(t.at)}${t.end ? ` to ${clock(t.end)}` : ""}${t.detail && !privacy ? `: ${t.detail}` : ""}`;
  const from = now - 86_400_000;
  const x = (at: string) =>
    `${Math.max(0, Math.min(100, ((Date.parse(at) - from) / 86_400_000) * 100))}%`;
  const hours = Array.from(
    { length: 8 },
    (_, i) => new Date(from + (i + 1) * 3 * 3_600_000)
  );
  return (
    <section className="today">
      <header className="today-head">
        <h4>The last 24 hours</h4>
        <div className="legend">
          <span className="legend-item ok">
            <span className="dotmark" /> run ok
          </span>
          <span className="legend-item bad">
            <span className="dotmark" /> failed
          </span>
          <span className="legend-item warn">
            <span className="dotmark" /> retried
          </span>
          <span className="legend-item teal">
            <span className="dotmark" /> email sent
          </span>
          <span className="legend-item">
            <span className="hatch" /> Mac asleep
          </span>
        </div>
      </header>
      <div className="strip">
        {hours.map((h) => (
          <span
            className="hour"
            key={h.getTime()}
            style={{ left: x(h.toISOString()) }}
          >
            {h.getHours().toString().padStart(2, "0")}h
          </span>
        ))}
        {ticks.map((t) =>
          t.end || t.label === "Mac asleep" ? (
            <span
              className={`span ${t.tone}${t.label === "Mac asleep" ? "sleep" : ""}`}
              key={`${t.at}${t.label}`}
              style={{
                left: x(t.at),
                width: `calc(${x(t.end ?? new Date(now).toISOString())} - ${x(t.at)} + 2px)`,
              }}
              title={tip(t)}
            />
          ) : (
            <span
              className={`tick ${t.tone}`}
              key={`${t.at}${t.label}`}
              style={{ left: x(t.at) }}
              title={tip(t)}
            />
          )
        )}
      </div>
    </section>
  );
}

/** A group opened over the plate: its cards. */
function Sheet({
  cards,
  id,
  name,
  now,
  onClose,
  onOpen,
  privacy,
}: {
  cards: Card[];
  id: string;
  name: string;
  now: number;
  onClose: () => void;
  onOpen: (card: string) => void;
  privacy: boolean;
}) {
  return (
    <>
      <motion.div
        animate={{ opacity: 1 }}
        className="scrim"
        exit={{ opacity: 0 }}
        initial={{ opacity: 0 }}
        onClick={onClose}
      />
      <motion.section
        aria-label={name}
        className="sheet"
        layoutId={`group-${id}`}
        transition={SPRING}
      >
        <header className="sheet-head">
          <div>
            <Glyph id={id} />
            <h2>{name}</h2>
          </div>
          <button
            aria-label="Close"
            className="close"
            onClick={onClose}
            type="button"
          >
            <Cross />
          </button>
        </header>
        <motion.div
          animate="shown"
          className="cards"
          initial="hidden"
          variants={{
            shown: {
              transition: { delayChildren: 0.12, staggerChildren: 0.045 },
            },
          }}
        >
          {cards.map((c) => (
            <motion.div
              key={c.id}
              variants={{
                hidden: { opacity: 0, scale: 0.97, y: 14 },
                shown: { opacity: 1, scale: 1, y: 0 },
              }}
            >
              <Tile
                card={c}
                now={now}
                onOpen={() => onOpen(c.id)}
                privacy={privacy}
              />
            </motion.div>
          ))}
        </motion.div>
      </motion.section>
    </>
  );
}

type Detail = Awaited<ReturnType<typeof detail>>;

/** A card's detail, or its next page before `before`. */
const readCard = (id: string, before?: string): Promise<Detail> =>
  fetch(
    `/status/card/${id}${before ? `?before=${encodeURIComponent(before)}` : ""}`
  ).then((r) => r.json());

type RunView = NonNullable<Awaited<ReturnType<typeof runDetail>>>;

function Run({ id, privacy }: { id: string; privacy: boolean }) {
  const [run, setRun] = useState<RunView | null | "missing">(null);
  useEffect(() => {
    fetch(`/status/run?id=${encodeURIComponent(id)}`)
      .then((r) => (r.ok ? r.json() : "missing"))
      .then(setRun, () => setRun("missing"));
  }, [id]);
  if (run === null) {
    return <div className="run muted">Reading the run…</div>;
  }
  if (run === "missing") {
    return <div className="run muted">This run is no longer in the log.</div>;
  }
  const minutes = (s: { endedAt: string | null; startedAt: string | null }) =>
    s.endedAt && s.startedAt
      ? `${Math.max(1, Math.round((Date.parse(s.endedAt) - Date.parse(s.startedAt)) / 60_000))} min`
      : "…";
  return (
    <motion.div
      animate={{ height: "auto", opacity: 1 }}
      className="run"
      initial={{ height: 0, opacity: 0 }}
    >
      {run.use && <p className="mono">Spent: {run.use}</p>}
      <table>
        <thead>
          <tr>
            <th>step</th>
            <th>outcome</th>
            <th>time</th>
            <th>counts</th>
          </tr>
        </thead>
        <tbody>
          {run.steps.map((s) => (
            <tr key={s.id}>
              <td>{s.step}</td>
              <td>
                <Pill tone={s.tone} word={s.outcome} />
              </td>
              <td>{minutes(s)}</td>
              <td>
                {Object.entries(s.result ?? {})
                  .filter(([k, v]) => typeof v === "number" && k !== "ms")
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ")}
                {s.use ? ` · ${s.use}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>What it wrote</h4>
      <div className="chips">
        {Object.entries(run.wrote.byType).length ? (
          Object.entries(run.wrote.byType).map(([k, v]) => (
            <Pill key={k} tone="teal" word={`${v} ${k}`} />
          ))
        ) : (
          <span className="muted">Nothing recorded under this run.</span>
        )}
      </div>
      <ul className="entries">
        {run.wrote.items.slice(0, 60).map((w) => (
          <li className="entry ok" key={w.id}>
            <span className="dotmark" />
            <span className="mono">{w.type}</span>
            <span className="when">{clock(w.at)}</span>
            {w.content && <Content lines={[w.content]} privacy={privacy} />}
          </li>
        ))}
      </ul>
    </motion.div>
  );
}

function History({
  entries,
  now,
  privacy,
}: {
  entries: Entry[];
  now: number;
  privacy: boolean;
}) {
  const [open, setOpen] = useState<string | null>(null);
  if (!entries.length) {
    return <p className="muted">Nothing in the last 7 days.</p>;
  }
  return (
    <ul className="entries">
      {entries.map((e, i) => (
        <li className={`entry ${e.tone}`} key={`${e.at}${i}`}>
          <span className="dotmark" />
          {e.run ? (
            <button
              className="open"
              onClick={() => setOpen(open === e.run ? null : (e.run ?? null))}
              type="button"
            >
              {e.title}
            </button>
          ) : (
            <span>{e.title}</span>
          )}
          <span className="when" title={e.at}>
            {e.at ? ago(e.at, now) : ""}
          </span>
          {e.sub && <span className="sub">{e.sub}</span>}
          {e.content && <Content lines={[e.content]} privacy={privacy} />}
          {e.run && open === e.run && <Run id={e.run} privacy={privacy} />}
        </li>
      ))}
    </ul>
  );
}

function Ask({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="ask">
      <p>{text}</p>
      <button
        className="btn"
        onClick={() =>
          navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1600);
          })
        }
        type="button"
      >
        {copied ? "Copied" : "Copy for Claude"}
      </button>
    </div>
  );
}

/** A card opened full screen: the card on the left, its state, history and log on the right. */
function Open({
  card,
  now,
  onClose,
  privacy,
}: {
  card: Card;
  now: number;
  onClose: () => void;
  privacy: boolean;
}) {
  const [history, setHistory] = useState<Entry[] | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  const [next, setNext] = useState<Detail["next"]>({
    history: null,
    log: null,
  });
  useEffect(() => {
    readCard(card.id).then(
      (d) => {
        setHistory(d.history);
        setLines(d.log);
        setNext(d.next);
      },
      () => setHistory([])
    );
  }, [card.id]);
  /** The next page of one list, back through the whole log. */
  const more = async (list: "history" | "log") => {
    const at = next[list];
    if (!at) {
      return;
    }
    const d = await readCard(card.id, at);
    if (list === "history") {
      setHistory((h) => [...(h ?? []), ...d.history]);
    } else {
      setLines((l) => [...l, ...d.log]);
    }
    setNext((n) => ({ ...n, [list]: d.next[list] }));
  };
  return (
    <motion.div
      animate={{ opacity: 1 }}
      className="detail"
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
      initial={{ opacity: 0 }}
    >
      <motion.article
        className={`card ${card.tone}`}
        drag="y"
        dragConstraints={{ bottom: 0, top: 0 }}
        dragElastic={{ bottom: 0.5, top: 0 }}
        layoutId={`card-${card.id}`}
        onDragEnd={(_, info) => {
          if (info.offset.y > 120) {
            onClose();
          }
        }}
        transition={SPRING}
      >
        <Face card={card} full now={now} privacy={privacy} />
        {card.ask && !privacy && <Ask text={card.ask} />}
      </motion.article>
      <motion.section
        animate={{ opacity: 1, x: 0 }}
        className="pane"
        initial={{ opacity: 0, x: 40 }}
        transition={{ delay: 0.12, ...SPRING }}
      >
        <button
          aria-label="Close"
          className="close"
          onClick={onClose}
          type="button"
        >
          <Cross />
        </button>
        <h4>History</h4>
        {history ? (
          <History entries={history} now={now} privacy={privacy} />
        ) : (
          <p className="muted">Reading…</p>
        )}
        {next.history && (
          <button
            className="btn more"
            onClick={() => more("history")}
            type="button"
          >
            Load older history
          </button>
        )}
        <h4>Log</h4>
        {privacy ? (
          <div className="redacted">
            raw log lines are hidden in privacy mode
          </div>
        ) : (
          <>
            <pre className="log">
              {lines.length
                ? lines.join("\n")
                : "No log lines for this part in the last 7 days."}
            </pre>
            {next.log && (
              <button
                className="btn more"
                onClick={() => more("log")}
                type="button"
              >
                Load older lines
              </button>
            )}
          </>
        )}
      </motion.section>
    </motion.div>
  );
}

function liveWord(plate: Plate | null) {
  if (!plate) {
    return "connecting";
  }
  return plate.problems
    ? `live · ${plate.problems} to look at`
    : "live · all well";
}

function App() {
  const { link, plate } = usePlate();
  const now = useNow();
  const [privacy, setPrivacy] = useState(() => stored(PRIVACY) === "on");
  const [group, setGroup] = useState<string | null>(null);
  const [cardId, setCardId] = useState<string | null>(null);
  useTab(plate, link);
  useEffect(() => store(PRIVACY, privacy ? "on" : "off"), [privacy]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") {
        return;
      }
      if (cardId) {
        setCardId(null);
      } else {
        setGroup(null);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [cardId]);
  const card = plate?.cards.find((c) => c.id === cardId);
  const opened = plate?.groups.find((g) => g.id === group);
  return (
    <MotionConfig reducedMotion="user">
      <header className="top">
        <div>
          <h1>
            Life, <em>as it runs</em>
          </h1>
          <div className="controls" style={{ marginTop: 12 }}>
            {link.kind === "live" ? (
              <span className={`pill ${plate?.worst ?? "idle"} live`}>
                {liveWord(plate)}
              </span>
            ) : (
              <span className="pill warn">Mac unreachable</span>
            )}
            <button
              aria-checked={privacy}
              className="switch"
              onClick={() => setPrivacy((p) => !p)}
              role="switch"
              type="button"
            >
              <span className="track">
                <span className="knob" />
              </span>
              Privacy mode
            </button>
          </div>
        </div>
        <div className="titleblock">
          <div>
            <b>Drawing</b>Life · status plate
          </div>
          <div>
            <b>Sheet</b>1 of 1
          </div>
          <div>
            <b>As of</b>
            {plate ? clock(plate.observedAt) : "…"}
          </div>
          <div>
            <b>Parts</b>
            {plate?.cards.length ?? "…"}
          </div>
        </div>
      </header>
      {link.kind !== "live" && (
        <p className="offline">
          The Mac can't be reached since{" "}
          {ago(new Date(link.since).toISOString(), now)}.
          {link.kind === "stale"
            ? ` Showing what it last sent, ${ago(link.pushedAt, now)}.`
            : " Showing the last plate this page saw."}
        </p>
      )}
      {plate ? (
        <>
          <Diagram link={link} onOpen={setGroup} plate={plate} />
          <Today now={now} privacy={privacy} ticks={plate.today} />
        </>
      ) : (
        <div aria-label="Reading the plate" className="skeleton" role="status">
          {["a", "b", "c", "d", "e"].map((k) => (
            <div key={k} />
          ))}
        </div>
      )}
      <AnimatePresence>
        {plate && opened && !card && (
          <Sheet
            cards={plate.cards.filter((c) => c.group === opened.id)}
            id={opened.id}
            key={opened.id}
            name={opened.name}
            now={now}
            onClose={() => setGroup(null)}
            onOpen={setCardId}
            privacy={privacy}
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {card && (
          <Open
            card={card}
            key={card.id}
            now={now}
            onClose={() => setCardId(null)}
            privacy={privacy}
          />
        )}
      </AnimatePresence>
    </MotionConfig>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<App />);
}
