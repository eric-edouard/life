// The voices to name (docs/processing.md, "Speakers"): the unnamed voices that
// talked with the owner or hold enough words, grouped (people.ts `regroup`), with a name the
// summaries heard for it, as cards to confirm, rename, give to someone else or ignore. Brief
// strangers, media and announcements get none.
//
// - A card is only a suggestion. An answer is the owner's correction (people.ts `assign`), so
//   only the owner creates people or adds voice evidence.
// - One notification a morning, and only when voices wait: its number is the queue's length,
//   the same the app's badge shows.
// - Names come from the summary runs (intelligence.ts `speakerIdentities`): recorded speech is
//   content, never a command, and a name is shown with the turns it was heard in.

import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  conversationJobs,
  conversations,
  live,
  people,
  type Suggestion,
  speakerAssignments,
  voiceSamples,
} from "@lifelog/db/schema";
import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { alertOf, type Pusher, sendPush } from "./apns";
import { touchedSince, turnRef } from "./change-log";
import { NAMING, ownerClock } from "./config";
import { record, recordedOn } from "./events";
import { type Clip, cardClips, readClip } from "./naming-clips";

import {
  assign,
  isCalled,
  isRejected,
  readOwnTurns,
  readVoices,
  type Target,
  voiceId,
} from "./people";
import { recheckOf } from "./recheck";
import { latestValid } from "./summaries";
import type { Result } from "./summary-calls";
import { type LoadedTurn, loadTurns } from "./transcript";
import { readVoiceProjection } from "./voice-map";

interface Voice {
  conversationId: string;
  exchanges: number;
  // Its unnamed group across conversations, or itself.
  group: string;
  jobId: string;
  // What the summaries called it, weighed by its talk.
  kind: string | null;
  // What the summaries heard, one per run (null: nothing).
  names: (string | null)[];
  people: (string | null)[];
  quotes: Suggestion["evidence"];
  seconds: number;
  // Called several people before the multi-select (`mixed`): asked again, who.
  several: boolean;
  speakerLabel: string;
  // Whether the summaries say it talks with the owner; null from runs that don't say.
  withOwner: boolean | null;
  // Count each stored turn once, even if conversations overlap.
  words: Map<string, number>;
}

// One conversation's unnamed voices, each with the turns it traded with the owner: a turn
// right before or after one of the owner's, in the same job.
function voicesOf(
  conversationId: string,
  turns: LoadedTurn[],
  ownerId: string,
  groups: Map<string, string>,
  skipped: Set<string>,
  skippedTurns: Set<string>,
  mixed: Set<string>
) {
  const voices = new Map<string, Voice>();
  for (const [i, t] of turns.entries()) {
    const label = t.person ? null : t.speakerLabel;
    const k = label && voiceId(t.ref.jobId, label);
    if (
      label &&
      k &&
      !skipped.has(k) &&
      !skippedTurns.has(turnRef(t.ref.jobId, t.ref.turnIndex))
    ) {
      const voice =
        voices.get(k) ??
        newVoice(conversationId, t, label, groups.get(k) ?? k, mixed.has(k));
      voice.seconds += t.endSeconds - t.startSeconds;
      voice.words.set(turnRef(t.ref.jobId, t.ref.turnIndex), t.words.length);
      voice.exchanges += [turns[i - 1], turns[i + 1]].filter(
        (o) => o?.ref.jobId === t.ref.jobId && o.person?.id === ownerId
      ).length;
      voices.set(k, voice);
    }
  }
  return voices;
}

const newVoice = (
  conversationId: string,
  t: LoadedTurn,
  speakerLabel: string,
  group: string,
  several: boolean
): Voice => ({
  conversationId,
  exchanges: 0,
  group,
  jobId: t.ref.jobId,
  kind: null,
  names: [],
  people: [],
  quotes: [],
  seconds: 0,
  several,
  speakerLabel,
  withOwner: null,
  words: new Map(),
});

