import { Drawer } from "@base-ui/react/drawer";
import type { DecisionRow, OwnerStep } from "@life/server/src/records/decision";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { loopName, say } from "../words";
import { useDensity } from "./density";
import { noteAnswer, tapAnswer } from "./order";

interface Props {
  /** A step of his is being written: a second tap waits for it. */
  busy: boolean;
  d: DecisionRow;
  /** After a new answer: on to the next one still his. */
  onAnswered: () => void;
  /** His step, written; true once Life took it. */
  onStep: (step: OwnerStep) => Promise<boolean>;
  /** His note has focus: the row of decisions doesn't swipe while he types. */
  onTyping: (typing: boolean) => void;
}

const where = (d: DecisionRow) =>
  loopName(d.loop) +
  (d.deadline
    ? `, ${new Date(d.deadline).toLocaleDateString(d.lang, { day: "numeric", month: "short" })}`
    : "");

/** The question's size from its length (at most 200 characters), one step down at the densest. */
const questionSize = (q: string, dense: number) => {
  const step =
    (q.length > 120 ? 2 : Number(q.length > 60)) + Number(dense >= 3);
  return ["text-[34px]", "text-[28px]", "text-[24px]", "text-[22px]"][step];
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

/** Everything long about a decision, in a sheet from the bottom: the one place long text scrolls. */
function Details({
  d,
  onStep,
  open,
  setOpen,
}: Pick<Props, "d" | "onStep"> & {
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const [wrong, setWrong] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <Drawer.Root
      onOpenChange={(o) => {
        setOpen(o);
        if (o && d.context && !d.contextOpenedAt) {
          onStep({ decision: d.id, step: "context" });
        }
      }}
      open={open}
      swipeDirection="down"
    >
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
              {d.to ? (
                <p className="m-0 text-[15px] text-text">
                  {say(d.lang, `À ${d.to}`, `To ${d.to}`)}
                </p>
              ) : null}
              {d.draft ? (
                <p className="m-0 whitespace-pre-wrap rounded-panel bg-card px-5 py-4 text-[17px]">
                  {d.draft}
                </p>
              ) : null}
              {d.options
                .filter((o) => o.draft || o.consequence)
                .map((o) => (
                  <div className="grid gap-1.5" key={o.id}>
                    <h3 className="m-0 font-bold text-[16px]">{o.label}</h3>
                    {o.consequence ? (
                      <p className="m-0 text-[15px] text-text">
                        {o.consequence}
                      </p>
                    ) : null}
                    {o.draft ? (
                      <p className="m-0 whitespace-pre-wrap rounded-panel bg-card px-5 py-4 text-[17px]">
                        {o.draft}
                      </p>
                    ) : null}
                  </div>
                ))}
              {d.context ? (
                <p className="m-0 whitespace-pre-wrap text-[16px] text-text">
                  {d.context}
                </p>
              ) : null}
              {sent ? (
                <p className="m-0 text-[15px] text-muted">
                  {say(d.lang, "Envoyé à l'audit.", "Sent to the audit.")}
                </p>
              ) : (
                <div className="grid gap-2">
                  <textarea
                    aria-label={say(
                      d.lang,
                      "Quelque chose ne va pas",
                      "Something's wrong"
                    )}
                    className="field"
                    onChange={(e) => setWrong(e.target.value)}
                    placeholder={say(
                      d.lang,
                      "Quelque chose ne va pas ? Dites-le ici.",
                      "Something wrong? Say it here."
                    )}
                    rows={2}
                    value={wrong}
                  />
                  {wrong.trim() ? (
                    <button
                      className="link justify-self-start"
                      onClick={async () => {
                        if (
                          await onStep({
                            data: {
                              loop: d.loop,
                              note: wrong.trim(),
                              ref: d.id,
                            },
                            step: "asked",
                          })
                        ) {
                          setSent(true);
                        }
                      }}
                      type="button"
                    >
                      {say(d.lang, "Envoyer à l'audit", "Send to the audit")}
                    </button>
                  ) : null}
                </div>
              )}
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
  d,
  dense,
  onOpen,
  text,
}: {
  d: DecisionRow;
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
        className={`${dense >= 2 ? "line-clamp-2" : "line-clamp-3"} text-[16px] text-ink`}
      >
        {text.replace(/\s+/g, " ")}
      </span>
      <span className="text-[14px] text-muted underline underline-offset-3">
        {d.draft
          ? say(d.lang, "Lire le message", "Read the message")
          : say(d.lang, "Plus de contexte", "More context")}
      </span>
    </button>
  );
}

/** One answer: its label, its consequence while there is room for it, a check once it is his. */
function Option({
  chosen,
  dense,
  disabled,
  o,
  onTap,
  pick,
}: {
  chosen: boolean;
  dense: number;
  disabled: boolean;
  o: DecisionRow["options"][number];
  onTap: () => void;
  pick: boolean;
}) {
  const still = useReducedMotion();
  return (
    <motion.button
      aria-pressed={chosen}
      className="opt"
      data-pick={pick || undefined}
      disabled={disabled}
      onClick={onTap}
      type="button"
      whileTap={still ? undefined : { scale: 0.985 }}
    >
      <span className="flex items-center justify-between gap-3">
        <span>{o.label}</span>
        {chosen ? <Check /> : null}
      </span>
      {o.consequence && dense < 2 ? (
        <span
          className={`${dense ? "line-clamp-1" : "line-clamp-2"} font-normal text-[15px] opacity-80`}
        >
          {o.consequence}
        </span>
      ) : null}
    </motion.button>
  );
}

/**
 * One decision, one screen, the answer always in reach: where it comes from, the question, a preview of anything long
 * (the whole of it in the sheet), and his answer pinned to the bottom. If a small screen still can't hold it, the
 * decision scrolls as one, its answer staying pinned; nothing scrolls inside anything else.
 */
export function Decision({ busy, d, onStep, onAnswered, onTyping }: Props) {
  const taken = d.status === "taken";
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
  const preview = d.draft ?? d.context;
  const hasMore = Boolean(
    d.context || d.options.some((o) => o.draft || (o.consequence && dense >= 2))
  );

  if (d.options.length === 0) {
    return (
      <div className="slide justify-center">
        <span className="text-[14px] text-muted">{where(d)}</span>
        <p className="m-0 text-muted">
          {say(d.lang, "Envoyé à l'audit : ", "Sent to the audit: ")}
          {d.question}
        </p>
      </div>
    );
  }
  return (
    <article aria-labelledby={`q-${d.id}`} className="slide" ref={article}>
      <span className="text-[14px] text-muted">{where(d)}</span>
      {/* Resting above the answer when it fits; mt-auto, not justify-end, so a tall one still scrolls to its top. */}
      <div className="mt-auto grid gap-4">
        <h2
          className={`m-0 text-balance font-semibold font-serif leading-[1.15] tracking-[-0.01em] ${questionSize(d.question, dense)}`}
          id={`q-${d.id}`}
        >
          {d.question}
        </h2>
        {d.to ? (
          <p className="m-0 text-[15px] text-text">
            {say(d.lang, `À ${d.to}`, `To ${d.to}`)}
          </p>
        ) : null}
        {/* Folding answers his typing; density only ever removes it at once, unanimated, so measuring never loops. */}
        <Fold onSettled={remeasure} shown={!typing && Boolean(preview)}>
          {dense < 3 && preview ? (
            <Preview
              d={d}
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
              dense={dense}
              disabled={taken || busy}
              key={o.id}
              o={o}
              onTap={async () => {
                const a = tapAnswer(d, o.id, note.trim());
                // A new answer moves on; taking one back stays.
                if ((await answer(a)) && a === o.id) {
                  onAnswered();
                }
              }}
              pick={o.id === d.pick}
            />
          ))}
        </Fold>
        {taken ? (
          <p className="m-0 text-[15px] text-text">
            {say(
              d.lang,
              "En cours : la boucle s'en occupe.",
              "Taken: the loop is on it."
            )}
          </p>
        ) : (
          <div className="flex items-end gap-2">
            <textarea
              aria-label={say(
                d.lang,
                "Ou dites-le à votre façon",
                "Or say it your way"
              )}
              className="field"
              onBlur={() => type(false)}
              onChange={(e) => {
                setNote(e.target.value);
                grow(e.target);
              }}
              onFocus={() => type(true)}
              placeholder={say(
                d.lang,
                "Ou dites-le à votre façon…",
                "Or say it your way…"
              )}
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
                {say(d.lang, "Envoyer", "Send")}
              </button>
            ) : null}
          </div>
        )}
        {hasMore && (!preview || dense >= 3) ? (
          <button
            className="link justify-self-start text-[14px]"
            onClick={() => setDetails(true)}
            type="button"
          >
            {say(d.lang, "Détails", "Details")}
          </button>
        ) : null}
      </div>
      <Details d={d} onStep={onStep} open={details} setOpen={setDetails} />
    </article>
  );
}
