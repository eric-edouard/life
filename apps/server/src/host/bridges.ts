import {
  copyFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { bundledBridge, WINDOWS } from "../core/platform";
import { execOk, untilAnswers } from "../core/proc";
import { writeSecret } from "../core/secret";
import { keepRunning } from "../core/service";
import { readSettings, setSettings, settings } from "../core/settings";
import { forgetBridgeReads } from "../memory/fix-checks";
import {
  BRIDGES,
  type CookieStep,
  cookieValues,
  HOMESERVER_URL,
  hasStates,
  isBridgeAdded,
  type LoginStep,
  OWNER,
  pastedValues,
  readBlock,
  readLogins,
  readOwnerAccount,
  readYaml,
  SERVER,
  startLogin,
  submitLoginStep,
  unlinkBridge,
} from "../sources/matrix";
import { NETWORKS, type Network } from "../sources/networks";
import { configPath, needsAppKeys, pendingAppKeys } from "./app-keys";
import { messagingStatus } from "./messaging-status";
import { hasChrome, signInWithChrome } from "./sign-in-browser";

// `bun life bridge [status]|add|link|remove [network]` (docs/use/bridges.md): the one way to set up and remove a bridge;
// linked by it or by his app's sign-in (`host/network-sign-in.ts`), both through the network's `loginFlow`. A network is added when its folder holds its config (`MACHINE_DIR/bridges/<network>`). The homeserver and each
// bridge run in one job the Mac keeps running (`core/service.ts`, `RUN_BRIDGES`), outside Life.app: the homeserver holds
// deleted messages until the archive copies them, so it keeps running when Life is closed.

const SYNAPSE_DIR = join(BRIDGES, "synapse");
const VENV = join(SYNAPSE_DIR, ".venv", "bin");
const PYTHON = join(VENV, "python");
const HOMESERVER_YAML = join(SYNAPSE_DIR, "homeserver.yaml");
const PORT = Number(new URL(HOMESERVER_URL).port);

const writeYaml = (path: string, value: unknown) =>
  writeFileSync(path, stringify(value, { indent: 2 }));

/** The config with each key set (a dotted path), the rest kept. */
export function withKeys(config: unknown, values: Record<string, unknown>) {
  const out = structuredClone(config) as Record<
    string,
    Record<string, unknown>
  >;
  for (const [path, value] of Object.entries(values)) {
    const keys = path.split(".");
    const last = keys.pop() as string;
    let o: Record<string, unknown> = out;
    for (const k of keys) {
      o[k] ??= {};
      o = o[k] as Record<string, unknown>;
    }
    o[last] = value;
  }
  return out;
}

const isAdded = (n: Network) => isBridgeAdded(n.name);

/**
 * A bridge's config with catch-up on: what came in while it was signed out or stopped is bridged once it is back (up to
 * 500 messages a chat). A chat first seen keeps the bridge's own initial count (50): a chat begun while signed out
 * would lose its messages at 0, and LINE's move from Beeper counts on them (docs/use/bridges.md).
 */
export const withCatchUp = (config: unknown) =>
  withKeys(config, {
    "backfill.enabled": true,
    "backfill.max_catchup_messages": 500,
  });

/**
 * The one job's program: the homeserver and every added bridge (a folder holding its config, run as `./bridge`), each
 * started again 10 s after it stops; on TERM each is stopped and waited for, so the homeserver shuts down cleanly. A
 * bridge's folder names it to the resource sample (`LIFE_BRIDGE`, inherited). A bridge's stdout repeats its own capped log (logs/bridge.log, every level): only its stderr reaches the job's log, which nothing caps.
 */
export const RUN_BRIDGES = `
trap 'kill $(jobs -p) 2>/dev/null; wait; exit 0' TERM
keep() { (
  cd "$1" || exit 1
  export LIFE_BRIDGE="$1"
  shift
  trap 'kill $! 2>/dev/null; wait $!; exit 0' TERM
  while :; do "$@" & wait $!; sleep 10; done
) & }
keep synapse .venv/bin/python -m synapse.app.homeserver -c homeserver.yaml
for c in */config.yaml; do [ -e "$c" ] && keep "\${c%/config.yaml}" ./bridge -c config.yaml >/dev/null; done
wait
`;

/** (Re)starts the one job, so it runs what is added now, and waits for the homeserver. */
async function restartBridges() {
  await keepRunning("bridges", BRIDGES, ["/bin/sh", "-c", RUN_BRIDGES]);
  await untilAnswers(
    () => fetch(`${HOMESERVER_URL}/_matrix/client/versions`).then(() => true),
    "the homeserver"
  );
}

/**
 * The daily heal, when the homeserver is set up: each added bridge's config given catch-up (`withCatchUp`), the one job
 * restarted, then each added bridge answering with its
 * logins' states (`hasStates`). A restart makes each bridge check its login
 * anew, so one that hung while saying CONNECTED (LINE, 5 Nov 2026) is running again or shows why not on the status
 * snapshot.
 */
export async function healBridges() {
  if (WINDOWS || !existsSync(HOMESERVER_YAML)) {
    return;
  }
  for (const n of NETWORKS.filter(isAdded)) {
    const config = readYaml(configPath(n));
    const caughtUp = withCatchUp(config);
    if (!Bun.deepEquals(config, caughtUp)) {
      writeYaml(configPath(n), caughtUp);
    }
  }
  await restartBridges();
  await Promise.all(
    NETWORKS.filter(isAdded).map(
      async (n) =>
        !(await needsAppKeys(n)) &&
        (await untilAnswers(
          async () => hasStates(await readLogins(n.name)) || undefined,
          `the ${n.label} bridge`
        ))
    )
  );
}

/**
 * The homeserver, set up once and safe to run again after a half-done try: Synapse in its own venv, local only, kept
 * running; his account and its token (`SECRETS.matrix`, with its password, so a token can be had again).
 */
async function addHomeserver() {
  mkdirSync(SYNAPSE_DIR, { recursive: true });
  if (!existsSync(PYTHON)) {
    console.log("Setting up the homeserver (Synapse)…");
    await execOk(["uv", "venv", "-q", "-p", "3.12", ".venv"], {
      cwd: SYNAPSE_DIR,
      timeout: 300_000,
    });
  }
  await execOk(
    ["uv", "pip", "install", "-q", "-p", PYTHON, "matrix-synapse", "qrcode"],
    {
      cwd: SYNAPSE_DIR,
      timeout: 600_000,
    }
  );
  if (!existsSync(HOMESERVER_YAML)) {
    await execOk(
      [
        PYTHON,
        "-m",
        "synapse.app.homeserver",
        "--server-name",
        SERVER,
        "--config-path",
        HOMESERVER_YAML,
        "--generate-config",
        "--report-stats=no",
      ],
      { cwd: SYNAPSE_DIR }
    );
    const c = readYaml(HOMESERVER_YAML);
    writeYaml(HOMESERVER_YAML, {
      ...c,
      app_service_config_files: [],
      enable_registration: false,
      federation_domain_whitelist: [],
      listeners: [
        {
          bind_addresses: ["127.0.0.1"],
          port: PORT,
          resources: [{ compress: false, names: ["client"] }],
          tls: false,
          type: "http",
          x_forwarded: false,
        },
      ],
      presence: { enabled: false },
      // The buffer before Life's archive: a deleted message's text is never pruned (.claude/rules/sources.md).
      redaction_retention_period: null,
      suppress_key_server_warning: true,
      trusted_key_servers: [],
    });
  }
  // The password is kept before his account is made, so a try that stops halfway logs in next time.
  const saved = readOwnerAccount();
  if (saved.token) {
    return; // set up already: the caller restarts the job once its own change is made
  }
  await restartBridges();
  const password = saved.password ?? crypto.randomUUID();
  if (!saved.password) {
    writeSecret("matrix", JSON.stringify({ password }));
    await execOk(
      [
        join(VENV, "register_new_matrix_user"),
        "-c",
        HOMESERVER_YAML,
        "-u",
        "owner",
        "-p",
        password,
        "-a",
        HOMESERVER_URL,
      ],
      { cwd: SYNAPSE_DIR }
    );
  }
  const res = await fetch(`${HOMESERVER_URL}/_matrix/client/v3/login`, {
    body: JSON.stringify({
      identifier: { type: "m.id.user", user: "owner" },
      password,
      type: "m.login.password",
    }),
    method: "POST",
  });
  const login = (await res.json()) as { access_token?: string; error?: string };
  if (!(res.ok && login.access_token)) {
    throw new Error(
      `the homeserver refused his login: ${login.error ?? res.status}`
    );
  }
  writeSecret(
    "matrix",
    JSON.stringify({ password, token: login.access_token })
  );
}

/** The registrations the homeserver loads, one per bridge. */
function setRegistration(network: string, on: boolean) {
  const c = readYaml(HOMESERVER_YAML);
  const path = join(BRIDGES, network, "registration.yaml");
  const files = ((c.app_service_config_files ?? []) as string[]).filter(
    (f) => f !== path
  );
  writeYaml(HOMESERVER_YAML, {
    ...c,
    app_service_config_files: on ? [...files, path] : files,
  });
}

/** Its config, the first time: this homeserver, SQLite, him as its admin, catch-up on. */
async function writeConfig(n: Network, bin: string, dir: string) {
  const config = configPath(n);
  await execOk([bin, "-c", config, "-e"], { cwd: dir });
  const c = readYaml(config) as Partial<
    Record<string, Record<string, unknown>>
  >;
  const appservice = c.appservice ?? {};
  writeYaml(
    config,
    withCatchUp({
      ...c,
      appservice: {
        ...appservice,
        address: `http://127.0.0.1:${appservice.port}`,
        public_address: undefined,
      },
      bridge: { ...c.bridge, permissions: { [OWNER]: "admin" } },
      database: {
        ...c.database,
        type: "sqlite3-fk-wal",
        uri: `file:${n.name}.db?_txlock=immediate`,
      },
      homeserver: { ...c.homeserver, address: HOMESERVER_URL, domain: SERVER },
    })
  );
  await execOk(
    [bin, "-g", "-c", config, "-r", join(dir, "registration.yaml")],
    { cwd: dir }
  );
  setRegistration(n.name, true);
}

/**
 * Adds a network's bridge, or puts the app's build of it in place again when it is there (an update brings a newer one);
 * links it unless it is linked. The program is built into the app (`bundledBridge`): nothing is built on his computer.
 */
async function add(n: Network) {
  const built = bundledBridge(n.name);
  if (!(built && existsSync(built))) {
    throw new Error(
      `no ${n.label} bridge in this build: bun scripts/bundled-tools.ts <folder>, then LIFE_BRIDGES_DIR=<folder>`
    );
  }
  await addHomeserver();
  const dir = join(BRIDGES, n.name);
  const bin = join(dir, "bridge");
  mkdirSync(dir, { recursive: true });
  // Copied then renamed: a running bridge keeps its old file until the job restarts it.
  copyFileSync(built, `${bin}.new`);
  renameSync(`${bin}.new`, bin);
  if (!isAdded(n)) {
    await writeConfig(n, bin, dir);
  }
  await restartBridges();
  const keys = await needsAppKeys(n);
  if (!keys) {
    await untilAnswers(() => readLogins(n.name), `the ${n.label} bridge`);
    console.log(`${n.label} bridge running.`);
  }
  if (!(keys || (await readBlock(n.name)))) {
    console.log(`${n.label} is linked already.`);
  } else if (process.stdin.isTTY) {
    await link(n);
  } else if (keys) {
    console.log(
      `${n.label} needs your own keys first: bun life bridge link ${n.name}`
    );
  } else {
    console.log(`Link it in a terminal: bun life bridge link ${n.name}`);
  }
}

/** Draws a QR code in the terminal (the homeserver's venv has `qrcode`). */
const drawQr = (data: string) =>
  Bun.spawnSync(
    [
      PYTHON,
      "-I",
      "-c",
      "import qrcode,sys;q=qrcode.QRCode(border=1);q.add_data(sys.argv[1]);q.print_ascii(invert=True)",
      data,
    ],
    { stdout: "inherit" }
  );

const echo = (on: boolean) =>
  Bun.spawnSync(["stty", on ? "echo" : "-echo"], { stdin: "inherit" });

/** Asks him in the terminal; hidden for a password or a cookie, its echo always given back (Ctrl-C included). */
function ask(name: string, hidden: boolean) {
  if (!hidden) {
    // biome-ignore lint/suspicious/noAlert: the CLI asks him in his terminal
    return prompt(`${name}:`) ?? "";
  }
  const restore = () => echo(true);
  // Ctrl-C still ends the CLI, its echo given back first.
  const abort = () => {
    restore();
    process.exit(130);
  };
  process.once("SIGINT", abort);
  echo(false);
  try {
    // biome-ignore lint/suspicious/noAlert: the CLI asks him in his terminal
    return prompt(`${name}:`) ?? "";
  } finally {
    restore();
    process.off("SIGINT", abort);
    console.log("");
  }
}

function show(step: LoginStep) {
  if (step.instructions) {
    console.log(step.instructions);
  }
  const shown = step.display_and_wait;
  if (shown?.type === "qr" && shown.data) {
    drawQr(shown.data);
  } else if (shown?.data) {
    console.log(shown.data);
  }
}

/**
 * A cookie step's values: a Chrome window he signs in to (`signInWithChrome`), else one request he pastes ("Copy as
 * cURL" from the browser's developer tools).
 */
async function signIn(step: CookieStep) {
  if (hasChrome()) {
    console.log(
      `Sign in to ${step.url} in the Chrome window that opens; it closes by itself once you're in.`
    );
    return await signInWithChrome(step);
  }
  // Read from the clipboard: a copied request is several lines, longer than a terminal line can hold.
  // biome-ignore lint/suspicious/noAlert: the CLI asks him in his terminal
  prompt(
    `Signed in at ${step.url}: developer tools → Network, reload, right-click a request to it → Copy as cURL, then press Enter.`
  );
  return cookieValues(
    step.fields ?? [],
    pastedValues(await execOk(["pbpaste"]))
  );
}

/**
 * What one step sends back, asked in the terminal: its fields (a password hidden); a cookie step's values all at once
 * (`signIn`), then one by one for a required one that didn't come. None for a step he only looks at.
 */
async function answersOf(step: LoginStep) {
  if (step.type !== "cookies") {
    return Object.fromEntries(
      (step.user_input?.fields ?? []).map((f) => [
        f.id,
        ask(f.name ?? f.id, f.type === "password"),
      ])
    );
  }
  const found = await signIn(step.cookies ?? {});
  for (const f of (step.cookies?.fields ?? []).filter(
    (x) => x.required && !found.has(x.id)
  )) {
    found.set(f.id, ask(f.id, true));
  }
  return Object.fromEntries(found);
}

/**
 * After he linked a network (here, or by his app's sign-in): the fix asks read the bridges again, and its source is on.
 * Whether it turned the source on: the archive starts again on the change (`readRunning`).
 */
export function afterLinked(n: Network) {
  forgetBridgeReads();
  const { sources } = readSettings();
  if (n.readByItsApp || sources.includes(n.name)) {
    return false;
  }
  setSettings({ sources: [...sources, n.name] });
  return true;
}

/** Links a network by its `loginFlow`, or the flow `flow` names; then `afterLinked`. */
async function link(n: Network, flow?: string) {
  const pending = await pendingAppKeys(n);
  if (pending.length > 0) {
    console.log(
      `${n.label} needs your own keys, from ${n.appKeys?.opens}. ${n.appKeys?.hint}`
    );
    const values = Object.fromEntries(
      pending.map(({ isNumber, path }) => {
        const key = path.split(".").pop() as string;
        const text = ask(key, n.appKeys?.secret.includes(path) ?? false).trim();
        if (!text || (isNumber && Number.isNaN(Number(text)))) {
          throw new Error(`${key}: nothing usable typed`);
        }
        return [path, isNumber ? Number(text) : text];
      })
    );
    writeYaml(configPath(n), withKeys(readYaml(configPath(n)), values));
    await restartBridges();
    await untilAnswers(() => readLogins(n.name), `the ${n.label} bridge`);
  }
  const chosen = flow ?? n.loginFlow;
  console.log(`Linking ${n.label} (${chosen})…`);
  let step = await startLogin(n.name, chosen);
  while (step.type !== "complete") {
    show(step);
    // biome-ignore lint/performance/noAwaitInLoops: each step follows the last
    step = await submitLoginStep(n.name, step, await answersOf(step));
  }
  if (afterLinked(n)) {
    console.log(`${n.label} is on: Life copies it from now on.`);
  }
  console.log(`${n.label} linked.`);
}

/**
 * Removes a network's bridge: logged out, unregistered, stopped, its folder gone, its source off. The archive stays, and the homeserver keeps its rooms; what the
 * archive hadn't copied yet is not copied.
 */
async function remove(n: Network) {
  await unlinkBridge(n.name).catch((e: Error) =>
    console.error(`logout: ${e.message}`)
  );
  rmSync(join(BRIDGES, n.name), { force: true, recursive: true });
  if (existsSync(HOMESERVER_YAML)) {
    setRegistration(n.name, false);
    await restartBridges();
  }
  if (!n.readByItsApp) {
    setSettings({ sources: settings().sources.filter((s) => s !== n.name) });
  }
  console.log(`${n.label} removed; what Life archived of it stays.`);
}

/** `bridge [status] | add <network> | link <network> [flow] | remove <network>`. */
export async function bridgeCommand(args: string[]) {
  if (WINDOWS) {
    console.error("the bridges run on macOS only");
    return 2;
  }
  const [verb, name, flow] = args;
  if (verb === "status" || !verb) {
    return messagingStatus();
  }
  const n = NETWORKS.find((x) => x.name === name);
  if (!(n && ["add", "link", "remove"].includes(verb))) {
    console.error(
      `usage: bun life bridge [status] | add|link|remove <${NETWORKS.map((x) => x.name).join("|")}> [flow]`
    );
    return 2;
  }
  if (verb !== "add" && !isAdded(n)) {
    console.error(`${n.label} isn't added: bun life bridge add ${n.name}`);
    return 2;
  }
  await {
    add: () => add(n),
    link: () => link(n, flow),
    remove: () => remove(n),
  }[verb as "add"]();
  return 0;
}
