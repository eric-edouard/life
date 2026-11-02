import { Drawer } from "@base-ui/react/drawer";
import type { Decision, OwnerStep } from "@life/server/src/records/decision";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { DENSEST, useDensity } from "./density";
import { noteAnswer } from "./order";

interface Props {
  /** A step of his is being written: a second tap waits for it. */
  busy: boolean;
  d: Decision;
  /** After a new answer: on to the next one still his. */
  onAnswered: () => void;
  /** His step, written; true once Life took it. */
  onStep: (step: OwnerStep) => Promise<boolean>;
  /** His note has focus: the row of decisions doesn't swipe while he types. */
  onTyping: (typing: boolean) => void;
}

const until = (deadline: string) =>
  `Open until ${new Date(deadline).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`;

/** The question's size from its length (at most 200 characters), one step down at the densest. */
const questionSize = (q: string, dense: number) => {
  const step =
    (q.length > 120 ? 2 : Number(q.length > 60)) + Number(dense >= DENSEST);
  return [
    "text-[34px] min-[900px]:text-[56px]",
    "text-[28px] min-[900px]:text-[46px]",
    "text-[24px] min-[900px]:text-[38px]",
    "text-[22px] min-[900px]:text-[32px]",
  ][step];
};

/** The field grows with his words, up to a few lines. */
const grow = (f: HTMLTextAreaElement) => {
  f.style.height = "auto";
  f.style.height = `${Math.min(f.scrollHeight, 160)}px`;
};

const EASE = [0.2, 0.8, 0.2, 1] as const;

