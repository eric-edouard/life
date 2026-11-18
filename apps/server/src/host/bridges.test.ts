import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { untilAnswers } from "../core/proc";
import { pendingKeysOf, RUN_BRIDGES, withKeys } from "./bridges";

// A made-up program: says it started, and that it was stopped on TERM.
const program = (name: string) =>
  `#!/bin/sh\ntouch "$OUT/${name}.started"\ntrap 'touch "$OUT/${name}.stopped"; exit 0' TERM\nwhile :; do sleep 0.1; done\n`;

function put(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  chmodSync(path, 0o755);
}

test("the one job runs the homeserver and every added bridge, and stops each on TERM", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bridges-"));
  const out = join(dir, "out");
  mkdirSync(out);
  put(join(dir, "synapse", ".venv", "bin", "python"), program("synapse"));
  put(join(dir, "line", "bridge"), program("line"));
  put(join(dir, "line", "config.yaml"), "");
  put(join(dir, "gone", "bridge"), program("gone")); // no config: not added
  const job = Bun.spawn(["/bin/sh", "-c", RUN_BRIDGES], {
    cwd: dir,
    env: { ...process.env, OUT: out },
  });
  const has = (f: string) => existsSync(join(out, f));
  await untilAnswers(
    async () => (has("synapse.started") && has("line.started")) || undefined,
    "the made-up programs",
    5
  );
  expect(has("gone.started")).toBe(false);
  job.kill("SIGTERM");
  await job.exited;
  expect(has("synapse.stopped") && has("line.stopped")).toBe(true);
});

test("a key still the example's is pending; one he set is not; writing keys keeps the rest of the config", () => {
  const example = { network: { api_hash: "x", api_id: 1, device: "d" } };
  const keys = ["network.api_id", "network.api_hash"];
  expect(pendingKeysOf(keys, example, example)).toEqual([
    { isNumber: true, path: "network.api_id" },
    { isNumber: false, path: "network.api_hash" },
  ]);
  const set = withKeys(example, {
    "network.api_hash": "abcdef0123",
    "network.api_id": 123_456,
  });
  expect(pendingKeysOf(keys, set, example)).toEqual([]);
  expect(set).toEqual({
    network: { api_hash: "abcdef0123", api_id: 123_456, device: "d" },
  });
  expect(example.network.api_id).toBe(1);
});
