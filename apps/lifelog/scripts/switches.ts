// The owner's switches (docs/processing.md, "Pausing transcription and AI"), the same ones as in
// the app's Settings.
//   bun run switches                        what they are now
//   bun run switches transcription off      transcription | ai | all, then on | off
//   bun run switches transcriber speech     engine claude | codex, transcriber scribe | speech
import { serverFetch } from "./server";

const choices: Record<string, string[]> = {
  engine: ["claude", "codex"],
  transcriber: ["scribe", "speech"],
};
const [which, state] = process.argv.slice(2);
let body: Record<string, boolean | string> | undefined;
if (which) {
  const on = state === "on";
  if (choices[which]?.includes(state ?? "")) {
    body = { [which]: state ?? "" };
  } else if (
    ["transcription", "ai", "all"].includes(which) &&
    (on || state === "off")
  ) {
    body = which === "all" ? { ai: on, transcription: on } : { [which]: on };
  } else {
    throw new Error(
      "usage: bun run switches [transcription|ai|all on|off | engine claude|codex | transcriber scribe|speech]"
    );
  }
}

const res = await serverFetch(
  "/switches",
  body ? { body: JSON.stringify(body), method: "PUT" } : {}
);
const now = (await res.json()) as {
  ai: boolean;
  engine: string;
  transcriber: string;
  transcription: boolean;
};
console.log(`transcription ${now.transcription ? "on" : "off"}`);
console.log(`ai            ${now.ai ? "on" : "off"}`);
console.log(`engine        ${now.engine}`);
console.log(`transcriber   ${now.transcriber}`);
