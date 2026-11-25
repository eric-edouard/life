import { afterAll, expect, setSystemTime, test } from "bun:test";
import { providerPause } from "./provider-pause";

afterAll(() => setSystemTime());

test("each provider error doubles the pause on background turns; a good run lifts it", () => {
  const at = Date.UTC(2026, 0, 1);
  setSystemTime(at);
  const pause = providerPause();
  expect(pause.block()).toBeUndefined();
  pause.heard(true);
  expect(pause.block()).toContain("2026-01-01T00:00:30");
  pause.heard(true);
  expect(pause.block()).toContain("2026-01-01T00:01:00");
  setSystemTime(at + 61_000);
  expect(pause.block()).toBeUndefined();
  pause.heard(true);
  expect(pause.block()).toContain("2026-01-01T00:03:01");
  pause.heard(false);
  expect(pause.block()).toBeUndefined();
  pause.heard(true);
  expect(pause.block()).toContain("2026-01-01T00:01:31");
});
