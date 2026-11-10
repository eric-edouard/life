import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("sidebar toggles whole clouds independently, keeps choices on refresh and preserves naming", async () => {
  const owner = "owner";
  const guest = "guest";
  const pointOf = (id: string, personId: string | null, kind: string) => ({
    basis: kind === "sample" ? "owner" : null,
    id,
    kind,
    personId,
    position: [0, 0, 0],
    ranking: [],
    words: personId ? 0 : 420,
  });
  const data = {
    candidateThreshold: 0.5,
    cards: [
      {
        clips: [
          {
            audio: null,
            jobId: "job",
            personId: null,
            speakerLabel: "a",
            text: "Made-up clip",
            turnIndex: 0,
          },
        ],
        conversations: 1,
        id: "group",
        name: null,
        scope: "speaker",
        words: 420,
      },
    ],
    models: [
      {
        model: "first@r1",
        points: [
          pointOf(owner, owner, "centroid"),
          pointOf(guest, guest, "centroid"),
          pointOf("group", null, "unnamed"),
          pointOf("owner-sample", owner, "sample"),
          pointOf("guest-sample", guest, "sample"),
        ],
      },
    ],
    people: [
      { id: owner, name: "Owner" },
      { id: guest, name: "Guest" },
    ],
  };
  // Point kind, not the id shape, chooses centroid size; basis chooses solid/hollow.
  const model = data.models.at(0);
  if (!model) {
    throw new Error("Missing seeded model");
  }
  const ownerSample = model.points.find(
    (p) => p.kind === "sample" && p.personId === owner
  );
  if (!ownerSample) {
    throw new Error("Missing seeded cloud");
  }
  for (const point of model.points) {
    if (point.kind === "centroid" && point.personId === owner) {
      point.id = "not-a-person-id";
    }
  }
  model.points.push({ ...ownerSample, basis: "recognized", id: owner });
  // Duplicate display names must still toggle different people.
  for (const person of data.people) {
    person.name = "Made-up name";
  }
  const loaded = Promise.withResolvers<void>();
  const initial = Promise.withResolvers<void>();
  const polls: (() => Promise<void>)[] = [];
  const requests: {
    path: string;
    options: { body?: string; method?: string };
  }[] = [];
  let mapReads = 0;
  const nodes = new Map();
  const noop = () => undefined;
  const node = () => ({
    addEventListener(_event: string, action: unknown) {
      this.click = action;
    },
    append(...children: unknown[]) {
      this.children.push(...children);
    },
    children: [] as any[],
    click: null as any,
    hidden: true,
    on(_event: string, action: unknown) {
      this.click = action;
    },
    pause: noop,
    querySelectorAll(selector = "") {
      const inputs = this.children.map((label) => label.children[0]);
      return selector === "input:checked"
        ? inputs.filter((input) => input.checked)
        : inputs;
    },
    removeAllListeners: noop,
    removeAttribute: noop,
    replaceChildren(...children: unknown[]) {
      this.children = children;
    },
    setAttribute: noop,
    style: {},
    value: "first@r1",
  });
  const el = (id: string) => {
    if (!nodes.has(id)) {
      nodes.set(id, node());
    }
    return nodes.get(id);
  };
  let traces: any[] = [];
  let layout: any;
  const restyles: unknown[] = [];
  const plotly = {
    react(_plot: unknown, next: any[], nextLayout: unknown) {
      traces = next;
      layout = nextLayout;
      return Promise.resolve();
    },
    restyle(_plot: unknown, value: unknown, indices: unknown) {
      restyles.push([value, indices]);
      return Promise.resolve();
    },
  };
  Object.defineProperty(el("status"), "textContent", {
    set(value) {
      if (value === "") {
        loaded.resolve();
      } else if (value === "Building the voice map…") {
        initial.resolve();
      }
    },
  });
  runInNewContext(
    readFileSync(new URL("./voices/page.js", import.meta.url), "utf8"),
    {
      clearTimeout: noop,
      crypto,
      document: {
        createElement: node,
        createTextNode: (text: string) => text,
        getElementById: el,
      },
      fetch: (path: string, options: { body?: string; method?: string }) => {
        requests.push({ options, path });
        if (path !== "/speakers/map") {
          return Promise.resolve({ ok: true, status: 200 });
        }
        mapReads += 1;
        const first = mapReads === 1;
        return Promise.resolve({
          json: () =>
            Promise.resolve(
              first
                ? { building: true }
                : {
                    ...structuredClone(data),
                    building: mapReads === 2,
                  }
            ),
          ok: true,
          status: first ? 202 : 200,
        });
      },
      history: { replaceState: noop },
      location: { hash: "#token=made-up-token", pathname: "/voices" },
      setTimeout: (action: () => Promise<void>, milliseconds: number) => {
        expect(milliseconds).toBe(500);
        polls.push(action);
        return polls.length;
      },
      URLSearchParams,
      window: { addEventListener: noop, Plotly: plotly },
    }
  );
  await initial.promise;
  expect(polls).toHaveLength(1);
  expect(el("detail").hidden).toBe(true);
  await polls[0]?.();
  await loaded.promise;
  expect(polls).toHaveLength(2);
  const checkboxes = el("visibility").querySelectorAll();
  expect(checkboxes).toHaveLength(3);
  expect(layout.showlegend).toBe(false);
  // The axes span every voice, so toggling one never rescales the others.
  expect(layout.scene.xaxis.range).toHaveLength(2);
  expect(layout.scene.xaxis.autorange).toBeUndefined();
  expect(traces.find((t) => t.customdata[0] === owner)?.customdata).toEqual([
    owner,
    owner,
    owner,
  ]);
  expect(traces[0].marker.size).toEqual([9, 4, 4]);
  // A hollow sample's ring is its person's colour, never the default white.
  expect(traces[0].marker.line.color).toBe(traces[0].marker.color);
  expect(traces[0].marker.symbol).toEqual(["circle", "circle", "circle-open"]);
  expect(traces.find((t) => t.customdata[0] === guest)?.customdata).toEqual([
    guest,
    guest,
  ]);
  checkboxes[0].checked = false;
  checkboxes[0].onchange();
  expect(restyles.at(-1)).toEqual([{ visible: false }, [0]]);
  expect(checkboxes[1].checked).toBe(true);
  await el("refresh").onclick();
  expect(traces.map((t) => t.visible)).toEqual([false, true, true]);
  el("show-none").onclick();
  expect(
    el("visibility")
      .querySelectorAll()
      .every((c: any) => !c.checked)
  ).toBe(true);
  el("show-all").onclick();
  await el("refresh").onclick();
  expect(traces.map((t) => t.visible)).toEqual([true, true, true]);
  el("plot").click({ points: [{ customdata: "group" }] });
  expect(el("detail").hidden).toBe(false);
  expect(el("context").textContent).toContain("420 words");
  el("several").onclick();
  const chosen = el("several-people")
    .querySelectorAll()
    .find((input: any) => input.value === guest);
  chosen.checked = true;
  const [, , form] = el("clips").children[0].children;
  form.children[1].value = "New made-up person";
  await form.children[2].click();
  expect(requests.at(-1)?.options.method).toBe("PUT");
  const { target } = JSON.parse(requests.at(-1)?.options.body ?? "{}");
  const savedClips = el("clips").children;
  const savedPeople = el("several-people").children;
  expect(savedClips[0].children[2].children[0].value).toBe(target.id);
  expect(
    el("several-people")
      .querySelectorAll()
      .find((input: any) => input.value === guest).checked
  ).toBe(true);
  // A fresh server snapshot still has the old clip; polling must preserve the edit in progress.
  await polls[1]?.();
  expect(el("done").hidden).toBe(false);
  expect(el("name-form").hidden).toBe(true);
  expect(el("several-people").hidden).toBe(false);
  expect(el("clips").children).toBe(savedClips);
  expect(el("several-people").children).toBe(savedPeople);
  expect(savedClips[0].children[2].children[0].value).toBe(target.id);
  expect(
    el("several-people")
      .querySelectorAll()
      .find((input: any) => input.value === guest).checked
  ).toBe(true);
});
