// His decisions, read from and answered through /me/decisions.json (Life, memory/decisions.jsonl). One decision at a
// time: on a phone they snap one per screen and the bar opens the overview; from 900 px the overview is a sidebar.
// Loops in his goals' order, each by deadline; closed ones under History. Every write is his step; Life refuses one
// on a decision a loop has already taken, and the page says so.

/** His answer once his note changes: an option he tapped stays; a note alone answers; clearing it reopens. */
export function noteAnswer(d, note) {
  const tapped = d.answer && d.answer !== "note" ? d.answer : null;
  if (tapped) {
    return tapped;
  }
  return note ? "note" : null;
}

/** His answer when he taps an option: tapping the one already chosen takes it back (his note, if any, then answers). */
export function tapAnswer(d, option, note) {
  if (d.answer !== option) {
    return option;
  }
  return note ? "note" : null;
}

/**
 * Escape closes the overview; every other key is left alone. As an `on…` handler, returning false would cancel the key
 * (30 Oct: typing in his answer did nothing).
 */
export function keyDown(e, sheet) {
  if (e.key === "Escape") {
    sheet(false);
  }
}

/** Still his to answer: open, with no answer yet. */
export const isOpen = (d) =>
  d.status === "open" && !d.answer && Boolean(d.options?.length);

/**
 * The loops in his goals' order (the lowest rank among a loop's open decisions), then the most open, then by name;
 * each with its live decisions by deadline, its closed ones newest first, and its standing grants.
 */
export function orderOf(decisions) {
  const openOf = (l) =>
    decisions.filter((d) => d.loop === l && d.status === "open");
  const rank = (l) => Math.min(99, ...openOf(l).map((d) => d.rank ?? 99));
  return [...new Set(decisions.map((d) => d.loop))]
    .sort(
      (a, b) =>
        rank(a) - rank(b) ||
        openOf(b).length - openOf(a).length ||
        a.localeCompare(b)
    )
    .map((loop) => {
      const mine = decisions.filter((d) => d.loop === loop);
      return {
        grants: mine.filter((d) => d.active),
        live: mine
          .filter((d) => !d.closedAt)
          .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9")),
        loop,
        past: mine
          .filter((d) => d.closedAt)
          .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? "")),
      };
    });
}

/** The next decision still his to answer after `id` in that order, wrapping round; none when all are answered. */
export function nextOpen(live, id) {
  const at = live.findIndex((d) => d.id === id);
  const after = [...live.slice(at + 1), ...live.slice(0, Math.max(at, 0))];
  return after.find(isOpen);
}

const $ = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) {
      continue;
    }
    if (k.startsWith("on")) {
      e[k] = v;
    } else {
      e.setAttribute(k, v);
    }
  }
  e.append(...kids.flat().filter((k) => k !== null && k !== undefined));
  return e;
};
const T = (d, f, e) => (d?.lang === "fr" ? f : e);
const FIRST_LETTER = /^./;
const name = (loop) =>
  loop.replaceAll("-", " ").replace(FIRST_LETTER, (c) => c.toUpperCase());
let all = [];
let current = "";
try {
  current = decodeURIComponent(globalThis.location?.hash.slice(1) ?? "");
} catch {
  // A malformed link opens on the first open decision.
}
let advance;
let shown = "";
/** The current decision in the link, so a reload or a shared link opens on it. */
const setHash = (id) =>
  globalThis.history.replaceState(null, "", `#${encodeURIComponent(id)}`);
let showHistory = false;

