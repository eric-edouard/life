import { marked } from "marked";
import { type ReactNode, StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import readme from "../../../docs/design/README.md?raw";
import {
  dateLabelOf,
  filesIn,
  type Item,
  itemPathOf,
  itemsOf,
  README,
  ROOT,
  readmeRowsOf,
  SHOWN,
  type Status,
  urlOf,
} from "./catalog";
import { DesignSystem } from "./design-system";
import "./styles.css";

const ITEMS = itemsOf(readmeRowsOf(readme));
const SOURCE = "https://github.com/eric-edouard/life/blob/main/";
const MEDIA = /\.(png|jpe?g|gif|svg|mp4|webm)$/;
const VIDEO = /\.(mp4|webm)$/;
const HASH = /^#\/?/;
/** The width a design page is laid out for. Narrower than this (an unfolded Duo, a tablet, a small window) it is
 *  scaled down whole, so its frame and its controls both show; at phone width it gets its own small layout instead. */
const DESIGN_WIDTH = 1180;
const PHONE_WIDTH = 600;
/** The screen's height less the page padding (and on a phone, the menu button's row). */
const FULL_HEIGHT = "h-[calc(100dvh-4.25rem)] lg:h-[calc(100dvh-1.75rem)]";

/** The route is the hash: "" home, "system", or a path under docs/design. */
const readRoute = () => decodeURIComponent(location.hash.replace(HASH, ""));
const useRoute = () => {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
      window.scrollTo(0, 0);
    };
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  return route;
};

const hrefOf = (path: string) => `#/${path}`;

const STATUS_COLOUR: Record<Status, string> = {
  Approved: "bg-ok",
  Proposals: "bg-ai",
  Superseded: "bg-faint",
  Tools: "bg-fg",
};
const STATUS_WORD: Record<Status, string> = {
  Approved: "Approved",
  Proposals: "Proposal",
  Superseded: "Superseded",
  Tools: "Tool",
};

/** A small mark for what an item is: a design (a phone), a note (lines), a folder of screens (a grid). */
function Mark({ item }: { item: Item }) {
  const hasPage =
    item.kind === "folder" &&
    filesIn(item.path).some((p) => p.endsWith(".html"));
  const kind = hasPage ? "design" : item.kind;
  return (
    <svg
      aria-hidden="true"
      className="size-4 shrink-0 text-muted"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      viewBox="0 0 16 16"
    >
      {kind === "design" && <rect height="12" rx="2.5" width="8" x="4" y="2" />}
      {kind === "note" && (
        <path d="M3 4h10M3 8h10M3 12h6" strokeLinecap="round" />
      )}
      {kind === "folder" && (
        <path
          d="M2.5 2.5h4.5v4.5h-4.5zM9 2.5h4.5v4.5H9zM2.5 9h4.5v4.5h-4.5zM9 9h4.5v4.5H9z"
          strokeLinejoin="round"
        />
      )}
    </svg>
  );
}

