// A job worker's stop (life#857): every test's app shares the bench's one db, so a test's worker stops after it.
import { expect, test } from "bun:test";
import { jobBench } from "./job-bench";
import { setSwitches } from "./switches";

const { accept, admitFragment, appWith, audio, env, fake, jobRow, uploads } =
  jobBench();

test("a stopped worker settles the send under way, then claims nothing", async () => {
  const app = appWith();
  setSwitches(env.db, { transcriber: "scribe" });
  const upload = Promise.withResolvers<void>();
  const held = Promise.withResolvers<void>();
  // Only the upload's answer is held, not the credits' read before it.
  fake.respond = async (call) => {
    if (call.path.endsWith("/speech-to-text")) {
      upload.resolve();
      await held.promise;
    }
    return accept();
  };
  await admitFragment(app, audio(60), 1);
  const working = app.s.worker.work();
  try {
    await upload.promise;
    let settled = false;
    const stopping = app.s.worker.stop().then(() => {
      settled = true;
    });
    await Bun.sleep(20);
    expect(settled).toBe(false);
    held.resolve();
    await Promise.all([stopping, working]);
  } finally {
    held.resolve();
  }

  const queued = await admitFragment(app, audio(60), 100);
  await app.s.worker.work();
  expect(jobRow(queued).state).toBe("queued");
  expect(uploads()).toHaveLength(1);
});
