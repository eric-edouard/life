import { expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR, MIN } from "../core/clock";
import { digest } from "../core/hash";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as logs from "../core/log";
import { setSettings, settings } from "../core/settings";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as models from "../models/llm";
import { Correction } from "../records/observation";
import type { SourceEvent, SourceFile } from "../records/source";
import type { FileEntry } from "../records/unit";
import { readImessage } from "../sources/imessage";
import { imessageFixture, whatsappFixture } from "../sources/store-fixtures";
import { copyWhatsapp, readWhatsapp } from "../sources/whatsapp";
import { CORRECTIONS, FILES } from "./memory-files";
import {
  asChatOrNot,
  describeFilesOnArrival,
  FILES_ON_ARRIVAL_A_DAY,
  filesDueOnArrival,
  keptFileLines,
  readFiles,
  showFiles,
  triage,
} from "./message-files";
import { locate } from "./quote-check";

const madeBy = {
  engine: "codex" as const,
  model: "m",
  prompt: "message-file-description.v1",
  run: "r",
};
const hashOf = (s: string) => digest("sha256", s, 16);
const id: FileEntry = {
  description: "French national identity card of Anne-Sophie.",
  hash: hashOf("id-card"),
  madeBy,
  ref: "imessage:at_0",
  schemaVersion: 1,
  text: "RÉPUBLIQUE FRANÇAISE CARTE NATIONALE D'IDENTITÉ",
};
const photo = (ref: string, path?: string): SourceFile => ({
  mime: "image/heic",
  name: "IMG_2910.HEIC",
  ref,
  ...(path ? { path } : {}),
});
const event = (...files: SourceFile[]): SourceEvent => ({
  at: "2026-10-17T04:01:00.000Z",
  chat: "+33600000000",
  files,
  fromMe: false,
  id: "imessage:g1",
  sender: "+33600000000",
  source: "imessage",
  text: "￼",
});

test("a file read once shows its description by its ref, also once it is gone; one never read and gone is a tag", () => {
  const known = new Map([[id.ref, id]]);
  const line = `[photo IMG_2910.HEIC, described by Life: ${id.description} | text: ${id.text}]`;
  expect(showFiles([event(photo(id.ref, "/here.heic"))], known)[0]?.text).toBe(
    line
  );
  expect(showFiles([event(photo(id.ref))], known)[0]?.text).toBe(line);
  // An observation may quote it: the quote check finds Life's description in the line.
  expect(locate("identity card of Anne-Sophie", [line])?.line).toBe(0);
  expect(showFiles([event(photo("imessage:at_1"))], known)[0]?.text).toBe(
    "[photo IMG_2910.HEIC, not on this Mac]"
  );
});

test("a file he deleted is left out of every read that shows it, and the pass that describes files still knows it", () => {
  writeFileSync(FILES, `${JSON.stringify(id)}\n`);
  try {
    expect(readFiles().get(id.ref)?.description).toBe(id.description);
    // His word, as his door recorded it: the file's ref, `file:<ref>`.
    const deleted = Correction.parse({
      at: "2026-11-24T09:00:00.000Z",
      kind: "deleted",
      refs: [`file:${id.ref}`],
      said: "that goes",
      schemaVersion: 1,
      withSources: false,
    });
    writeFileSync(CORRECTIONS, `${JSON.stringify(deleted)}\n`, { flag: "a" });
    expect(readFiles().has(id.ref)).toBe(false);
    // The description passes ask the ledger as it is: its line still holds it, so it is never read (or paid) again.
    expect(keptFileLines().get(id.ref)?.description).toBe(id.description);
    expect(
      filesDueOnArrival(
        [event(photo(id.ref, "/here.heic"))],
        keptFileLines(),
        new Set()
      ).due
    ).toEqual([]);
  } finally {
    rmSync(FILES, { force: true });
    rmSync(CORRECTIONS, { force: true });
  }
});

