import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// The page's controls, without a browser or a listening test server.
class Element {
  children: Element[] = [];
  checked = false;
  disabled = false;
  hidden = false;
  onclick?: () => unknown;
  onsubmit?: (event: { preventDefault: () => void }) => unknown;
  textContent = "";
  type = "";
  value = "";
  addEventListener(_name: string, callback: () => unknown) {
    this.onclick = callback;
  }
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(selector === "input:checked" && !child.checked ? [] : [child]),
      ...child.querySelectorAll(selector),
    ]);
  }
  removeAllListeners() {
    return null;
  }
  removeAttribute() {
    return null;
  }
  setAttribute() {
    return null;
  }
  pause() {
    return null;
  }
  on() {
    return null;
  }
}

const script = readFileSync(
  new URL("./voices/page.js", import.meta.url),
  "utf8"
);
async function page(scope = "speaker") {
  const owner = randomUUID();
  const first = randomUUID();
  const second = randomUUID();
  const elements = new Map<string, Element>();
  const el = (name: string) => {
    const node = elements.get(name) ?? new Element();
    elements.set(name, node);
    return node;
  };
  const calls: {
    body: Record<string, unknown>;
    method: string;
    path: string;
  }[] = [];
  const card = {
    clips: [0, 1].map((turnIndex) => ({
      audio: null,
      jobId: "job",
      personId: null,
      speakerLabel: "a",
      text: "Made-up words",
      turnIndex,
    })),
    conversations: 1,
    id: "group",
    name: null,
    scope,
    voices: [{ jobId: "job", speakerLabel: "a" }],
    words: 500,
  };
  runInNewContext(script, {
    crypto: { randomUUID },
    document: {
      createElement: () => new Element(),
      createTextNode: () => new Element(),
      getElementById: el,
    },
    fetch: (path: string, options: { body?: string; method?: string }) => {
      calls.push({
        body: JSON.parse(options.body ?? "{}"),
        method: options.method ?? "GET",
        path,
      });
      return Promise.resolve({
        json: () =>
          Promise.resolve({
            candidateThreshold: 0.4,
            cards: [card],
            models: [],
            people: [
              { id: owner, isOwner: true, name: "Owner" },
              { id: first, name: "First" },
              { id: second, name: "Second" },
            ],
          }),
        ok: true,
      });
    },
    history: {
      replaceState() {
        return null;
      },
    },
    location: { hash: "#token=test", pathname: "/voices" },
    URL: {
      revokeObjectURL() {
        return null;
      },
    },
    URLSearchParams,
    window: {
      addEventListener() {
        return null;
      },
      Plotly: { react: () => Promise.resolve() },
    },
  });
  await Bun.sleep(0);
  await el("all").children[0]?.onclick?.();
  return { calls, el, first, owner, second };
}

test("Several people derives the owner and an unnamed clip after a clip PUT, without extra choices", async () => {
  const { calls, el, first, owner } = await page();
  await el("several").onclick?.();
  const form = el("clips").children[0]?.children[2];
  const select = form?.children[0];
  if (!select) {
    throw new Error("No clip naming control");
  }
  select.value = first;
  await form?.children[2]?.onclick?.();
  await Bun.sleep(0);
  const unknownForm = el("clips").children[1]?.children[2];
  await unknownForm?.children[2]?.onclick?.();
  await Bun.sleep(0);
  await el("done").onclick?.();
  await Bun.sleep(0);
  expect(calls.filter((c) => c.method === "PUT")).toEqual([
    {
      body: { target: { kind: "person", personId: first }, turnIndex: 0 },
      method: "PUT",
      path: "/transcripts/job/speakers/a",
    },
    {
      body: { target: { kind: "unknown" }, turnIndex: 1 },
      method: "PUT",
      path: "/transcripts/job/speakers/a",
    },
  ]);
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    answer: { kind: "several", people: [owner, first], unknown: true },
    voices: [{ jobId: "job", speakerLabel: "a" }],
  });
});

test("a split group names every turn with PUT and never answers a phone card", async () => {
  const { calls, el } = await page("turns");
  el("name").value = "Guest";
  el("name-form").onsubmit?.({
    preventDefault() {
      return null;
    },
  });
  await Bun.sleep(0);
  const writes = calls.filter((c) => c.method === "PUT");
  expect(writes.map((c) => c.body.turnIndex)).toEqual([0, 1]);
  expect(writes[0]?.body.target).toEqual(writes[1]?.body.target);
  expect(writes[0]?.body.target).toMatchObject({ kind: "new", name: "Guest" });
  expect(calls.some((c) => c.method === "POST")).toBe(false);
});

test("Several people keeps unknown only while a clip is unnamed", async () => {
  const { calls, el, first, owner } = await page();
  await el("several").onclick?.();
  for (const turnIndex of [0, 1]) {
    const form = el("clips").children[turnIndex]?.children[2];
    const select = form?.children[0];
    if (!select) {
      throw new Error("No clip naming control");
    }
    select.value = first;
    // biome-ignore lint/performance/noAwaitInLoops: each saved pick redraws the clip controls
    await form?.children[2]?.onclick?.();
    await Bun.sleep(0);
  }
  await el("done").onclick?.();
  await Bun.sleep(0);
  expect(calls.find((c) => c.method === "POST")?.body).toEqual({
    answer: { kind: "several", people: [owner, first], unknown: false },
    voices: [{ jobId: "job", speakerLabel: "a" }],
  });
});