// The turns a run cites (its own turn ids), as quotes.
function quotes(
  ids: number[],
  runTurns: { jobId: string; turnIndex: number }[],
  byRef: Map<string, LoadedTurn>,
  conversationId: string
): Suggestion["evidence"] {
  return ids.flatMap((id) => {
    const ref = runTurns[id];
    const turn = ref && byRef.get(turnRef(ref.jobId, ref.turnIndex));
    return turn
      ? [
          {
            at: turn.ref.capturedAt,
            conversationId,
            text: turn.text.slice(0, NAMING.quoteChars),
          },
        ]
      : [];
  });
}

// Everything a run says about its unnamed speakers; runs before prompt version 6 say only
// their kind.
const heardOf = (run: Result | null) => [
  ...(run?.speakerKinds ?? []).map((k) => ({
    ...k,
    evidenceTurnIds: [] as number[],
    name: null,
    personId: null,
    withOwner: null,
  })),
  ...(run?.speakerIdentities ?? []),
];

// What the latest summary run said about each voice: its kind, a name with the turns it was
// heard in (a run cites turns only for a name), the owner's person it seems to be.
function heardIn(
  run: Result | null,
  runTurns: { jobId: string; turnIndex: number }[],
  turns: LoadedTurn[],
  voices: Map<string, Voice>
) {
  const byRef = new Map(
    turns.map((t) => [turnRef(t.ref.jobId, t.ref.turnIndex), t])
  );
  for (const s of heardOf(run)) {
    const voice = voices.get(voiceId(s.jobId, s.speakerLabel));
    if (voice) {
      voice.kind = s.kind;
      voice.withOwner = s.withOwner ?? voice.withOwner;
      voice.people.push(s.personId);
      voice.names.push(s.name);
      voice.quotes.push(
        ...quotes(s.evidenceTurnIds, runTurns, byRef, voice.conversationId)
      );
    }
  }
}

// The value said most often, ignoring case.
const mostOf = (values: (string | null)[]) =>
  [
    ...Map.groupBy(
      values.filter((v) => v !== null),
      (v) => v.toLowerCase()
    ).values(),
  ].sort((a, b) => b.length - a.length)[0]?.[0] ?? null;

// A group of voices as a card, its id the group's, or why it gets none.
function judge(
  group: string,
  voices: Voice[],
  words: number
): Suggestion | "media" | "stranger" {
  const seconds = voices.reduce((sum, v) => sum + v.seconds, 0);
  const exchanges = voices.reduce((sum, v) => sum + v.exchanges, 0);
  const media = voices
    .filter((v) => v.kind === "media" || v.kind === "announcement")
    .reduce((sum, v) => sum + v.seconds, 0);
  if (voices.some((v) => v.several)) {
    // Called several people before: asked again who, whatever the checks below say.
    return { ...cardOf(group, voices, seconds, exchanges), kind: "several" };
  }
  if (media * 2 > seconds) {
    return "media";
  }
  // Turns next to the owner's can be people nearby talking among themselves: when the
  // summaries say none talks with him, enough words still warrant asking for a name.
  const told = voices.filter((v) => v.withOwner !== null);
  const overheard = told.length > 0 && !told.some((v) => v.withOwner);
  if (
    words < NAMING.minWords &&
    (overheard ||
      exchanges < NAMING.minExchanges ||
      seconds < NAMING.minSeconds)
  ) {
    return "stranger";
  }
  return cardOf(group, voices, seconds, exchanges);
}

function cardOf(
  group: string,
  voices: Voice[],
  seconds: number,
  exchanges: number
): Suggestion {
  const personId = mostOf(voices.flatMap((v) => v.people));
  return {
    conversations: new Set(voices.map((v) => v.conversationId)).size,
    evidence: voices.flatMap((v) => v.quotes).slice(0, NAMING.quotes),
    exchanges,
    id: group,
    kind: personId ? "known_person" : "new_person",
    name: mostOf(voices.flatMap((v) => v.names)),
    namedPersonId: null,
    personId,
    seconds: Math.round(seconds),
    voices: voices.map(({ conversationId, jobId, speakerLabel }) => ({
      conversationId,
      jobId,
      speakerLabel,
    })),
  };
}

export type Card = Suggestion & { clips: Clip[]; words: number };

