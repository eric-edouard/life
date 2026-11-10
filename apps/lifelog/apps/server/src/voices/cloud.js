// The 3D cloud of voices, as both pages draw it (lifelog's voice map and the voice bench's page):
// the colours, the scene, and axes that hold still when a person is hidden.
(() => {
  const colors = [
    "#e2626a",
    "#78b3cf",
    "#b9a0db",
    "#d0b478",
    "#83bba3",
    "#d69b7d",
  ];
  // One axis's extent over every point, a little padded.
  const rangeOf = (points, axis) => {
    const values = points.map((p) => p.position[axis]);
    const low = Math.min(...values, 0);
    const high = Math.max(...values, 0);
    const pad = (high - low) * 0.05 || 1;
    return [low - pad, high + pad];
  };
  window.voiceCloud = {
    // A person's colour by their place in the list of people: the six of the brand, then hues
    // of the same weight, a golden angle apart.
    colorOf: (index) =>
      colors[index] ?? `hsl(${Math.round((index * 137.5) % 360)}, 48%, 66%)`,
    // `points` is every point, shown or not, so toggling a person never moves or rescales the rest.
    // The camera stays while `revision` does.
    draw: (plot, traces, points, revision) =>
      window.Plotly.react(
        plot,
        traces,
        {
          font: { color: "#cfc8c0" },
          margin: { b: 0, l: 0, r: 0, t: 0 },
          paper_bgcolor: "#0b0a0a",
          scene: {
            aspectmode: "cube",
            bgcolor: "#0b0a0a",
            xaxis: { range: rangeOf(points, 0), visible: false },
            yaxis: { range: rangeOf(points, 1), visible: false },
            zaxis: { range: rangeOf(points, 2), visible: false },
          },
          showlegend: false,
          uirevision: revision,
        },
        {
          displayModeBar: false,
          responsive: true,
          showLink: false,
          showSendToCloud: false,
        }
      ),
    unnamed: "#8a837d",
  };
})();
