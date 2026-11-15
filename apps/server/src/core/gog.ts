import { existsSync, readFileSync } from "node:fs";
import { SECRETS } from "./secret";

/**
 * The one way Life runs `gog` (Google Calendar, Google Tasks): its command line and environment, as `exec`'s two
 * arguments. gog keeps its tokens in a file keyring that needs `GOG_KEYRING_PASSWORD`; Life.app's helper has no shell
 * profile, so the password comes from `SECRETS.gogKeyring` (`bun life gog-keyring`) unless the process already has one.
 */
export function gogCall(
  kind: "calendar" | "tasks",
  account: string,
  args: string[]
): [string[], { env: Record<string, string | undefined> }] {
  const env: Record<string, string | undefined> = { ...process.env };
  if (!env.GOG_KEYRING_PASSWORD && existsSync(SECRETS.gogKeyring)) {
    env.GOG_KEYRING_PASSWORD = readFileSync(SECRETS.gogKeyring, "utf8").trim();
  }
  return [
    ["gog", kind, ...args, `--account=${account}`, "--json", "--no-input"],
    { env },
  ];
}
