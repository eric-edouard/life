// The audio of every transcription job, kept in a bucket (S3 API) or, without one, on this
// machine's disk (AUDIO_DIR). A key names one audio, so storing it twice is a no-op. Services
// inject it like the other outside systems (services.ts): the server needs one to boot
// (index.ts); tests keep it in memory.
import { randomUUID } from "node:crypto";
import { rename, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { S3Client } from "bun";
import type { Config } from "./config";

export interface AudioStore {
  // Removes the object; none is no error. The backup's retention of old snapshots, a withdrawn
  // job (jobs.ts `withdraw`) and fragments once joined or withdrawn (cutter.ts) call it.
  delete: (key: string) => Promise<void>;
  // The object's bytes, or null when there is none.
  get: (key: string) => Promise<Uint8Array | null>;
  // Stores the bytes unless the key already holds an object. Throws when the store is down.
  put: (key: string, bytes: Uint8Array, type?: string) => Promise<void>;
}

// An upload from before blocks, by its hash; a block, by its source and first page.
export const audioKey = (audioSha256: string) => `jobs/${audioSha256}.ogg`;
const BLOCKS = "blocks/";
export const blockKey = (sourceId: string, firstPage: number, sha: string) =>
  `${BLOCKS}${sourceId}/${firstPage}-${sha}.ogg`;
// A block's audio, checked against the quiet ranges; an old job's may hold dictation from
// before the Mac kept them. The cutter stores each job it joins from fragments as a block.
export const isBlockKey = (key: string) => key.startsWith(BLOCKS);
// A speech fragment, by its source, first page and audio, until its block closes (cutter.ts).
export const fragmentKey = (sourceId: string, firstPage: number, sha: string) =>
  `fragments/${sourceId}/${firstPage}-${sha}.ogg`;

// A batch of a thin phone's raw pages, by its source, first page and bytes (pages.ts).
export const pagesKey = (sourceId: string, firstPage: number, sha: string) =>
  `pages/${sourceId}/${firstPage}-${sha}.bin`;

const allSet = <T extends object>(
  settings: T
): settings is { [K in keyof T]: NonNullable<T[K]> } =>
  Object.values(settings).every(Boolean);

// The bucket when S3_* is set, else the disk under AUDIO_DIR. Throws with neither, or with only
// part of the bucket's settings: audio kept in memory is lost at the next restart.
export function audioStore(config: Config): AudioStore {
  const settings = {
    accessKeyId: config.S3_ACCESS_KEY_ID,
    bucket: config.S3_BUCKET,
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    secretAccessKey: config.S3_SECRET_ACCESS_KEY,
  };
  if (config.AUDIO_DIR && !Object.values(settings).some(Boolean)) {
    return diskAudioStore(config.AUDIO_DIR);
  }
  if (!allSet(settings)) {
    throw new Error(
      "Set AUDIO_DIR, or all of S3_ACCESS_KEY_ID, S3_BUCKET, S3_ENDPOINT, S3_REGION and S3_SECRET_ACCESS_KEY: every job's audio is kept"
    );
  }
  const client = new S3Client(settings);
  return {
    delete: async (key) => {
      await client.file(key).delete();
    },
    get: async (key) => {
      const file = client.file(key);
      return (await file.exists()) ? file.bytes() : null;
    },
    put: async (key, bytes, type = "audio/ogg") => {
      const file = client.file(key);
      if (!(await file.exists())) {
        await file.write(bytes, { type });
      }
    },
  };
}

// An audio key's file under `dir`. Refused when absolute or with `..` between either separator (Windows reads `\` as
// one too).
const SEPARATOR = /[\\/]/;
export function keyPath(dir: string, key: string) {
  if (isAbsolute(key) || key.split(SEPARATOR).includes("..")) {
    throw new Error(`not an audio key: ${key}`);
  }
  return join(dir, key);
}

// The audio on this machine's disk, under `dir`. A write goes to a temporary name and is renamed
// into place (Bun.write makes the folders), so a key never holds half a file. A key with `..` is
// refused, behind the routes' `SourceId`. ponytail: no fsync; a power cut can lose the newest file (a fragment lost that way is
// withdrawn and sent again, cutter.ts); fsync if a job's audio is ever lost.
export function diskAudioStore(dir: string): AudioStore {
  const path = (key: string) => keyPath(dir, key);
  return {
    delete: (key) => rm(path(key), { force: true }),
    get: async (key) => {
      const file = Bun.file(path(key));
      return (await file.exists()) ? file.bytes() : null;
    },
    put: async (key, bytes) => {
      const to = path(key);
      if (await Bun.file(to).exists()) {
        return;
      }
      const part = `${to}.${randomUUID()}.part`;
      await Bun.write(part, bytes);
      await rename(part, to);
    },
  };
}

const BYTE_RANGE = /^bytes=(\d+)-(\d*)$/;

// The bytes of an HTTP `Range: bytes=a-b` or `bytes=a-` header (inclusive), or null to send the whole.
export function byteRange(header: string | undefined, length: number) {
  const asked = BYTE_RANGE.exec(header ?? "");
  const start = Number(asked?.[1]);
  const end = Math.min(asked?.[2] ? Number(asked[2]) : length, length - 1);
  return asked && start <= end ? { end, start } : null;
}

// Stores an upload under `key`; false when the bucket failed, and the caller admits nothing.
export async function storeAudio(
  store: AudioStore,
  key: string,
  bytes: Uint8Array,
  type?: string
) {
  try {
    await store.put(key, bytes, type);
    return true;
  } catch (error) {
    console.error(`storing audio ${key}: ${String(error)}`);
    return false;
  }
}

// The bucket in memory, for tests and the OpenAPI script. `down` makes every
// call throw, as an unreachable bucket does; `writes` counts the objects actually written.
export function memoryAudioStore() {
  const objects = new Map<string, Uint8Array>();
  const reach = () => {
    if (audio.down) {
      throw new Error("bucket unreachable");
    }
  };
  const audio: AudioStore & {
    down: boolean;
    objects: typeof objects;
    writes: number;
  } = {
    delete: (key) => {
      reach();
      objects.delete(key);
      return Promise.resolve();
    },
    down: false,
    get: (key) => {
      reach();
      return Promise.resolve(objects.get(key) ?? null);
    },
    objects,
    put: (key, bytes) => {
      reach();
      if (!objects.has(key)) {
        objects.set(key, bytes);
        audio.writes += 1;
      }
      return Promise.resolve();
    },
    writes: 0,
  };
  return audio;
}
