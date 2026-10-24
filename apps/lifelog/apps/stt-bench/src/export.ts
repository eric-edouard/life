// The archive, read-only (DATABASE_PATH and AUDIO_DIR, as in Lifelog Host's server.env): the completed
// jobs with stored audio, and Scribe's stored words of some of them.
import { join } from "node:path";
import { connect } from "@lifelog/db";
import { transcriptionJobs, transcripts } from "@lifelog/db/schema";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { THAI, tokens } from "./score";

const LATIN = /[A-Za-zÀ-ÖØ-öø-ÿ]/;

function env(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name} as Lifelog Host's server.env does`);
  }
  return value;
}

type Archive = ReturnType<typeof connect>;

function read<T>(query: (db: Archive) => T) {
  const db = connect(env("DATABASE_PATH"), { readonly: true });
  try {
    return query(db);
  } finally {
    db.$client.close(true);
  }
}

const joined = (db: Archive) =>
  db
    .select({
      captureStart: transcriptionJobs.captureStart,
      id: transcriptionJobs.id,
      key: transcriptionJobs.objectKey,
      language: transcripts.languageCode,
      parsed: transcripts.parsed,
      seconds: transcriptionJobs.preparedDurationSeconds,
    })
    .from(transcriptionJobs)
    .innerJoin(transcripts, eq(transcripts.jobId, transcriptionJobs.id));

// One row per job: no text, only counts (its words in Latin and Thai script, and in each list).
export function jobRows(en: readonly string[], fr: readonly string[]) {
  const rows = read((db) =>
    joined(db)
      .where(
        and(
          eq(transcriptionJobs.state, "completed"),
          isNotNull(transcriptionJobs.objectKey)
        )
      )
      .all()
  );
  return rows.map(({ captureStart, id, language, parsed, seconds }) => {
    const { words } = parsed;
    const said = words.flatMap((w) => tokens(w.text));
    const count = (keep: (text: string) => boolean) =>
      words.filter((w) => keep(w.text)).length;
    return {
      captureStart: captureStart?.toISOString() ?? "",
      en: said.filter((t) => en.includes(t)).length,
      fr: said.filter((t) => fr.includes(t)).length,
      id,
      language,
      latin: count((t) => LATIN.test(t)),
      seconds,
      speakers: new Set(words.map((w) => w.speakerId).filter(Boolean)).size,
      thai: count((t) => THAI.test(t)),
    };
  });
}

// Scribe's stored words of those jobs, and where each job's audio is (keys come from the archive).
export function storedWords(ids: string[]) {
  const dir = env("AUDIO_DIR");
  const rows = read((db) =>
    joined(db).where(inArray(transcriptionJobs.id, ids)).all()
  );
  return rows.map((r) => ({
    audio: join(dir, r.key ?? ""),
    id: r.id,
    words: r.parsed.words,
  }));
}
