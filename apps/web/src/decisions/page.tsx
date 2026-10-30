import { Drawer } from "@base-ui/react/drawer";
import type { DecisionRow, OwnerStep } from "@life/server/src/records/decision";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readDecisions, writeStep } from "../api";
import { Decision } from "./decision";
import { isOpen, keyDown, nextOpen, orderOf } from "./order";
import { Theme } from "./theme";
import { useVisibleHeight } from "./visible-height";
import { loopName, say } from "./words";

// His decisions, one per screen side by side: a sideways swipe (or the arrow keys) moves, an up-down drag scrolls the
// one on screen. The current one is its id in the link (#id), so a reload or a shared link opens on it. From 900 px
// the overview is a sidebar; below, a sheet from the top, opened by the bar.

const idOfHash = () => {
  try {
    return decodeURIComponent(globalThis.location.hash.slice(1));
  } catch {
    // A malformed link opens on the first open decision.
    return "";
  }
};

function Overview({
  all,
  current,
  go,
}: {
  all: DecisionRow[];
  current: string;
  go: (id: string) => void;
}) {
  const [history, setHistory] = useState(false);
  const step = useStep();
  const groups = orderOf(all);
  const live = groups.flatMap((g) => g.live);
  const [first] = all;
  return (
    <nav
      aria-label={say(first?.lang, "Toutes les décisions", "All decisions")}
      className="grid gap-4"
    >
      <header className="flex items-baseline justify-between px-3">
        <h1 className="m-0 font-semibold font-serif text-[22px]">
          {say(first?.lang, "Décisions", "Decisions")}
        </h1>
        <span className="text-[15px] text-muted">
          {say(
            first?.lang,
            `${live.filter((d) => !isOpen(d)).length} sur ${live.length} faites`,
            `${live.filter((d) => !isOpen(d)).length} of ${live.length} done`
          )}
        </span>
      </header>
      {groups.map((g) => (
        <div className="grid" key={g.loop}>
          <h2 className="m-0 px-3 pt-1 pb-1.5 font-bold text-[14px] text-muted">
            {loopName(g.loop)}
          </h2>
          {g.live.map((d) => (
            <button
              aria-current={d.id === current}
              className="row"
              data-done={!isOpen(d) || undefined}
              key={d.id}
              onClick={() => go(d.id)}
              type="button"
            >
              <span aria-hidden="true" className="mark" />
              <span className="min-w-0">{d.question}</span>
              {isOpen(d) ? null : (
                <span className="sr-only">
                  {say(d.lang, " (fait)", " (done)")}
                </span>
              )}
            </button>
          ))}
          {g.grants.map((gr) => (
            <p className="m-0 px-3 py-1 text-[14px] text-muted" key={gr.id}>
              {gr.scope}{" "}
              <button
                className="link"
                onClick={() =>
                  step.mutate({ decision: gr.id, step: "revoked" })
                }
                type="button"
              >
                {say(gr.lang, "Retirer", "Revoke")}
              </button>
            </p>
          ))}
          {history
            ? g.past.map((d) => (
                <p className="m-0 px-3 py-1 text-[14px] text-muted" key={d.id}>
                  {d.question}:{" "}
                  <b>
                    {d.status === "done"
                      ? (d.options.find((o) => o.id === d.answer)?.label ??
                        d.note ??
                        "")
                      : d.status}
                  </b>
                  {d.result ? `, ${d.result}` : ""}
                </p>
              ))
            : null}
        </div>
      ))}
      {all.some((d) => d.closedAt) ? (
        <p className="m-0 px-3 text-[14px]">
          <button
            className="link"
            onClick={() => setHistory(!history)}
            type="button"
          >
            {history
              ? say(first?.lang, "Masquer l'historique", "Hide history")
              : say(first?.lang, "Historique", "History")}
          </button>
        </p>
      ) : null}
      <Theme lang={first?.lang} />
    </nav>
  );
}

/** His step, then the decisions read again (the poll waits while it saves). */
function useStep() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: writeStep,
    mutationKey: ["step"],
    onSettled: () => client.invalidateQueries({ queryKey: ["decisions"] }),
  });
}

