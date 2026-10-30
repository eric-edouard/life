import type { DecisionRow, OwnerStep } from "@life/server/src/records/decision";
import { useEffect, useRef, useState } from "react";
import { noteAnswer, tapAnswer } from "./order";
import { loopName, say } from "./words";

interface Props {
  d: DecisionRow;
  /** After a new answer: on to the next one still his. */
  onAnswered: () => void;
  /** His answer, written; true once Life took it. */
  onStep: (step: OwnerStep) => Promise<boolean>;
  /** His note has focus: the row of decisions doesn't swipe while he types. */
  onTyping: (typing: boolean) => void;
}

const where = (d: DecisionRow) =>
  loopName(d.loop) +
  (d.deadline
    ? `, ${new Date(d.deadline).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
    : "");

/** The question's size from its length: a long one doesn't push the answer off screen. */
const questionSize = (q: string) => {
  if (q.length > 140) {
    return "text-[clamp(20px,6cqi,26px)]";
  }
  return q.length > 70
    ? "text-[clamp(22px,7cqi,32px)]"
    : "text-[clamp(26px,8.5cqi,44px)]";
};

/** The field grows with his words, up to a few lines. */
const grow = (f: HTMLTextAreaElement) => {
  f.style.height = "auto";
  f.style.height = `${Math.min(f.scrollHeight, 160)}px`;
};

/** "Something's wrong": his own request about this loop, for the audit. */
function Wrong({ d, onStep }: Pick<Props, "d" | "onStep">) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  if (!open) {
    return (
      <button className="link" onClick={() => setOpen(true)} type="button">
        {say(d.lang, "Quelque chose ne va pas", "Something's wrong")}
      </button>
    );
  }
  return (
    <div className="grid w-full gap-2">
      <textarea
        autoFocus
        className="field"
        onChange={(e) => setNote(e.target.value)}
        placeholder={say(d.lang, "Ce qui ne va pas…", "What's wrong…")}
        rows={2}
        value={note}
      />
      <button
        className="link justify-self-start"
        disabled={!note.trim()}
        onClick={async () => {
          if (
            await onStep({
              data: { loop: d.loop, note: note.trim(), ref: d.id },
              step: "asked",
            })
          ) {
            setOpen(false);
            setNote("");
          }
        }}
        type="button"
      >
        {say(d.lang, "Envoyer à l'audit", "Send to the audit")}
      </button>
    </div>
  );
}

/**
 * One decision, one screen: where it comes from (fixed); what is asked, resting at the bottom, scrolling when it is
 * too tall; and his answer, pinned to the bottom, above the keyboard.
 */
export function Decision({ d, onStep, onAnswered, onTyping }: Props) {
  const taken = d.status === "taken";
  const [note, setNote] = useState(d.note ?? "");
  const [showContext, setShowContext] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  // A refetch brings his saved note; never under his fingers.
  useEffect(() => {
    if (document.activeElement !== field.current) {
      setNote(d.note ?? "");
    }
  }, [d.note]);

  const answer = (a: string | null) =>
    onStep({
      data: { answer: a, note: note.trim() },
      decision: d.id,
      step: "answered",
    });

  if (d.options.length === 0) {
    return (
      <div className="slide justify-center">
        <span className="text-[15px] text-muted">{where(d)}</span>
        <p className="text-muted">
          {say(d.lang, "Envoyé à l'audit : ", "Sent to the audit: ")}
          {d.question}
        </p>
      </div>
    );
  }
  return (
    <article aria-labelledby={`q-${d.id}`} className="slide">
      <span className="shrink-0 text-[15px] text-muted">{where(d)}</span>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">
        {/* Resting at the bottom when it fits; mt-auto, not justify-end, so a tall one still scrolls to its top. */}
        <div className="mt-auto grid gap-4 py-2">
          <h2
            className={`m-0 font-semibold font-serif leading-[1.15] tracking-[-0.01em] ${questionSize(d.question)}`}
            id={`q-${d.id}`}
          >
            {d.question}
          </h2>
          {d.to ? (
            <p className="m-0 text-[15px] text-text">
              {say(d.lang, `À ${d.to}`, `To ${d.to}`)}
            </p>
          ) : null}
          {d.draft ? (
            <p className="m-0 whitespace-pre-wrap rounded-panel bg-surface px-5 py-4 text-[17px]">
              {d.draft}
            </p>
          ) : null}
          {d.status === "open" && d.result ? (
            <p className="m-0 text-[15px] text-text">{d.result}</p>
          ) : null}
          {showContext && d.context ? (
            <p className="m-0 whitespace-pre-wrap text-[15px] text-text">
              {d.context}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-5">
            {d.context && !showContext ? (
              <button
                className="link"
                onClick={() => {
                  setShowContext(true);
                  if (!d.contextOpenedAt) {
                    onStep({ decision: d.id, step: "context" });
                  }
                }}
                type="button"
              >
                {say(d.lang, "Plus de contexte", "More context")}
              </button>
            ) : null}
            <Wrong d={d} onStep={onStep} />
          </div>
        </div>
      </div>
      {/* His answer, pinned: the options scroll among themselves when too tall, his own words always in sight. */}
      <div className="flex max-h-[62%] shrink-0 flex-col gap-2.5">
        <div className="grid min-h-0 gap-2.5 overflow-y-auto overscroll-contain">
          {d.options.map((o) => (
            <button
              aria-pressed={d.answer === o.id}
              className="opt"
              data-pick={o.id === d.pick || undefined}
              disabled={taken}
              key={o.id}
              onClick={async () => {
                const a = tapAnswer(d, o.id, note.trim());
                // A new answer moves on; taking one back stays.
                if ((await answer(a)) && a === o.id) {
                  onAnswered();
                }
              }}
              type="button"
            >
              <span>{o.label}</span>
              {o.draft ? (
                <span className="whitespace-pre-wrap font-normal text-[15px] opacity-85">
                  {o.draft}
                </span>
              ) : null}
              {o.consequence ? (
                <span className="font-normal text-[15px] opacity-85">
                  {o.consequence}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        {taken ? (
          <p className="m-0 text-[15px] text-text">
            {say(
              d.lang,
              "En cours : la boucle s'en occupe.",
              "Taken: the loop is on it."
            )}
          </p>
        ) : (
          <textarea
            aria-label={say(
              d.lang,
              "Ou dites-le à votre façon",
              "Or say it your way"
            )}
            className="field"
            onBlur={() => {
              onTyping(false);
              // Saved when he leaves the field, not on each key: the file is append-only.
              if (note.trim() !== (d.note ?? "")) {
                answer(noteAnswer(d, note.trim()));
              }
            }}
            onChange={(e) => {
              setNote(e.target.value);
              grow(e.target);
            }}
            onFocus={(e) => {
              onTyping(true);
              e.target.scrollIntoView({ block: "nearest" });
            }}
            placeholder={say(
              d.lang,
              "Ou dites-le à votre façon…",
              "Or say it your way…"
            )}
            ref={field}
            rows={1}
            value={note}
          />
        )}
      </div>
    </article>
  );
}
