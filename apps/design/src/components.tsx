// App v4's components and its edge, each drawn live: the prototype itself, brought to the variation's scene by its
// side-panel buttons and cropped to the part it draws. The list is docs/design/components.json, the one source; a
// variation shows "In the app" while its parity board row is green, read from the board's last run, else its typed status.
import { useEffect, useRef, useState } from "react";
import data from "../../../docs/design/components.json";
import { urlOf } from "./catalog";

export interface Variation {
  name: string;
  on?: string;
  /** Another design page to draw instead of the prototype. */
  page?: string;
  /** The part of the phone it draws, the latest match; none: the whole phone. */
  part?: string;
  row: string | null;
  scene?: string[];
  status: string;
}
interface Group {
  name: string;
  variations: Variation[];
}

const GROUPS: Group[] = data.groups;
const PROTOTYPE = "2026-11-23-chat-first/2026-11-25-app-v4.html";
const BOARD = "2026-11-23-chat-first/parity/board.json";
const RULEBOOK = "#/2026-11-23-chat-first/2026-11-26-original-components.md";
/** The edge has a page of its own: the Glow. */
const EDGE = "The edge";
/** The prototype's own layout width: the phone sits in it as on its page. */
const PAGE_WIDTH = 1180;
const PAGE_HEIGHT = 960;
/** How long the prototype takes to draw a click's lines (its own scenes ink in over about this). */
const STEP_MS = 1500;
/** The share of the screen's height a drawing may take. */
const FIT = 0.7;
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** A variation's status as shown: "in" while its board row is green, else as typed. */
export const statusOf = (v: Variation, green: Set<string>) =>
  v.row && green.has(v.row) ? "in" : v.status;

const LABEL: Record<string, string> = {
  designed: "Designed",
  in: "✓ In the app",
  next: "Next batch",
};
const labelOf = (status: string, on?: string) =>
  status === "waiting" ? `Waiting on ${on}` : (LABEL[status] ?? status);

/** The board's green rows, from its last run on the Mac (none when it never ran here). */
function useGreenRows() {
  const [green, setGreen] = useState(new Set<string>());
  useEffect(() => {
    let current = true;
    fetch(urlOf(BOARD), { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { rows: [] }))
      .then(
        (b: { rows: { green: boolean; id: string }[] }) =>
          current &&
          setGreen(new Set(b.rows.filter((r) => r.green).map((r) => r.id)))
      )
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, []);
  return green;
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));
interface Box {
  height: number;
  width: number;
  x: number;
  y: number;
}

/** Where the part shows inside the phone (or the page), in the page's own pixels: its visible part only. */
function cropOf(page: Document, part?: string): Box | null {
  const root = page.getElementById("ph") ?? page.body;
  const el = part ? [...root.querySelectorAll(part)].at(-1) : root;
  if (!el) {
    return null;
  }
  // A part in the thread shows as far as the thread does, never under the status bar or the field.
  const thread = page.getElementById("thread");
  const a = el.getBoundingClientRect();
  const b = (thread?.contains(el) ? thread : root).getBoundingClientRect();
  const x = Math.max(a.left, b.left);
  const y = Math.max(a.top, b.top);
  const width = Math.min(a.right, b.right) - x;
  const height = Math.min(a.bottom, b.bottom) - y;
  return width > 0 && height > 0 ? { height, width, x, y } : null;
}

/** Scrolls the phone's thread to the part's top. Never `scrollIntoView`: it scrolls this page's own boxes too. */
function showInThread(page: Document, part?: string) {
  const thread = page.getElementById("thread");
  const el = part ? [...page.querySelectorAll(part)].at(-1) : undefined;
  if (thread && el && thread.contains(el)) {
    thread.scrollTop +=
      el.getBoundingClientRect().top - thread.getBoundingClientRect().top;
  }
}

