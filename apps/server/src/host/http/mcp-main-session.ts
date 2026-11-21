import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { errorOf } from "../../core/log-line";
import { off } from "../../core/outputs";
import {
  type MainSessionAnswer,
  type MainSessionAsk,
  type MainSessionLine,
  MainSessionScreen,
} from "../../records/main-session-wire";
import { DOOR_PORT, MAIN_SESSION_PATH } from "./http";
import { localKey } from "./local-key";
import { REVERSIBLE, tool } from "./mcp-tool";

// The connector's Tell Life (his decisions of 21 Nov 2026): `ask_main_session`, his app's token only. It hands his words
// and his screen's refs to the desk's main session over the door's loopback path, by the local key, and relays what the
// session streams as progress notifications; the call ends on its answer. Nothing is kept here: the desk keeps the
// turn, and a retry under the tap's key (`life/answerKey`) asks once.

/** Where the desk takes his words: the door's one other path, on loopback. */
const MAIN_SESSION_URL = `http://127.0.0.1:${DOOR_PORT}${MAIN_SESSION_PATH}`;

const error = (what: string): MainSessionAnswer => ({ kind: "error", what });

/** Each NDJSON line of `body` as it arrives. */
async function* linesOf(body: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of body) {
    const lines = (rest + decoder.decode(chunk, { stream: true })).split("\n");
    rest = lines.pop() ?? "";
    yield* lines.filter(Boolean);
  }
  if (rest) {
    yield rest;
  }
}

/**
 * Hands `ask` to the desk at `url`: with words, each line it streams goes to `report` and its answer is returned; with
 * none, his presence (`{kept, why}`). A desk that can't be reached, or ends with no answer, answers an error.
 */
export async function askDesk(
  ask: MainSessionAsk,
  report: (line: MainSessionLine) => void,
  url = MAIN_SESSION_URL
) {
  let res: Response;
  try {
    res = await fetch(url, {
      body: JSON.stringify(ask),
      headers: { authorization: `Bearer ${localKey()}` },
      method: "POST",
      // A turn may read for minutes: the stream is its own clock.
      timeout: false,
    });
  } catch (e) {
    return error(`Life's desk can't be reached: ${errorOf(e).error}`);
  }
  if (!(res.ok && res.body)) {
    return error(`Life's desk refused: ${res.status}`);
  }
  if (!ask.words) {
    return (await res.json()) as { kept: boolean; why?: string };
  }
  for await (const text of linesOf(res.body)) {
    const line = JSON.parse(text) as MainSessionLine;
    if (line.kind === "answer") {
      return line.answer;
    }
    report(line);
  }
  return error("Life's desk ended with no answer.");
}

export function mainSessionTool(server: McpServer, notHis: string) {
  tool(
    server,
    "ask_main_session",
    "His app's token only: Tell Life. His `words` (as he sent them, verbatim) to Life's main session, with `screen`, the refs on his screen (`tab`, `open`: the ref open, `visible`: up to 20 refs in view; never text). Its progress notifications stream what it does as it goes, each a JSON line: `thinking`, `working` (`id`, `title`, `state`: a tool call), `words` (`text`, a chunk of its answer; a `working` line after words starts them again). Returns its answer (JSON), one kind of a closed list: `reply` (`words`) or `error` (`what`; his words stay his to send again). Without `words`, his presence on the Tell Life screen: the session is kept open so his next words start at once (`{kept, why}`). The tap's `life/answerKey` makes a retry ask once. Read-only for now: it answers, and changes nothing.",
    z.object({
      screen: MainSessionScreen.optional(),
      words: z.string().trim().min(1).max(8000).optional(),
    }),
    async ({ screen, words }, agent, call) => {
      if (agent) {
        throw new Error(notHis);
      }
      const why = off("desk");
      if (why) {
        return error(why);
      }
      return await askDesk({ key: call.answerKey, screen, words }, (line) =>
        call.report(line)
      );
    },
    REVERSIBLE
  );
}
