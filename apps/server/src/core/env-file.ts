// A keys file's `NAME=value` lines (`SECRETS.env`), with no other import: the voice server reads the same file.
const LINE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** The keys in `text`, by name; any other line is skipped. */
export const parseEnvFile = (text: string): Record<string, string> =>
  Object.fromEntries(
    text.split("\n").flatMap((l) => {
      const m = LINE.exec(l);
      return m ? [[m[1], m[2]]] : [];
    })
  );
