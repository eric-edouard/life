import { sendRefusalOf } from "./send-guard";

// The send guard's hook (`SEND_GUARD_HOOK`): reads the tool call on stdin and the row's facts from `LIFE_SEND_FACTS`;
// exits 2 with the refusal on stderr, which both runtimes show the agent. Any failure refuses (fails closed). Kept apart
// from Life's command line so a tool call waits for this file alone (`scripts/helper.ts` bundles it).

try {
  const why = sendRefusalOf(
    JSON.parse(await Bun.stdin.text()),
    JSON.parse(process.env.LIFE_SEND_FACTS ?? "")
  );
  if (why) {
    console.error(why);
    process.exit(2);
  }
} catch (e) {
  console.error(`Life's send guard failed, so this call is refused: ${e}`);
  process.exit(2);
}
