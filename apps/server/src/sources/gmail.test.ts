import { expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gmailSend } from "./gmail";

const ME = "me@example.com";
const FOUND = JSON.stringify({ messages: [{ id: "g1", threadId: "t1" }] });

/** A made-up gog: a search finds `found`; the send answers `send`. Every command line is kept. */
function gog(
  found = FOUND,
  send: {
    code?: number;
    killed?: unknown;
    stderr?: string;
    stdout?: string;
  } = {
    stdout: '{"messageId":"g2"}',
  },
  searchError?: string
) {
  const calls: string[][] = [];
  const files: boolean[] = [];
  const run = (cmd: string[]) => {
    calls.push(cmd);
    const attach = cmd.find((a) => a.startsWith("--attach="));
    if (attach) {
      files.push(existsSync(attach.slice(9)));
    }
    const ok = { code: 0, killed: null, stderr: "", stdout: "" };
    if (cmd[2] === "messages") {
      return Promise.resolve(
        searchError
          ? { ...ok, code: 1, stderr: searchError }
          : { ...ok, stdout: found }
      );
    }
    return Promise.resolve({ ...ok, ...send });
  };
  const path = gmailSend({
    addresses: () => [ME],
    run,
    staging: mkdtempSync(join(tmpdir(), "gmail-test-")),
  });
  return { calls, files, path };
}

const mail = {
  chat: "ana@example.com",
  from: ME,
  subject: "Friday",
  text: "Can you come?",
  to: "ana@example.com",
};

test("a new mail: exact argv, never reply-all, quote, signature or tracking", async () => {
  const g = gog();
  expect(await g.path.refusal(mail)).toBeUndefined();
  let handed = 0;
  expect(
    await g.path.send({ ...mail, cc: "bo@example.com" }, "t", () => {
      handed += 1;
    })
  ).toBe("gmail:g2");
  expect(handed).toBe(1);
  const send = g.calls.at(-1) as string[];
  expect(send).toEqual([
    "gog",
    "gmail",
    "send",
    "--to=ana@example.com",
    "--cc=bo@example.com",
    `--from=${ME}`,
    "--subject=Friday",
    "--body=Can you come?",
    `--account=${ME}`,
    "--json",
    "--no-input",
  ]);
});

test("a reply carries the Gmail id the search found, for the Message-ID", async () => {
  const g = gog();
  await g.path.send({ ...mail, onMessage: "mail:abc@mail.example.com" }, "t");
  expect(g.calls[0]).toContain("rfc822msgid:abc@mail.example.com");
  expect(g.calls.at(-1)).toContain("--reply-to-message-id=g1");
});

test("a file is staged for gog, then removed", async () => {
  const g = gog();
  const file = {
    bytes: new Uint8Array([1]),
    mime: "application/pdf",
    name: "a.pdf",
  };
  await g.path.send({ ...mail, file }, "t");
  expect(g.files).toEqual([true]);
  const staged = (g.calls.at(-1) as string[]).find((a) =>
    a.startsWith("--attach=")
  );
  expect(existsSync((staged as string).slice(9))).toBe(false);
});

test("refused: an address that isn't his, a bad address, a search miss, an account gog lacks, a reaction", async () => {
  const g = gog();
  expect(
    await g.path.refusal({ ...mail, from: "other@example.com" })
  ).toContain("isn't one of his");
  expect(
    await g.path.refusal({ ...mail, to: "ana@example.com, nobody" })
  ).toContain("addresses");
  expect(await g.path.refusal({ ...mail, cc: "x y@example.com" })).toContain(
    "addresses"
  );
  expect(await g.path.refusal({ ...mail, reaction: "👍" })).toContain(
    "takes no reactions"
  );
  expect(g.path.takes(mail.chat)).toMatchObject({ file: true, reply: true });
  expect(
    await gog('{"messages":[]}').path.refusal({
      ...mail,
      onMessage: "mail:x@y",
    })
  ).toContain("has no message");
  const nogmail = gog(FOUND, undefined, "no token for me@example.com");
  expect(await nogmail.path.refusal(mail)).toContain(
    "gog auth add me@example.com --services=gmail"
  );
});

test("a failure after gog started may have gone; a missing gog or a scope error did not send", async () => {
  const after = gog(FOUND, { code: 1, stderr: "boom" });
  await expect(after.path.send(mail, "t")).rejects.toThrow("may have gone");
  const killed = gog(FOUND, { code: 1, killed: "SIGTERM" });
  await expect(killed.path.send(mail, "t")).rejects.toThrow("may have gone");
  const none = gog(FOUND, { code: -1, stderr: "not found" });
  await expect(none.path.send(mail, "t")).rejects.toThrow(
    "not sent: gog didn't start"
  );
  const scope = gog(FOUND, {
    code: 1,
    stderr: "insufficient authentication scopes",
  });
  await expect(scope.path.send(mail, "t")).rejects.toThrow(
    "not sent: gog can't use me@example.com"
  );
});

test("a Message-ID that could widen the search is refused before it", async () => {
  const g = gog();
  expect(await g.path.refusal({ ...mail, onMessage: "mail:a b@x" })).toContain(
    "isn't a mail's id"
  );
  expect(
    await g.path.refusal({ ...mail, onMessage: 'mail:a"@x OR in:anywhere' })
  ).toContain("isn't a mail's id");
  expect(g.calls).toEqual([]);
});

test("an answer that isn't JSON still counts as sent; a comma in a file name and a file over 25 MB do not reach gog", async () => {
  const g = gog(FOUND, { stdout: "Sent." });
  const file = {
    bytes: new Uint8Array([1]),
    mime: "text/plain",
    name: "a,b.txt",
  };
  expect(await g.path.send({ ...mail, file }, "t")).toBe(
    "gmail: no id came back"
  );
  const staged = (g.calls.at(-1) as string[]).find((a) =>
    a.startsWith("--attach=")
  );
  expect(staged).toEndWith("a_b.txt");
  const big = { ...file, bytes: new Uint8Array(25_000_001) };
  expect(await g.path.refusal({ ...mail, file: big })).toContain(
    "at most 25 MB"
  );
});