/** Folds away while he types, and comes back when he leaves the field. */
function Fold({
  shown,
  children,
  onSettled,
}: {
  shown: boolean;
  children: React.ReactNode;
  onSettled: () => void;
}) {
  const still = useReducedMotion();
  return (
    <AnimatePresence initial={false}>
      {shown ? (
        <motion.div
          animate={{ height: "auto", opacity: 1 }}
          className="grid gap-2.5 overflow-hidden"
          exit={{ height: 0, opacity: 0 }}
          initial={{ height: 0, opacity: 0 }}
          // Only once it has opened: the space it takes is what density must measure.
          onAnimationComplete={(to) =>
            (to as { height?: unknown }).height === "auto" && onSettled()
          }
          transition={{ duration: still ? 0 : 0.22, ease: EASE }}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

/** A decision's context, in a sheet from the bottom: the one place long text scrolls. */
function Details({
  d,
  open,
  setOpen,
}: {
  d: Decision;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  return (
    <Drawer.Root onOpenChange={setOpen} open={open} swipeDirection="down">
      <Drawer.Portal>
        <Drawer.Backdrop className="fixed inset-0 z-10 bg-ink/25 transition-opacity duration-300 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0 motion-reduce:transition-none" />
        <Drawer.Viewport className="fixed inset-0 z-20">
          <Drawer.Popup className="absolute inset-x-0 bottom-0 mx-auto flex max-h-[85%] max-w-[784px] translate-y-(--drawer-swipe-movement-y) flex-col rounded-t-[24px] bg-ground shadow-[0_-1px_0_var(--rule)] transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] data-[ending-style]:translate-y-full data-[starting-style]:translate-y-full data-[swiping]:transition-none motion-reduce:transition-none">
            <span
              aria-hidden="true"
              className="mx-auto mt-2.5 h-1 w-10 shrink-0 rounded-full bg-rule"
            />
            <Drawer.Content className="grid gap-6 overflow-y-auto overscroll-contain px-6 pt-4 pb-[max(24px,env(safe-area-inset-bottom))]">
              <Drawer.Title className="m-0 font-semibold font-serif text-[22px] leading-tight">
                {d.question}
              </Drawer.Title>
              <p className="m-0 whitespace-pre-wrap text-[16px] text-text">
                {d.context}
              </p>
            </Drawer.Content>
          </Drawer.Popup>
        </Drawer.Viewport>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** A check that draws itself when his answer lands. */
function Check() {
  const still = useReducedMotion();
  return (
    <svg
      aria-hidden="true"
      className="size-5 shrink-0"
      fill="none"
      viewBox="0 0 20 20"
    >
      <motion.path
        animate={{ pathLength: 1 }}
        d="M4.5 10.5 8.5 14.5 15.5 6"
        initial={{ pathLength: still ? 1 : 0 }}
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2.2}
        transition={{ duration: 0.28, ease: EASE }}
      />
    </svg>
  );
}

/** The first lines of something long, read as one paragraph (its blank lines would spend the few it has); the whole in the sheet. */
function Preview({
  dense,
  onOpen,
  text,
}: {
  dense: number;
  onOpen: () => void;
  text: string;
}) {
  return (
    <button
      className="grid cursor-pointer gap-1.5 rounded-panel bg-card px-5 py-4 text-left"
      onClick={onOpen}
      type="button"
    >
      <span
        className={`${dense ? "line-clamp-2" : "line-clamp-3"} text-[16px] text-ink`}
      >
        {text.replace(/\s+/g, " ")}
      </span>
      <span className="text-[14px] text-muted underline underline-offset-3">
        More context
      </span>
    </button>
  );
}

/** One answer: its label, a check once it is his. */
function Option({
  chosen,
  disabled,
  o,
  onTap,
}: {
  chosen: boolean;
  disabled: boolean;
  o: Decision["options"][number];
  onTap: () => void;
}) {
  const still = useReducedMotion();
  return (
    <motion.button
      aria-pressed={chosen}
      className="opt"
      disabled={disabled}
      onClick={onTap}
      type="button"
      whileTap={still ? undefined : { scale: 0.985 }}
    >
      <span className="flex items-center justify-between gap-3">
        <span>{o.label}</span>
        {chosen ? <Check /> : null}
      </span>
    </motion.button>
  );
}

/**
 * One decision, one screen, the answer always in reach: until when it is open, the question, a preview of its context
 * (the whole of it in the sheet), and his answer pinned to the bottom. If a small screen still can't hold it, the
 * decision scrolls as one, its answer staying pinned; nothing scrolls inside anything else.
 */
export function DecisionCard({ busy, d, onStep, onAnswered, onTyping }: Props) {
  const [note, setNote] = useState(d.note ?? "");
  const [typing, setTyping] = useState(false);
  const [details, setDetails] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const article = useRef<HTMLElement>(null);
  const [dense, remeasure] = useDensity(article);
  // A refetch brings his saved note, but never over words he hasn't sent.
  const saved = useRef(d.note ?? "");
  useEffect(() => {
    setNote((mine) => (mine.trim() === saved.current ? (d.note ?? "") : mine));
    saved.current = d.note ?? "";
  }, [d.note]);
  const unsent = note.trim() !== (d.note ?? "");

  const answer = (a: string | null) =>
    onStep({
      data: { answer: a, note: note.trim() },
      decision: d.id,
      step: "answered",
    });
  // His words alone answer only when he sends them; leaving the field keeps them with his answer, if any.
  const saveNote = () =>
    unsent ? answer(noteAnswer(d, note.trim())) : Promise.resolve(false);
  const type = (on: boolean) => {
    setTyping(on);
    onTyping(on);
  };
  const preview = d.context;

  return (
    <article
      aria-labelledby={`q-${d.id}`}
      className="slide min-[900px]:justify-center-safe"
      ref={article}
    >
      {d.deadline ? (
        <span className="text-[14px] text-muted">{until(d.deadline)}</span>
      ) : null}
      {/* Resting above the answer when it fits (mt-auto, not justify-end, so a tall one still scrolls to its top); a
          wide screen centers the whole decision instead. */}
      <div className="mt-auto grid gap-4 min-[900px]:mt-0 min-[900px]:gap-6">
        <h2
          className={`m-0 text-balance font-semibold font-serif leading-[1.15] tracking-[-0.01em] min-[900px]:font-bold min-[900px]:leading-[1.08] ${questionSize(d.question, dense)}`}
          id={`q-${d.id}`}
        >
          {d.question}
        </h2>
        {/* Folding answers his typing; density only ever removes it at once, unanimated, so measuring never loops. */}
        <Fold onSettled={remeasure} shown={!typing && Boolean(preview)}>
          {dense < DENSEST && preview ? (
            <Preview
              dense={dense}
              onOpen={() => setDetails(true)}
              text={preview}
            />
          ) : null}
        </Fold>
      </div>
      {/* His answer, at the bottom, in reach of his thumb. */}
      <div className="grid gap-2.5 pt-3">
        <Fold onSettled={remeasure} shown={!typing}>
          {d.options.map((o) => (
            <Option
              chosen={d.answer === o.id}
              disabled={busy}
              key={o.id}
              o={o}
              onTap={async () => {
                // His answer already, no note typed: nothing to write, just on to the next.
                if ((d.answer === o.id && !unsent) || (await answer(o.id))) {
                  onAnswered();
                }
              }}
            />
          ))}
        </Fold>
        <div className="flex items-end gap-2">
          <textarea
            aria-label="Or say it your way"
            className="field"
            onBlur={() => type(false)}
            onChange={(e) => {
              setNote(e.target.value);
              grow(e.target);
            }}
            onFocus={() => type(true)}
            placeholder="Or say it your way…"
            ref={field}
            rows={1}
            value={note}
          />
          {unsent ? (
            <button
              className="opt shrink-0 bg-ink px-4 py-3 font-semibold text-[16px] text-card"
              disabled={busy}
              onClick={async () => {
                field.current?.blur();
                if ((await saveNote()) && noteAnswer(d, note.trim())) {
                  onAnswered();
                }
              }}
              // Keeps the field's focus until the tap lands, so the options don't unfold under his finger.
              onPointerDown={(e) => e.preventDefault()}
              type="button"
            >
              Send
            </button>
          ) : null}
        </div>
        {preview && dense >= DENSEST ? (
          <button
            className="link justify-self-start text-[14px]"
            onClick={() => setDetails(true)}
            type="button"
          >
            Details
          </button>
        ) : null}
      </div>
      <Details d={d} open={details} setOpen={setDetails} />
    </article>
  );
}
