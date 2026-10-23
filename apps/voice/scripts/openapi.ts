// Writes openapi.json for the iOS client to mirror (enums, shapes): `bun run openapi`.
// `--check` writes nothing and fails when the committed file is stale (the gate runs it).

import { schema } from "@life/voice-db";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { createApp, openApiDocument } from "../src/app";
import { loadConfig } from "../src/config";
import { services } from "../src/services";

const config = loadConfig({
  DATABASE_PATH: ":memory:",
  DEVICE_TOKEN_HASH: "0".repeat(64),
  ELEVENLABS_API_KEY: "unused",
  PUBLIC_BASE_URL: "https://lifelog.invalid",
});
const app = createApp(services(config, drizzle.mock({ schema })));
const path = `${import.meta.dir}/../openapi.json`;
const document = openApiDocument(app, config);
if (process.argv.includes("--check")) {
  // Key order included: the committed file is this document, formatted by Biome.
  if (
    JSON.stringify(await Bun.file(path).json()) !== JSON.stringify(document)
  ) {
    console.error(
      "openapi.json is stale: run `bun run --cwd apps/voice openapi`"
    );
    process.exit(1);
  }
} else {
  await Bun.write(path, `${JSON.stringify(document, null, 2)}\n`);
  console.log(`wrote ${path}`);
}