// The voices to recheck: each speaker he named, judged without its own conversations
// (speakers.ts `soundsLikeOf`), the most doubtful first. A turn with its own answer is not the
// speaker's sample.
// ponytail: every named voice is judged again on each build (0.7 s for 700 of them, in the
// worker); keep each voice's verdict between builds if that grows.
function readRechecks(
  db: Db,
  reader: ReturnType<typeof readVoices>,
  clip: ReturnType<typeof readClip>
) {
  const rows = db
    .select()
    .from(speakerAssignments)
    .where(
      and(
        eq(speakerAssignments.source, "owner"),
        isNull(speakerAssignments.turnIndex),
        isNotNull(speakerAssignments.personId),
        isNull(speakerAssignments.candidates),
        eq(speakerAssignments.rechecked, false),
        sql`exists (select 1 from ${conversationJobs} c where c.job_id = ${speakerAssignments.jobId})`
      )
    )
    .all();
  const clipsOf = cardClips(db, reader, clip);
  return rows
    .flatMap((row) => {
      const samples = reader.samples([row]);
      const heard =
        row.personId &&
        recheckOf(
          samples,
          row.personId,
          reader.profiles,
          new Set(samples.map((s) => s.conversationId))
        );
      if (!heard) {
        return [];
      }
      const group = voiceId(row.jobId, row.speakerLabel);
      const voices = new Map<string, Voice>();
      for (const sample of samples) {
        const found = clip(sample);
        if (!found) {
          continue;
        }
        const voice =
          voices.get(found.conversationId) ??
          newVoice(
            found.conversationId,
            found.turn,
            row.speakerLabel,
            group,
            false
          );
        voice.seconds += found.turn.endSeconds - found.turn.startSeconds;
        voice.words.set(
          turnRef(row.jobId, sample.turnIndex),
          found.turn.words.length
        );
        voices.set(found.conversationId, voice);
      }
      if (!voices.size) {
        return [];
      }
      const members = [...voices.values()];
      const card: Suggestion = {
        ...cardOf(
          group,
          members,
          members.reduce((sum, v) => sum + v.seconds, 0),
          0
        ),
        kind: "recheck",
        namedPersonId: row.personId,
        personId: heard.personId,
      };
      return [
        {
          card: {
            ...card,
            clips: clipsOf(card),
            words: members.reduce(
              (sum, v) =>
                sum + [...v.words.values()].reduce((a, b) => a + b, 0),
              0
            ),
          },
          share: heard.share,
        },
      ];
    })
    .sort((a, b) => b.share - a.share)
    .map(({ card }) => card);
}

// Split groups are map-only cards; their members include every sample, even past the clip cut.
function readSplitCards(
  rows: (typeof speakerAssignments.$inferSelect)[],
  samples: (typeof voiceSamples.$inferSelect)[],
  clip: ReturnType<typeof readClip>
) {
  const byTurn = Map.groupBy(samples, (s) => turnRef(s.jobId, s.turnIndex));
  return [...Map.groupBy(rows, (r) => r.candidateId)].flatMap(
    ([group, members]) => {
      const voices: Voice[] = [];
      const clips: Clip[] = [];
      const memberSamples: (typeof voiceSamples.$inferSelect)[] = [];
      for (const row of members) {
        if (row.turnIndex === null) {
          continue;
        }
        const found = clip({ jobId: row.jobId, turnIndex: row.turnIndex });
        if (!found) {
          continue;
        }
        const voice = newVoice(
          found.conversationId,
          found.turn,
          row.speakerLabel,
          group ?? row.id,
          false
        );
        voice.seconds = found.turn.endSeconds - found.turn.startSeconds;
        voice.words.set(
          turnRef(row.jobId, row.turnIndex),
          found.turn.words.length
        );
        voices.push(voice);
        clips.push(found.clip);
        memberSamples.push(
          ...(byTurn.get(turnRef(row.jobId, row.turnIndex)) ?? [])
        );
      }
      const seconds = voices.reduce((sum, v) => sum + v.seconds, 0);
      const words = voices.reduce(
        (sum, v) => sum + [...v.words.values()].reduce((a, b) => a + b, 0),
        0
      );
      const card: Card = {
        // Map point/card ids are strings: turns/ reserves the split-group namespace.
        ...cardOf(`turns/${group}`, voices, seconds, 0),
        clips,
        words,
      };
      return clips.length
        ? [
            {
              card: { ...card, scope: "turns" as const },
              samples: memberSamples,
            },
          ]
        : [];
    }
  );
}

