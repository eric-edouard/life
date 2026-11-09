(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get("token");
  // Keep the token only in this page's memory, never in history or browser storage.
  history.replaceState(null, "", location.pathname);
  const el = (id) => document.getElementById(id);
  const status = (message) => {
    el("status").textContent = message;
  };
  let data;
  let selected;
  let audioUrl;
  let playback = 0;
  let saving = false;
  let refresh;
  let isSeveral = false;
  const isSplit = (card) => card.scope === "turns";
  const hiddenPeople = new Set();
  const nameOf = (id) =>
    data.people.find((p) => p.id === id)?.name ?? "Unnamed voice";
  const modelOf = () => data.models.find((m) => m.model === el("model").value);
  const pointOf = (id) =>
    modelOf()?.points.find((p) => p.id === id && p.kind === "unnamed");
  const button = (text, action) => {
    const node = document.createElement("button");
    node.type = "button";
    node.textContent = text;
    node.addEventListener("click", () =>
      Promise.resolve(action()).catch((e) => status(e.message))
    );
    return node;
  };
  async function request(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      throw new Error(
        response.status === 401 || response.status === 403
          ? "This link cannot open the voice map. Run bun run voices for a new link."
          : `Could not load or save (${response.status}). Try again.`
      );
    }
    return response;
  }
  function stopAudio() {
    playback += 1;
    el("player").pause();
    el("player").hidden = true;
    el("player").removeAttribute("src");
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      audioUrl = null;
    }
  }
  async function play(clip) {
    stopAudio();
    const current = playback;
    if (!clip.audio) {
      status("This older clip is available only in the phone's recording.");
      return;
    }
    status("Loading clip…");
    const response = await request(`/transcripts/${clip.audio.jobId}/audio`);
    const blob = await response.blob();
    if (current !== playback) {
      return;
    }
    audioUrl = URL.createObjectURL(blob);
    const player = el("player");
    player.src = audioUrl;
    player.hidden = false;
    player.onloadedmetadata = () => {
      player.currentTime = clip.audio.start;
      player.play().catch((e) => status(e.message));
    };
    player.ontimeupdate = () => {
      if (player.currentTime >= clip.audio.end) {
        player.pause();
      }
    };
    status("");
  }
  function show(card, autoplay = true) {
    if (saving) {
      return;
    }
    stopAudio();
    selected = card;
    isSeveral = false;
    el("several-people").replaceChildren();
    el("several-people").hidden = true;
    el("done").hidden = true;
    el("name-form").hidden = false;
    el("several").hidden = isSplit(card);
    el("detail").hidden = false;
    el("title").textContent = card.name || "Who's this?";
    el("context").textContent =
      `${card.words.toLocaleString()} words across ${card.conversations} conversations`;
    showClips(card);
    showRankings(card);
    el("name").value = "";
    if (autoplay) {
      const clip = card.clips.find((c) => c.audio);
      if (clip) {
        play(clip).catch((e) => status(e.message));
      }
    }
  }
  function showRankings(card) {
    el("answers").replaceChildren(
      ...(pointOf(card.id)?.ranking ?? []).map((r) =>
        button(
          `${nameOf(r.personId)} · likeness ${r.score.toFixed(3)} · margin ${r.margin.toFixed(3)}`,
          () => answer({ kind: "assign", personId: r.personId })
        )
      )
    );
  }
  function showClips(card) {
    el("clips").replaceChildren(
      ...card.clips.map((clip) => {
        const node = document.createElement("div");
        node.className = "clip";
        const quote = document.createElement("blockquote");
        quote.textContent = clip.text;
        const listen = button(
          clip.audio ? "Play clip" : "Only on the phone",
          () => play(clip)
        );
        listen.disabled = !clip.audio;
        node.append(quote, listen);
        if (isSeveral) {
          node.append(clipNames(clip));
        }
        return node;
      })
    );
  }
  function personSelect(personId) {
    const select = document.createElement("select");
    select.setAttribute("aria-label", "Who is speaking in this clip?");
    for (const person of [{ id: "", name: "Unknown" }, ...data.people]) {
      const option = document.createElement("option");
      option.value = person.id;
      option.textContent = person.name;
      select.append(option);
    }
    select.value = personId || "";
    return select;
  }
  function clipNames(clip) {
    const form = document.createElement("form");
    const select = personSelect(clip.personId);
    const name = document.createElement("input");
    name.placeholder = "Or type a new name";
    name.setAttribute("aria-label", "New name for this clip");
    name.maxLength = 200;
    const save = button("Save clip", async () => {
      if (saving || !clip.speakerLabel) {
        return;
      }
      saving = true;
      save.disabled = true;
      try {
        const text = name.value.trim();
        const value = text
          ? { kind: "confirm", name: text }
          : { kind: "assign", personId: select.value };
        const target = targetOf(value, crypto.randomUUID());
        await nameTurn(clip, target);
        clip.personId = target.personId || target.id || null;
        if (target.kind === "new") {
          data.people.push({ id: target.id, name: target.name });
        }
        showClips(selected);
        showPeople();
        status("Clip saved. Name the other clips, then choose Done.");
      } finally {
        saving = false;
        save.disabled = false;
      }
    });
    form.onsubmit = (event) => event.preventDefault();
    form.append(select, name, save);
    return form;
  }
  function readSeveralPeople() {
    const required = new Set([
      ...data.people.filter((p) => p.isOwner).map((p) => p.id),
      ...selected.clips.map((clip) => clip.personId || "unknown"),
    ]);
    const chosen = new Set([
      ...required,
      ...[...el("several-people").querySelectorAll("input:checked")]
        .filter((input) => !input.disabled)
        .map((input) => input.value),
    ]);
    return { chosen, required };
  }
  function showPeople() {
    const { chosen, required } = readSeveralPeople();
    el("several-people").replaceChildren(
      ...[...data.people, { id: "unknown", name: "Someone unknown too" }].map(
        (person) => {
          const label = document.createElement("label");
          const input = document.createElement("input");
          input.type = "checkbox";
          input.value = person.id;
          input.checked = chosen.has(person.id);
          input.disabled = required.has(person.id);
          label.append(input, document.createTextNode(person.name));
          return label;
        }
      )
    );
  }
  const nameTurn = (clip, target) =>
    request(
      `/transcripts/${clip.jobId}/speakers/${encodeURIComponent(clip.speakerLabel)}`,
      {
        body: JSON.stringify({ target, turnIndex: clip.turnIndex }),
        method: "PUT",
      }
    );
  function targetOf(value, id) {
    if (value.kind === "confirm") {
      const existing = data.people.find(
        (p) => p.name.toLowerCase() === value.name.toLowerCase()
      );
      return existing
        ? { kind: "person", personId: existing.id }
        : { id, kind: "new", name: value.name };
    }
    if (value.kind === "assign" && value.personId) {
      return { kind: "person", personId: value.personId };
    }
    return { kind: value.kind === "media" ? "media" : "unknown" };
  }
  async function answer(value) {
    if (saving || !selected) {
      return;
    }
    saving = true;
    const card = selected;
    const controls = [
      ...el("detail").querySelectorAll("button, input, select"),
    ];
    for (const control of controls) {
      control.disabled = true;
    }
    status("Saving…");
    try {
      if (isSplit(card)) {
        const target = targetOf(value, crypto.randomUUID());
        for (const clip of card.clips) {
          // biome-ignore lint/performance/noAwaitInLoops: the first PUT creates a new person before the rest name them
          await nameTurn(clip, target);
        }
      } else {
        await request("/naming-queue/answer", {
          body: JSON.stringify({
            answer: value,
            voices: card.voices.map(({ jobId, speakerLabel }) => ({
              jobId,
              speakerLabel,
            })),
          }),
          method: "POST",
        });
      }
      selected = null;
      stopAudio();
      el("detail").hidden = true;
      await load();
      status("Voice named. Choose another voice.");
    } finally {
      saving = false;
      for (const control of controls) {
        control.disabled = false;
      }
    }
  }
  const colors = [
    "#e2626a",
    "#78b3cf",
    "#b9a0db",
    "#d0b478",
    "#83bba3",
    "#d69b7d",
  ];
  async function draw() {
    const model = modelOf();
    const points = model?.points ?? [];
    const people = [...new Set(points.map((p) => p.personId))];
    const traces = people.map((personId) => {
      const same = points.filter((p) => p.personId === personId);
      return {
        customdata: same.map((p) => p.personId ?? p.id),
        hoverinfo: "text",
        marker: {
          color: personId
            ? colors[
                data.people.findIndex((p) => p.id === personId) % colors.length
              ]
            : "#8a837d",
          opacity: 0.8,
          size: same.map((p) => {
            if (personId) {
              return p.kind === "centroid" ? 9 : 3;
            }
            return 5 + Math.min(22, Math.sqrt(p.words) / 8);
          }),
          symbol: same.map((p) =>
            p.basis === "recognized" ? "circle-open" : "circle"
          ),
        },
        mode: "markers",
        name: personId ? nameOf(personId) : "Unnamed",
        text: same.map((p) =>
          personId ? nameOf(personId) : `${p.words.toLocaleString()} words`
        ),
        type: "scatter3d",
        visible: !hiddenPeople.has(personId),
        x: same.map((p) => p.position[0]),
        y: same.map((p) => p.position[1]),
        z: same.map((p) => p.position[2]),
      };
    });
    el("visibility").replaceChildren(
      ...traces.map((trace, i) => {
        const personId = people[i];
        const label = document.createElement("label");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = trace.visible;
        checkbox.onchange = () => {
          if (checkbox.checked) {
            hiddenPeople.delete(personId);
          } else {
            hiddenPeople.add(personId);
          }
          window.Plotly.restyle(el("plot"), { visible: checkbox.checked }, [
            i,
          ]).catch((e) => status(e.message));
        };
        const swatch = document.createElement("span");
        swatch.className = "swatch";
        swatch.style.backgroundColor = trace.marker.color;
        swatch.setAttribute("aria-hidden", "true");
        label.append(checkbox, swatch, document.createTextNode(trace.name));
        return label;
      })
    );
    await window.Plotly.react(
      el("plot"),
      traces,
      {
        font: { color: "#cfc8c0" },
        margin: { b: 0, l: 0, r: 0, t: 0 },
        paper_bgcolor: "#0b0a0a",
        scene: {
          bgcolor: "#0b0a0a",
          xaxis: { visible: false },
          yaxis: { visible: false },
          zaxis: { visible: false },
        },
        showlegend: false,
        uirevision: model?.model,
      },
      {
        displayModeBar: false,
        responsive: true,
        showLink: false,
        showSendToCloud: false,
      }
    );
    el("plot").removeAllListeners("plotly_click");
    el("plot").on("plotly_click", (event) => {
      const id = event.points[0]?.customdata;
      const card = data.cards.find((c) => c.id === id);
      if (card) {
        show(card);
      } else {
        status(`${nameOf(id)} — this voice is already named.`);
      }
    });
    const listed = (cards) =>
      cards.map((card) =>
        button(
          `${card.name || "Unnamed voice"} · ${card.words.toLocaleString()} words`,
          () => show(card)
        )
      );
    // The queue's order is authoritative. Only filter by its best shared likeness in this model.
    const easy = data.cards.filter(
      (c) => (pointOf(c.id)?.ranking[0]?.score ?? -1) > data.candidateThreshold
    );
    el("easy").replaceChildren(...listed(easy));
    if (!easy.length) {
      el("easy").textContent = "No easy targets in this voice model.";
    }
    el("all").replaceChildren(...listed(data.cards));
    if (!data.cards.length) {
      el("all").textContent = "All caught up.";
    }
    if (selected && !isSeveral) {
      const card = data.cards.find((c) => c.id === selected.id);
      if (card) {
        showRankings(card);
      } else {
        selected = null;
        el("detail").hidden = true;
        stopAudio();
      }
    }
  }
  async function load() {
    clearTimeout(refresh);
    const response = await request("/speakers/map");
    const next = await response.json();
    if (next.building) {
      refresh = setTimeout(() => load().catch((e) => status(e.message)), 500);
    }
    if (response.status === 202) {
      status("Building the voice map…");
      return;
    }
    data = next;
    const previous = el("model").value;
    el("model").replaceChildren(
      ...data.models.map((m) => {
        const option = document.createElement("option");
        option.value = m.model;
        option.textContent = m.model;
        return option;
      })
    );
    if (data.models.some((m) => m.model === previous)) {
      el("model").value = previous;
    }
    await draw();
    status(
      data.models.length
        ? ""
        : "No voice samples yet. Voices can still be named from the list."
    );
  }
  for (const id of ["show-all", "show-none"]) {
    el(id).onclick = () => {
      for (const checkbox of el("visibility").querySelectorAll("input")) {
        checkbox.checked = id === "show-all";
        checkbox.onchange();
      }
    };
  }
  el("refresh").onclick = () => load().catch((e) => status(e.message));
  el("model").onchange = () => draw().catch((e) => status(e.message));
  el("name-form").onsubmit = (event) => {
    event.preventDefault();
    const name = el("name").value.trim();
    if (name) {
      answer({ kind: "confirm", name }).catch((e) => status(e.message));
    }
  };
  el("ignore").onclick = () =>
    answer({ kind: "ignore" }).catch((e) => status(e.message));
  el("media").onclick = () =>
    answer({ kind: "media" }).catch((e) => status(e.message));
  el("several").onclick = () => {
    isSeveral = true;
    showClips(selected);
    showPeople();
    el("several-people").hidden = false;
    el("done").hidden = false;
    el("name-form").hidden = true;
    el("answers").replaceChildren();
    status(
      "Name each clip, then choose everyone heard in this voice and Done."
    );
  };
  el("done").onclick = () => {
    const { chosen } = readSeveralPeople();
    answer({
      kind: "several",
      people: [...chosen].filter((id) => id !== "unknown"),
      unknown: chosen.has("unknown"),
    }).catch((e) => status(e.message));
  };
  window.addEventListener("pagehide", () => {
    clearTimeout(refresh);
    stopAudio();
  });
  if (token) {
    load().catch((e) => status(e.message));
  } else {
    status("Open this page with bun run voices on your Mac.");
  }
})();
