import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readAppended, readLineCount, readLinesFrom } from "./files";

const n = 300_000;
const line = (i: number) => `${JSON.stringify({ id: `ask_${i}`, kind: "ask", said: "x".repeat(250) })}\n`;
const path = join(mkdtempSync(join(tmpdir(), "bench-")), "ledger.jsonl");
writeFileSync(path, Array.from({ length: n }, (_, i) => line(i)).join(""));
const t = (label: string, f: () => unknown) => {
  const a = performance.now();
  f();
  console.log(label, (performance.now() - a).toFixed(1), "ms");
};
const fold = () => readAppended(path, z.any(), (l?: unknown[]) => [...(l ?? [])], (acc, r) => acc.push(r));
t("line index cold", () => readLineCount(path));
t("page of 1000 at the end", () => readLinesFrom(path, n - 1000, 1000));
t("fold cold", fold);
appendFileSync(path, line(n));
t("line index after append", () => readLineCount(path));
t("fold after append", fold);
