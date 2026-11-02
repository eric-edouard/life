import { Drawer } from "@base-ui/react/drawer";
import type { Decision, OwnerStep } from "@life/server/src/records/decision";
import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { readDecisions, writeStep } from "../api";
import { Theme } from "../theme";
import { useCurrent } from "./current";
import { DecisionCard } from "./decision";
import { DONE, isOpen, nextOpen, orderOf } from "./order";
import { useVisibleHeight } from "./visible-height";

// His decisions (Life's fact checks), one per screen side by side: a sideways swipe (or the arrow keys) moves, an
// up-down drag scrolls the one on screen. The current one is its id in the link (#id), so a reload or a shared link
// opens on it. From 900 px the overview is a sidebar; below, a sheet from the top, opened by the bar.

function Overview({
  all,
  current,
  go,
}: {
  all: Decision[];
  current: string;
  go: (id: string) => void;
}) {
  const [history, setHistory] = useState(false);
  const { live, past } = orderOf(all);
  return (
    <nav aria-label="All decisions" className="grid gap-4">
      <header className="flex items-baseline justify-between px-3">
        <h1 className="m-0 font-semibold font-serif text-[22px]">Decisions</h1>
        <span className="text-[15px] text-muted">
          {live.filter((d) => !isOpen(d)).length} of {live.length} done
        </span>
      </header>
      <div className="grid">
        {live.map((d) => (
          <button
            aria-current={d.id === current}
            className="row"
            data-done={!isOpen(d) || undefined}
            key={d.id}
            onClick={() => go(d.id)}
            type="button"
          >
            <span aria-hidden="true" className="mark" />
            <span className="line-clamp-2 min-w-0">{d.question}</span>
            {isOpen(d) ? null : <span className="sr-only"> (done)</span>}
          </button>
        ))}
        {history
          ? past.map((d) => (
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
      {past.length > 0 ? (
        <p className="m-0 px-3 text-[14px]">
          <button
            className="link"
            onClick={() => setHistory(!history)}
            type="button"
          >
            {history ? "Hide history" : "History"}
          </button>
        </p>
      ) : null}
      <Theme />
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

/** The bar on a phone: one segment per decision (green once answered, dark for the one on screen), opening the overview. */
function Bar({
  current,
  live,
  open,
  overview,
  setOpen,
}: {
  current: string;
  live: Decision[];
  open: boolean;
  overview: React.ReactNode;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Drawer.Root onOpenChange={setOpen} open={open} swipeDirection="up">
      <Drawer.Trigger
        aria-label="All decisions"
        className="block w-full shrink-0 cursor-pointer border-0 bg-ground px-6 pt-[max(14px,env(safe-area-inset-top))] pb-2.5 min-[900px]:hidden"
      >
        <span className="flex gap-1">
          {live.map((d) => (
            <span
              className="h-1 flex-1 rounded-sm bg-rule transition-colors duration-300 data-[here]:bg-ink data-[on]:bg-synced"
              data-here={(isOpen(d) && d.id === current) || undefined}
              data-on={!isOpen(d) || undefined}
              key={d.id}
            />
          ))}
        </span>
        <span className="mt-2 block text-center text-[14px] text-muted">
          All {live.length}
        </span>
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-10 bg-ink/20 transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Drawer.Viewport className="fixed inset-0 z-20">
          <Drawer.Popup className="absolute inset-x-0 top-0 max-h-[88%] translate-y-(--drawer-swipe-movement-y) overflow-y-auto rounded-b-[24px] bg-card px-5 pt-[max(24px,env(safe-area-inset-top))] pb-6 shadow-[0_1px_0_var(--rule)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[ending-style]:-translate-y-full data-[starting-style]:-translate-y-full data-[swiping]:transition-none motion-reduce:transition-none">
            <Drawer.Content>{overview}</Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** After the last one: nothing left to do today. */
function Done({ count }: { count: number }) {
  return (
    <>
      <h2 className="m-0 font-semibold font-serif text-[32px]">
        That's all for today.
      </h2>
      <p className="m-0 text-[15px] text-muted">{count} decisions made.</p>
    </>
  );
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
  const live = useMemo(() => orderOf(all).live, [all]);
  const [typing, setTyping] = useState(false);
  const [sheet, setSheet] = useState(false);
  const closeSheet = useCallback(() => setSheet(false), []);
  const { allDone, current, go, watch } = useCurrent(live, closeSheet);
  // The move after an answer: one at a time, none left behind when the page goes.
  const moving = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(moving.current), []);

  const onStep = async (s: OwnerStep) => {
    try {
      await step.mutateAsync(s);
      return true;
    } catch {
      return false;
    }
  };
  const overview = <Overview all={all} current={current} go={go} />;

  return (
    <div
      className="flex h-dvh overflow-hidden"
      style={height ? { height } : undefined}
    >
      <aside className="hidden w-[360px] shrink-0 overflow-y-auto bg-card px-5 py-8 min-[900px]:block">
        {overview}
      </aside>
      <main className="flex min-w-0 flex-1 flex-col">
        <Bar
          current={current}
          live={live}
          open={sheet}
          overview={overview}
          setOpen={setSheet}
        />
        {error ? (
          <p className="m-auto text-error">{error.message}</p>
        ) : (
          <div
            className="flex min-h-0 flex-1 snap-x snap-mandatory overflow-x-auto overflow-y-hidden overscroll-x-contain [scrollbar-width:none] data-[typing]:overflow-x-hidden"
            data-typing={typing || undefined}
          >
            {live.map((d) => (
              <section
                className="@container h-full w-full shrink-0 snap-start snap-always"
                id={`d-${d.id}`}
                key={d.id}
                ref={watch}
              >
                <DecisionCard
                  busy={step.isPending}
                  d={d}
                  onAnswered={() => {
                    // A pause to see his answer land, then on: to the next one still his, or to the end.
                    const next = nextOpen(live, d.id);
                    clearTimeout(moving.current);
                    moving.current = setTimeout(
                      () => go(next?.id ?? DONE),
                      450
                    );
                  }}
                  onStep={onStep}
                  onTyping={setTyping}
                />
              </section>
            ))}
            {allDone ? (
              <section
                className="grid h-full w-full shrink-0 snap-start snap-always place-content-center gap-2 px-6 text-center"
                id={`d-${DONE}`}
                ref={watch}
              >
                <Done count={live.length} />
              </section>
            ) : null}
          </div>
        )}
      </main>
    </div>
  );
}
