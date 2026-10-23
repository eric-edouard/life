// The owner's two switches (docs/voice/processing.md, "Pausing transcription and AI"), the same ones as
// in the app's Settings.
//   bun run switches                        what they are now
//   bun run switches transcription off      transcription | ai | all, then on | off
import { serverFetch } from "./server";

const [which, state] = process.argv.slice(2);
let body: Record<string, boolean | string> | undefined;
if (which) {
  if (
    !(
      (which === "engine" && ["claude", "codex"].includes(state ?? "")) ||
      (["transcription", "ai", "all"].includes(which) &&
        (state === "on" || state === "off"))
    )
  ) {
    throw new Error(
      "usage: bun run switches [transcription|ai|all on|off | engine claude|codex]"
    );
  }
  const on = state === "on";
  if (which === "engine") {
    body = { engine: state ?? "" };
  } else {
    body = which === "all" ? { ai: on, transcription: on } : { [which]: on };
  }
}

const res = await serverFetch(
  "/switches",
  body ? { body: JSON.stringify(body), method: "PUT" } : {}
);
const now = (await res.json()) as {
  ai: boolean;
  transcription: boolean;
  engine: string;
};
console.log(`transcription ${now.transcription ? "on" : "off"}`);
console.log(`ai            ${now.ai ? "on" : "off"}`);

console.log(`engine        ${now.engine}`);
