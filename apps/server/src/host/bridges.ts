import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { WINDOWS } from "../core/platform";
import { execOk, untilAnswers } from "../core/proc";
import { SECRETS, writeSecret } from "../core/secret";
import { keepRunning } from "../core/service";
import { setSettings, settings } from "../core/settings";
import { NETWORKS, type Network } from "../sources/bridged";
import {
  BRIDGES,
  type CookieStep,
  cookieValues,
  HOMESERVER_URL,
  hasStates,
  isBridgeAdded,
  type LoginStep,
  linkBridge,
  loginFlows,
  OWNER,
  pastedValues,
  readBlock,
  readLogins,
  SERVER,
  unlinkBridge,
} from "../sources/matrix";
import { messagingStatus } from "./messaging-status";
import { hasChrome, signInWithChrome } from "./sign-in-browser";

// `bun life bridge [status]|add|link|remove [network]` (docs/use/bridges.md): the one way to set up, link and remove a
// bridge. A network is added when its folder holds its config (`MACHINE_DIR/bridges/<network>`). The homeserver and each
// bridge run in one job the Mac keeps running (`core/service.ts`, `RUN_BRIDGES`), outside Life.app: the homeserver holds
// deleted messages until the archive copies them, so it keeps running when Life is closed.

const SYNAPSE_DIR = join(BRIDGES, "synapse");
const VENV = join(SYNAPSE_DIR, ".venv", "bin");
const PYTHON = join(VENV, "python");
const HOMESERVER_YAML = join(SYNAPSE_DIR, "homeserver.yaml");
const PORT = Number(new URL(HOMESERVER_URL).port);

const readYaml = (path: string) =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeYaml = (path: string, value: unknown) =>
  writeFileSync(path, Bun.YAML.stringify(value, null, 2));

const configPath = (n: Network) => join(BRIDGES, n.name, "config.yaml");
const isAdded = (n: Network) => isBridgeAdded(n.name);

/**
 * The one job's program: the homeserver and every added bridge (a folder holding its config, run as `./bridge`), each
 * started again 10 s after it stops; on TERM each is stopped and waited for, so the homeserver shuts down cleanly. A
 * bridge's stdout repeats its own capped log (logs/bridge.log, every level): only its stderr reaches the job's log, which nothing caps.
 */
export const RUN_BRIDGES = `
trap 'kill $(jobs -p) 2>/dev/null; wait; exit 0' TERM
keep() { (
  cd "$1" || exit 1
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
 * The daily heal, when the homeserver is set up: the one job restarted, then each added bridge answering with its
 * logins' states (`hasStates`). A restart makes each bridge check its login
 * anew, so one that hung while saying CONNECTED (LINE, 5 Nov 2026) is running again or shows why not on the status
 * snapshot.
 */
export async function healBridges() {
  if (WINDOWS || !existsSync(HOMESERVER_YAML)) {
    return;
  }
  await restartBridges();
  await Promise.all(
    NETWORKS.filter(isAdded).map((n) =>
      untilAnswers(
        async () => hasStates(await readLogins(n.name)) || undefined,
        `the ${n.label} bridge`
      )
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
      // The buffer before Life's archive: a deleted message's text is never pruned (AGENTS.md).
      redaction_retention_period: null,
      suppress_key_server_warning: true,
      trusted_key_servers: [],
    });
  }
  // The password is kept before his account is made, so a try that stops halfway logs in next time.
  const saved = (
    existsSync(SECRETS.matrix)
      ? JSON.parse(readFileSync(SECRETS.matrix, "utf8"))
      : {}
  ) as { password?: string; token?: string };
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

/** Its newest release tag, from git itself (no API, no rate limit). */
async function newestTag(n: Network) {
  const tag = (
    await execOk([
      "git",
      "ls-remote",
      "--tags",
      "--refs",
      "--sort=-v:refname",
      `https://github.com/${n.repo}`,
    ])
  )
    .split("\n")[0]
    ?.split("refs/tags/")[1];
  if (!tag) {
    throw new Error(`${n.repo}: no release tag`);
  }
  return tag;
}

/** Its config, the first time: this homeserver, SQLite, him as its admin. */
async function writeConfig(n: Network, bin: string, dir: string) {
  const config = configPath(n);
  await execOk([bin, "-c", config, "-e"], { cwd: dir });
  const c = readYaml(config) as Partial<
    Record<string, Record<string, unknown>>
  >;
  const appservice = c.appservice ?? {};
  writeYaml(config, {
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
  });
  await execOk(
    [bin, "-g", "-c", config, "-r", join(dir, "registration.yaml")],
    { cwd: dir }
  );
  setRegistration(n.name, true);
}

/** Adds a network's bridge, or rebuilds it at its newest release when it is there; links it unless it is linked. */
async function add(n: Network) {
  await addHomeserver();
  const dir = join(BRIDGES, n.name);
  const src = join(dir, "src");
  const bin = join(dir, "bridge");
  const tag = await newestTag(n);
  console.log(`Building the ${n.label} bridge (${n.repo} ${tag})…`);
  rmSync(src, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  await execOk(
    [
      "git",
      "clone",
      "-q",
      "--depth",
      "1",
      "--branch",
      tag,
      `https://github.com/${n.repo}`,
      src,
    ],
    {
      timeout: 300_000,
    }
  );
  await execOk(["go", "build", "-tags", "goolm", "-o", bin, `./${n.cmd}`], {
    cwd: src,
    timeout: 900_000,
  });
  if (!isAdded(n)) {
    await writeConfig(n, bin, dir);
  }
  await restartBridges();
  await untilAnswers(() => readLogins(n.name), `the ${n.label} bridge`);
  console.log(`${n.label} bridge running.`);
  if (!(await readBlock(n.name))) {
    console.log(`${n.label} is linked already.`);
  } else if (process.stdin.isTTY) {
    await link(n);
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

/** Links a network: its first way to log in unless `flow` names another; then its source on. */
async function link(n: Network, flow?: string) {
  const flows = await loginFlows(n.name);
  const chosen = flows.find((f) => f.id === flow) ?? flows[0];
  if (!chosen) {
    throw new Error(`${n.label}: the bridge offers no way to log in`);
  }
  console.log(
    `Linking ${n.label}: ${chosen.description} (others: ${flows.map((f) => f.id).join(", ")})`
  );
  await linkBridge(n.name, chosen.id, {
    cookies: signIn,
    show,
    value: (f) => ask(f.name, f.hidden),
  });
  if (!settings().sources.includes(n.name)) {
    setSettings({ sources: [...settings().sources, n.name] });
    console.log(
      `${n.label} is on: Life copies it once it restarts (menu bar → Restart).`
    );
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
  setSettings({ sources: settings().sources.filter((s) => s !== n.name) });
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
