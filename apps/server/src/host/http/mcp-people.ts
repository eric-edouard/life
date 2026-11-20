import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { PERSON_PICTURES, pictureFileOf } from "../../memory/party";
import { tool } from "./mcp-tool";

// The connector's people tools: the pictures a party shows (`read_person_pictures`). People's pictures leave the Mac
// for any app he paired, never for a paired agent (SECURITY.md, his word of 20 Nov 2026).

/** A picture's id: its original bytes' digest (`pictureIdOf`); nothing else names a file. */
const PICTURE_ID = /^[0-9a-f]{32}$/;
/** At most this many pictures in one call. */
const MAX_IDS = 64;

/** The kept pictures `ids` name, as base64 JPEGs, and the ids no picture is kept for (gone since, or never kept). */
export function readPersonPictures(ids: readonly string[]) {
  const pictures: { data: string; id: string; mime: "image/jpeg" }[] = [];
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    try {
      const data = readFileSync(
        join(PERSON_PICTURES, pictureFileOf(id))
      ).toString("base64");
      pictures.push({ data, id, mime: "image/jpeg" });
    } catch {
      missing.push(id);
    }
  }
  return { missing, pictures };
}

/** Registers `read_person_pictures`: any app he paired reads it; a paired agent is refused. */
export function personPicturesTool(server: McpServer) {
  tool(
    server,
    "read_person_pictures",
    `The pictures people and organizations show (JSON), by the picture ids a party carries (\`picture.id\`, in \`read_matters\`, \`read_matter\`, \`read_inbox\`), at most ${MAX_IDS}: \`pictures\` (\`id\`, \`mime\`, \`data\`: a 216 px JPEG as base64) and \`missing\` (ids with no picture now: read the party again). For his own apps; a paired agent is refused.`,
    z.object({
      ids: z.array(z.string().regex(PICTURE_ID)).min(1).max(MAX_IDS),
    }),
    (a, agent) => {
      if (agent) {
        throw new Error(
          "Not done: this app was paired as an agent; people's pictures go only to his own apps."
        );
      }
      return Promise.resolve(readPersonPictures(a.ids));
    }
  );
}
