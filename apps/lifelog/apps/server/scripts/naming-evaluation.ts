// The naming evaluator's turn and independent-recording statistics.
import { NAMING } from "../src/config";
import { isNamingGate } from "../src/inferred-speakers";

export function namingCounts(
  rows: { prediction: string | null; correct: boolean }[]
) {
  const predicted = rows.filter((r) => r.prediction !== null);
  const correct = predicted.filter((r) => r.correct).length;
  const n = predicted.length;
  const z2 = NAMING.gateZ ** 2;
  const centre = (correct + z2 / 2) / (n + z2);
  const spread = n
    ? (NAMING.gateZ * Math.sqrt((correct * (n - correct)) / n + z2 / 4)) /
      (n + z2)
    : 0;
  return {
    correct,
    coverage: rows.length ? n / rows.length : 0,
    interval: n ? [centre - spread, centre + spread] : null,
    precision: n ? correct / n : null,
    predictions: n,
    turns: rows.length,
  };
}
export function namingUnitsOf(
  rows: {
    prediction: string | null;
    correct: boolean;
    recordingId: string;
    callId: string | null;
  }[]
) {
  const units = (key: "recordingId" | "callId") =>
    namingCounts(
      [
        ...Map.groupBy(
          rows.filter((r) => r[key] !== null),
          (r) => r[key]
        ).values(),
      ].map((group) => ({
        correct: group.every((r) => r.prediction === null || r.correct),
        prediction: group.some((r) => r.prediction !== null) ? "named" : null,
      }))
    );
  return { calls: units("callId"), recordings: units("recordingId") };
}
export const lowerBoundOf = (...reports: { interval: number[] | null }[]) =>
  Math.min(...reports.map((r) => r.interval?.[0] ?? 0));

export async function installNamingGate(
  receipt: { model: string; [key: string]: unknown },
  server = process.env.PUBLIC_BASE_URL,
  token = process.env.CORRECTIONS_TOKEN ?? process.env.DEVICE_TOKEN
) {
  if (!isNamingGate(receipt, receipt.model)) {
    throw new Error("only a passing current naming report can be installed");
  }
  if (!(server && token)) {
    throw new Error(
      "--install needs PUBLIC_BASE_URL and CORRECTIONS_TOKEN or DEVICE_TOKEN"
    );
  }
  const response = await fetch(new URL("/naming-gate", server), {
    body: JSON.stringify({ model: receipt.model, receipt }),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(`naming gate installation failed (${response.status})`);
  }
}