// The unnamed voices of conversation `id`, with what its summary said about them.
function voicesIn(db: Db, id: string, ownerId: string) {
  const loaded = loadTurns(db, id)?.turns ?? [];
  const jobs = [...new Set(loaded.map((t) => t.ref.jobId))];
  const assignments =
    jobs.length > 0
      ? db
          .select()
          .from(speakerAssignments)
          .where(inArray(speakerAssignments.jobId, jobs))
          .all()
      : [];
  const rows = assignments.filter((r) => r.turnIndex === null);
  const skippedTurns = readOwnTurns(db, assignments);
  const groups = new Map(
    rows.flatMap((r) =>
      r.source === "recognized" && r.candidateId && !r.mixed
        ? [[voiceId(r.jobId, r.speakerLabel), r.candidateId]]
        : []
    )
  );
  // The owner already answered for it, or it sounds like someone he said isn't anyone he knows:
  // never asked. One called several people (`mixed`) is asked again.
  const skipped = new Set(
    rows.flatMap((r) =>
      r.source === "owner" || isRejected(r)
        ? [voiceId(r.jobId, r.speakerLabel)]
        : []
    )
  );
  const mixed = new Set(
    rows.flatMap((r) => (r.mixed ? [voiceId(r.jobId, r.speakerLabel)] : []))
  );
  const run = latestValid(db, id);
  // A mixed voice is asked about named or not.
  const turns = loaded.map((t) =>
    mixed.has(voiceId(t.ref.jobId, t.speakerLabel ?? ""))
      ? { ...t, person: null }
      : t
  );
  const mine = voicesOf(
    id,
    turns,
    ownerId,
    groups,
    skipped,
    skippedTurns,
    mixed
  );
  heardIn(run?.result ?? null, run?.turns ?? [], loaded, mine);
  return [...mine.values()];
}

// The owner person, whose turns "talks with the owner" counts against.
const ownerOf = (db: Db) =>
  db.query.people.findFirst({ where: eq(people.isOwner, true) }).sync();

// Unnamed voices as cards with the words naming them unlocks; media and brief strangers get none. A group
// spans conversations (and days) through its unnamed group.
function suggest(
  db: Db,
  voices: Voice[],
  reader: ReturnType<typeof readVoices>
) {
  // A card no summary tied to a person may still sound like one, the owner included: then it
  // asks "Is this X?" rather than calling them new.
  const soundsLike = reader.match;
  const everyone = db.select().from(people).all();
  // A heard name that is already the person's says nothing new ("Jojo" for Marie-Jo): no name.
  const news = (name: string | null, personId: string) => {
    const person = everyone.find((p) => p.id === personId);
    return name && person && isCalled(person, name) ? null : name;
  };
  const suggestions = [...Map.groupBy(voices, (v) => v.group)].flatMap(
    ([group, members]) => {
      const words = [
        ...new Map(members.flatMap((v) => [...v.words])).values(),
      ].reduce((sum, count) => sum + count, 0);
      const verdict = judge(group, members, words);
      return typeof verdict === "string"
        ? []
        : [
            {
              card: ((): Suggestion => {
                const personId = verdict.personId ?? soundsLike(verdict.voices);
                return personId && verdict.kind !== "several"
                  ? {
                      ...verdict,
                      kind: "known_person" as const,
                      name: news(verdict.name, personId),
                      personId,
                    }
                  : verdict;
              })(),
              words,
            },
          ];
    }
  );
  return suggestions;
}

// Every live conversation, including historical voices still waiting for a name.
const conversationsOf = (db: Db) =>
  db
    .select({ id: conversations.id })
    .from(conversations)
    .where(live)
    .all()
    .map((c) => c.id);