test("triage: a known ref is not opened, a known hash is copied under its new ref, a new content is listed once", async () => {
  const bytes: Record<string, string> = {
    "/a.heic": "id-card",
    "/b.heic": "beach",
    "/c.heic": "beach",
  };
  const opened: string[] = [];
  const { copies, fresh } = await triage(
    [
      event(
        photo(id.ref, "/old.heic"),
        photo("whatsapp:chat/forwarded", "/a.heic"),
        photo("whatsapp:chat/b", "/b.heic"),
        photo("line:c", "/c.heic"),
        photo("line:gone"),
        { mime: "video/mp4", path: "/v.mp4", ref: "line:video" }
      ),
    ],
    [id],
    (f) => {
      opened.push(f.path);
      return Promise.resolve(Buffer.from(bytes[f.path] ?? ""));
    }
  );
  expect(opened).toEqual(["/a.heic", "/b.heic", "/c.heic"]);
  expect(copies).toEqual([{ ...id, ref: "whatsapp:chat/forwarded" }]);
  expect([...fresh.values()].map((c) => [c.hash, c.refs])).toEqual([
    [hashOf("beach"), ["whatsapp:chat/b", "line:c"]],
  ]);
});

test("a photo-only message carries its attachments as files, a link preview left out", () => {
  const image = join(mkdtempSync(join(tmpdir(), "att-")), "IMG_2910.HEIC");
  writeFileSync(image, "bytes");
  // The text Messages keeps for a photo-only message: one U+FFFC.
  const db = imessageFixture(String.fromCharCode(0xff_fc), [
    { mime: "image/heic", name: "IMG_2910.HEIC", path: image },
    // Never downloaded to this Mac, and Messages left its type out.
    { mime: null, name: "Audio Message.caf", path: null },
  ]);
  const read = (d: Date) => readImessage(d, db);
  const since = new Date(Date.now() - HOUR);
  expect(read(since)[0]?.files).toEqual([
    {
      mime: "image/heic",
      name: "IMG_2910.HEIC",
      path: image,
      ref: "imessage:at_0",
    },
    { mime: "audio/x-caf", name: "Audio Message.caf", ref: "imessage:at_1" },
  ]);
  expect(showFiles(read(since), new Map())[0]?.text).toBe(
    "[photo IMG_2910.HEIC]\n[audio Audio Message.caf, not on this Mac]"
  );
});

test("a phone call has no words and no file, and is kept: its readers write its line", () => {
  const call = {
    at: "2026-11-10T09:00:00.000Z",
    chat: "+33600000001",
    fromMe: false,
    id: "phone:+33600000001/1",
    phoneCall: { seconds: 90, video: false },
    sender: "+33600000001",
    source: "phone" as const,
    text: "",
  };
  expect(
    showFiles([call, { ...call, phoneCall: undefined }], new Map())
  ).toEqual([call]);
});

test("media rows are files: the archive's copy, a document's name, a photo never downloaded", () => {
  const { add, dir, now, source } = whatsappFixture();
  add(1, "P1", 1, null, 300, "Media/120@g.us/a/photo.jpg");
  add(2, "D1", 8, "plan R19.pdf", 200, "Media/120@g.us/b/doc.pdf");
  add(3, "P2", 1, null, 100);
  // A link's media is its preview, not a file.
  add(4, "L1", 7, "https://example.com", 50, "Media/120@g.us/c/preview.jpg");
  copyWhatsapp(source, dir, now);
  const read = (d: Date) => readWhatsapp(d, dir, source);
  const since = new Date(now - HOUR);
  expect(read(since).map((e) => e.files)).toEqual([
    [
      {
        mime: "image/jpeg",
        path: join(dir, "media", "Media/120@g.us/a/photo.jpg"),
        ref: "whatsapp:120@g.us/P1",
      },
    ],
    [
      {
        mime: "application/pdf",
        name: "plan R19.pdf",
        path: join(dir, "media", "Media/120@g.us/b/doc.pdf"),
        ref: "whatsapp:120@g.us/D1",
      },
    ],
    [{ mime: "image/jpeg", ref: "whatsapp:120@g.us/P2" }],
    [],
  ]);
  expect(showFiles(read(since), new Map()).map((e) => e.text)).toEqual([
    "[photo]",
    "[pdf plan R19.pdf]",
    "[photo, not on this Mac]",
    "https://example.com",
  ]);
});

