import { Hono } from "hono";
import { ARCHIVE } from "../../sources/archived";
import {
  heldThrough,
  isCompanionToken,
  noteReached,
  Push,
  receive,
} from "../companion";
import { HEADERS, text } from "./http";

// A companion Mac's push (`host/companion.ts`), on the public port, behind the token the hub minted for it: where each
// table resumes, and a batch of the Mac's archive rows. It takes rows in; it serves nothing of his.

const BEARER = /^Bearer (.+)$/;

/** The routes, storing into the archive in `dir`. */
export const createCompanion = (dir = ARCHIVE) =>
  new Hono()
    .use("/companion/*", async (c, next) => {
      const token = BEARER.exec(c.req.header("authorization") ?? "")?.[1];
      if (!(token && isCompanionToken(token))) {
        return text("not the companion", 401);
      }
      noteReached();
      await next();
    })
    .get("/companion/cursors", () =>
      Response.json(heldThrough(dir), { headers: HEADERS })
    )
    .post("/companion/push", async (c) => {
      let push: Push;
      try {
        const bytes = new Uint8Array(await c.req.arrayBuffer());
        const raw =
          c.req.header("content-encoding") === "gzip"
            ? Bun.gunzipSync(bytes)
            : bytes;
        push = Push.parse(JSON.parse(new TextDecoder().decode(raw)));
      } catch (e) {
        return text(`not a push: ${(e as Error).message}`, 400);
      }
      try {
        return Response.json(
          { added: receive(push, dir) },
          { headers: HEADERS }
        );
      } catch (e) {
        return text((e as Error).message, 400);
      }
    });
