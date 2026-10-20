// The portrait's clip player (/me/player.js). Each <figure class="clip" data-clip="/me/<page>/<clip>"> gets its
// words from <clip>.json (lifelog's own timings, cut to the clip) and plays <clip>.m4a, marking the word being
// said `now` and the ones before it `said`, as lifelog's app does. A word is a button: it plays from there.
// One clip plays at a time. The page styles .clip, .turn, .who, .w, .now, .said and .playing.

let current = null;

for (const clip of document.querySelectorAll("figure.clip[data-clip]")) {
  const src = clip.dataset.clip;
  const say = clip.querySelector(".say");
  const play = clip.querySelector("button.play");
  const audio = new Audio(`${src}.m4a`);
  audio.preload = "none";
  let spans = [];
  let frame = 0;

  fetch(`${src}.json`)
    .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
    .then(({ words }) => {
      say.replaceChildren();
      let turn = null;
      let who = null;
      for (const w of words) {
        if (w.who !== who) {
          ({ who } = w);
          turn = document.createElement("p");
          turn.className = "turn";
          const label = document.createElement("span");
          label.className = "who";
          label.textContent = who;
          turn.append(label);
          say.append(turn);
        }
        const span = document.createElement("span");
        span.className = "w";
        span.textContent = w.w;
        span.dataset.s = w.s;
        span.dataset.e = w.e;
        span.addEventListener("click", () => {
          audio.currentTime = w.s / 1000;
          start();
        });
        turn.append(turn.childNodes.length > 1 ? w.sp : "", span);
      }
      spans = [...say.querySelectorAll(".w")];
    })
    .catch(() => clip.classList.add("unavailable"));

  const paint = () => {
    const t = audio.currentTime * 1000;
    for (const s of spans) {
      s.classList.toggle("now", t >= s.dataset.s && t < s.dataset.e);
      s.classList.toggle("said", t >= s.dataset.e);
    }
    if (!audio.paused) {
      frame = requestAnimationFrame(paint);
    }
  };
  const start = () => {
    if (current && current !== audio) {
      current.pause();
    }
    current = audio;
    audio.play();
  };
  audio.addEventListener("play", () => {
    clip.classList.add("playing");
    play.setAttribute("aria-label", "Pause");
    frame = requestAnimationFrame(paint);
  });
  audio.addEventListener("pause", () => {
    clip.classList.remove("playing");
    play.setAttribute("aria-label", "Play");
    cancelAnimationFrame(frame);
    paint();
  });
  audio.addEventListener("ended", () => {
    audio.currentTime = 0;
    paint();
  });
  play.addEventListener("click", () =>
    audio.paused ? start() : audio.pause()
  );
}