const DAY = "2026-10-17";
const described = (
  ref: string,
  hash: string,
  run = `${DAY}T10-00-00.000Z`
) => ({
  ...id,
  hash,
  madeBy: { ...madeBy, run },
  ref,
});

test("arrival: a video, a file with no path, a known ref and an attempted ref are not due; a file that gains a path is; the day's limit counts contents", () => {
  const files = [
    photo("a:new", "/a.heic"),
    photo("a:known", "/b.heic"),
    photo("a:tried", "/c.heic"),
    photo("a:nopath"),
    { mime: "video/mp4", path: "/v.mp4", ref: "a:video" },
  ];
  const known = new Map([["a:known", described("a:known", hashOf("k"))]]);
  const due = (k: typeof known, tried: string[] = ["a:tried"]) =>
    filesDueOnArrival([event(...files)], k, new Set(tried), DAY);
  expect(due(known).due[0]?.files?.map((f) => f.ref)).toEqual(["a:new"]);
  expect(due(known).atMost).toBe(FILES_ON_ARRIVAL_A_DAY - 1);
  // It gains a path at a later tick: due then.
  expect(
    filesDueOnArrival(
      [event(photo("a:nopath", "/d.heic"))],
      known,
      new Set(),
      DAY
    ).due
  ).toHaveLength(1);
  // The same content under two refs counts once; a line of an earlier day does not count.
  const twice = new Map([
    ["x:1", described("x:1", hashOf("same"))],
    ["x:2", described("x:2", hashOf("same"))],
    ["x:3", described("x:3", hashOf("old"), "2026-10-16T10-00-00.000Z")],
  ]);
  expect(due(twice).atMost).toBe(FILES_ON_ARRIVAL_A_DAY - 1);
  // The limit spent: nothing more.
  const spent = new Map(
    Array.from({ length: FILES_ON_ARRIVAL_A_DAY }, (_, i) => [
      `s:${i}`,
      described(`s:${i}`, hashOf(`c${i}`)),
    ])
  );
  expect(due(spent).atMost).toBe(0);
});

test("arrival: with no file due the ledger is not counted (a line the count could not read does not throw)", () => {
  const bad = new Map([
    [
      "z:1",
      {
        ...described("z:1", hashOf("z")),
        madeBy: { ...madeBy, run: "not-a-run" },
      },
    ],
    ["z:known", described("z:known", hashOf("k"))],
  ]);
  const r = filesDueOnArrival(
    [event(photo("z:known", "/a.heic"))],
    bad,
    new Set(),
    DAY
  );
  expect(r).toEqual({ atMost: 0, due: [] });
  // Something due: the count runs, and a line of another day never reaches localDate.
  expect(() =>
    filesDueOnArrival([event(photo("z:new", "/b.heic"))], bad, new Set(), DAY)
  ).not.toThrow();
});

// A 1-pixel PNG; trailing bytes after its end make a different content that `sips` still reads.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const image = (dir: string, name: string, extra = "") => {
  const path = join(dir, name);
  writeFileSync(
    path,
    Buffer.concat([Buffer.from(PNG, "base64"), Buffer.from(extra)])
  );
  return path;
};
const lineCount = (ref: string) =>
  readFileSync(FILES, "utf8")
    .split("\n")
    .filter((l) => l.includes(`"ref":"${ref}"`)).length;

