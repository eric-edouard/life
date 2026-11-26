import { z } from "zod";
import { clock, MIN } from "../core/clock";
import {
  isBridgeAdded,
  type LoginStep,
  REFUSED,
  readLogins,
  signInOf,
  startLogin,
  submitLoginStep,
} from "../sources/matrix";
import { NETWORKS, type Network } from "../sources/networks";
import { afterLinked } from "./bridges";

// His app's sign-in to a messaging network (`sign_in_to_network`, docs/plans/2026-11-26-sign-in-from-phone.md): one
// bridge login step per call, by the network's `loginFlow`, on loopback. Life keeps no login of its own: the phone
// carries `loginId`, `stepId` and `type` between calls, and the answers live only in the call (never logged, never
// stored). The one thing held here is a display-and-wait step's call to the bridge, which blocks while he types the
// code in the network's app: iOS cuts a request when the app leaves the screen, so the wait outlives his request.

/** An id the bridge gave, sent back in its URL's path: one segment, never `.` or `..`. */
const StepId = z.string().regex(/^(?!\.{1,2}$)[\w.:-]{1,200}$/);

export const NetworkSignIn = z
  .object({
    answers: z
      .record(z.string(), z.string())
      .optional()
      .describe(
        "The step's values by field id: a form's, or a cookie step's (cookies, headers, `extract_js` results); none for `display_and_wait`"
      ),
    loginId: StepId.optional().describe("The `loginId` of the step answered"),
    network: z.enum(NETWORKS.map((n) => n.name) as [Network["name"]]),
    stepId: StepId.optional().describe("The `stepId` of the step answered"),
    type: z
      .enum(["cookies", "display_and_wait", "user_input"])
      .optional()
      .describe("The `type` of the step answered"),
  })
  .strict();
type NetworkSignIn = z.infer<typeof NetworkSignIn>;

/** One step as the phone draws it: only what it draws, never the bridge's whole answer. */
const stepOf = (s: LoginStep) => ({
  ...(s.cookies && {
    cookies: {
      extractJs: s.cookies.extract_js,
      fields: (s.cookies.fields ?? []).map((f) => ({
        id: f.id,
        required: f.required ?? false,
        sources: (f.sources ?? []).map((x) => ({
          cookieDomain: x.cookie_domain,
          name: x.name,
          requestUrlRegex: x.request_url_regex,
          type: x.type,
        })),
      })),
      url: s.cookies.url,
      userAgent: s.cookies.user_agent,
      waitForUrlPattern: s.cookies.wait_for_url_pattern,
    },
  }),
  ...(s.display_and_wait && {
    display: { data: s.display_and_wait.data, type: s.display_and_wait.type },
  }),
  ...(s.user_input && {
    fields: (s.user_input.fields ?? []).map((f) => ({
      description: f.description,
      id: f.id,
      name: f.name ?? f.id,
      type: f.type,
    })),
  }),
  instructions: s.instructions,
  loginId: s.login_id,
  stepId: s.step_id,
  type: s.type,
});

/** How long one request holds a display step's wait before answering `waiting`; and its progress pings. */
export const HOLD = { ms: MIN, pingMs: 10_000 };
/** A wait nobody came back for is dropped: the bridge's own call ends at 10 minutes. */
const WAIT_KEPT = 15 * MIN;

/** The display steps' waits, by network and login: the bridge's answer to come, never his answers. */
const waits = new Map<
  string,
  { at: number; next: Promise<LoginStep>; stepId: string }
>();

/** What the bridge said, in his words: a refusal, a wait past its time, or a bridge that can't be reached. */
function refusalOf(e: unknown, n: Network) {
  const { message, name } = e as Error;
  if (name === "TimeoutError") {
    return new Error("Not done: that took too long. Try again.");
  }
  if (REFUSED.test(message)) {
    return new Error(`Not done: ${n.label} didn't accept that. Try again.`);
  }
  return new Error(
    `Not done: Life can't reach the ${n.label} bridge on your Mac right now.`
  );
}

