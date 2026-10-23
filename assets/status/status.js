// Life's status page: the status snapshot (apps/server/src/host/status/snapshot.ts), the same one Life.app shows,
// read again every 15 seconds. Cards in trouble first, each with its sentence to paste into a session. His words and
// errors' text arrive with the snapshot (behind the sign-in) and are hidden on screen until "Show content" is on.

const EVERY_MS = 15_000;
const $ = (id) => document.getElementById(id);

const ago = (at) => {
  if (!at) {
    return "never";
  }
  const s = Math.round((Date.now() - Date.parse(at)) / 1000);
  if (s < 60) {
    return `${Math.max(s, 0)} s ago`;
  }
  if (s < 3600) {
    return `${Math.round(s / 60)} min ago`;
  }
  return s < 172_800
    ? `${Math.round(s / 3600)} h ago`
    : `${Math.round(s / 86_400)} d ago`;
};

/** An element with its class and text; text is always set as text, never as markup. */
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) {
    e.className = cls;
  }
  if (text !== undefined) {
    e.textContent = text;
  }
  return e;
}

function cardOf(c, withAsk) {
  const card = el("article", "card");
  card.dataset.tone = c.tone;
  const top = el("div", "top");
  top.append(el("h3", "name", c.name), el("span", "word", c.word));
  top.append(
    el("p", "headline", c.at ? `${c.headline} · ${ago(c.at)}` : c.headline)
  );
  card.append(top);
  if (c.facts.length) {
    const dl = el("dl");
    for (const f of c.facts) {
      // An instant, a value, or both; an instant never recorded (null, or absent where the value is too) is "never".
      const never = f.at === null || !f.value;
      const when = f.at || never ? ago(f.at) : "";
      dl.append(
        el("dt", "", f.label),
        el("dd", "", [f.value, when].filter(Boolean).join(", "))
      );
    }
    card.append(dl);
  }
  for (const line of c.content ?? []) {
    card.append(el("p", "content", line));
  }
  if (withAsk && c.ask) {
    const row = el("div", "ask");
    const copy = el("button", "", "Copy");
    copy.onclick = async () => {
      await navigator.clipboard.writeText(c.ask);
      copy.textContent = "Copied";
    };
    row.append(el("span", "", c.ask), copy);
    card.append(row);
  }
  return card;
}

function verdictOf(s) {
  const n = s.trouble.length;
  if (n === 0) {
    return "Everything is working.";
  }
  return n === 1 ? "One part needs you." : `${n} parts need you.`;
}

function draw(s) {
  $("verdict").textContent = verdictOf(s);
  $("observed").textContent =
    `Read ${ago(s.observedAt)} · ${s.cards.length} parts`;
  const byId = new Map(s.cards.map((c) => [c.id, c]));
  $("trouble").replaceChildren(
    ...s.trouble.map((id) => cardOf(byId.get(id), true))
  );
  $("groups").replaceChildren(
    ...s.groups.flatMap((g) => {
      const cards = s.cards.filter((c) => c.group === g.id);
      if (!cards.length) {
        return [];
      }
      const section = el("section", "group");
      section.append(
        el("h2", "", g.name),
        ...cards.map((c) => cardOf(c, false))
      );
      return [section];
    })
  );
}

async function load() {
  const res = await fetch("./snapshot").catch(() => null);
  if (res?.status === 401) {
    location.reload();
    return;
  }
  if (!res?.ok) {
    $("observed").textContent = "Life did not answer: trying again.";
    return;
  }
  draw(await res.json());
}

const shown = () => {
  try {
    return localStorage.getItem("life-show-content") === "1";
  } catch {
    return false;
  }
};
$("content").checked = shown();
document.body.classList.toggle("show", shown());
$("content").onchange = (e) => {
  document.body.classList.toggle("show", e.target.checked);
  try {
    localStorage.setItem("life-show-content", e.target.checked ? "1" : "0");
  } catch {
    // A browser that keeps nothing: the toggle still works for this visit.
  }
};
load();
setInterval(load, EVERY_MS);
