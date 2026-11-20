import { setSystemTime, spyOn } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, HOUR, iso } from "../core/clock";
import { agentOf, currentAssignmentOf } from "../host/desk-read";
import type { Messaging } from "../host/events";
import type { SourceEvent } from "../records/source";
import { register, setWait } from "./agent-actions";
import { turnEnded, wakeDue } from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The wait contract's test desk: a fake runtime, the clock faked, a made-up chat (`wait-contract.test.ts`).

export const T0 = Date.UTC(2026, 10, 18, 9, 0);
export const ANA = { chat: "Test Ana", from_me: false };

export const advance = (ms: number) =>
  setSystemTime(new Date(clock().getTime() + ms));
export const ahead = (ms: number) => iso(clock().getTime() + ms);

/** A chat store whose messages are `list`, row by row, as `incoming` and `read` see it. */
export const chatSource = (list: SourceEvent[]) =>
  ({
    incoming: (from: number) => ({
      end: list.length + 1,
      rows: list
        .map((e, i) => ({ at: e.at, id: e.id, row: i + 1 }))
        .filter((r) => r.row >= from),
    }),
    kind: "chat",
    label: "WhatsApp",
    name: "whatsapp",
    read: (since: Date) => list.filter((e) => e.at >= since.toISOString()),
    silentAfter: 0,
  }) as Messaging;

export function setup() {
  setSystemTime(new Date(T0));
  const dir = mkdtempSync(join(tmpdir(), "life-desk-"));
  const fake = fakeRuntime();
  const messages: SourceEvent[] = [];
  const path = join(dir, "desk.sqlite");
  const desk: Desk = {
    db: openDesk(path),
    runtimes: { fake: fake.runtime },
    sources: [chatSource(messages)],
  };
  /** A message in a made-up chat, now. */
  const write = (chat = "Test Ana") => {
    const id = `whatsapp:m${messages.length + 1}`;
    messages.push({
      at: clock().toISOString(),
      chat,
      fromMe: false,
      id,
      sender: chat,
      source: "whatsapp",
      text: "hello",
    });
    return id;
  };
  /** The agent's turn ends, as its runtime reports it. */
  const end = async (id: string, failed = false) => {
    const s = fake.sessions.get(agentOf(desk.db, id)?.session ?? "");
    if (s) {
      s.running = false;
    }
    await turnEnded(desk, id, { ok: !failed });
  };
  /** A registered agent after its first turn: waiting for Ana's messages until `until`. */
  const waiting = async (until = HOUR) => {
    const id = register(desk, {
      brief: "Test brief: follow up with Ana",
      folder: dir,
      runtime: "fake",
    });
    await wakeDue(desk);
    await setWait(desk, on(desk, id), {
      events: [ANA],
      reason: "Ana's reply",
      until: ahead(until),
    });
    await end(id);
    return id;
  };
  const turns = (id: string) =>
    desk.db
      .query<{ cause: string; outcome: string | null }, [string]>(
        "select cause, outcome from turn where agent_id = ? order by id"
      )
      .all(id);
  const queue = (id: string, eventId: string, name = "message.received") =>
    desk.db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, ?, '{}', ?)",
      [asgOf(desk, id), eventId, name, clock().toISOString()]
    );
  const eventRow = (id: string, eventId: string) =>
    desk.db
      .query<
        {
          consumed_at: string | null;
          dropped_at: string | null;
          handed: number;
        },
        [string, string]
      >(
        "select handed, consumed_at, dropped_at from event where assignment_id = ? and event_id = ?"
      )
      .get(asgOf(desk, id), eventId);
  return { desk, dir, end, eventRow, fake, path, queue, turns, waiting, write };
}

/** The assignment row agent `id` works on (each test agent has one): what the door's tools take. */
export function on(desk: Desk, id: string) {
  const s = currentAssignmentOf(desk.db, id);
  if (!s) {
    throw new Error(`${id} holds no assignment`);
  }
  return s;
}

/** The assignment agent `id` works on (each test agent has one). */
export const asgOf = (desk: Desk, id: string) =>
  currentAssignmentOf(desk.db, id)?.id ?? "";

/** A new agent on a made-up matter, its first turn launched. */
export async function started(desk: Desk, step: string) {
  const id = register(desk, {
    brief: "Test brief: watch the repair",
    folder: tmpdir(),
    runtime: "fake",
    steps: [step],
  });
  await wakeDue(desk);
  return id;
}

/** A made-up open matter holding `steps` (each a to-do at `at`), as the matter book gives it. */
export const matterView = (
  id: string,
  steps: string[],
  at = "2026-11-18T08:00:00.000Z"
) => ({
  areas: [],
  goal: { at, by: "life", text: `Goal of ${id}` },
  hasOwnOpenStep: true,
  id,
  important: false,
  lone: false,
  name: `Matter ${id}`,
  nextStep: { at, by: "life", kind: "do", text: `Next step of ${id}` },
  open: true,
  openSteps: [],
  owedTo: [],
  projects: [],
  status: "moving",
  steps: steps.map((ref) => ({
    at,
    day: at.slice(0, 10),
    kind: "to_do",
    quote: "",
    ref,
    text: `Step ${ref}`,
  })),
  waitingOn: [],
  with: [],
});

/** Runs `f` while the matter book holds `views` (`readMatterBook`). */
export async function withMatters<T>(views: unknown[], f: () => Promise<T>) {
  const matters = await import("../memory/matters");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue(
    views as never
  );
  try {
    return await f();
  } finally {
    book.mockRestore();
  }
}
