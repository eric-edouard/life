import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execOk } from "../core/proc";
import { BRIDGES } from "../sources/matrix";
import type { Network } from "../sources/networks";

// A bridge that exits until he fills in his own keys (`appKeys` in `NETWORKS`): which keys are still the example's.

export const readYaml = (path: string) =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
export const configPath = (n: Network) => join(BRIDGES, n.name, "config.yaml");

const valueAt = (c: unknown, path: string) =>
  path
    .split(".")
    .reduce<unknown>(
      (o, k) => (o as Record<string, unknown> | undefined)?.[k],
      c
    );

/** The keys still holding the example config's value (a placeholder), and whether that value is a number. */
export const pendingKeysOf = (
  paths: readonly string[],
  config: unknown,
  example: unknown
) =>
  paths
    .filter((p) => valueAt(config, p) === valueAt(example, p))
    .map((path) => ({
      isNumber: typeof valueAt(example, path) === "number",
      path,
    }));

/** Its `appKeys` still the example's: the example is the one the bridge itself writes (`-e`), so Life holds no placeholder. */
export async function pendingAppKeys(n: Network) {
  if (!n.appKeys) {
    return [];
  }
  const tmp = mkdtempSync(join(tmpdir(), "bridge-example-"));
  try {
    const example = join(tmp, "config.yaml");
    await execOk([join(BRIDGES, n.name, "bridge"), "-c", example, "-e"], {
      cwd: tmp,
    });
    return pendingKeysOf(
      n.appKeys.paths,
      readYaml(configPath(n)),
      readYaml(example)
    );
  } finally {
    rmSync(tmp, { force: true, recursive: true });
  }
}

/** A bridge that exits until he fills in its keys: its login can't be waited for (the one job restarts it every 10 s). */
export const needsAppKeys = async (n: Network) =>
  (await pendingAppKeys(n)).length > 0;