function StatusDot({ status }: { status?: Status }) {
  if (status === undefined) {
    return null;
  }
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${STATUS_COLOUR[status]}`}
      title={STATUS_WORD[status]}
    />
  );
}

function Sidebar({ onPick, route }: { onPick: () => void; route: string }) {
  const [query, setQuery] = useState("");
  const shown = ITEMS.filter((i) =>
    `${i.title} ${i.about ?? ""} ${i.path}`
      .toLowerCase()
      .includes(query.toLowerCase())
  );
  const byDate = Map.groupBy(shown, (i) => i.date);
  const current = itemPathOf(route);
  const row = (href: string, active: boolean, children: ReactNode) => (
    <a
      aria-current={active ? "page" : undefined}
      className={`flex items-center gap-2.5 rounded-control px-2.5 py-1.5 text-fg text-row-line no-underline hover:bg-wash ${active ? "bg-tint font-semibold" : ""}`}
      href={href}
      key={href}
      onClick={onPick}
    >
      {children}
    </a>
  );
  return (
    <nav className="flex h-full flex-col gap-4 overflow-y-auto px-3 pt-4 pb-10">
      <input
        aria-label="Find a design"
        className="rounded-control bg-card px-3 py-2 text-fg text-row-line outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-ai"
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find"
        type="search"
        value={query}
      />
      <div className="flex flex-col">
        {row("#/", route === "", "Home")}
        {row("#/system", route === "system", "Design system")}
      </div>
      {[...byDate].map(([date, items]) => (
        <section className="flex flex-col" key={date}>
          <h2 className="mb-1 px-2.5 font-semibold text-heading text-muted">
            {dateLabelOf(date)}
          </h2>
          {items.map((i) =>
            row(
              hrefOf(i.path),
              current === i.path,
              <>
                <Mark item={i} />
                <span className="min-w-0 flex-1 truncate">{i.title}</span>
                <StatusDot status={i.status} />
              </>
            )
          )}
        </section>
      ))}
      {shown.length === 0 ? (
        <p className="px-2.5 text-faint text-row-line">
          Nothing matches “{query}”.
        </p>
      ) : null}
    </nav>
  );
}

/** Status and date of an item, on one quiet line. */
function Meta({ item }: { item: Item }) {
  return (
    <span className="flex shrink-0 items-center gap-2 text-faint text-meta">
      {item.status === undefined ? null : (
        <>
          <StatusDot status={item.status} />
          {STATUS_WORD[item.status]}
          <span aria-hidden="true">·</span>
        </>
      )}
      {dateLabelOf(item.date)}
    </span>
  );
}

/** At phone width the prototype fills the screen: its drawn status bar (`.sb`) goes, the phone's real one shows. */
const hideDrawnStatusBar = (frame: HTMLIFrameElement) => {
  const page = frame.contentDocument;
  const style = page?.createElement("style");
  if (page && style) {
    style.textContent = "@media (max-width:500px){.sb{display:none}}";
    page.head.append(style);
  }
};

/** A design page, live. Below its layout width (and above a phone's) it is scaled down whole to fit the box. */
function Frame({ app = false, path }: { app?: boolean; path: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });
  useEffect(() => {
    const el = frame.current;
    if (!(app && el)) {
      return;
    }
    const on = () => hideDrawnStatusBar(el);
    el.addEventListener("load", on);
    return () => el.removeEventListener("load", on);
  }, [app]);
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    const watch = new ResizeObserver(([entry]) => {
      if (entry) {
        setSize({
          height: entry.contentRect.height,
          width: entry.contentRect.width,
        });
      }
    });
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  const fits = size.width >= DESIGN_WIDTH || size.width < PHONE_WIDTH;
  const scale = fits ? 1 : size.width / DESIGN_WIDTH;
  return (
    <div
      className={`relative min-h-0 flex-1 overflow-hidden bg-card ${app ? "" : "rounded-panel"}`}
      ref={box}
    >
      <iframe
        className="absolute top-0 left-0 origin-top-left"
        ref={frame}
        src={urlOf(path)}
        style={{
          height: size.height / scale,
          transform: `scale(${scale})`,
          width: size.width / scale,
        }}
        title={path}
      />
    </div>
  );
}

/** A note in Markdown: links to other designs open here, links outside docs/design open the source. */
function Note({ markdown, path }: { markdown?: string; path: string }) {
  const [text, setText] = useState(markdown ?? "");
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (markdown === undefined) {
      fetch(urlOf(path))
        .then((r) => r.text())
        .then(setText);
    }
  }, [path, markdown]);
  useEffect(() => {
    const el = box.current;
    if (!el) {
      return;
    }
    // The repo's own notes, rendered by marked.
    el.innerHTML = marked.parse(text, { async: false });
    const base = new URL(urlOf(path), location.origin);
    for (const img of el.querySelectorAll("img")) {
      img.src = new URL(img.getAttribute("src") ?? "", base).href;
      img.loading = "lazy";
    }
    for (const a of el.querySelectorAll("a")) {
      const target = new URL(a.getAttribute("href") ?? "", base);
      if (target.origin !== location.origin) {
        a.target = "_blank";
        continue;
      }
      const inside = target.pathname.startsWith(`/${ROOT}`)
        ? decodeURIComponent(target.pathname.slice(ROOT.length + 1))
        : undefined;
      a.href =
        inside && (inside.endsWith("/") || SHOWN.test(inside))
          ? hrefOf(inside) + target.hash
          : `${SOURCE}${target.pathname.slice(1)}${target.hash}`;
    }
  }, [text, path]);
  return <div className="note" ref={box} />;
}

/** A folder: its pages and notes as rows, its screenshots and recordings as a grid. */
function Folder({ path }: { path: string }) {
  const inside = filesIn(path).map((p) => p.slice(path.length));
  const pages = inside.filter((p) => SHOWN.test(p));
  const media = inside.filter((p) => MEDIA.test(p));
  return (
    <div className="flex flex-col gap-8">
      {pages.length > 0 ? (
        <ul className="m-0 flex list-none flex-col p-0">
          {pages.map((p) => (
            <li className="shadow-[inset_0_-1px_var(--line)]" key={p}>
              <a
                className="flex py-3 text-fg text-title no-underline hover:text-muted"
                href={hrefOf(path + p)}
              >
                {p}
              </a>
            </li>
          ))}
        </ul>
      ) : null}
      {media.length > 0 ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-4">
          {media.map((p) => (
            <figure className="m-0 flex flex-col gap-2" key={p}>
              {VIDEO.test(p) ? (
                <video
                  className="w-full rounded-block bg-card"
                  controls
                  preload="metadata"
                  src={urlOf(path + p)}
                >
                  <track kind="captions" />
                </video>
              ) : (
                <a href={urlOf(path + p)} rel="noreferrer" target="_blank">
                  <img
                    alt={p}
                    className="h-auto w-full rounded-block bg-card"
                    height={844}
                    loading="lazy"
                    src={urlOf(path + p)}
                    width={390}
                  />
                </a>
              )}
              <figcaption className="break-all text-faint text-meta">
                {p}
              </figcaption>
            </figure>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** What a path shows: a page live, a note, a folder, or why nothing is there. */
function Body({ path }: { path: string }) {
  if (filesIn(path).length === 0) {
    return (
      <p className="text-muted">
        No file at {path}. It may have moved: find it in the list.
      </p>
    );
  }
  if (path.endsWith("/")) {
    return <Folder path={path} />;
  }
  return path.endsWith(".html") ? <Frame path={path} /> : <Note path={path} />;
}

/** The title line: the item (and the file inside it), its status and date, and the file opened alone. */
function Title({ item, path }: { item?: Item; path: string }) {
  const sub = item && path !== item.path ? path.slice(item.path.length) : "";
  const parent = item && sub ? item : undefined;
  return (
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="m-0 min-w-0 font-bold text-header">
        {parent ? (
          <a
            className="text-muted no-underline hover:text-fg"
            href={hrefOf(parent.path)}
          >
            {parent.title} /{" "}
          </a>
        ) : null}
        {parent ? sub : (item?.title ?? path)}
      </h1>
      {item ? <Meta item={item} /> : null}
      {path.endsWith("/") ? null : (
        <a
          className="ml-auto rounded-full bg-tint px-3 py-1 text-fg text-meta no-underline hover:bg-glass"
          href={urlOf(path)}
          rel="noreferrer"
          target="_blank"
        >
          Open alone
        </a>
      )}
    </header>
  );
}

/** One item, or a file inside one: a page fills the space left under its title line. */
function Viewer({ path }: { path: string }) {
  const item = ITEMS.find((i) => i.path === itemPathOf(path));
  const isPage = path.endsWith(".html");
  return (
    <div className={`flex flex-col gap-4 ${isPage ? FULL_HEIGHT : ""}`}>
      <Title item={item} path={path} />
      {item?.about && !isPage ? (
        <p className="m-0 max-w-[68ch] text-muted">{item.about}</p>
      ) : null}
      <Body path={path} />
    </div>
  );
}

/** Home: the approved design, live and whole, then the README (statuses, dates) as the one index. */
function Home() {
  const approved = ITEMS.find((i) => i.status === "Approved");
  return (
    <div className="flex flex-col gap-12">
      {approved ? (
        <section className={`flex flex-col gap-4 ${FULL_HEIGHT}`}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <h1 className="m-0 font-bold text-[clamp(1.75rem,4vw,2.75rem)] leading-none tracking-tight">
              {approved.title}
            </h1>
            <Meta item={approved} />
            <a
              className="ml-auto rounded-full bg-fg px-5 py-2 font-semibold text-body text-on no-underline"
              href={hrefOf(approved.path)}
            >
              Open
            </a>
          </div>
          <Frame path={approved.path} />
        </section>
      ) : null}
      <Note markdown={readme} path={README} />
    </div>
  );
}

/** Opened from the home screen: the approved prototype alone, full screen, as the app would be. */
function AppScreen() {
  const approved = ITEMS.find((i) => i.status === "Approved");
  if (!approved) {
    return <Home />;
  }
  return (
    <div className="fixed inset-0 flex">
      <Frame app path={approved.path} />
    </div>
  );
}

const STANDALONE =
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true;
const LIST_KEY = "design.list";
const WIDE = "(min-width: 64rem)";

const readList = () => {
  try {
    return localStorage.getItem(LIST_KEY) !== "hidden";
  } catch {
    return true;
  }
};

function App() {
  const route = useRoute();
  // A phone or a narrow window: the list is a drawer over the page.
  const [drawer, setDrawer] = useState(false);
  // A wide screen: the list beside the page, or hidden so the design takes the whole width; remembered per device.
  const [list, setList] = useState(readList);
  const toggle = () => {
    if (!matchMedia(WIDE).matches) {
      setDrawer(!drawer);
      return;
    }
    setList(!list);
    try {
      localStorage.setItem(LIST_KEY, list ? "hidden" : "shown");
    } catch {
      // Storage refused: the choice lasts this visit only.
    }
  };
  // From the home screen, home is the prototype itself, the list a drawer under a small grabber.
  const isApp = STANDALONE && route === "";
  const shown = list && !isApp;
  // Wide: beside the page when shown; else a drawer when open (the app screen's), else gone.
  let asideWide = "lg:hidden";
  if (shown) {
    asideWide = "lg:translate-x-0";
  } else if (drawer) {
    asideWide = "lg:fixed lg:h-auto";
  }
  let page: ReactNode = <Viewer path={route} />;
  if (isApp) {
    page = <AppScreen />;
  } else if (route === "") {
    page = <Home />;
  } else if (route === "system") {
    page = <DesignSystem />;
  }
  return (
    <div
      className={`min-h-dvh lg:grid ${shown ? "lg:grid-cols-[16rem_1fr]" : "lg:grid-cols-[1fr]"}`}
    >
      <button
        aria-expanded={drawer || shown}
        aria-label="Designs"
        className={
          isApp
            ? "fixed top-[env(safe-area-inset-top)] left-1/2 z-30 grid h-6 w-16 -translate-x-1/2 place-items-center"
            : "fixed top-3 left-3 z-30 grid size-9 place-items-center rounded-full bg-glass text-fg backdrop-blur"
        }
        onClick={isApp ? () => setDrawer(!drawer) : toggle}
        type="button"
      >
        {isApp ? (
          <span className="h-1 w-9 rounded-full bg-glass" />
        ) : (
          <svg
            aria-hidden="true"
            className="size-4"
            fill="none"
            stroke="currentColor"
            strokeLinecap="round"
            strokeWidth="1.5"
            viewBox="0 0 16 16"
          >
            <path d="M2.5 4.5h11M2.5 8h11M2.5 11.5h11" />
          </svg>
        )}
      </button>
      <aside
        className={`fixed inset-y-0 left-0 z-20 w-[min(20rem,86vw)] bg-sheet pt-12 transition-transform duration-200 lg:sticky lg:top-0 lg:h-dvh lg:w-auto lg:bg-bg ${drawer ? "translate-x-0" : "-translate-x-full"} ${asideWide}`}
      >
        <Sidebar onPick={() => setDrawer(false)} route={route} />
      </aside>
      {drawer ? (
        <button
          aria-label="Close the list"
          className={`fixed inset-0 z-10 bg-bg/60 ${shown ? "lg:hidden" : ""}`}
          onClick={() => setDrawer(false)}
          type="button"
        />
      ) : null}
      <main
        className={`min-w-0 px-3 pt-14 pb-3 sm:px-4 lg:pt-3 lg:pr-3 ${shown ? "lg:pl-2" : "lg:pl-16"}`}
      >
        {page}
      </main>
    </div>
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>
  );
}
