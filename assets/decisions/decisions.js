// His decisions, read from and answered through /me/decisions.json (Life, memory/decisions.jsonl). One tab per loop;
// the ones not closed first by deadline, closed ones as history. Every write is his step; Life refuses one on a
// decision a loop has already taken, and the page says so.
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
const fr = (d) => d.lang === "fr";
const T = (d, f, e) => (fr(d) ? f : e);
let all = [];
let tab = location.hash.slice(1);

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

function wrong(loop, ref, d) {
  const ta = $("textarea", {
    hidden: "",
    placeholder: T(d, "Ce qui ne va pas…", "What's wrong…"),
    rows: "2",
  });
  const send = $(
    "button",
    {
      class: "more",
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
      class: "more",
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

/** His answer once his note changes: an option he tapped stays; a note alone answers; clearing it reopens. */
function noteAnswer(d, note) {
  const tapped = d.answer && d.answer !== "note" ? d.answer : null;
  if (tapped) {
    return tapped;
  }
  return note ? "note" : null;
}

/** His answer when he taps an option: tapping the one already chosen takes it back (his note, if any, then answers). */
function tapAnswer(d, option, note) {
  if (d.answer !== option) {
    return option;
  }
  return note ? "note" : null;
}

function card(d) {
  // His own request ("Something's wrong"): nothing to answer.
  if (!d.options?.length) {
    return $(
      "p",
      { class: "past" },
      T(d, "Envoyé à l'audit : ", "Sent to the audit: "),
      d.question
    );
  }
  const taken = d.status === "taken";
  const note = $("textarea", {
    disabled: taken ? "" : null,
    placeholder: T(d, "Autre chose…", "Something else…"),
    rows: "1",
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
    "article",
    {},
    $("h2", {}, d.question),
    d.draft ? $("p", { class: "draft" }, d.draft) : null,
    d.status === "open" && d.result ? $("p", { class: "res" }, d.result) : null,
    $(
      "div",
      { class: "opts", role: "radiogroup" },
      (d.options ?? []).map((o) =>
        $(
          "button",
          {
            "aria-checked": String(d.answer === o.id),
            class: "opt",
            disabled: taken ? "" : null,
            onclick: () =>
              step({
                data: {
                  answer: tapAnswer(d, o.id, note.value.trim()),
                  note: note.value.trim(),
                },
                decision: d.id,
                step: "answered",
              }),
            role: "radio",
            type: "button",
          },
          $("span", { class: o.id === d.pick ? "pick" : null }, o.label),
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
      : note,
    d.context
      ? $(
          "button",
          {
            class: "more",
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
    ctx,
    wrong(d.loop, d.id, d)
  );
}

function render() {
  // The loops with the most open decisions first, then by name.
  const open = (l) =>
    all.filter((d) => d.loop === l && d.status === "open").length;
  const loops = [...new Set(all.map((d) => d.loop))].sort(
    (a, b) => open(b) - open(a) || a.localeCompare(b)
  );
  tab = loops.includes(tab) ? tab : loops[0];
  const tabs = document.getElementById("tabs");
  tabs.replaceChildren(
    ...loops.map((l) => {
      const n = open(l);
      return $(
        "button",
        {
          "aria-selected": String(l === tab),
          onclick: () => {
            tab = l;
            location.hash = l;
            render();
          },
          role: "tab",
        },
        l,
        n ? $("span", { class: "n" }, String(n)) : null
      );
    })
  );
  const mine = all.filter((d) => d.loop === tab);
  const live = mine
    .filter((d) => !d.closedAt)
    .sort((a, b) => (a.deadline ?? "9").localeCompare(b.deadline ?? "9"));
  const past = mine
    .filter((d) => d.closedAt)
    .sort((a, b) => (b.closedAt ?? "").localeCompare(a.closedAt ?? ""));
  const grants = mine.filter((d) => d.active);
  const first = mine[0] ?? {};
  document.getElementById("main").replaceChildren(
    ...grants.map((g) =>
      $(
        "p",
        { class: "past" },
        g.scope,
        " · ",
        $(
          "button",
          {
            class: "more",
            onclick: () => step({ decision: g.id, step: "revoked" }),
            type: "button",
          },
          T(g, "Retirer", "Revoke")
        )
      )
    ),
    ...live.map(card),
    live.some((d) => d.status === "open")
      ? null
      : $(
          "p",
          { class: "quiet" },
          T(first, "Rien à décider.", "Nothing to decide.")
        ),
    ...past.map((d) =>
      $(
        "p",
        { class: "past" },
        d.question,
        " · ",
        $(
          "b",
          {},
          d.status === "done"
            ? ((d.options ?? []).find((o) => o.id === d.answer)?.label ??
                d.note ??
                "")
            : d.status
        ),
        d.result ? ` · ${d.result}` : ""
      )
    ),
    tab ? wrong(tab, tab, first) : null
  );
}

async function load() {
  const r = await fetch("/me/decisions.json");
  if (r.status === 401) {
    return location.assign("/me");
  }
  all = await r.json();
  if (!document.activeElement?.matches("textarea")) {
    render();
  }
}

load();
setInterval(load, 20_000);
