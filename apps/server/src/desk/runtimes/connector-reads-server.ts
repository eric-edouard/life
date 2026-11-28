// The connector's reads for a second Life's agents: whether they get them (a frozen copy's only) and the stdio server
// that serves them (`life connector-reads`), given by every runtime the same way.

import { join } from "node:path";
import { isFrozenCopy } from "../../core/clock";
import {
  IS_COMPILED_HELPER,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
} from "../../core/paths";

/**
 * Whether a second Life's agents read that Life (the connector's reads, `connectorReadsOf`, beside their door): only a
 * frozen copy measured (a question case's, `isFrozenCopy`). A demo's made-up Life keeps its door alone: some reads reach
 * the Mac's own stores (its contacts), which are his, not the demo's.
 */
export const isSecondLifeReading = () => isFrozenCopy();

/** The secrets the connector's reads use, from the desk's own environment: never on a command line (`connectorReadsOf`). */
const READER_SECRETS = ["GOG_KEYRING_PASSWORD", "LIFELOG_TOKEN"];
const envOf = (keep: (name: string) => boolean) =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      (e): e is [string, string] => e[1] !== undefined && keep(e[0])
    )
  );

/**
 * The connector's reads as a stdio MCP server (`life connector-reads`): the compiled helper itself in the app, the CLI's
 * entry in a checkout, with Life's paths (`LIFE_*`) and the test switch in `env`, and the secrets its reads use apart in
 * `secrets`, values as they are: a runtime that writes its MCP servers into its program's arguments (Claude Code's
 * `--mcp-config`) gives them to the program's environment instead, which its servers inherit. A runtime runs it with
 * its own environment beside this one, so the helper is told it is not bun (`BUN_BE_BUN`).
 */
export const connectorReadsOf = () => {
  const env = envOf((n) => n.startsWith("LIFE_") || n === "NODE_ENV");
  return {
    args: [
      ...(IS_COMPILED_HELPER
        ? []
        : [
            join(
              LIFE_CODE_DIR,
              "apps",
              "server",
              "src",
              "desk",
              "life-entry.ts"
            ),
          ]),
      "connector-reads",
    ],
    command: process.execPath,
    // Life's state, never the agent's folder: bun reads a folder's `.env` and `bunfig.toml` at start.
    cwd: LIFE_STATE_DIR,
    env: { ...env, BUN_BE_BUN: "" },
    secrets: envOf((n) => READER_SECRETS.includes(n)),
  };
};