/** One variation, live: mounted once near the screen, brought to its scene, then kept cropped to its part as it moves. */
function Live({ v }: { v: Variation }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [near, setNear] = useState(false);
  const [crop, setCrop] = useState<Box | null>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const seen = new IntersectionObserver(
      ([e]) => e?.isIntersecting && setNear(true),
      { rootMargin: "600px" }
    );
    const sized = new ResizeObserver(([e]) =>
      setWidth(e?.contentRect.width ?? 0)
    );
    seen.observe(el);
    sized.observe(el);
    return () => {
      seen.disconnect();
      sized.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = frame.current;
    if (!(near && el)) {
      return;
    }
    let tick = 0;
    let stopped = false;
    // Not the `load` event: the page's web fonts hold it, slow or offline. Its own markup is enough to act on.
    const ready = () => {
      const page = el.contentDocument;
      return page?.readyState !== "loading" &&
        page?.location.href.endsWith(v.page ?? PROTOTYPE)
        ? page
        : null;
    };
    const run = async () => {
      let page = ready();
      while (!(page || stopped)) {
        // biome-ignore lint/performance/noAwaitInLoops: waits for the page's markup, one look at a time
        await wait(200);
        page = ready();
      }
      if (!page) {
        return;
      }
      await wait(600);
      for (const click of v.scene ?? []) {
        page.querySelector<HTMLElement>(click)?.click();
        // biome-ignore lint/performance/noAwaitInLoops: each click acts on the state the one before it brought
        await wait(STEP_MS);
      }
      showInThread(page, v.part);
      const measure = () => setCrop(cropOf(page, v.part));
      measure();
      if (!stopped) {
        tick = window.setInterval(measure, 1000);
      }
    };
    run();
    return () => {
      stopped = true;
      clearInterval(tick);
    };
  }, [near, v]);
  // At most its own size, the card's width, and most of the screen's height: a whole phone shows whole.
  const scale = crop
    ? Math.min(1, width / crop.width, (innerHeight * FIT) / crop.height)
    : 0;
  return (
    <div
      className="relative overflow-hidden rounded-block bg-card"
      ref={box}
      style={{ height: crop ? crop.height * scale : 240 }}
    >
      {near ? (
        // The drawing's own window, centred: the page around the part never shows beside it.
        <div
          className="absolute inset-y-0 overflow-hidden"
          style={{
            left: crop ? (width - crop.width * scale) / 2 : 0,
            width: crop ? crop.width * scale : "100%",
          }}
        >
          <iframe
            className="absolute top-0 left-0 origin-top-left transition-opacity duration-300"
            ref={frame}
            src={urlOf(v.page ?? PROTOTYPE)}
            style={{
              height: PAGE_HEIGHT,
              opacity: crop ? 1 : 0,
              transform: crop
                ? `scale(${scale}) translate(${-crop.x}px, ${-crop.y}px)`
                : undefined,
              width: PAGE_WIDTH,
            }}
            tabIndex={-1}
            title={v.name}
          />
        </div>
      ) : null}
    </div>
  );
}

function Badge({ on, status }: { on?: string; status: string }) {
  return (
    <span
      className={`shrink-0 rounded-full px-2.5 py-0.5 text-meta ${status === "in" ? "bg-tint text-ok" : "bg-tint text-muted"}`}
    >
      {labelOf(status, on)}
    </span>
  );
}

/** A group: its variations side by side, lettered when there are several. */
function GroupOf({
  green,
  group,
  wide,
}: {
  green: Set<string>;
  group: Group;
  wide?: boolean;
}) {
  const many = group.variations.length > 1;
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 font-semibold text-heading text-muted">
        {group.name}
      </h2>
      <div
        className={`grid gap-6 ${wide ? "grid-cols-[repeat(auto-fill,minmax(17rem,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(14rem,1fr))]"}`}
      >
        {group.variations.map((v, i) => (
          <figure
            className={`m-0 flex flex-col gap-2 ${v.page ? "col-span-full" : ""}`}
            key={v.name}
          >
            <Live v={v} />
            <figcaption className="flex items-start justify-between gap-2">
              <span className="text-row-line">
                {many ? (
                  <span className="mr-1.5 font-semibold text-faint">
                    {LETTERS[i]}
                  </span>
                ) : null}
                {v.name}
              </span>
              <Badge on={v.on} status={statusOf(v, green)} />
            </figcaption>
          </figure>
        ))}
      </div>
    </section>
  );
}

function Header({ about, title }: { about: React.ReactNode; title: string }) {
  return (
    <header className="flex flex-col gap-3">
      <h1 className="m-0 font-bold text-[clamp(2rem,5vw,3.25rem)] leading-none tracking-tight">
        {title}
      </h1>
      <p className="m-0 max-w-[60ch] text-muted">{about}</p>
    </header>
  );
}

const shown = GROUPS.filter((g) => g.name !== EDGE);

export function Components() {
  const green = useGreenRows();
  const counts = Object.entries(
    Object.groupBy(
      shown.flatMap((g) => g.variations),
      (v) => labelOf(statusOf(v, green), v.on)
    )
  );
  return (
    <div className="flex flex-col gap-12">
      <Header
        about={
          <>
            Every part of the approved prototype, drawn live from it. What each
            does and why:{" "}
            <a className="text-fg" href={RULEBOOK}>
              the rulebook
            </a>
            . The edge is on its own page, the Glow.{" "}
            {counts
              .map(([label, list]) => `${list?.length} ${label.toLowerCase()}`)
              .join(" · ")}
            .
          </>
        }
        title="Components"
      />
      {shown.map((g) => (
        <GroupOf green={green} group={g} key={g.name} />
      ))}
    </div>
  );
}

export function Glow() {
  const green = useGreenRows();
  const edge = GROUPS.find((g) => g.name === EDGE);
  return (
    <div className="flex flex-col gap-12">
      <Header
        about={
          <>
            The ring round every screen, the one exception to no borders, no
            motion and one colour. It glides between its states, idle never
            livelier than the others, so you always tell them apart. Live from
            the prototype; its rules are in{" "}
            <a className="text-fg" href={RULEBOOK}>
              the rulebook
            </a>
            .
          </>
        }
        title="Glow"
      />
      {edge ? <GroupOf green={green} group={edge} wide /> : null}
    </div>
  );
}