/** Only a network he must sign in (signed out, or never linked): never one whose login works, so no account is swapped. */
async function gate(n: Network) {
  if (!isBridgeAdded(n.name)) {
    throw new Error(`Not done: ${n.label} isn't added to Life on your Mac.`);
  }
  const logins = await readLogins(n.name).catch((e: unknown) => {
    throw refusalOf(e, n);
  });
  if (!signInOf(logins)) {
    throw new Error(`Not done: ${n.label} doesn't need signing in now.`);
  }
}

/** The bridge's next step; once it is `complete`, the network linked (`afterLinked`), whether or not he is still here. */
const linkedOf = (n: Network, step: Promise<LoginStep>) =>
  step.then(
    (s) => {
      if (s.type === "complete") {
        afterLinked(n);
      }
      return s;
    },
    (e: unknown) => {
      throw refusalOf(e, n);
    }
  );

/** The answer to the phone: the next step, or done (the network linked, its source on). */
const answerOf = (n: Network, step: LoginStep) =>
  step.type === "complete"
    ? { network: n.name, status: "done" }
    : { status: "step", step: stepOf(step) };

/** A display step: its wait, started once, held for `HOLD.ms` with pings; `waiting` when he is still in the other app. */
async function heldWait(
  n: Network,
  step: { login_id: string; step_id: string },
  report: (step: Record<string, unknown>) => void
) {
  const now = clock().getTime();
  for (const [k, w] of waits) {
    if (now - w.at > WAIT_KEPT) {
      waits.delete(k);
    }
  }
  const key = `${n.name}/${step.login_id}`;
  let w = waits.get(key);
  // Back after the wait was dropped: linked meanwhile (its step answered while he was away) is done.
  const logins = w
    ? undefined
    : await readLogins(n.name).catch(() => undefined);
  if (logins && !signInOf(logins)) {
    return answerOf(n, { ...step, type: "complete" });
  }
  if (w?.stepId !== step.step_id) {
    const next = linkedOf(
      n,
      submitLoginStep(n.name, { ...step, type: "display_and_wait" }, {})
    );
    next.catch(() => undefined);
    w = { at: now, next, stepId: step.step_id };
    waits.set(key, w);
  }
  const pings = setInterval(() => report({ step: "waiting" }), HOLD.pingMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      w.next.then(
        (s) => ({ s }),
        (e: unknown) => ({ e })
      ),
      new Promise<undefined>((done) => {
        timer = setTimeout(() => done(undefined), HOLD.ms);
      }),
    ]);
    if (!settled) {
      return {
        loginId: step.login_id,
        status: "waiting",
        stepId: step.step_id,
      };
    }
    waits.delete(key);
    if ("e" in settled) {
      throw settled.e;
    }
    return answerOf(n, settled.s);
  } finally {
    clearInterval(pings);
    clearTimeout(timer);
  }
}

/**
 * `sign_in_to_network`: `{network}` starts its `loginFlow` (only while he must sign it in); with `loginId`, `stepId`,
 * `type` and `answers`, one step answered. The answer is the next step, `waiting` (ask again with the same step), or
 * `done`.
 */
export async function signInToNetwork(
  a: NetworkSignIn,
  report: (step: Record<string, unknown>) => void
) {
  const n = NETWORKS.find((x) => x.name === a.network) as Network;
  if (!(a.loginId || a.stepId || a.type || a.answers)) {
    await gate(n);
    return answerOf(n, await linkedOf(n, startLogin(n.name, n.loginFlow)));
  }
  if (!(a.loginId && a.stepId && a.type)) {
    throw new Error(
      "Not done: a step needs its `loginId`, `stepId` and `type`."
    );
  }
  const step = { login_id: a.loginId, step_id: a.stepId };
  if (a.type === "display_and_wait") {
    return heldWait(n, step, report);
  }
  return answerOf(
    n,
    await linkedOf(
      n,
      submitLoginStep(n.name, { ...step, type: a.type }, a.answers ?? {})
    )
  );
}
