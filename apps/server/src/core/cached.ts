// A read redone at most every `ms`; a read that may fail, its error kept rather than thrown.

const memo = new Map<string, { at: number; value: Promise<unknown> }>();

/** The read's value, redone at most every `ms` (the status stream asks every few seconds, the push every minute). */
export function cached<T>(key: string, ms: number, read: () => Promise<T> | T) {
  const now = performance.now();
  const hit = memo.get(key);
  if (hit && now - hit.at < ms) {
    return hit.value as Promise<T>;
  }
  const value = Promise.resolve().then(read);
  memo.set(key, { at: now, value });
  return value;
}

/** A read that may fail: its error, never a throw (one broken store never blanks the status snapshot). */
export async function safe<T>(read: () => Promise<T> | T) {
  try {
    return { ok: true as const, value: await read() };
  } catch (e) {
    return { error: (e as Error).message, ok: false as const };
  }
}