// Only eligible, returned cards get clips. Playable cards come first, then the most words a
// name unlocks, so the first card is useful to hear and to answer.
function cardsOf(
  db: Db,
  voices: Voice[],
  reader: ReturnType<typeof readVoices>,
  clip: ReturnType<typeof readClip>
) {
  const clipsOf = cardClips(db, reader, clip);
  return suggest(db, voices, reader)
    .map(({ card, words }) => ({
      card: { ...card, clips: clipsOf(card) },
      words,
    }))
    .sort(
      (a, b) =>
        Number(b.card.clips.some((c) => c.audio || c.at)) -
          Number(a.card.clips.some((c) => c.audio || c.at)) || b.words - a.words
    )
    .map(({ card, words }) => ({ ...card, words }));
}

// A split row is a recognized, unnamed turn in a candidate group, not a label or owner row.
const isSplitRow = (row: typeof speakerAssignments.$inferSelect) =>
  row.source === "recognized" &&
  row.turnIndex !== null &&
  row.candidateId !== null &&
  row.personId === null;

export function readVoiceMap(
  db: Db,
  cards: Card[],
  reader = readVoices(db),
  clip = readClip(db)
) {
  // Only split members need a separate read; speaker-card samples were decoded by the queue.
  const rows = db.select().from(speakerAssignments).all();
  const splitRows = rows.filter(isSplitRow);
  const samples = splitRows.length
    ? db
        .select()
        .from(voiceSamples)
        .where(
          // SQL form of isSplitRow: filter before decoding embeddings.
          sql`exists (select 1 from ${speakerAssignments} a where a.job_id = ${voiceSamples.jobId}
      and a.turn_index = ${voiceSamples.turnIndex} and a.source = 'recognized'
      and a.candidate_id is not null and a.person_id is null)`
        )
        .all()
    : [];
  return readVoiceProjection(
    db,
    [
      ...cards.map((card) => ({
        card: { ...card, scope: "speaker" as const },
        samples: reader.samples(card.voices),
      })),
      ...readSplitCards(splitRows, samples, clip),
    ],
    reader.profiles
  );
}

// The voices to name: unnamed voices that talked with the owner or hold enough words, one card
// per voice group across conversations and days. Its id is the group, or the voice's own id.
// An answer leaves no state here: the
// owner's rows keep its voices out of the next build. Empty without an owner person.
// Kept between reads: built again when the change log or live conversations moved, reading again
// only the voices of the conversations the changes touched (`touchedSince`; an answer logs its
// speaker rows, so its voices never come back). The cards are made again from every voice, since
// a change may be about a person or a profile. A fresh cache's first read is the full build.
// One incremental queue per read-only worker.

export function namingQueue(db: Db) {
  let kept: {
    items: ReturnType<typeof cardsOf>;
    rechecks: Card[];
    reader: ReturnType<typeof readVoices>;
    clip: ReturnType<typeof readClip>;
    ownerId: string;
    seen: number;
    voices: Map<string, Voice[]>;
  } | null = null;
  return {
    // A failed build throws, keeps what was there, and is retried by the next read.
    items() {
      const owner = ownerOf(db);
      if (!owner) {
        kept = null;
        return [];
      }
      const last = kept?.ownerId === owner.id ? kept : null;
      const touched = touchedSince(db, last?.seen ?? null);
      const ids = conversationsOf(db);
      const before = last?.voices ?? new Map<string, Voice[]>();
      if (
        last &&
        touched.through === last.seen &&
        ids.length === before.size &&
        ids.every((id) => before.has(id))
      ) {
        return last.items;
      }
      const again = new Set(touched.ids ?? ids);
      const voices = new Map(
        ids.map((id) => [
          id,
          (!again.has(id) && before.get(id)) || voicesIn(db, id, owner.id),
        ])
      );
      const reader = readVoices(db);
      const clip = readClip(db);
      kept = {
        clip,
        items: cardsOf(db, [...voices.values()].flat(), reader, clip),
        ownerId: owner.id,
        reader,
        rechecks: readRechecks(db, reader, clip),
        seen: touched.through,
        voices,
      };
      return kept.items;
    },
    // The worker calls this after items(), reusing that build's parsed samples and clips.
    projection() {
      const items = this.items();
      return readVoiceMap(db, items, kept?.reader, kept?.clip);
    },
    rechecks() {
      this.items();
      return kept?.rechecks ?? [];
    },
  };
}

