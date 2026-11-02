import type { Decision, OwnerStep } from "@life/server/src/records/decision";

// The app's one way to Life's /api/: a signed-out answer (401) sends him to the sign-in, back here after.

export class SignedOut extends Error {}

async function call(path: string, init?: RequestInit) {
  const r = await fetch(path, init);
  if (r.status === 401) {
    throw new SignedOut();
  }
  if (!r.ok) {
    throw new Error(await r.text());
  }
  return r;
}

const post = (path: string, body: unknown) =>
  call(path, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });

export const readDecisions = async (): Promise<Decision[]> =>
  (await call("/api/decisions")).json();

export const writeStep = (step: OwnerStep) => post("/api/decisions", step);

export const signIn = (password: string) => post("/api/sign-in", { password });
