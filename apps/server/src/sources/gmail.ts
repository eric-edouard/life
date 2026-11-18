import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { MIN } from "../core/clock";
import { gogCall } from "../core/gog";
import { exec } from "../core/proc";
import type { Outgoing, SendPath } from "./contract";
import { mailAccounts, messageIdOfMail } from "./mail";

// The one mail send: gog's Gmail does it, from an account gog holds (the only place Life names `gogCall("gmail"`,
// `scripts/imports.test.ts`). A new mail, or a reply in the thread of one message of his; never reply-all, a quote, a
// signature or tracking: the mail is exactly what his card showed.

interface Run {
  code: number;
  killed: unknown;
  stderr: string;
  stdout: string;
}
interface Options {
  /** The addresses of his mail accounts. */
  addresses?: () => string[];
  /** Runs gog (`gogCall`'s command line and environment). */
  run?: (
    cmd: string[],
    o: { env: Record<string, string | undefined>; timeout: number }
  ) => Promise<Run>;
  /** Where a file is staged for gog: a fresh private folder in it, removed after the send. */
  staging?: string;
}

/** What a Message-ID may hold in a Gmail search: no space, quote, brace or paren. */
const MESSAGE_ID = /^[\w.!#$%&'*+/=?^`|~@-]+$/;
/** Gmail takes 35 MB a message, its encoding included. ponytail: 25 MB of file; raise it if one is ever refused wrongly. */
const FILE_MAX = 25_000_000;
const ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const AUTH =
  /auth|token|scope|credential|insufficient|invalid_grant|keyring|permission/i;

/** A comma-separated list of addresses, or the one it isn't. */
const addressesIn = (list: string) => list.split(",").map((a) => a.trim());
const isAddresses = (list: string) =>
  addressesIn(list).every((a) => ADDRESS.test(a));

/** What he does when gog can't act as `account` for Gmail: one step, gog's own. */
const reauthorize = (account: string) =>
  `gog can't use ${account} for Gmail: run \`gog auth add ${account} --services=gmail --force-consent\` and sign in`;

/** gog's answer to the send: the sent id, or `not sent` (gog didn't start, or can't act for the account) or `may have gone`. */
function answerOf(r: Run, from: string) {
  if (r.killed) {
    throw new Error("may have gone: gog didn't answer: read Sent");
  }
  if (r.code === -1 || (r.code !== 0 && AUTH.test(r.stderr))) {
    throw new Error(
      `not sent: ${r.code === -1 ? `gog didn't start: ${r.stderr.trim()}` : reauthorize(from)}`
    );
  }
  if (r.code !== 0) {
    throw new Error(
      `may have gone: gog failed (${r.stderr.trim().slice(-200)}): read Sent`
    );
  }
  // It went (exit 0): an answer that isn't JSON, or holds no id, still counts as sent.
  let out: { id?: string; messageId?: string } = {};
  try {
    out = JSON.parse(r.stdout);
  } catch {
    // no id came back
  }
  const id = out.messageId ?? out.id;
  return id ? `gmail:${id}` : "gmail: no id came back";
}

/**
 * The send path of mail through gog's Gmail (`Descriptor.send`). It returns the sent message's Gmail id as gog's JSON
 * gives it, not Life's `mail:<Message-ID>` (gog's answer holds no RFC id; Mail's copy has its own id later).
 */
export function gmailSend({
  addresses = () => mailAccounts().flatMap((a) => a.addresses),
  run = (cmd, o) => exec(cmd, o),
  staging = tmpdir(),
}: Options = {}): SendPath {
  const gog = (account: string, args: string[], timeout = MIN) => {
    const [cmd, { env }] = gogCall("gmail", account, args);
    return run(cmd, { env, timeout });
  };
  /** Proves gog holds `from` with Gmail by a read, and finds the Gmail id of the message replied to: `id` is undefined without one. */
  const lookup = async (
    d: Outgoing
  ): Promise<{ id?: string; problem?: string }> => {
    const from = d.from as string;
    const rfc = d.onMessage && messageIdOfMail(d.onMessage);
    if (d.onMessage && !(rfc && MESSAGE_ID.test(rfc))) {
      return { problem: "`onMessage` isn't a mail's id (`mail:<Message-ID>`)" };
    }
    const r = await gog(from, [
      "messages",
      "search",
      rfc ? `rfc822msgid:${rfc}` : "in:sent",
      "--max=1",
      "--ids-only",
    ]);
    if (r.code !== 0) {
      return {
        problem: AUTH.test(r.stderr)
          ? reauthorize(from)
          : `gog couldn't read ${from}'s Gmail: ${r.stderr.trim().slice(-200)}`,
      };
    }
    if (!rfc) {
      return {};
    }
    const id = (JSON.parse(r.stdout || "{}") as { messages?: { id: string }[] })
      .messages?.[0]?.id;
    return id
      ? { id }
      : { problem: `${from}'s Gmail has no message ${d.onMessage}` };
  };
  return {
    block: () => Promise.resolve(undefined),
    holds: () => [],
    refusal: async (d) => {
      if (d.reaction || d.mentions) {
        return "mail sends text and one file";
      }
      if (!(d.from && d.to && d.subject)) {
        return "a mail needs `from`, `to` and `subject`";
      }
      if (d.file && d.file.bytes.length > FILE_MAX) {
        return `a mail's file is at most ${FILE_MAX / 1e6} MB`;
      }
      if (!addresses().some((a) => a.toLowerCase() === d.from?.toLowerCase())) {
        return `${d.from} isn't one of his mail addresses`;
      }
      if (!(isAddresses(d.to) && (!d.cc || isAddresses(d.cc)))) {
        return "`to` and `cc` are addresses separated by commas";
      }
      return (await lookup(d)).problem;
    },
    send: async (d) => {
      const found = await lookup(d);
      if (found.problem) {
        throw new Error(`not sent: ${found.problem}`);
      }
      const from = d.from as string;
      const folder = d.file
        ? await mkdtemp(join(staging, "life-mail-"))
        : undefined;
      try {
        let attach: string[] = [];
        if (d.file && folder) {
          const path = join(folder, basename(d.file.name).replaceAll(",", "_"));
          await Bun.write(path, d.file.bytes);
          attach = [`--attach=${path}`];
        }
        const r = await gog(
          from,
          [
            "send",
            `--to=${d.to}`,
            ...(d.cc ? [`--cc=${d.cc}`] : []),
            `--from=${from}`,
            `--subject=${d.subject}`,
            `--body=${d.text ?? ""}`,
            ...(found.id ? [`--reply-to-message-id=${found.id}`] : []),
            ...attach,
          ],
          3 * MIN
        );
        return answerOf(r, from);
      } finally {
        if (folder) {
          await rm(folder, { force: true, recursive: true });
        }
      }
    },
  };
}
