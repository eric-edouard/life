// Selection reads stored progress first; only the selected conversation loads model context.
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  conversations,
  lifePeopleSnapshot,
  namingAttempts,
} from "@lifelog/db/schema";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { touchedSince } from "./change-log";
import { NAMING } from "./config";
import { reportError } from "./diagnostics";
import {
  type NamingInput,
  namingBacklogClass,
  namingPolicyHash,
  namingPromptHash,
  namingWorkHash,
} from "./inferred-speakers";

type Attempt = typeof namingAttempts.$inferSelect;
export interface NamingWork {
  arrivedAt: number;
  attempt: Attempt | null;
  backlogClass: number;
  conversationId: string;
  input: NamingInput;
  isFresh: boolean;
}

function isEligible(
  attempt: Pick<Attempt, "state" | "attempts" | "nextEligibleAt"> | null,
  now: number,
  writes: boolean,
  applied = false
) {
  return (
    !attempt ||
    (writes && attempt.state === "named" && !applied) ||
    ((attempt.state === "failed" ||
      attempt.state === "abstained" ||
      attempt.state === "queued") &&
      attempt.attempts < NAMING.retryMaxAttempts &&
      (!attempt.nextEligibleAt || attempt.nextEligibleAt.getTime() <= now))
  );
}

function orderOf(
  a: {
    isFresh: boolean;
    backlogClass: number;
    arrivedAt: number;
    conversationId: string;
  },
  b: typeof a
) {
  return (
    Number(!a.isFresh) - Number(!b.isFresh) ||
    (a.isFresh && b.isFresh ? 0 : a.backlogClass - b.backlogClass) ||
    b.arrivedAt - a.arrivedAt ||
    a.conversationId.localeCompare(b.conversationId)
  );
}

export function selectNamingWork(
  work: NamingWork[],
  now = clock().getTime(),
  writes = false
) {
  return (
    work
      .filter((w) =>
        isEligible(
          w.attempt,
          now,
          writes,
          !!(w.attempt?.result as { applied?: boolean } | null)?.applied
        )
      )
      .sort(orderOf)[0] ?? null
  );
}

export function namingSelection(
  db: Db,
  readInputs: (db: Db, id: string) => Iterable<NamingInput | null>
) {
  let cursor: number | null = null;
  let revision = "";
  const inspected = new Map<
    string,
    {
      hashes: string[];
      backlogClass: number;
      complete: boolean;
      windows: Iterator<NamingInput | null>;
      pending: NamingInput | null;
    }
  >();
  return (model: string, startedAt: Date, mode: string, writes: boolean) => {
    const changes = touchedSince(db, cursor);
    const [global] = db.all<{ people: number; profiles: string | null }>(sql`
      select (select coalesce(max(seq), 0) from change_log where kind = 'person') as people,
        (select group_concat(id || ':' || person_id || ':' || sample_id) from voice_profiles) as profiles`);
    const next = JSON.stringify([
      model,
      namingPromptHash(),
      namingPolicyHash(),
      db.select().from(lifePeopleSnapshot).get()?.hash,
      global,
    ]);
    if (revision !== next || changes.ids === null) {
      inspected.clear();
    } else {
      for (const id of changes.ids) {
        inspected.delete(id);
      }
    }
    cursor = changes.through;
    revision = next;
    const attempts = db
      .select({
        applied: sql<number>`coalesce(json_extract(${namingAttempts.result}, '$.applied'), 0)`,
        attempts: namingAttempts.attempts,
        conversationId: namingAttempts.conversationId,
        id: namingAttempts.id,
        inputHash: namingAttempts.inputHash,
        nextEligibleAt: namingAttempts.nextEligibleAt,
        state: namingAttempts.state,
      })
      .from(namingAttempts)
      .all();
    const byHash = new Map(attempts.map((a) => [a.inputHash, a]));
    const attempted = new Set(attempts.map((a) => a.conversationId));
    const now = clock().getTime();
    const candidates = db
      .select({
        arrivedAt: conversations.createdAt,
        conversationId: conversations.id,
        hasVoice: sql<boolean>`exists (select 1 from voice_samples v where v.conversation_id = ${conversations.id})`,
      })
      .from(conversations)
      .where(
        and(
          isNull(conversations.retiredAt),
          mode === "arrivals"
            ? gte(conversations.createdAt, startedAt)
            : undefined
        )
      )
      .all()
      .map((c) => ({
        ...c,
        arrivedAt: c.arrivedAt.getTime(),
        backlogClass:
          inspected.get(c.conversationId)?.backlogClass ??
          (c.hasVoice ? NAMING.backlogVoice : NAMING.backlogContext),
        isFresh: c.arrivedAt >= startedAt && !attempted.has(c.conversationId),
      }))
      .filter((c) => {
        const previous = inspected.get(c.conversationId);
        return (
          !previous?.complete ||
          previous.hashes.some((storedHash) =>
            isEligible(
              byHash.get(storedHash) ?? null,
              now,
              writes,
              !!byHash.get(storedHash)?.applied
            )
          )
        );
      })
      .sort(orderOf);
    const [selected] = candidates;
    if (!selected) {
      return null;
    }
    const readNext = () => {
      const progress = inspected.get(selected.conversationId) ?? {
        backlogClass: selected.backlogClass,
        complete: false,
        hashes: [],
        pending: null,
        windows: readInputs(db, selected.conversationId)[Symbol.iterator](),
      };
      if (progress.complete) {
        progress.windows = readInputs(db, selected.conversationId)[
          Symbol.iterator
        ]();
        progress.complete = false;
      }
      inspected.set(selected.conversationId, progress);
      const advance = () => {
        if (progress.pending) {
          const attempt = byHash.get(
            namingWorkHash(progress.pending.inputHash, model)
          );
          if (!isEligible(attempt ?? null, now, writes, !!attempt?.applied)) {
            progress.pending = null;
          }
        }
        if (!progress.pending) {
          const window = progress.windows.next();
          progress.complete = window.done === true;
          progress.pending = window.value ?? null;
        }
      };
      try {
        advance();
        const input = progress.pending;
        if (input) {
          const hash = namingWorkHash(input.inputHash, model);
          progress.hashes = [...new Set([...progress.hashes, hash])];
          progress.backlogClass = namingBacklogClass(input);
          inspected.set(selected.conversationId, progress);
          const attempt = byHash.get(hash) ?? null;
          if (!isEligible(attempt, now, writes, !!attempt?.applied)) {
            progress.pending = null;
            return "advancing";
          }
          return {
            ...selected,
            attempt: attempt
              ? (db
                  .select()
                  .from(namingAttempts)
                  .where(eq(namingAttempts.id, attempt.id))
                  .get() ?? null)
              : null,
            input,
          };
        }
      } catch (error) {
        reportError(db, "naming context", error);
        progress.complete = true;
      }
      return !progress.complete || candidates.length > 1 ? "advancing" : null;
    };
    return readNext();
  };
}
