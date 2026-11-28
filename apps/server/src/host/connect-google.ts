import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MIN } from "../core/clock";
import { gogCall, gogClient, gogKeyringPassword } from "../core/gog";
import { LIFE_CODE_DIR } from "../core/paths";
import { exec } from "../core/proc";
import { writeSecret } from "../core/secret";
import { isMailAddress } from "../sources/gmail";
import { CONTACTS_SCOPE } from "../sources/google-contacts";

// Connect Google: one of the owner's Google accounts signed in through gog, so Life can read Gmail, his Google
// calendar and his Google Contacts, and send mail from that address (`bun life connect-google <address>`). It is not
// the `gmail` source, which reads and sends, nor a setting: who is signed in is gog's own list (`readGoogleAccounts`).
// Privacy: the sign-in goes between this computer and Google; the tokens stay in gog's file keyring on this computer,
// never at Life's developer, and what Life reads with them reaches only the AI he chose (SECURITY.md).

/** How long the sign-in is given: gog's own `--timeout=5m` for his answer in the browser, and a moment more. */
const AUTH_MS = 6 * MIN;

/** What a gog call answered (the fields `connectGoogle` reads). */
export interface GogRun {
  code: number;
  stderr: string;
  stdout: string;
}

/** What `connectGoogle` runs gog through, and the client JSON this build carries; a test passes both. */
export interface ConnectOptions {
  /** The JSON `scripts/app.ts` copied in, `<LIFE_CODE_DIR>/google-client.json` by default. */
  clientFile?: string;
  run?: (
    cmd: string[],
    o: { env: Record<string, string | undefined>; timeout: number }
  ) => Promise<GogRun>;
}

/**
 * Signs `address` in: gog holds a keyring password (made here once, if Life has none yet) and an OAuth client under
 * Life's own name (`gogClient`, from this build's JSON unless he stored his own), then gog opens his browser for
 * Google's consent. Everything goes through `gogCall`, so `core/gog.ts` stays the one place naming gog.
 */
export async function connectGoogle(
  address: string,
  o: ConnectOptions = {}
): Promise<void> {
  if (!isMailAddress(address)) {
    throw new Error(`"${address}" isn't a mail address.`);
  }
  const run = o.run ?? ((cmd, opts) => exec(cmd, opts));
  /** One `gog auth` call, its output; a failure is gog's own words. */
  const call = async (args: string[], timeout = MIN) => {
    const [cmd, { env }] = gogCall("auth", undefined, args);
    const r = await run(cmd, { env, timeout });
    if (r.code !== 0) {
      throw new Error(
        `gog ${args.slice(0, 2).join(" ")}: ${(r.stderr || r.stdout).trim().slice(-300)}`
      );
    }
    return r.stdout;
  };
  // The keyring's password is made once and read later as `gogCall` finds it: a second one would lose the tokens.
  if (!gogKeyringPassword()) {
    writeSecret("gogKeyring", randomBytes(32).toString("base64url"));
  }
  // Life's OAuth client, in gog's own bucket: a client he stored himself under that name stays.
  const client = gogClient();
  const listed = JSON.parse(
    (await call(["credentials", "list"])).trim() || "{}"
  ) as {
    clients?: { client?: string }[];
  };
  if (!(listed.clients ?? []).some((c) => c.client === client)) {
    const file = o.clientFile ?? join(LIFE_CODE_DIR, "google-client.json");
    if (!existsSync(file)) {
      throw new Error(
        `This build has no Google client: store your own with \`gog auth credentials set <file> --client ${client}\`, then run this again.`
      );
    }
    await call(["credentials", "set", file, `--client=${client}`]);
  }
  // His sign-in, in his own browser on a loopback port: no `--no-input`, which would stop gog from opening it.
  await call(
    [
      "add",
      address,
      "--services=gmail,calendar,tasks",
      "--gmail-scope=read-send",
      `--extra-scopes=${CONTACTS_SCOPE}`,
      "--force-consent",
      "--timeout=5m",
    ],
    AUTH_MS
  );
}
