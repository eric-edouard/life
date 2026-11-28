// A messaging network's bridge check (`bun life bridge`'s): whether its bridge can read now, the command that fixes it,
// and whether it is signed in. A check may take 10 s, so the status window and the integration read get the last one
// found, refreshed in the background (`latestBridgeChecks`).

import { enabledSources } from "../memory/sources";
import { copierOf } from "../sources/bridged";
import { isBridgeAdded, isBridgeLinked, readBlock } from "../sources/matrix";
import { NETWORKS, type Network } from "../sources/networks";
import { needsAppKeys } from "./app-keys";

/**
 * One network's bridge, as last checked: what it found, the command that fixes it, whether it waits on his keys, and
 * whether he is signed in (its bridge linked, or Beeper holding it); none when the check itself failed.
 */
interface BridgeCheck {
  command?: string;
  needsKeys?: true;
  ok: boolean;
  signedIn?: boolean;
  text: string;
}

/**
 * Whether a network's bridge can read now: none needed for a network its own app is read from, its keys first when it
 * has app keys pending, then whichever app copies it (its bridge, or Beeper until it is linked).
 */
async function readBridgeCheck(n: Network): Promise<BridgeCheck | undefined> {
  // A network its own app is read from (WhatsApp) has a bridge only for sending: no bridge is no problem.
  if (n.readByItsApp && !isBridgeAdded(n.name)) {
    return;
  }
  const copier = n.readByItsApp ? "bridge" : copierOf(n.name);
  const signedIn =
    isBridgeLinked(n.name) || copier === "beeper" || copier === "beeper-closed";
  return { ...(await bridgeStateOf(n, copier)), signedIn };
}

/** What a network's copier says now; the CLI's words go to `command`, alone. */
async function bridgeStateOf(
  n: Network,
  copier: ReturnType<typeof copierOf>
): Promise<BridgeCheck> {
  if (
    isBridgeAdded(n.name) &&
    !isBridgeLinked(n.name) &&
    (await needsAppKeys(n))
  ) {
    return {
      command: `bun life bridge link ${n.name}`,
      needsKeys: true,
      ok: false,
      text: "needs your app keys",
    };
  }
  if (copier === "beeper") {
    // Added but not linked yet: Beeper is still the one copying, so no gap opens; linking ends its session.
    return {
      ok: true,
      text: isBridgeAdded(n.name)
        ? "read from Beeper until you sign in from your phone"
        : "read from Beeper",
    };
  }
  if (copier === "beeper-closed") {
    return { ok: false, text: "Beeper is closed" };
  }
  if (!copier) {
    return {
      command: `bun life bridge add ${n.name}`,
      ok: false,
      text: "no bridge",
    };
  }
  const why = await readBlock(n.name);
  return why ? { ok: false, text: why } : { ok: true, text: "bridge running" };
}

/** Every network with something to check: its source is on, or its bridge is added. */
async function bridgeChecksNow() {
  const on = new Set(enabledSources().map((d) => d.name as string));
  const networks = NETWORKS.filter(
    (n) => on.has(n.name) || isBridgeAdded(n.name)
  );
  const found = await Promise.all(
    networks.map(async (n) => ({
      // One network's failing check never freezes the others'.
      check: await readBridgeCheck(n).catch(
        (e): BridgeCheck => ({ ok: false, text: (e as Error).message })
      ),
      name: n.name,
    }))
  );
  return new Map(
    found.flatMap((f) =>
      f.check ? [[f.name, f.check] as [string, BridgeCheck]] : []
    )
  );
}

let bridges = new Map<string, BridgeCheck>();
let checkedAt = Number.NEGATIVE_INFINITY;
let check: Promise<void> | undefined;

/**
 * Every network's bridge check as last found: the status window reads every 3 s and a check may take 10 s, so a stale
 * one starts a fresh one in the background (every 15 s at most). Only a process's first read waits for one (10 s at
 * most, once), so a fresh process, like the tick's source alert, sees its bridges.
 */
export async function latestBridgeChecks(): Promise<Map<string, BridgeCheck>> {
  if (!check && performance.now() - checkedAt > 15_000) {
    // In a promise from the start: a check that throws at once never stops the snapshot or the next check.
    check = Promise.resolve()
      .then(() => bridgeChecksNow())
      .then((m) => {
        bridges = m;
      })
      .catch(() => undefined)
      .finally(() => {
        check = undefined;
        checkedAt = performance.now();
      });
  }
  if (checkedAt === Number.NEGATIVE_INFINITY) {
    await check;
  }
  return bridges;
}
