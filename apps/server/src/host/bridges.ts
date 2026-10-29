import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { HOME } from "../core/platform";
import { exec, execOk } from "../core/proc";
import { writeSecret } from "../core/secret";
import { setSettings, settings } from "../core/settings";
import { NETWORKS, type Network } from "../sources/bridged";
import {
  BRIDGES,
  bridgeSend,
  configOf,
  type LoginStep,
  linkBridge,
  loginFlows,
  OWNER,
  SERVER,
  unlinkBridge,
} from "../sources/matrix";

// `bun life bridge list|add|link|remove [network]` (docs/use/bridges.md): the one way to set up, link and remove a
// bridge. A network is added when its folder holds its config (`MACHINE_DIR/bridges/<network>`). The homeserver and each
// bridge run under launchd, one job each, outside Life.app: the homeserver holds deleted messages until the archive
// copies them, so it keeps running when Life is closed.

const SYNAPSE_DIR = join(BRIDGES, "synapse");
const PYTHON = join(SYNAPSE_DIR, ".venv", "bin", "python");
const HOMESERVER_YAML = join(SYNAPSE_DIR, "homeserver.yaml");
const AGENTS = join(HOME, "Library", "LaunchAgents");
const labelOf = (job: string) => `com.ericedouard.life.${job}`;
const uid = () => process.getuid?.() ?? 501;

/** A launchd job that keeps `args` running in `dir`, started at login, its output in ~/Library/Logs/<label>.log. */
async function keepRunning(job: string, dir: string, args: string[]) {
  const label = labelOf(job);
  const log = join(HOME, "Library", "Logs", `${label}.log`);
  const strings = args.map((a) => `<string>${a}</string>`).join("");
  mkdirSync(AGENTS, { recursive: true });
  const plist = join(AGENTS, `${label}.plist`);
  writeFileSync(
    plist,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${strings}</array>
<key>WorkingDirectory</key><string>${dir}</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>StandardOutPath</key><string>${log}</string><key>StandardErrorPath</key><string>${log}</string>
</dict></plist>
`
  );
  await exec(["launchctl", "bootout", `gui/${uid()}/${label}`]);
  await execOk(["launchctl", "bootstrap", `gui/${uid()}`, plist]);
}

async function stopRunning(job: string) {
  const label = labelOf(job);
  await exec(["launchctl", "bootout", `gui/${uid()}/${label}`]);
  rmSync(join(AGENTS, `${label}.plist`), { force: true });
}

const isRunning = async (job: string) =>
  (await exec(["launchctl", "print", `gui/${uid()}/${labelOf(job)}`])).code ===
  0;

const readYaml = (path: string) =>
  Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const writeYaml = (path: string, value: unknown) =>
  writeFileSync(path, Bun.YAML.stringify(value, null, 2));

async function restartHomeserver() {
  await exec([
    "launchctl",
    "kickstart",
    "-k",
    `gui/${uid()}/${labelOf("synapse")}`,
  ]);
  for (const _ of Array.from({ length: 30 })) {
    // biome-ignore lint/performance/noAwaitInLoops: waiting for it to answer, once a second
    const up = await fetch(
      "http://127.0.0.1:8008/_matrix/client/versions"
    ).catch(() => undefined);
    if (up?.ok) {
      return;
    }
    await Bun.sleep(1000);
  }
  throw new Error("the homeserver didn't come back");
}

/** The homeserver, once: Synapse in its own venv, local only, his account and its token (`SECRETS.matrix`). */
async function addHomeserver() {
  if (existsSync(HOMESERVER_YAML)) {
    return;
  }
  console.log("Setting up the homeserver (Synapse)…");
  mkdirSync(SYNAPSE_DIR, { recursive: true });
  await execOk(["uv", "venv", "-q", "-p", "3.12", ".venv"], {
    cwd: SYNAPSE_DIR,
    timeout: 300_000,
  });
  await execOk(
    ["uv", "pip", "install", "-q", "-p", PYTHON, "matrix-synapse", "qrcode"],
    {
      cwd: SYNAPSE_DIR,
      timeout: 600_000,
    }
  );
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
        port: 8008,
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
  await keepRunning("synapse", SYNAPSE_DIR, [
    PYTHON,
    "-m",
    "synapse.app.homeserver",
    "-c",
    HOMESERVER_YAML,
  ]);
  await restartHomeserver();
  const password = crypto.randomUUID();
  await execOk(
    [
      join(SYNAPSE_DIR, ".venv", "bin", "register_new_matrix_user"),
      "-c",
      HOMESERVER_YAML,
      "-u",
      "owner",
      "-p",
      password,
      "-a",
      "http://127.0.0.1:8008",
    ],
    { cwd: SYNAPSE_DIR }
  );
  const login = (await (
    await fetch("http://127.0.0.1:8008/_matrix/client/v3/login", {
      body: JSON.stringify({
        identifier: { type: "m.id.user", user: "owner" },
        password,
        type: "m.login.password",
      }),
      method: "POST",
    })
  ).json()) as { access_token: string };
  writeSecret("matrix", JSON.stringify({ token: login.access_token }));
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

const binaryOf = (n: Network) => n.cmd.split("/").at(-1) as string;

/** Adds a network's bridge, or rebuilds it at its newest release when it is there: then links it. */
async function add(n: Network) {
  await addHomeserver();
  const dir = join(BRIDGES, n.name);
  const src = join(dir, "src");
  // Its newest release tag, from git itself (no API, no rate limit).
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
    { timeout: 300_000 }
  );
  await execOk(
    [
      "go",
      "build",
      "-tags",
      "goolm",
      "-o",
      join(dir, binaryOf(n)),
      `./${n.cmd}`,
    ],
    {
      cwd: src,
      timeout: 900_000,
    }
  );
  const bin = join(dir, binaryOf(n));
  const config = join(dir, "config.yaml");
  if (!existsSync(config)) {
    await execOk([bin, "-c", config, "-e"], { cwd: dir });
    const c = readYaml(config) as Partial<
      Record<string, Record<string, unknown>>
    >;
    const appservice = c.appservice ?? {};
    const network = (c.network ?? {}) as Record<
      string,
      Record<string, unknown>
    >;
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
      homeserver: {
        ...c.homeserver,
        address: "http://127.0.0.1:8008",
        domain: SERVER,
      },
      // A bridge Life only sends through makes no rooms of its history.
      ...(n.reads || !network.history_sync
        ? {}
        : {
            network: {
              ...network,
              history_sync: {
                ...network.history_sync,
                max_initial_conversations: 0,
              },
            },
          }),
    });
    await execOk(
      [bin, "-g", "-c", config, "-r", join(dir, "registration.yaml")],
      { cwd: dir }
    );
    setRegistration(n.name, true);
    await restartHomeserver();
  }
  await keepRunning(`bridge-${n.name}`, dir, [bin, "-c", "config.yaml"]);
  console.log(`${n.label} bridge running.`);
  if (process.stdin.isTTY) {
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
    {
      stdout: "inherit",
    }
  );

/** Asks him in the terminal; hidden for a password or a cookie (`stty -echo`). */
function ask(name: string, hidden: boolean) {
  if (hidden) {
    Bun.spawnSync(["stty", "-echo"], { stdin: "inherit" });
  }
  // biome-ignore lint/suspicious/noAlert: the CLI asks him in his terminal
  const value = prompt(`${name}:`) ?? "";
  if (hidden) {
    Bun.spawnSync(["stty", "echo"], { stdin: "inherit" });
    console.log("");
  }
  return value;
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
  if (step.cookies?.url) {
    console.log(
      `From ${step.cookies.url} (signed in), paste each cookie's value:`
    );
  }
}