// His theme: the system's (auto) unless he picked light or dark, kept in this browser only.
const THEMES = [
  ["auto", "Auto", "Auto"],
  ["light", "Clair", "Light"],
  ["dark", "Sombre", "Dark"],
];
function readTheme() {
  try {
    return localStorage.getItem("theme") ?? "auto";
  } catch {
    return "auto";
  }
}
function setTheme(theme) {
  try {
    localStorage.setItem("theme", theme);
  } catch {
    // Private browsing: the pick lasts this visit.
  }
  if (theme === "auto") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function flash(msg) {
  const f = document.getElementById("flash");
  f.textContent = msg;
  f.hidden = false;
  setTimeout(() => {
    f.hidden = true;
  }, 4000);
}

async function step(body) {
  const r = await fetch("/me/decisions.json", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
  if (!r.ok) {
    flash(await r.text());
  }
  await load();
  return r.ok;
}

/** "Something's wrong": his own request about a loop (`ref` a decision or the loop), for the audit. */
function wrong(loop, ref, d) {
  const ta = $("textarea", {
    hidden: "",
    placeholder: T(d, "Ce qui ne va pas…", "What's wrong…"),
    rows: "2",
  });
  const send = $(
    "button",
    {
      class: "link",
      hidden: "",
      onclick: async () =>
        ta.value.trim() &&
        (await step({
          data: { loop, note: ta.value.trim(), ref },
          step: "asked",
        })) &&
        flash(T(d, "Envoyé à l'audit.", "Sent to the audit.")),
      type: "button",
    },
    T(d, "Envoyer", "Send")
  );
  const open = $(
    "button",
    {
      class: "link",
      onclick: (e) => {
        ta.hidden = false;
        send.hidden = false;
        e.target.remove();
        ta.focus();
      },
      type: "button",
    },
    T(d, "Quelque chose ne va pas", "Something's wrong")
  );
  return $("div", {}, open, ta, send);
}

function go(id, smooth = true) {
  clearTimeout(advance);
  current = id;
  showHistory = false;
  document.body.classList.remove("sheet");
  setHash(id);
  document
    .getElementById(`d-${id}`)
    ?.scrollIntoView({ behavior: smooth ? "smooth" : "instant" });
  renderList();
}

function card(d, where) {
  // His own request ("Something's wrong"): nothing to answer.
  if (!d.options?.length) {
    return $(
      "section",
      { id: `d-${d.id}` },
      $("span", { class: "where" }, where),
      $(
        "p",
        { class: "quiet" },
        T(d, "Envoyé à l'audit : ", "Sent to the audit: "),
        d.question
      )
    );
  }
  const taken = d.status === "taken";
  const note = $("textarea", {
    disabled: taken ? "" : null,
    placeholder: T(
      d,
      "Votre réponse, avec vos mots…",
      "Your answer, in your words…"
    ),
    rows: "2",
  });
  note.value = d.note ?? "";
  // Saved when he leaves the field, not on each key: the file is append-only.
  note.onchange = () =>
    step({
      data: {
        answer: noteAnswer(d, note.value.trim()),
        note: note.value.trim(),
      },
      decision: d.id,
      step: "answered",
    });
  const ctx = $("p", { class: "ctx", hidden: "" }, d.context ?? "");
  return $(
    "section",
    { id: `d-${d.id}` },
    $("span", { class: "where" }, where),
    $("h2", { class: "q", id: `q-${d.id}` }, d.question),
    d.to ? $("p", { class: "to" }, T(d, `À ${d.to}`, `To ${d.to}`)) : null,
    d.draft ? $("p", { class: "draft" }, d.draft) : null,
    d.status === "open" && d.result ? $("p", { class: "res" }, d.result) : null,
    $(
      "div",
      { "aria-labelledby": `q-${d.id}`, class: "opts", role: "radiogroup" },
      d.options.map((o) =>
        $(
          "button",
          {
            "aria-checked": String(d.answer === o.id),
            class: o.id === d.pick ? "opt pick" : "opt",
            disabled: taken ? "" : null,
            onclick: async () => {
              const answer = tapAnswer(d, o.id, note.value.trim());
              const ok = await step({
                data: { answer, note: note.value.trim() },
                decision: d.id,
                step: "answered",
              });
              // A new answer moves on; taking one back stays.
              const next =
                ok &&
                answer === o.id &&
                nextOpen(
                  orderOf(all).flatMap((g) => g.live),
                  d.id
                );
              if (next) {
                advance = setTimeout(() => go(next.id), 400);
              }
            },
            role: "radio",
            type: "button",
          },
          $("span", {}, o.label),
          o.draft ? $("span", { class: "d" }, o.draft) : null,
          o.consequence ? $("span", { class: "c" }, o.consequence) : null
        )
      )
    ),
    taken
      ? $(
          "p",
          { class: "res" },
          T(d, "En cours : la boucle s'en occupe.", "Taken: the loop is on it.")
        )
      : $(
          "label",
          {},
          T(d, "Ou dites-le à votre façon", "Or say it your way"),
          note
        ),
    $(
      "div",
      { class: "links" },
      d.context
        ? $(
            "button",
            {
              class: "link",
              onclick: (e) => {
                ctx.hidden = false;
                e.target.remove();
                if (!d.contextOpenedAt) {
                  step({ decision: d.id, step: "context" });
                }
              },
              type: "button",
            },
            T(d, "Plus de contexte", "More context")
          )
        : null,
      wrong(d.loop, d.id, d)
    ),
    ctx
  );
}

/** A bar segment: green once answered, dark for the one on screen. */
function segmentOf(d) {
  if (!isOpen(d)) {
    return "on";
  }
  return d.id === current ? "here" : null;
}

function renderList() {
  const groups = orderOf(all);
  const live = groups.flatMap((g) => g.live);
  const done = live.filter((d) => !isOpen(d)).length;
  const [first] = all;
  const list = document.getElementById("list");
  list.replaceChildren(
    $(
      "header",
      {},
      $("h1", {}, T(first, "Décisions", "Decisions")),
      $(
        "span",
        { class: "count" },
        T(
          first,
          `${done} sur ${live.length} faites`,
          `${done} of ${live.length} done`
        )
      )
    ),
    ...groups.map((g) =>
      $(
        "div",
        { class: "group" },
        $("h2", {}, name(g.loop)),
        g.live.map((d) =>
          $(
            "button",
            {
              "aria-current": String(d.id === current),
              class: isOpen(d) ? "row" : "row done",
              onclick: () => go(d.id),
              type: "button",
            },
            $("span", { "aria-hidden": "true", class: "mark" }),
            d.question,
            isOpen(d)
              ? null
              : $("span", { class: "sr" }, T(d, " (fait)", " (done)"))
          )
        ),
        g.grants.map((gr) =>
          $(
            "p",
            { class: "side" },
            gr.scope,
            " ",
            $(
              "button",
              {
                class: "link",
                onclick: () => step({ decision: gr.id, step: "revoked" }),
                type: "button",
              },
              T(gr, "Retirer", "Revoke")
            )
          )
        ),
        showHistory
          ? g.past.map((d) =>
              $(
                "p",
                { class: "side" },
                d.question,
                ": ",
                $(
                  "b",
                  {},
                  d.status === "done"
                    ? ((d.options ?? []).find((o) => o.id === d.answer)
                        ?.label ??
                        d.note ??
                        "")
                    : d.status
                ),
                d.result ? `, ${d.result}` : ""
              )
            )
          : null
      )
    ),
    all.some((d) => d.closedAt)
      ? $(
          "p",
          { class: "side" },
          $(
            "button",
            {
              class: "link",
              onclick: () => {
                showHistory = !showHistory;
                renderList();
              },
              type: "button",
            },
            showHistory
              ? T(first, "Masquer l'historique", "Hide history")
              : T(first, "Historique", "History")
          )
        )
      : null,
    $(
      "p",
      { "aria-labelledby": "theme", class: "theme", role: "group" },
      $("span", { id: "theme" }, T(first, "Thème", "Theme")),
      THEMES.map(([id, fr, en]) =>
        $(
          "button",
          {
            "aria-pressed": String(
              (document.documentElement.dataset.theme ?? "auto") === id
            ),
            class: "link",
            onclick: () => {
              setTheme(id);
              renderList();
            },
            type: "button",
          },
          T(first, fr, en)
        )
      )
    )
  );
  const bar = document.getElementById("bar");
  bar.replaceChildren(
    $(
      "span",
      { class: "seg" },
      live.map((d) =>
        $("span", {
          class: segmentOf(d),
        })
      )
    ),
    $(
      "span",
      { class: "hint" },
      T(first, `Toutes les ${live.length}`, `All ${live.length}`)
    )
  );
}

function render() {
  const groups = orderOf(all);
  const live = groups.flatMap((g) => g.live);
  if (!live.some((d) => d.id === current)) {
    current = (live.find(isOpen) ?? live[0])?.id ?? "";
  }
  const where = (d) =>
    name(d.loop) +
    (d.deadline
      ? `, ${new Date(d.deadline).toLocaleDateString(undefined, { day: "numeric", month: "short" })}`
      : "");
  document
    .getElementById("cards")
    .replaceChildren(
      ...live.map((d) => card(d, where(d))),
      live.some(isOpen)
        ? null
        : $(
            "section",
            {},
            $(
              "h2",
              { class: "q" },
              T(all.at(0), "Rien à décider.", "Nothing to decide.")
            )
          )
    );
  renderList();
  // Scroll only when the decision on screen changed, never under his eyes on a reload.
  if (current !== shown) {
    shown = current;
    document
      .getElementById(`d-${current}`)
      ?.scrollIntoView({ behavior: "instant" });
  }
}

async function load() {
  const r = await fetch("/me/decisions.json");
  if (r.status === 401) {
    return location.assign("/me");
  }
  const text = await r.text();
  // Nothing new: leave the page (and his focus) alone.
  if (text === load.last) {
    return;
  }
  load.last = text;
  all = JSON.parse(text);
  if (!document.activeElement?.matches("textarea")) {
    render();
  }
}

if (globalThis.document) {
  setTheme(readTheme());
  const bar = document.getElementById("bar");
  const sheet = (open) => {
    document.body.classList.toggle("sheet", open);
    bar.setAttribute("aria-expanded", String(open));
  };
  bar.onclick = () => sheet(!document.body.classList.contains("sheet"));
  document.onkeydown = (e) => keyDown(e, sheet);
  // The decision on screen is the current one: its row in the overview, the bar's dark segment.
  const seen = new IntersectionObserver(
    (entries) => {
      const centre = entries.find((e) => e.isIntersecting);
      if (centre && centre.target.id.slice(2) !== current) {
        current = centre.target.id.slice(2);
        shown = current;
        setHash(current);
        renderList();
      }
    },
    // The decision across the screen's middle line is the one on screen, however tall.
    { root: document.getElementById("main"), rootMargin: "-45% 0px -45% 0px" }
  );
  new MutationObserver(() => {
    for (const s of document.querySelectorAll("#cards section[id]")) {
      seen.observe(s);
    }
  }).observe(document.getElementById("cards"), { childList: true });
  load();
  setInterval(load, 20_000);
}
