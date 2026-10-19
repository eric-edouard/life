// Life's truth check: the statements by group; each answer is saved at once (memory/ratings.jsonl).

// A deck of items to judge one at a time, generic (items {id, text, note} in, verdicts out): swipe or tap right for
// true, left for false, Skip, Undo. Keys: → ← ↓ and Backspace. onVerdict(id, "true" | "false" | "skip" | null: undo).
const KEYS = { ArrowDown: "skip", ArrowLeft: "false", ArrowRight: "true" };

export function deck(root, onVerdict) {
  root.innerHTML = `<div class="stage"></div><div class="actions">
<button class="false" data-verdict="false">False</button><button class="true" data-verdict="true">True</button>
<button class="quiet" data-undo disabled>Undo</button><button class="quiet" data-verdict="skip">Skip</button></div>`;
  const stage = root.querySelector(".stage");
  const undoButton = root.querySelector("[data-undo]");
  let queue = [];
  const done = [];
  let flying = null; // the card on its way out, settled at once by a quicker answer, an undo or a load

  function render() {
    const [item] = queue;
    undoButton.disabled = done.length === 0;
    stage.replaceChildren();
    if (!item) {
      return;
    }
    const el = document.createElement("article");
    el.innerHTML = `<p class="note"></p><p class="text"></p>`;
    el.firstChild.textContent = item.note;
    el.lastChild.textContent = item.text;
    let start = null;
    el.onpointerdown = (e) => {
      start = { t: e.timeStamp, x: e.clientX };
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };
    el.onpointermove = (e) => start && lean(el, e.clientX - start.x);
    const end = (e) => {
      const dx = e.clientX - start.x;
      const quick = Math.abs(dx) / (e.timeStamp - start.t + 1) > 0.6;
      start = null;
      el.classList.remove("dragging");
      if (
        e.type === "pointerup" &&
        (Math.abs(dx) > el.offsetWidth * 0.28 || quick)
      ) {
        judge(dx > 0 ? "true" : "false");
      } else {
        lean(el, 0);
      }
    };
    el.onpointerup = end;
    el.onpointercancel = end;
    stage.append(el);
  }

  function lean(el, dx) {
    el.style.transform = `translateX(${dx}px) rotate(${dx / 18}deg)`;
    el.dataset.lean = dx > 0 ? "true" : "false";
    el.style.setProperty("--lean", Math.min(1, Math.abs(dx) / 100));
  }

  function judge(verdict) {
    flying?.();
    const el = stage.firstChild;
    if (!el) {
      return;
    }
    const settle = () => {
      if (flying === settle) {
        flying = null;
        done.push(queue.shift());
        onVerdict(done.at(-1).id, verdict);
        render();
      }
    };
    flying = settle;
    lean(el, { false: -1, skip: 0, true: 1 }[verdict] * window.innerWidth);
    el.classList.add("gone");
    el.ontransitionend = (e) => e.propertyName === "transform" && settle();
    setTimeout(settle, 400); // reduced motion: no transition to wait for
  }

  function undo() {
    flying?.();
    const item = done.pop();
    if (item) {
      queue.unshift(item);
      onVerdict(item.id, null);
      render();
    }
  }

  root.onclick = (e) => {
    const b = e.target.closest("button");
    if (b?.dataset.verdict) {
      judge(b.dataset.verdict);
    } else if (b?.hasAttribute("data-undo")) {
      undo();
    }
  };
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("select, input, textarea")) {
      return; // the keys belong to the control
    }
    const verdict = KEYS[e.key];
    if (verdict) {
      judge(verdict);
    } else if (e.key === "Backspace") {
      undo();
    }
  });
  return (items) => {
    flying?.();
    queue = [...items];
    render();
  };
}

const $ = (id) => document.getElementById(id);
const PENDING = "life-check-pending";
const byClaim = new Map();
let groups = [];

const left = (g) => g.statements.filter((s) => s.answer === null);
const note = (s) =>
  [
    s.source,
    new Date(s.date).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    }),
    s.kind !== "fact" && s.kind,
  ]
    .filter(Boolean)
    .join(" · ");

// Answers wait in localStorage until Life has them: a lost connection or an expired sign-in loses none.
const pending = () => JSON.parse(localStorage.getItem(PENDING) ?? "[]");
const keep = (list) => localStorage.setItem(PENDING, JSON.stringify(list));
// One flush at a time across tabs (a Web Lock), so two tabs never send or drop the same answer.
const flush = () =>
  navigator.locks.request("life-check-flush", async () => {
    try {
      for (let list = pending(); list.length > 0; list = pending()) {
        // biome-ignore lint/performance/noAwaitInLoops: one at a time, in the order he answered (an undo after its answer)
        const res = await fetch("/check/answer", {
          body: JSON.stringify(list[0]),
          method: "POST",
        });
        if (res.status === 401) {
          location.href = "/check/login";
          return;
        }
        if (res.status >= 500) {
          throw new Error(String(res.status));
        }
        if (res.status !== 204) {
          $("status").textContent =
            `Not saved (${res.status} ${await res.text()}): answers kept here`;
          return;
        }
        keep(pending().slice(1));
        $("status").textContent = "Saved";
      }
    } catch {
      $("status").textContent = "Not saved yet, retrying";
      setTimeout(flush, 4000);
    }
  });

// The group picker is a native select: each option names a group and how far he is in it.
function pick(current) {
  const done = (g) => g.statements.length - left(g).length;
  $("group").replaceChildren(
    ...groups.map(
      (g) => new Option(`${g.name} · ${done(g)}/${g.statements.length}`, g.id)
    )
  );
  $("group").value = current.id;
  $("bar").value = done(current) / current.statements.length;
}

const load = deck($("deck"), (claim, answer) => {
  const s = byClaim.get(claim);
  s.answer = answer;
  keep([...pending(), { answer, claim }]);
  flush();
  const group = groups.find((g) => g.statements.includes(s));
  if (answer === null) {
    open(group, claim); // an undo goes back to its group, the card taken back first
    return;
  }
  const next =
    left(group).length > 0 ? null : groups.find((g) => left(g).length > 0);
  pick(next ?? group);
  if (next) {
    open(next);
  } else if (!groups.some((g) => left(g).length > 0)) {
    $("status").textContent = "All checked.";
  }
});

function open(g, first) {
  pick(g);
  load(
    left(g)
      .toSorted((a, b) => (b.claim === first) - (a.claim === first))
      .map((s) => ({ id: s.claim, note: note(s), text: s.text }))
  );
}
$("group").onchange = () => open(groups.find((g) => g.id === $("group").value));

const res = await fetch("/check/statements");
if (res.status === 401) {
  location.href = "/check/login";
} else if (res.ok) {
  ({ groups } = await res.json());
  for (const s of groups.flatMap((g) => g.statements)) {
    byClaim.set(s.claim, s);
  }
  for (const a of pending()) {
    const s = byClaim.get(a.claim);
    if (s) {
      s.answer = a.answer;
    }
  }
  if (groups.length > 0) {
    open(groups.find((g) => left(g).length > 0) ?? groups[0]);
  }
  flush();
} else {
  $("status").textContent = `Life answered ${res.status} ${await res.text()}`;
}