/** Links a network: its first way to log in unless `flow` names another; then its source on when Life reads it. */
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
    show,
    value: (f) => ask(f.name, f.hidden),
  });
  if (n.reads && !settings().sources.includes(n.name)) {
    setSettings({ sources: [...settings().sources, n.name] });
    console.log(
      `${n.label} is on: Life copies it once it restarts (menu bar → Restart).`
    );
  }
  console.log(`${n.label} linked.`);
}

/** Removes a network's bridge: logged out, unregistered, stopped, its folder gone, its source off. The archive stays. */
async function remove(n: Network) {
  await unlinkBridge(n.name).catch((e: Error) =>
    console.error(`logout: ${e.message}`)
  );
  await stopRunning(`bridge-${n.name}`);
  if (existsSync(HOMESERVER_YAML)) {
    setRegistration(n.name, false);
    await restartHomeserver();
  }
  rmSync(join(BRIDGES, n.name), { force: true, recursive: true });
  setSettings({ sources: settings().sources.filter((s) => s !== n.name) });
  console.log(`${n.label} removed; what Life archived of it stays.`);
}

const sourceState = (n: Network) => {
  if (!n.reads) {
    return "sends only";
  }
  return settings().sources.includes(n.name) ? "source on" : "source off";
};

/** Each network: added, running, linked (its bridge's own word), its source on. */
async function list() {
  for (const n of NETWORKS) {
    const added = existsSync(join(BRIDGES, n.name, "config.yaml"));
    const state = added
      ? [
          // biome-ignore lint/performance/noAwaitInLoops: one line per network, in order
          (await isRunning(`bridge-${n.name}`)) ? "running" : "stopped",
          (await bridgeSend(n.name).blocked()) ?? "linked",
          sourceState(n),
        ].join(", ")
      : "not added";
    console.log(`${n.label.padEnd(10)} ${state}`);
  }
}

/** `bridge list | add <network> | link <network> [flow] | remove <network>`. */
export async function bridgeCommand(args: string[]) {
  const [verb, name, flow] = args;
  if (verb === "list" || !verb) {
    await list();
    return 0;
  }
  const n = NETWORKS.find((x) => x.name === name);
  if (!n) {
    console.error(
      `usage: bun life bridge list | add|link|remove <${NETWORKS.map((x) => x.name).join("|")}> [flow]`
    );
    return 2;
  }
  if (verb === "add") {
    await add(n);
  } else if (verb === "link") {
    configOf(n.name);
    await link(n, flow);
  } else if (verb === "remove") {
    await remove(n);
  } else {
    console.error(`unknown verb ${verb}`);
    return 2;
  }
  return 0;
}
