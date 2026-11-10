import { afterEach, expect, spyOn, test } from "bun:test";
import { NAMING } from "../src/config";
import { namingPolicyHash, namingPromptHash } from "../src/inferred-speakers";
import { installNamingGate, summarizeNamingUnits } from "./naming-evaluation";

const original = NAMING.calibration;
afterEach(() => Object.assign(NAMING, { calibration: original }));
function receipt() {
  const calibration = {
    confidence: 0.99,
    contradictionMargin: 0.2,
    contradictionScore: 0.8,
  };
  Object.assign(NAMING, { calibration });
  return {
    calibration,
    calibrationRecordingIds: ["calibration"],
    callPredictions: 200,
    contextCallPredictions: 200,
    contextCorrect: 200,
    contextLowerBound: 0.981,
    contextPredictions: 200,
    contextRecordingPredictions: 200,
    correct: 200,
    datasetHash: "synthetic",
    heldOutRecordingIds: Array.from({ length: 200 }, (_, i) => `audio-${i}`),
    inputHashes: Array.from({ length: 200 }, (_, i) => `call-${i}`),
    lowerBound: 0.981,
    model: "synthetic",
    passed: true,
    policyHash: namingPolicyHash(),
    precision: 1,
    predictions: 200,
    promptHash: namingPromptHash(),
    recordingPredictions: 200,
  };
}

test("evaluator installation sends a passing receipt through authenticated server route only", async () => {
  const gate = receipt();
  const send = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  try {
    await installNamingGate(gate, "https://synthetic.test", "synthetic-token");
    expect(send).toHaveBeenCalledTimes(1);
    const [url, request] = send.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://synthetic.test/naming-gate");
    expect(request?.headers).toMatchObject({
      authorization: "Bearer synthetic-token",
    });
    expect(JSON.parse(String(request?.body))).toEqual({
      model: gate.model,
      receipt: gate,
    });
    await expect(
      installNamingGate(
        { ...gate, passed: false },
        "https://synthetic.test",
        "synthetic-token"
      )
    ).rejects.toThrow("passing");
    expect(send).toHaveBeenCalledTimes(1);
    send.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(
      installNamingGate(gate, "https://synthetic.test", "synthetic-token")
    ).rejects.toThrow("401");
  } finally {
    send.mockRestore();
  }
});

test("independent recording and call intervals need distinct audio and calls, not repeated turns", () => {
  const independent = Array.from({ length: 200 }, (_, i) => ({
    callId: `call-${i}`,
    correct: true,
    prediction: "guest",
    recordingId: `audio-${i}`,
  }));
  const distinct = summarizeNamingUnits(independent);
  expect(distinct.recordings.interval?.[0]).toBeGreaterThanOrEqual(
    NAMING.precision
  );
  expect(distinct.calls.interval?.[0]).toBeGreaterThanOrEqual(NAMING.precision);
  const repeated = summarizeNamingUnits(
    independent.map((r) => ({
      ...r,
      callId: "same-call",
      recordingId: "same-audio",
    }))
  );
  expect(repeated.recordings.predictions).toBe(1);
  expect(repeated.calls.interval?.[0]).toBeLessThan(NAMING.precision);
});
