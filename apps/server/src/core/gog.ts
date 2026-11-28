import { existsSync, readFileSync } from "node:fs";
import { cached } from "./cached";
import { MIN } from "./clock";
import { log } from "./log";
import { errorOf } from "./log-line";
import { exec } from "./proc";
import { SECRETS } from "./secret";

/** What Life runs gog for: his accounts (the sign-in), the calendar, Gmail send, Google Tasks, Google Contacts. */
export type GogKind = "auth" | "calendar" | "contacts" | "gmail" | "tasks";

/**
 * gog's keyring password: this process's own `GOG_KEYRING_PASSWORD`, else the one `connectGoogle` made and Life keeps
 * in `SECRETS.gogKeyring`, else none. Found here alone, so a keyring never gets a second password (`connect-google.ts`).
 */
export function gogKeyringPassword(): string | undefined {
  const own = process.env.GOG_KEYRING_PASSWORD?.trim();
  if (own) {
    return own;
  }
  const kept = existsSync(SECRETS.gogKeyring)
    ? readFileSync(SECRETS.gogKeyring, "utf8").trim()
    : "";
  return kept || undefined;
}

/** The client Life's OAuth credentials and tokens live under (gog's `--client`), unless a process names its own. */
export const gogClient = () => process.env.GOG_CLIENT?.trim() || "life";

/**
 * The one way Life runs `gog` (his accounts, the calendar, Gmail, Google Tasks, Contacts): its command line and
 * environment, as `exec`'s two arguments. The keyring is a file (`GOG_KEYRING_BACKEND`), never a Keychain item: the
 * app's helper has no shell profile, and macOS blocks on the prompt a new item raises. `account` is left out for a call
 * that names none (`auth list`); `auth add` keeps its prompts, since it opens his browser for the sign-in.
 */
export function gogCall(
  kind: GogKind,
  account: string | undefined,
  args: string[]
): [string[], { env: Record<string, string | undefined> }] {
  const env: Record<string, string | undefined> = {
    ...process.env,
    GOG_CLIENT: gogClient(),
    GOG_KEYRING_BACKEND: "file",
  };
  const password = gogKeyringPassword();
  if (password) {
    env.GOG_KEYRING_PASSWORD = password;
  }
  const signingIn = kind === "auth" && args[0] === "add";
  return [
    [
      "gog",
      kind,
      ...args,
      ...(account ? [`--account=${account}`] : []),
      "--json",
      ...(signingIn ? [] : ["--no-input"]),
    ],
    { env },
  ];
}

/** An account gog holds under Life's OAuth client, as `gog auth list --check --json` gives it. */
export interface GoogleAccount {
  /** Its address, as gog reports it. */
  address: string;
  /** Its granted scopes, as their full URLs: a read that needs one checks it here. */
  scopes: string[];
  /** The services it was authorized for (`gmail`, `calendar`, `tasks`, …). */
  services: string[];
  /** Whether gog could still exchange its refresh token for an access token (the `--check`). */
  valid: boolean;
}

/** The accounts in `gog auth list --check --json`'s answer, one per address it holds. */
export function googleAccountsOf(text: string): GoogleAccount[] {
  const answer = JSON.parse(text.trim() || "{}") as {
    accounts?: {
      email?: string;
      scopes?: string[];
      services?: string[];
      valid?: boolean;
    }[];
  };
  return (answer.accounts ?? []).flatMap((a) =>
    a.email
      ? [
          {
            address: a.email,
            scopes: a.scopes ?? [],
            services: a.services ?? [],
            valid: a.valid !== false,
          },
        ]
      : []
  );
}

const ACCOUNTS_MS = 5 * MIN;
let accounts: GoogleAccount[] = [];

/**
 * The accounts gog holds under Life's OAuth client, each with whether its token still works and the scopes gog reports:
 * one read per 5 minutes, its answer also kept for the callers that can't wait (`latestGoogleAccounts`). A read that
 * fails is logged and reads as no accounts: a status read never throws.
 */
export const readGoogleAccounts = (): Promise<GoogleAccount[]> =>
  cached("gog accounts", ACCOUNTS_MS, async () => {
    accounts = await readAccountsNow();
    return accounts;
  });

/** The accounts as `readGoogleAccounts` last read them, for a caller that can't wait (his own mail addresses). */
export const latestGoogleAccounts = () => accounts;

async function readAccountsNow() {
  // No password means no keyring yet, so no account: the first `connectGoogle` makes it, and until then this is no call.
  if (!gogKeyringPassword()) {
    return [];
  }
  try {
    const r = await exec(...gogCall("auth", undefined, ["list", "--check"]));
    if (r.code !== 0) {
      throw new Error((r.stderr || r.stdout).trim().slice(-300));
    }
    return googleAccountsOf(r.stdout);
  } catch (e) {
    log("source.read", {
      ...errorOf(e),
      ok: false,
      source: "google accounts",
    });
    return [];
  }
}