test.skipIf(!Bun.which("sips"))(
  "arrival: one line per ref and prompt version, offline marks nothing, a second pass makes no call and logs no run, a failed file is tried once",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "arrival-"));
    const files = [
      photo("t:a", image(dir, "a.png", "a")),
      photo("t:b", image(dir, "b.png", "b")),
      photo("t:c", image(dir, "c.png", "c")),
    ];
    const events = [event(...files)];
    let calls = 0;
    let during: (() => void) | undefined;
    const ask = spyOn(models, "askOnce").mockImplementation(((o: {
      input: { files: { id: string }[] };
    }) => {
      calls += 1;
      during?.();
      return Promise.resolve({
        files: o.input.files.map((f) => ({
          description: `d${f.id}`,
          id: f.id,
        })),
      });
    }) as never);
    const online = spyOn(models, "isOnline").mockResolvedValue(false);
    const log = spyOn(logs, "log");
    const runs = () =>
      log.mock.calls.filter((c) => c[0] === "run.start").length;
    try {
      // Offline: nothing is asked, nothing marked.
      expect(await describeFilesOnArrival(events)).toBeUndefined();
      expect(calls).toBe(0);
      online.mockResolvedValue(true);
      // Another process writes a line for t:a while the call runs; ours is not appended beside it.
      during = () => {
        writeFileSync(
          FILES,
          `${JSON.stringify(described("t:a", hashOf("other")))}\n`,
          { flag: "a" }
        );
      };
      const first = await describeFilesOnArrival(events);
      expect(calls).toBe(1);
      expect(first?.described).toBe(3);
      for (const ref of ["t:a", "t:b", "t:c"]) {
        expect(lineCount(ref)).toBe(1);
      }
      expect(readFiles().get("t:b")?.description).toBeDefined();
      // Run again: every ref has a line, so no call and no run.
      const before = runs();
      expect(await describeFilesOnArrival(events)).toBeUndefined();
      expect([calls, runs()]).toEqual([1, before]);
      // A line of an older prompt version is replaced by the new one: latest wins.
      const newer = [photo("t:d", image(dir, "d.png", "d"))];
      writeFileSync(
        FILES,
        `${JSON.stringify({
          ...described("t:d", hashOf("old")),
          madeBy: {
            ...described("t:d", "x").madeBy,
            prompt: "message-file-description.v0",
          },
        })}\n`,
        { flag: "a" }
      );
      during = undefined;
      await describeFilesOnArrival([event(...newer)]);
      expect(lineCount("t:d")).toBe(2);
      expect(readFiles().get("t:d")?.madeBy?.prompt).toBe(madeBy.prompt);
      // A call that fails: the file is tried once by this process, not on every tick.
      ask.mockRejectedValue(new Error("provider down"));
      const bad = [event(photo("t:e", image(dir, "e.png", "e")))];
      await describeFilesOnArrival(bad);
      const tried = calls;
      await describeFilesOnArrival(bad);
      expect(calls).toBe(tried);
      expect(readFiles().has("t:e")).toBe(false);
    } finally {
      ask.mockRestore();
      online.mockRestore();
      log.mockRestore();
      rmSync(FILES, { force: true });
      rmSync(dir, { force: true, recursive: true });
    }
  }
);

test.skipIf(!(Bun.which("sips") && Bun.which("textutil")))(
  "arrival: with the day's limit spent a document is still read by code and no image goes to a model",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "spent-"));
    const doc = join(dir, "note.txt");
    writeFileSync(doc, "Plan for the trip");
    const png = image(dir, "p.png", "spent");
    const today = new Date().toISOString().replaceAll(":", "-");
    writeFileSync(
      FILES,
      `${Array.from({ length: FILES_ON_ARRIVAL_A_DAY }, (_, i) =>
        JSON.stringify(described(`s:${i}`, hashOf(`c${i}`), today))
      ).join("\n")}\n`
    );
    const ask = spyOn(models, "askOnce");
    const online = spyOn(models, "isOnline").mockResolvedValue(true);
    try {
      const r = await describeFilesOnArrival([
        event(
          { mime: "text/plain", name: "note.txt", path: doc, ref: "s:doc" },
          photo("s:png", png)
        ),
      ]);
      expect(ask).not.toHaveBeenCalled();
      expect(r?.read).toBe(1);
      expect(readFiles().get("s:doc")?.text).toBe("Plan for the trip");
      expect(readFiles().has("s:png")).toBe(false);
    } finally {
      ask.mockRestore();
      online.mockRestore();
      rmSync(FILES, { force: true });
      rmSync(dir, { force: true, recursive: true });
    }
  }
);

