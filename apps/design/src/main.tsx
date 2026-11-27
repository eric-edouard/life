import files from "virtual:design-files";
import { marked } from "marked";
import {
  StrictMode,
  type TouchEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import readme from "../../../docs/design/README.md?raw";
import { Brand } from "./brand";
import {
  agoOf,
  dateLabelOf,
  dateOf,
  type Entry,
  filesIn as filesUnder,
  LATEST_URL,
  latestOf,
  pathsOf,
  ROOT,
  SHOWN,
  type Tab,
  tabsOf,
  urlOf,
} from "./catalog";
import { Components, Glow } from "./components";
import "./styles.css";

const PATHS = pathsOf(files);
/** The README section whose tab is the design system's pages. */
const SYSTEM_TAB = "Design system";
/** The design system's pages, drawn by the app: the README's section names them in words, never as rows. */
const SYSTEM_PAGES = {
  brand: { draw: Brand, title: "Brand" },
  components: { draw: Components, title: "Components" },
  glow: { draw: Glow, title: "Glow" },
} as const;
type SystemPage = keyof typeof SYSTEM_PAGES;
const isSystemPage = (route: string): route is SystemPage =>
  Object.hasOwn(SYSTEM_PAGES, route);
const TABS: Tab[] = tabsOf(readme).map((t) =>
  t.title === SYSTEM_TAB
    ? {
        ...t,
        entries: Object.entries(SYSTEM_PAGES).map(([path, p]) => ({
          about: "",
          path,
          title: p.title,
        })),
      }
    : t
);
const ENTRIES = TABS.flatMap((t) => t.entries);
/** The approved prototype: the Prototype tab's first entry. Home shows it, and the home-screen app opens on it. */
const PROTOTYPE = TABS.find((t) => t.title === "Prototype")?.entries[0];
const filesIn = (folder: string) => filesUnder(PATHS, folder);
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
/** A tab's own page when it isn't its first entry: the design system opens on its brand; explorations are only a group. */
const TAB_PAGE: Record<string, string | null> = {
  [SYSTEM_TAB]: "brand",
  Explorations: null,
};

/** The route is the hash: "" the prototype, a design system page, or a path under docs/design. */
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

const hrefOf = (route: string) => `#/${route}`;

/** Where a tab's heading goes, and the entries listed under it (its first is the heading's own page, unless set). */
const tabPartsOf = (tab: Tab) => {
  const page = TAB_PAGE[tab.title];
  if (page !== undefined) {
    return { entries: tab.entries, page };
  }
  return { entries: tab.entries.slice(1), page: tab.entries[0]?.path ?? null };
};

type Latest = ReturnType<typeof latestOf>;

function Sidebar({
  latest = [],
  onPick,
  route,
}: {
  latest?: Latest;
  onPick: () => void;
  route: string;
}) {
  const [query, setQuery] = useState("");
  const matches = (e: Entry) =>
    `${e.title} ${e.about}`.toLowerCase().includes(query.toLowerCase());
  const here = route || PROTOTYPE?.path;
  return (
    <nav className="flex h-full flex-col gap-5 overflow-y-auto px-3 pt-4 pb-10">
      <input
        aria-label="Find a design"
        className="rounded-control bg-card px-3 py-2 text-fg text-row-line outline-none placeholder:text-faint focus-visible:outline-2 focus-visible:outline-ai"
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Find"
        type="search"
        value={query}
      />
      {latest.length > 0 && !query ? (
        <section className="flex flex-col gap-0.5">
          <h2 className="m-0 px-2.5 py-1.5 font-semibold text-heading text-muted">
            Latest changes
          </h2>
          {latest.map(({ at, entry }) => (
            <a
              aria-current={here === entry.path ? "page" : undefined}
              className={`flex flex-col rounded-control px-2.5 py-1.5 text-fg no-underline hover:bg-wash ${here === entry.path ? "bg-tint" : ""}`}
              href={hrefOf(entry.path)}
              key={entry.path}
              onClick={onPick}
            >
              <span className="truncate text-row-line">{entry.title}</span>
              <span className="text-faint text-meta">{agoOf(at)}</span>
            </a>
          ))}
        </section>
      ) : null}
      {TABS.map((tab) => {
        const { entries, page } = tabPartsOf(tab);
        const shown = query ? tab.entries.filter(matches) : entries;
        if (query && shown.length === 0) {
          return null;
        }
        return (
          <section className="flex flex-col gap-0.5" key={tab.title}>
            {page === null ? (
              <h2 className="m-0 px-2.5 py-1.5 font-semibold text-heading text-muted">
                {tab.title}
              </h2>
            ) : (
              <a
                aria-current={here === page ? "page" : undefined}
                className={`rounded-control px-2.5 py-1.5 font-semibold text-fg text-title no-underline hover:bg-wash ${here === page ? "bg-tint" : ""}`}
                href={hrefOf(page)}
                onClick={onPick}
              >
                {tab.title}
              </a>
            )}
            {shown.map((e) => (
              <a
                aria-current={here === e.path ? "page" : undefined}
                className={`ml-2.5 flex flex-col rounded-control px-2.5 py-1.5 text-fg no-underline hover:bg-wash ${here === e.path ? "bg-tint" : ""}`}
                href={hrefOf(e.path)}
                key={e.path}
                onClick={onPick}
              >
                <span className="truncate text-row-line">{e.title}</span>
                {e.date ? (
                  <span className="text-faint text-meta">
                    {dateLabelOf(e.date)}
                  </span>
                ) : null}
              </a>
            ))}
          </section>
        );
      })}
    </nav>
  );
}

/** On the home-screen app a page drawing one phone (`.ph`: App v4's, the turn by turn shell's) becomes the screen: the
 *  phone fills it edge to edge with no frame, its drawn status bar and home indicator give way to the real ones, its side
 *  panel and hint go, and the page never scrolls. The pages' own phone-width rules lose to their `!important` padding. */
const SCREEN_CSS = `html,body{height:100%;overflow:hidden;overscroll-behavior:none;background:#000}
main,.shell{display:block!important;padding:0!important;min-height:0!important}
.fitbox,.fit{width:100vw!important;height:100dvh!important}
.ph{transform:none!important;width:100vw!important;height:100dvh!important;--r:0px!important}
.sb,.sbar,.home,.side,.hint{display:none!important}`;

/** Whether a loaded page draws one phone, made the screen if so. */
const fillScreen = (frame: HTMLIFrameElement) => {
  const page = frame.contentDocument;
  if (page?.querySelectorAll(".ph").length !== 1) {
    return false;
  }
  const style = page.createElement("style");
  style.textContent = SCREEN_CSS;
  page.head.append(style);
  return true;
};

/** A design page, live. Below its layout width (and above a phone's) it is scaled down whole to fit the box. */
function Frame({ app = false, path }: { app?: boolean; path: string }) {
  const box = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [size, setSize] = useState({ height: 0, width: 0 });
  // A page that is one phone fills the screen; any other keeps clear of the status bar and home indicator.
  const [filled, setFilled] = useState(false);
  useEffect(() => {
    const el = frame.current;
    if (!(app && el)) {
      return;
    }
    const on = () => setFilled(fillScreen(el));
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
  const fits = filled || size.width >= DESIGN_WIDTH || size.width < PHONE_WIDTH;
  const scale = fits ? 1 : size.width / DESIGN_WIDTH;
  return (
    <div
      className={`relative min-h-0 flex-1 overflow-hidden ${app ? "" : "rounded-panel bg-card"}`}
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
    if (markdown !== undefined) {
      return;
    }
    let current = true;
    fetch(urlOf(path))
      .then((r) => (r.ok ? r.text() : `Could not read ${path} (${r.status}).`))
      .then((t) => current && setText(t));
    return () => {
      current = false;
    };
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

/** The title line: the entry's name (else the file's), its date, and the file opened alone. */
function Title({ entry, path }: { entry?: Entry; path: string }) {
  const date = entry?.date ?? dateOf(path);
  return (
    <header className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h1 className="m-0 min-w-0 font-bold text-header">
        {entry?.title ?? path.split("/").filter(Boolean).at(-1)}
      </h1>
      {date ? (
        <span className="text-faint text-meta">{dateLabelOf(date)}</span>
      ) : null}
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

/** An entry, or any file a note links to: a page fills the space left under its title line. */
function Viewer({ path }: { path: string }) {
  const entry = ENTRIES.find((e) => e.path === path);
  const isPage = path.endsWith(".html");
  return (
    <div className={`flex flex-col gap-4 ${isPage ? FULL_HEIGHT : ""}`}>
      <Title entry={entry} path={path} />
      <Body path={path} />
    </div>
  );
}

/** On the home-screen app: a page alone, full screen, as the app would be. */
function AppScreen({ path }: { path: string }) {
  return (
    <div className="fixed inset-0 flex bg-black">
      <Frame app key={path} path={path} />
    </div>
  );
}

/** Opened from the home screen (or `?standalone`, to try it in a browser). */
const STANDALONE =
  matchMedia("(display-mode: standalone)").matches ||
  (navigator as { standalone?: boolean }).standalone === true ||
  new URLSearchParams(location.search).has("standalone");
if (STANDALONE) {
  document.documentElement.classList.add("standalone");
}
const LIST_KEY = "design.list";
const WIDE = "(min-width: 64rem)";

const readList = () => {
  try {
    return localStorage.getItem(LIST_KEY) !== "hidden";
  } catch {
    return true;
  }
};

/** The page for a route ("" the prototype): a design system page, else an entry. On the home-screen app a design page
 *  is the whole screen, anything else scrolls in its own box clear of the status bar and home indicator. */
function Page({ isApp, route }: { isApp: boolean; route: string }) {
  const path = route || (PROTOTYPE?.path ?? "");
  if (isApp && path.endsWith(".html") && filesIn(path).length > 0) {
    return <AppScreen path={path} />;
  }
  let page = <Viewer path={path} />;
  if (isSystemPage(route)) {
    const Draw = SYSTEM_PAGES[route].draw;
    page = <Draw />;
  }
  return isApp ? (
    <div className="fixed inset-0 overflow-y-auto overscroll-contain px-4 pt-[max(env(safe-area-inset-top),1rem)] pb-[calc(env(safe-area-inset-bottom)+5rem)]">
      {page}
    </div>
  ) : (
    page
  );
}

/** Opens the list: a round button; on the home-screen app it floats low on the right, in reach of the thumb, above the
 *  design's field and home indicator. */
function MenuButton({
  isApp,
  isOpen,
  onClick,
}: {
  isApp: boolean;
  isOpen: boolean;
  onClick: () => void;
}) {
  return (
    <button
      aria-expanded={isOpen}
      aria-label="Designs"
      className={`fixed z-30 grid place-items-center rounded-full bg-glass text-fg backdrop-blur ${isApp ? "right-[max(env(safe-area-inset-right),0.5rem)] bottom-[calc(env(safe-area-inset-bottom)+7.5rem)] size-11 opacity-70" : "top-3 left-3 size-9"}`}
      onClick={onClick}
      type="button"
    >
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
    </button>
  );
}

/** How far down a swipe on the open sheet closes it, in pixels. */
const CLOSES_AT = 80;

/** The list's look: on the home-screen app a sheet from the bottom, swiped down to close; else a drawer from the left
 *  (beside the page on a wide screen when shown). Same list, same motion. */
const asideOf = (isApp: boolean, open: boolean, shown: boolean) => {
  if (isApp) {
    return `inset-x-0 bottom-0 top-[calc(max(env(safe-area-inset-top),1rem)+1.5rem)] rounded-t-panel pt-2 pb-[env(safe-area-inset-bottom)] ${open ? "translate-y-0" : "translate-y-full"}`;
  }
  return `inset-y-0 left-0 w-[min(20rem,86vw)] pt-12 lg:sticky lg:top-0 lg:h-dvh lg:w-auto lg:bg-bg ${open ? "translate-x-0" : "-translate-x-full"} ${shown ? "lg:translate-x-0" : "lg:hidden"}`;
};

/** A swipe down on the sheet, while its list is at its top, drags it and past CLOSES_AT closes it. */
const useSwipeDown = (close: () => void) => {
  const from = useRef<number | null>(null);
  const offsetOf = (e: TouchEvent<HTMLElement>) =>
    Math.max(0, (e.touches[0]?.clientY ?? 0) - (from.current ?? 0));
  return {
    onTouchEnd: (e: TouchEvent<HTMLElement>) => {
      const moved = Number.parseFloat(e.currentTarget.style.translate || "0");
      e.currentTarget.style.translate = "";
      e.currentTarget.style.transition = "";
      from.current = null;
      if (moved > CLOSES_AT) {
        close();
      }
    },
    onTouchMove: (e: TouchEvent<HTMLElement>) => {
      if (from.current !== null) {
        e.currentTarget.style.translate = `0 ${offsetOf(e)}px`;
      }
    },
    onTouchStart: (e: TouchEvent<HTMLElement>) => {
      const list = e.currentTarget.querySelector("nav");
      from.current =
        (list?.scrollTop ?? 0) > 0 ? null : (e.touches[0]?.clientY ?? null);
      e.currentTarget.style.transition = "none";
    },
  };
};

/** The latest changed entries, asked of the server each time the list opens (the checkout moves every minute). */
const useLatest = (open: boolean) => {
  const [latest, setLatest] = useState<Latest>([]);
  useEffect(() => {
    if (!open) {
      return;
    }
    fetch(LATEST_URL)
      .then((r) => (r.ok ? r.json() : []))
      .then((commits) => setLatest(latestOf(ENTRIES, commits)))
      .catch(() => setLatest([]));
  }, [open]);
  return latest;
};

function App() {
  const route = useRoute();
  // A phone or a narrow window: the list is a drawer over the page. The home-screen app opens on it.
  const [drawer, setDrawer] = useState(STANDALONE);
  // A wide screen: the list beside the page, or hidden so the design takes the whole width; remembered per device.
  const [list, setList] = useState(readList);
  // From the home screen every design is the whole screen, the list a sheet under a floating button.
  const isApp = STANDALONE;
  const shown = list && !isApp;
  const swipe = useSwipeDown(() => setDrawer(false));
  const latest = useLatest(isApp && drawer);
  const toggle = () => {
    if (isApp || !matchMedia(WIDE).matches) {
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
  return (
    <div
      className={`min-h-dvh lg:grid ${shown ? "lg:grid-cols-[16rem_1fr]" : "lg:grid-cols-[1fr]"}`}
    >
      <MenuButton isApp={isApp} isOpen={drawer || shown} onClick={toggle} />
      <aside
        className={`fixed z-20 flex flex-col bg-sheet transition-transform duration-200 ${asideOf(isApp, drawer, shown)}`}
        {...(isApp ? swipe : {})}
      >
        {isApp ? (
          <span className="mx-auto h-1 w-9 flex-none rounded-full bg-glass" />
        ) : null}
        <div className="min-h-0 flex-1">
          <Sidebar
            latest={latest}
            onPick={() => setDrawer(false)}
            route={route}
          />
        </div>
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
        <Page isApp={isApp} route={route} />
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