export function DecisionsPage() {
  const saving = useIsMutating({ mutationKey: ["step"] }) > 0;
  const { data: all = [], error } = useQuery({
    queryFn: readDecisions,
    queryKey: ["decisions"],
    refetchInterval: saving ? false : 20_000,
  });
  const step = useStep();
  const height = useVisibleHeight();
  const live = useMemo(() => orderOf(all).flatMap((g) => g.live), [all]);
  const [wanted, setWanted] = useState(idOfHash);
  const [typing, setTyping] = useState(false);
  const [sheet, setSheet] = useState(false);
  const track = useRef<HTMLDivElement>(null);
  // The one on screen: the link's, while it is still live; else the first open one.
  const current =
    live.find((d) => d.id === wanted)?.id ??
    (live.find(isOpen) ?? live[0])?.id ??
    "";
  const at = live.findIndex((d) => d.id === current);

  const go = useCallback((id: string, smooth = true) => {
    setWanted(id);
    setSheet(false);
    globalThis.history.replaceState(null, "", `#${encodeURIComponent(id)}`);
    document.getElementById(`d-${id}`)?.scrollIntoView({
      behavior: smooth ? "smooth" : "instant",
      inline: "start",
    });
  }, []);

  // On the first load (and when the one he was on closes), the row opens on the current one.
  const shown = useRef("");
  useEffect(() => {
    if (current && current !== shown.current) {
      shown.current = current;
      document
        .getElementById(`d-${current}`)
        ?.scrollIntoView({ behavior: "instant", inline: "start" });
    }
  }, [current]);

  // A swipe that settles on another decision makes it the current one.
  useEffect(() => {
    const t = track.current;
    if (!t) {
      return;
    }
    const settle = () => {
      const d = live[Math.round(t.scrollLeft / t.clientWidth)];
      if (d && d.id !== shown.current) {
        shown.current = d.id;
        setWanted(d.id);
        globalThis.history.replaceState(
          null,
          "",
          `#${encodeURIComponent(d.id)}`
        );
      }
    };
    t.addEventListener("scrollend", settle);
    return () => t.removeEventListener("scrollend", settle);
  }, [live]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      keyDown(e, () => setSheet(false));
      if (e.target instanceof HTMLElement && e.target.closest("textarea")) {
        return;
      }
      const by = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
      const d = by ? live[at + by] : undefined;
      if (d) {
        go(d.id);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [at, live, go]);

  const onStep = async (s: OwnerStep) => {
    try {
      await step.mutateAsync(s);
      return true;
    } catch {
      return false;
    }
  };
  const [first] = all;
  const overview = <Overview all={all} current={current} go={go} />;

  return (
    <div
      className="flex h-dvh overflow-hidden"
      style={height ? { height } : undefined}
    >
      <aside className="hidden w-[360px] shrink-0 overflow-y-auto bg-surface px-5 py-8 min-[900px]:block">
        {overview}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Drawer.Root onOpenChange={setSheet} open={sheet} swipeDirection="up">
          <Drawer.Trigger
            aria-label={say(
              first?.lang,
              "Toutes les décisions",
              "All decisions"
            )}
            className="block w-full shrink-0 cursor-pointer border-0 bg-ground px-6 pt-[max(14px,env(safe-area-inset-top))] pb-2.5 min-[900px]:hidden"
          >
            <span className="flex gap-1">
              {live.map((d) => (
                <span
                  className="h-1 flex-1 rounded-sm bg-rule data-[here]:bg-ink data-[on]:bg-synced"
                  data-here={(isOpen(d) && d.id === current) || undefined}
                  data-on={!isOpen(d) || undefined}
                  key={d.id}
                />
              ))}
            </span>
            <span className="mt-2 block text-center text-[14px] text-muted">
              {say(
                first?.lang,
                `Toutes les ${live.length}`,
                `All ${live.length}`
              )}
            </span>
          </Drawer.Trigger>
          <Drawer.Portal>
            <Drawer.Backdrop className="fixed inset-0 z-10 bg-ink/20 transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
            <Drawer.Viewport className="fixed inset-0 z-20">
              <Drawer.Popup className="absolute inset-x-0 top-0 max-h-[88%] translate-y-(--drawer-swipe-movement-y) overflow-y-auto rounded-b-[24px] bg-ground px-5 pt-[max(24px,env(safe-area-inset-top))] pb-6 shadow-[0_1px_0_var(--rule)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full data-[swiping]:transition-none">
                <Drawer.Content>{overview}</Drawer.Content>
              </Drawer.Popup>
            </Drawer.Viewport>
          </Drawer.Portal>
        </Drawer.Root>
        {error ? (
          <p className="m-auto text-error">{error.message}</p>
        ) : (
          <div
            className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] data-[typing]:overflow-x-hidden"
            data-typing={typing || undefined}
            ref={track}
          >
            {live.map((d) => (
              <section
                className="@container h-full w-full shrink-0 snap-start snap-always"
                id={`d-${d.id}`}
                key={d.id}
              >
                <Decision
                  d={d}
                  onAnswered={() => {
                    const next = nextOpen(live, d.id);
                    if (next) {
                      setTimeout(() => go(next.id), 400);
                    }
                  }}
                  onStep={onStep}
                  onTyping={setTyping}
                />
              </section>
            ))}
            {live.some(isOpen) || all.length === 0 ? null : (
              <section className="grid h-full w-full shrink-0 snap-start place-items-center">
                <h2 className="font-semibold font-serif text-[32px]">
                  {say(first?.lang, "Rien à décider.", "Nothing to decide.")}
                </h2>
              </section>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