test("a voice note is heard by lifelog, offline too: its words, an empty line for audio it cannot hear, nothing while busy, asked again once 5 minutes passed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "voice-"));
  const note = (name: string, bytes: string): SourceFile => {
    writeFileSync(join(dir, name), bytes);
    return { mime: "audio/ogg", name, path: join(dir, name), ref: `t:${name}` };
  };
  const files = [
    note("heard.ogg", "OggS heard"),
    note("noise.ogg", "OggS noise"),
    note("busy.ogg", "OggS busy"),
  ];
  const answers = new Map([
    [
      digest("sha256", "OggS heard", 64),
      Response.json({ text: "See you  at eight" }),
    ],
    [digest("sha256", "OggS noise", 64), new Response("", { status: 400 })],
  ]);
  const asked: string[] = [];
  const old = settings().lifelog;
  const token = process.env.LIFELOG_TOKEN;
  setSettings({ lifelog: { url: "https://lifelog.example" } });
  process.env.LIFELOG_TOKEN = "made-up-token";
  const fetch = spyOn(globalThis, "fetch").mockImplementation(((
    input: string | URL | Request
  ) => {
    const url = new URL(String(input));
    expect(url.pathname).toBe("/voice-notes/transcript");
    expect(url.searchParams.get("at")).toBe("2026-10-17T04:01:00.000Z");
    const key = url.searchParams.get("key") ?? "";
    asked.push(key);
    return Promise.resolve(
      answers.get(key)?.clone() ?? new Response("", { status: 503 })
    );
  }) as typeof globalThis.fetch);
  const online = spyOn(models, "isOnline").mockResolvedValue(false);
  try {
    await describeFilesOnArrival([event(...files)]);
    const known = readFiles();
    expect(known.get("t:heard.ogg")?.text).toBe("See you at eight");
    expect(known.get("t:noise.ogg")?.text).toBeUndefined();
    expect(known.has("t:noise.ogg")).toBe(true);
    expect(known.has("t:busy.ogg")).toBe(false);
    expect(showFiles([event(...files)], known)[0]?.text).toBe(
      "[audio heard.ogg | text: See you at eight]\n[audio noise.ogg]\n[audio busy.ogg]"
    );
    await describeFilesOnArrival([event(...files)]);
    expect(asked).toHaveLength(3);
    setSystemTime(Date.now() + 5 * MIN);
    await describeFilesOnArrival([event(...files)]);
    expect(
      asked.filter((k) => k === digest("sha256", "OggS busy", 64))
    ).toHaveLength(2);
    expect(asked).toHaveLength(4);
  } finally {
    setSystemTime();
    fetch.mockRestore();
    online.mockRestore();
    setSettings({ lifelog: old ?? null });
    if (token === undefined) {
      delete process.env.LIFELOG_TOKEN;
    } else {
      process.env.LIFELOG_TOKEN = token;
    }
    rmSync(dir, { force: true, recursive: true });
  }
});

test("only a chat's audio is heard: mail's keeps no audio file to read, a chat keeps it", () => {
  const audio: SourceFile = {
    mime: "audio/mp4",
    name: "memo.m4a",
    path: "/x/memo.m4a",
    ref: "t:memo",
  };
  const withAudio = event(audio, photo("t:p", "/x/p.heic"));
  expect(asChatOrNot(withAudio, true)).toBe(withAudio);
  expect(asChatOrNot(withAudio, false).files?.map((f) => f.ref)).toEqual([
    "t:p",
  ]);
});
