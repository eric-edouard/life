// The voice bench's page: the report as a cloud to turn and listen to, the models side by side,
// and the review, whose answers go to the bench's own file (POST /answers).
(() => {
  const NAMES = {
    campplus: "CAM++",
    ecapa: "ECAPA",
    "mect-b2": "MECT-B2",
    "mect-b2-causal": "MECT-B2 Causal",
    "redimnet2-b6": "ReDimNet2-B6",
    "redimnet2-b6-cn": "ReDimNet2-B6 with Chinese",
    "redimnet2-plus": "ReDimNet2+",
    resnet293: "ResNet293",
  };
  // What lifelog runs today.
  const BASELINE = "ecapa";
  const UNKNOWN = { color: "#6b645e", id: "unknown", name: "Nobody I know" };
  const UNANSWERED = {
    color: "#3f3b38",
    id: "unanswered",
    name: "Not answered yet",
  };

  const el = (id) => document.getElementById(id);
  const node = (tag, props, ...children) => {
    const made = Object.assign(document.createElement(tag), props);
    made.append(...children);
    return made;
  };
  const percent = (x) => `${(x * 100).toFixed(1)}%`;
  // The model whose first guess is right most often: the one to look at first.
  const surestOf = () =>
    report.models.toSorted((a, b) => b.firstRight - a.firstRight)[0];
  const heardBy = (m) => Object.keys(m.turns).length;
  // A summary at one of the report's budgets of wrong names: the first is his rule.
  const at = (summary, budget = 0) =>
    summary.points[budget] ?? { budget: 0, namedRight: 0 };
  const status = (text) => {
    el("status").textContent = text;
  };

  let report;
  let model;
  // Who a turn belongs to in the cloud, per group id.
  let groups = [];
  let selected = null;
  let everyBlend = false;
  const hidden = new Set([UNANSWERED.id]);
  // The turns he answered in the bench, the latest last (the bench's answers file, then this
  // visit's): their cards are out of the queue. Back takes the latest card out of it again.
  const answered = new Set();

  const labelOf = (key) => {
    const name = report.models.find((m) => m.key === key)?.model ?? key;
    return NAMES[name] ?? name;
  };
  const nameOf = (id) =>
    report.people.find((p) => p.id === id)?.name ?? "Someone";
  const groupOf = (turn) => {
    if (!turn.truth) {
      return UNANSWERED.id;
    }
    if (turn.truth.kind === "person") {
      return turn.truth.personId;
    }
    return turn.truth.kind === "unknown" ? UNKNOWN.id : null;
  };
  const saidOf = (turn) => {
    if (!turn.truth) {
      return "Not answered yet";
    }
    if (turn.truth.kind === "person") {
      return `You said ${nameOf(turn.truth.personId)}`;
    }
    return turn.truth.kind === "unknown"
      ? "You said nobody you know"
      : "Left out of the scoring";
  };
  const factsOf = (turn) =>
    [
      `${turn.durationSeconds.toFixed(1)} s`,
      turn.language,
      turn.day,
      `${turn.speakersInJob} ${turn.speakersInJob === 1 ? "voice" : "voices"} in the recording`,
    ].join(", ");

  // A share as a bar and its number.
  const bar = (share) =>
    node(
      "div",
      { className: "bar" },
      node("div", {}, node("div", { style: `width:${share * 100}%` })),
      node("span", {}, percent(share))
    );
  const cell = (text, className = "num") => node("td", { className }, text);

  function play(player, id) {
    player.src = `/clips/${id}.wav`;
    // A browser may refuse sound before the first click; the player's own button still works.
    player.play().catch(() => undefined);
  }

  // The cloud ------------------------------------------------------------------------------

  // Where he named the turn: is the model's first guess that person?
  function symbolOf(turn, heard) {
    if (turn.truth?.kind !== "person") {
      return "circle-open";
    }
    return turn.truth.personId === heard.best ? "circle" : "x";
  }

  async function drawCloud() {
    const points = report.turns.flatMap((turn) => {
      const heard = model.turns[turn.id];
      const group = groupOf(turn);
      return heard && group
        ? [{ group, heard, position: heard.position, turn }]
        : [];
    });
    const traces = groups.map((group) => {
      const own = points.filter((p) => p.group === group.id);
      return {
        customdata: own.map((p) => p.turn.id),
        hoverinfo: "text",
        marker: {
          color: group.color,
          line: { color: group.color, width: 1 },
          opacity: 0.85,
          size: 3.5,
          symbol: own.map((p) => symbolOf(p.turn, p.heard)),
        },
        mode: "markers",
        name: group.name,
        text: own.map(
          (p) => `${group.name}, ${p.turn.durationSeconds.toFixed(1)} s`
        ),
        type: "scatter3d",
        visible: !hidden.has(group.id),
        x: own.map((p) => p.position[0]),
        y: own.map((p) => p.position[1]),
        z: own.map((p) => p.position[2]),
      };
    });
    const picked = points.find((p) => p.turn.id === selected);
    if (picked) {
      traces.push({
        hoverinfo: "skip",
        marker: {
          color: "#ece7e1",
          line: { color: "#ece7e1", width: 2 },
          size: 14,
          symbol: "circle-open",
        },
        mode: "markers",
        type: "scatter3d",
        x: [picked.position[0]],
        y: [picked.position[1]],
        z: [picked.position[2]],
      });
    }
    await window.voiceCloud.draw(el("plot"), traces, points, "cloud");
    el("plot").removeAllListeners("plotly_click");
    el("plot").on("plotly_click", (event) => {
      const id = event.points[0]?.customdata;
      if (id) {
        listen(id);
      }
    });
  }

  function drawPeople() {
    const shown = (id, isShown) => {
      if (isShown) {
        hidden.delete(id);
      } else {
        hidden.add(id);
      }
    };
    el("people").replaceChildren(
      ...groups.map((group) => {
        const checkbox = node("input", {
          checked: !hidden.has(group.id),
          type: "checkbox",
        });
        checkbox.onchange = () => {
          shown(group.id, checkbox.checked);
          drawCloud();
        };
        return node(
          "label",
          {},
          checkbox,
          node("span", {
            ariaHidden: "true",
            className: "swatch",
            style: `background:${group.color}`,
          }),
          group.name,
          node("span", {}, group.count.toLocaleString())
        );
      })
    );
    for (const [id, isShown] of [
      ["show-all", true],
      ["show-none", false],
    ]) {
      el(id).onclick = () => {
        for (const group of groups) {
          shown(group.id, isShown);
        }
        drawPeople();
        drawCloud();
      };
    }
  }

  function listen(id) {
    const turn = report.turns.find((t) => t.id === id);
    selected = id;
    el("listen-empty").hidden = true;
    el("listen-body").hidden = false;
    el("listen-truth").textContent = saidOf(turn);
    el("listen-text").textContent = turn.text;
    el("listen-facts").textContent = factsOf(turn);
    el("listen-models").replaceChildren(
      ...report.models.map((m) => {
        const heard = m.turns[id];
        return node(
          "tr",
          { className: heard?.isNamed ? "" : "muted" },
          cell(labelOf(m.key), ""),
          cell(
            heard?.best
              ? `${nameOf(heard.best)}${heard.isNamed ? "" : ", not sure"}`
              : "Nobody",
            ""
          ),
          cell(heard ? heard.score.toFixed(2) : ""),
          cell(heard ? heard.margin.toFixed(2) : "")
        );
      })
    );
    play(el("player"), id);
    drawCloud();
  }

  // The models -----------------------------------------------------------------------------

  function drawModels() {
    el("models").replaceChildren(
      ...report.models.map((m) => {
        const tab = node(
          "button",
          { ariaPressed: String(m === model), type: "button" },
          labelOf(m.key),
          node("small", {}, percent(at(m).namedRight))
        );
        tab.onclick = () => pick(m);
        return tab;
      })
    );
    el("board-models").replaceChildren(
      ...report.models.map((m) => {
        const name = node("button", { type: "button" }, labelOf(m.key));
        name.onclick = () => pick(m);
        return node(
          "tr",
          { className: m === model ? "picked" : "" },
          node(
            "td",
            {},
            name,
            m.model === BASELINE
              ? node("span", { className: "note" }, "what lifelog runs today")
              : "",
            heardBy(m) < report.counts.turns
              ? node(
                  "span",
                  { className: "note" },
                  `quick look, ${heardBy(m).toLocaleString()} turns`
                )
              : ""
          ),
          node("td", {}, bar(at(m).namedRight)),
          cell(percent(at(m, 1).namedRight)),
          cell(percent(at(m, 2).namedRight)),
          cell(percent(m.firstRight)),
          cell(percent(at(m.voices).namedRight)),
          cell(percent(m.macro)),
          cell(percent(m.equalError)),
          cell(m.secondsPerClip.toFixed(2))
        );
      })
    );
    const blends = everyBlend ? report.blends : report.blends.slice(0, 8);
    el("board-blends").replaceChildren(
      ...blends.map((b) =>
        node(
          "tr",
          {},
          cell(b.models.map(labelOf).join(" + "), ""),
          node("td", {}, bar(at(b).namedRight)),
          cell(percent(at(b, 1).namedRight)),
          cell(percent(at(b, 2).namedRight)),
          cell(percent(b.firstRight)),
          cell(""),
          cell(""),
          cell(percent(b.equalError)),
          cell("")
        )
      )
    );
    el("more-blends").hidden = everyBlend || report.blends.length <= 8;
    el("more-blends").onclick = () => {
      everyBlend = true;
      drawModels();
    };
  }

  function drawCurves() {
    const axis = {
      color: "#a9a29b",
      gridcolor: "rgba(236,231,225,.08)",
      ticksuffix: "%",
      zeroline: false,
    };
    window.Plotly.react(
      el("curve-plot"),
      report.models.map((m, i) => ({
        hovertemplate: `${labelOf(m.key)}: %{y:.1f}% right at %{x:.1f}% wrong<extra></extra>`,
        line: {
          color: window.voiceCloud.colorOf(i),
          dash: m.model === BASELINE ? "dot" : "solid",
          width: m === model ? 3.5 : 1.5,
        },
        mode: "lines",
        name: labelOf(m.key),
        x: m.curve.map(([wrong]) => wrong * 100),
        y: m.curve.map(([, right]) => right * 100),
      })),
      {
        font: { color: "#cfc8c0" },
        legend: { orientation: "h", y: -0.2 },
        margin: { b: 50, l: 60, r: 10, t: 10 },
        paper_bgcolor: "#0b0a0a",
        plot_bgcolor: "#0b0a0a",
        shapes: [
          {
            line: { color: "#e2626a", dash: "dash", width: 1 },
            type: "line",
            x0: at(model).budget * 100,
            x1: at(model).budget * 100,
            y0: 0,
            y1: 1,
            yref: "paper",
          },
        ],
        xaxis: {
          ...axis,
          range: [0, 10],
          title: { text: "Wrong names, of the names given" },
        },
        yaxis: {
          ...axis,
          rangemode: "tozero",
          title: { text: "Known voices named right" },
        },
      },
      { displayModeBar: false, responsive: true }
    );
  }

  function drawWeak() {
    el("weak-model").textContent = labelOf(model.key);
    const splits = (id, rows, label = (group) => group) => {
      el(id).replaceChildren(
        ...rows.map((row) =>
          node(
            "div",
            { className: "split" },
            label(row.group),
            bar(row.firstRight),
            node("small", {}, row.known.toLocaleString())
          )
        )
      );
    };
    splits("by-length", model.byLength);
    splits("by-language", model.byLanguage);
    splits("by-evidence", model.byEvidence);
    splits("by-person", model.byPerson, nameOf);
  }

  function drawPairs() {
    const keys = report.models.map((m) => m.key);
    const pairOf = (a, b) =>
      report.blends.find(
        (blend) =>
          blend.models.length === 2 &&
          blend.models.includes(a) &&
          blend.models.includes(b)
      );
    const shareOf = (a, b) =>
      (a === b ? report.models.find((m) => m.key === a) : pairOf(a, b))
        .firstRight;
    const all = keys.flatMap((a) => keys.map((b) => shareOf(a, b)));
    const low = Math.min(...all);
    const spread = Math.max(...all) - low || 1;
    el("pairs-table").replaceChildren(
      node(
        "thead",
        {},
        node(
          "tr",
          {},
          node("th", {}, ""),
          ...keys.map((key) => node("th", {}, labelOf(key)))
        )
      ),
      node(
        "tbody",
        {},
        ...keys.map((a) =>
          node(
            "tr",
            {},
            node("th", {}, labelOf(a)),
            ...keys.map((b) => {
              const share = shareOf(a, b);
              const agreeing = a === b ? undefined : pairOf(a, b)?.agreeing;
              return node(
                "td",
                {
                  style: `background:rgb(155 27 36 / ${Math.round(((share - low) / spread) * 85)}%)`,
                },
                percent(share),
                agreeing === undefined
                  ? ""
                  : node("small", {}, `agree ${percent(agreeing)}`)
              );
            })
          )
        )
      )
    );
    const triple = report.blends.find((b) => b.models.length === 3);
    el("triple").textContent = triple
      ? `The best three together, ${triple.models.map(labelOf).join(", ")}: ${percent(triple.firstRight)}.`
      : "";
  }

  function pick(next) {
    model = next;
    drawModels();
    drawCurves();
    drawWeak();
    drawCloud();
  }

  // The review -----------------------------------------------------------------------------

  // A card is answered when its first turn is: one answer goes to all of its turns.
  const queue = () => report.review.filter((c) => !answered.has(c.turns[0]));
  const turnOf = (id) => report.turns.find((t) => t.id === id);
  // Which of the card's clips is playing.
  let clip = 0;

  function whyOf(card) {
    const [closest] = card.candidates;
    const turns =
      card.turns.length === 1 ? "1 turn" : `${card.turns.length} turns`;
    return `${saidOf(turnOf(card.turns[0]))}. Most models hear ${nameOf(closest.personId)} on ${turns} of this voice.`;
  }

  async function answer(kind, personId) {
    const [card] = queue();
    if (!card) {
      return;
    }
    // Each turn's answer is one line; the card stays in the queue unless all are kept.
    const responses = await Promise.all(
      card.turns.map((id) =>
        fetch("/answers", {
          body: JSON.stringify({ id, kind, personId }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        }).catch(() => ({ ok: false, status: "the bench did not answer" }))
      )
    );
    const failed = responses.find((response) => !response.ok);
    if (failed) {
      status(`The answer was not kept (${failed.status}).`);
      return;
    }
    for (const id of card.turns) {
      answered.delete(id);
      answered.add(id);
    }
    status("Kept. Score again to count your answers.");
    clip = 0;
    drawReview(true);
  }

  // The card he answered last comes back, to answer again: the latest answer of a turn counts.
  // Only cards of this scoring: a card answered before the last score is no longer in the report.
  function back() {
    const order = [...answered];
    const [card] = report.review
      .filter((c) => answered.has(c.turns[0]))
      .sort((a, b) => order.indexOf(b.turns[0]) - order.indexOf(a.turns[0]));
    if (!card) {
      status("Nothing to go back to since the last scoring.");
      return;
    }
    for (const id of card.turns) {
      answered.delete(id);
    }
    status("Back on the voice before. Answer it again to change it.");
    clip = 0;
    drawReview(true);
  }

  function drawClip(card, isPlaying) {
    const id = card.clips[clip % card.clips.length];
    const turn = turnOf(id);
    el("review-text").textContent = turn.text;
    el("review-facts").textContent =
      `${factsOf(turn)}, clip ${(clip % card.clips.length) + 1} of ${card.clips.length}`;
    if (isPlaying) {
      play(el("review-player"), id);
    } else {
      el("review-player").src = `/clips/${id}.wav`;
    }
  }

  function drawReview(isPlaying) {
    const left = queue();
    const [card] = left;
    el("review-count").textContent = left.length || "";
    el("review-card").hidden = !card;
    el("review-done").hidden = !!card;
    if (!card) {
      return;
    }
    const said = turnOf(card.turns[0]).truth;
    el("review-why").textContent = whyOf(card);
    el("review-left").textContent =
      `${left.length} voices to go, ${left.reduce((sum, c) => sum + c.turns.length, 0)} turns.`;
    el("review-names").replaceChildren(
      ...card.candidates.map(({ personId, share }, i) => {
        const button = node(
          "button",
          { type: "button" },
          node("kbd", {}, String(i + 1)),
          ` ${nameOf(personId)} `,
          node("small", { className: "share" }, percent(share)),
          said?.personId === personId ? " (your answer)" : ""
        );
        button.onclick = () => answer("person", personId);
        return button;
      })
    );
    el("review-other").value = "";
    drawClip(card, isPlaying);
  }

  function wireReview() {
    for (const button of document.querySelectorAll("#review [data-kind]")) {
      button.onclick = () => answer(button.dataset.kind);
    }
    el("review-back").onclick = back;
    el("review-other").onchange = () => {
      if (el("review-other").value) {
        answer("person", el("review-other").value);
      }
    };
    const KEYS = {
      b: back,
      m: () => answer("media"),
      n: () => answer("unknown"),
      s: () => answer("skipped"),
      v: () => answer("several"),
    };
    document.addEventListener("keydown", (event) => {
      const box = el("review-card").getBoundingClientRect();
      const isInView = box.bottom > 0 && box.top < window.innerHeight;
      const [item] = queue();
      if (
        !(isInView && item) ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        ["SELECT", "INPUT", "BUTTON"].includes(event.target.tagName)
      ) {
        return;
      }
      const key = event.key.toLowerCase();
      const person = item.candidates[Number(key) - 1]?.personId;
      if (key === " " || key === "arrowright") {
        event.preventDefault();
        clip += key === " " ? 0 : 1;
        drawClip(item, true);
      } else if (KEYS[key]) {
        KEYS[key]();
      } else if (person) {
        answer("person", person);
      }
    });
    el("rescore").onclick = async () => {
      el("rescore").disabled = true;
      status("Scoring…");
      try {
        const response = await fetch("/score", { method: "POST" });
        if (!response.ok) {
          throw new Error(`scoring failed (${response.status})`);
        }
        await load();
        status("Scored with your answers.");
      } catch (error) {
        status(error.message);
      } finally {
        el("rescore").disabled = false;
      }
    };
  }

  // ----------------------------------------------------------------------------------------

  function drawTop() {
    const [best] = report.models;
    const baseline = report.models.find((m) => m.model === BASELINE);
    const [blend] = report.blends;
    const surest = surestOf();
    const parts =
      at(best).namedRight < 0.1
        ? [
            "No model names your voices at 1 wrong name in 100 yet.",
            `${labelOf(surest.key)} has the right person first ${percent(surest.firstRight)} of the time` +
              (baseline && baseline !== surest
                ? `, ${labelOf(baseline.key)} today ${percent(baseline.firstRight)}.`
                : "."),
          ]
        : [
            `${labelOf(best.key)} names ${percent(at(best).namedRight)} of your known voices, wrong on at most 1 name in 100.`,
            baseline && baseline !== best
              ? `${labelOf(baseline.key)}, what lifelog runs today, names ${percent(at(baseline).namedRight)}.`
              : "",
            blend && at(blend).namedRight > at(best).namedRight
              ? `${blend.models.map(labelOf).join(" with ")} together: ${percent(at(blend).namedRight)}.`
              : "",
          ];
    el("verdict").textContent = parts.join(" ");
    const { answered: all, excluded, known, turns, unknown } = report.counts;
    el("counts").textContent =
      `${turns.toLocaleString()} turns from your recordings: ${known.toLocaleString()} you named, ` +
      `${unknown.toLocaleString()} you said are nobody you know, ${excluded.toLocaleString()} left out, ` +
      `${(turns - all).toLocaleString()} not answered yet.`;
  }

  async function load() {
    const response = await fetch("/report.json");
    if (!response.ok) {
      el("verdict").textContent =
        "No report yet. Run `bun run bench all`, then reload.";
      return;
    }
    report = await response.json();
    // None yet is no file.
    const kept = await fetch("/answers.jsonl");
    const lines = kept.ok ? (await kept.text()).split("\n") : [];
    answered.clear();
    for (const line of lines.filter(Boolean)) {
      const { id } = JSON.parse(line);
      answered.delete(id);
      answered.add(id);
    }
    const counts = Map.groupBy(report.turns, groupOf);
    // People by how many turns he named them for: the most heard get the brand's own colours.
    const named = report.people
      .filter((p) => counts.has(p.id))
      .sort((a, b) => counts.get(b.id).length - counts.get(a.id).length)
      .map((p, i) => ({
        color: window.voiceCloud.colorOf(i),
        id: p.id,
        name: p.name,
      }));
    groups = [...named, UNKNOWN, UNANSWERED]
      .filter((g) => counts.has(g.id))
      .map((g) => ({ ...g, count: counts.get(g.id).length }));
    el("review-other").replaceChildren(
      node("option", { value: "" }, "Choose a person"),
      ...report.people
        .toSorted((a, b) => a.name.localeCompare(b.name))
        .map((p) => node("option", { value: p.id }, p.name))
    );
    model = report.models.find((m) => m.key === model?.key) ?? surestOf();
    drawTop();
    drawPeople();
    drawPairs();
    drawReview(false);
    pick(model);
  }

  wireReview();
  load().catch((error) => {
    el("verdict").textContent = error.message;
  });
})();
