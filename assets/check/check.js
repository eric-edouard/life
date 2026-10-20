// Life's truth check: the statements by group; each answer is saved at once (memory/ratings.jsonl).

// A deck of items to judge one at a time, generic: items {id, text, note, without?} and verdicts in, onVerdict(id, value |
// null: undo) out. A verdict is {value, label, key, swipe?, main?}: its button, its key, a swipe that way ("left",
// "right", "up") judge it; main ones get the big buttons; an item's `without` lists the values it doesn't offer. Undo is
// a button and Backspace.
const AWAY = { left: [-1, 0], right: [1, 0], up: [0, -1] };

export function deck(root, verdicts, onVerdict) {
  const button = (v) =>
    `<button class="${v.main ? "main" : "quiet"}" data-verdict="${v.value}">${v.label}</button>`;
  root.innerHTML = `<div class="stage"></div><div class="actions">${verdicts
    .filter((v) => v.main)
    .map(button)
    .join("")}</div>
<div class="actions"><button class="quiet" data-undo disabled>Undo</button>${verdicts
    .filter((v) => !v.main)
    .map(button)
    .join("")}</div>`;
  const stage = root.querySelector(".stage");
  const undoButton = root.querySelector("[data-undo]");
  // The verdicts the card on top offers.
  const offered = () =>
    verdicts.filter((v) => !queue[0]?.without?.includes(v.value));
  // The verdict whose way is within 45° of the drag.
  const bySwipe = (x, y) =>
    offered().find(({ swipe }) => {
      const [a, b] = AWAY[swipe] ?? [0, 0];
      return a * x + b * y > Math.hypot(x, y) * Math.SQRT1_2;
    });
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
    const shown = new Set(offered().map((v) => v.value));
    for (const b of root.querySelectorAll("[data-verdict]")) {
      b.hidden = !shown.has(b.dataset.verdict);
    }
    const el = document.createElement("article");
    el.innerHTML = `<p class="note"></p><p class="text"></p>`;
    el.firstChild.textContent = item.note;
    el.lastChild.textContent = item.text;
    let start = null;
    el.onpointerdown = (e) => {
      start = { t: e.timeStamp, x: e.clientX, y: e.clientY };
      el.setPointerCapture(e.pointerId);
      el.classList.add("dragging");
    };
    el.onpointermove = (e) =>
      start && lean(el, e.clientX - start.x, e.clientY - start.y);
    const end = (e) => {
      const [dx, dy] = [e.clientX - start.x, e.clientY - start.y];
      const far = Math.hypot(dx, dy);
      const quick = far / (e.timeStamp - start.t + 1) > 0.6;
      start = null;
      el.classList.remove("dragging");
      const v = bySwipe(dx, dy);
      if (
        e.type === "pointerup" &&
        v &&
        (far > el.offsetWidth * 0.28 || quick)
      ) {
        judge(v.value);
      } else {
        lean(el, 0, 0);
      }
    };
    el.onpointerup = end;
    el.onpointercancel = end;
    stage.append(el);
  }

  function lean(el, dx, dy) {
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 18}deg)`;
    el.dataset.lean = bySwipe(dx, dy)?.value ?? "";
    el.style.setProperty("--lean", Math.min(1, Math.hypot(dx, dy) / 100));
  }

  function judge(verdict) {
    flying?.();
    if (!offered().some((v) => v.value === verdict)) {
      return; // a quick second answer reaches the next card, which may not offer it
    }
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
    const [x, y] = AWAY[verdicts.find((v) => v.value === verdict).swipe] ?? [
      0, 0,
    ];
    lean(el, x * window.innerWidth, y * window.innerHeight);
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
    const verdict = offered().find((v) => v.key === e.key);
    if (verdict) {
      judge(verdict.value);
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
  [`as of ${s.asOf}`, s.source, s.kind !== "fact" && s.kind]
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

// True, but over (`outdated`): true when Life recorded it, not anymore (a closure kept as history, never "false"); not
// offered on a moment, which has no closed state.
const VERDICTS = [
  {
    key: "ArrowLeft",
    label: "False",
    main: true,
    swipe: "left",
    value: "false",
  },
  {
    key: "ArrowUp",
    label: "True, but over",
    main: true,
    swipe: "up",
    value: "outdated",
  },
  {
    key: "ArrowRight",
    label: "True",
    main: true,
    swipe: "right",
    value: "true",
  },
  { key: "ArrowDown", label: "Skip", value: "skip" },
];

const load = deck($("deck"), VERDICTS, (claim, answer) => {
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
      .map((s) => ({
        id: s.claim,
        note: note(s),
        text: s.text,
        without: s.kind === "moment" ? ["outdated"] : [],
      }))
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
