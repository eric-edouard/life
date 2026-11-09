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
  const nameOf = (id) =>
    data.people.find((p) => p.id === id)?.name ?? "Unnamed voice";
  const modelOf = () => data.models.find((m) => m.model === el("model").value);
  const pointOf = (id) =>
    modelOf()?.points.find((p) => p.id === id && !p.personId);
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
    stopAudio();
    selected = card;
    el("detail").hidden = false;
    el("title").textContent = card.name || "Who's this?";
    el("context").textContent =
      `${card.words.toLocaleString()} words across ${card.conversations} conversations`;
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
        return node;
      })
    );
    el("answers").replaceChildren(
      ...(pointOf(card.id)?.ranking ?? []).map((r) =>
        button(
          `${nameOf(r.personId)} · likeness ${r.score.toFixed(3)} · margin ${r.margin.toFixed(3)}`,
          () => answer({ kind: "assign", personId: r.personId })
        )
      )
    );
    el("name").value = "";
    if (autoplay) {
      const clip = card.clips.find((c) => c.audio);
      if (clip) {
        play(clip).catch((e) => status(e.message));
      }
    }
  }
  async function answer(value) {
    if (saving || !selected) {
      return;
    }
    saving = true;
    const card = selected;
    const controls = [...el("detail").querySelectorAll("button, input")];
    for (const control of controls) {
      control.disabled = true;
    }
    status("Saving…");
    try {
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
    const traces = [...new Set(points.map((p) => p.personId))].map(
      (personId) => {
        const same = points.filter((p) => p.personId === personId);
        return {
          customdata: same.map((p) => p.id),
          hoverinfo: "text",
          marker: {
            color: personId
              ? colors[
                  data.people.findIndex((p) => p.id === personId) %
                    colors.length
                ]
              : "#8a837d",
            opacity: 0.9,
            size: same.map((p) =>
              personId ? 9 : 5 + Math.min(22, Math.sqrt(p.words) / 8)
            ),
          },
          mode: "markers",
          name: personId ? nameOf(personId) : "Unnamed",
          text: same.map((p) =>
            personId ? nameOf(personId) : `${p.words.toLocaleString()} words`
          ),
          type: "scatter3d",
          x: same.map((p) => p.position[0]),
          y: same.map((p) => p.position[1]),
          z: same.map((p) => p.position[2]),
        };
      }
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
    if (selected) {
      const card = data.cards.find((c) => c.id === selected.id);
      if (card) {
        show(card, false);
      } else {
        selected = null;
        el("detail").hidden = true;
        stopAudio();
      }
    }
  }
  async function load() {
    data = await (await request("/speakers/map")).json();
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
  window.addEventListener("pagehide", stopAudio);
  if (token) {
    load().catch((e) => status(e.message));
  } else {
    status("Open this page with bun run voices on your Mac.");
  }
})();