export type CardAnswer =
  | { kind: "confirm"; name: string }
  | { kind: "assign"; personId: string }
  | { kind: "ignore" }
  | { kind: "media" }
  | { kind: "several"; people: string[]; unknown: boolean };

// The person an answer already names: the one picked, or the one whose name or alias the owner
// typed, so a nickname never makes a second person.
function existingPerson(db: Db, action: CardAnswer) {
  if (action.kind === "assign") {
    return action.personId;
  }
  if (action.kind !== "confirm") {
    return null;
  }
  // ponytail: every person read to match in JS (Unicode case); a few hundred rows at most.
  const everyone = db.select().from(people).all();
  return everyone.find((p) => isCalled(p, action.name))?.id ?? null;
}

// "Several people": who, named passage by passage in place, and the one besides the owner to
// fall back on in a closed set (owner, Oct 15).
export function severalTarget(
  db: Db,
  { people: ids, unknown }: { people: string[]; unknown: boolean }
): Target {
  const chosen = db.select().from(people).where(inArray(people.id, ids)).all();
  const [other, more] = chosen.filter((p) => !p.isOwner);
  return {
    candidates: { people: chosen.map((p) => p.id).sort(), unknown },
    kind: "several",
    personId: unknown || more ? null : (other?.id ?? null),
  };
}

// The owner's answer for a group of voices: a new person named `name`, the person `personId`,
// nobody they know, a video or TV playing (left out of summaries and search, never evidence), or
// several people. Each voice becomes the owner's correction of a whole speaker, so voice evidence
// moves as it always does. Returns the person they went to, or
// null when no voice is a speaker of its transcript.
export function answerVoices(
  db: Db,
  voices: Pick<Suggestion["voices"][number], "jobId" | "speakerLabel">[],
  action: CardAnswer
) {
  const several = action.kind === "several" ? severalTarget(db, action) : null;
  let personId = existingPerson(db, action);
  let answered = 0;
  for (const voice of voices) {
    let target: Target = { kind: "unknown" };
    if (several) {
      target = several;
    } else if (action.kind === "media") {
      target = { kind: "media" };
    } else if (personId) {
      target = { kind: "person", personId };
    } else if (action.kind === "confirm") {
      target = { id: randomUUID(), kind: "new", name: action.name };
    }
    const rows = assign(db, {
      jobId: voice.jobId,
      speakerLabel: voice.speakerLabel,
      target,
      turnIndex: null,
    });
    if (!Array.isArray(rows)) {
      continue;
    }
    answered += 1;
    if (target.kind === "new") {
      personId =
        rows.find(
          (r) => r.speakerLabel === voice.speakerLabel && r.turnIndex === null
        )?.personId ?? null;
    }
  }
  record(db, "voices.answered", {
    action: action.kind,
    voices: answered,
  });
  return answered > 0 ? { personId } : null;
}

// Once a morning, from NAMING.hour in the owner's zone: one notification with how many voices wait
// to be named, the queue's length, which is the number the app's badge shows. Nothing when none
// waits. Recorded as an event, so a restart the same morning sends nothing twice.
// ponytail: in-process, polled by the server's 5-minute loop; one replica, like the others.
export function morningPush(
  db: Db,
  push: Pusher | null,
  bundleId: string,
  queue: { items: () => Card[] | Promise<Card[]> }
) {
  let busy = false;
  const notify = (day: string, count: number) =>
    sendPush(
      db,
      push,
      "people_digest",
      alertOf(
        bundleId,
        "New people",
        `${count} ${count === 1 ? "voice" : "voices"} to name.`,
        { peopleDigest: day }
      )
    );
  return {
    async morning(at = clock()) {
      const { date, hour } = ownerClock(at);
      if (busy || hour < NAMING.hour) {
        return null;
      }
      busy = true;
      try {
        if (recordedOn(db, "voices.digest", date)) {
          return null;
        }
        const count = (await queue.items()).length;
        record(db, "voices.digest", { count, day: date });
        if (count > 0) {
          await notify(date, count);
        }
        return { count };
      } finally {
        busy = false;
      }
    },
  };
}
export type MorningPush = ReturnType<typeof morningPush>;
