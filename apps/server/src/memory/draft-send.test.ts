import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../core/hash";
import type { SourceEvent } from "../records/source";
import type { Descriptor, Outgoing, SendPath } from "../sources/contract";
import { BRIDGES } from "../sources/matrix";
import { resolveDraft, sendDraft } from "./draft-send";

const KIT_JID = /^\d+@s\.whatsapp\.net$/;
const NOW = new Date("2026-11-18T09:00:00.000Z");
const line = (chat: string, chatName: string): SourceEvent => ({
  at: "2026-11-10T12:00:00.000Z",
  chat,
  chatName,
  fromMe: false,
  id: `${chat}:1`,
  sender: chatName,
  source: "telegram",
  text: "hi",
});

/** A made-up bridged source: Ana's two chats, one of them its bridge's room, and a group. */
const source = (
  name: string,
  events: SourceEvent[],
  opens = false,
  refusal: SendPath["refusal"] = async () => undefined,
  send: SendPath["send"] = async () => "$ev"
): Descriptor => ({
  kind: "chat",
  label: name,
  name: name as never,
  read: () => events,
  send: {
    block: async () =>
      name === "elsewhere" ? "elsewhere's bridge isn't on this Mac" : undefined,
    holds: (chats) => chats.filter((c) => c.startsWith("!")),
    limitMs: () => 1000,
    opens: opens
      ? async (chat) => (KIT_JID.test(chat) ? "Test Kit" : undefined)
      : undefined,
    refusal,
    send,
  },
  silentAfter: 0,
});

// Its bridge, added and linked: the made-up provisioning API says its one login is connected.
const provisioning = Bun.serve({
  fetch: () =>
    Response.json({ logins: [{ state: { state_event: "CONNECTED" } }] }),
  port: 0,
});
beforeAll(() => {
  mkdirSync(join(BRIDGES, "sendnet"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "sendnet", "config.yaml"),
    `appservice:\n  port: ${provisioning.port}\nprovisioning:\n  shared_secret: s3cret\n`
  );
});
afterAll(() => {
  provisioning.stop();
  rmSync(join(BRIDGES, "sendnet"), { force: true, recursive: true });
});

const hi = "Can you come Friday?";

test("a draft names one chat its bridge holds: a chat key, or a person with one such 1:1 chat; its name is what his card shows", async () => {
  const sendnet = source("sendnet", [
    line("!ana:life.local", "Test Ana"),
    line("ana-export-id", "Test Ana"),
    line("!crew:life.local", "Boat crew"),
  ]);
  const read = (to: string) =>
    resolveDraft({ channel: "sendnet", text: hi, to }, NOW, [sendnet]);
  expect(await read("!crew:life.local")).toEqual({
    channel: "sendnet",
    chat: "!crew:life.local",
    text: hi,
    to: "Boat crew",
  });
  expect(await read("Test Ana")).toMatchObject({ chat: "!ana:life.local" });
  await expect(read("ana-export-id")).rejects.toThrow("no chat");
  await expect(read("Nobody Known")).rejects.toThrow("no chat");
});

test("a draft is refused when asked: two chats for one person, a source that doesn't send, or a bridge not on this Mac", async () => {
  const two = source("sendnet", [
    line("!ana:life.local", "Test Ana"),
    line("!ana2:life.local", "Test Ana"),
  ]);
  const ask = (channel: string, sources: Descriptor[]) =>
    resolveDraft({ channel, text: hi, to: "Test Ana" }, NOW, sources);
  await expect(ask("sendnet", [two])).rejects.toThrow(
    "Test Ana has 2 chats on sendnet"
  );
  const mail = { ...two, kind: "mail", name: "mail", send: undefined };
  await expect(ask("mail", [mail as Descriptor, two])).rejects.toThrow(
    "one of sendnet"
  );
  await expect(ask("elsewhere", [source("elsewhere", [])])).rejects.toThrow(
    "elsewhere's bridge isn't on this Mac"
  );
  await expect(
    resolveDraft({ channel: "sendnet", to: "Test Ana" }, NOW, [two])
  ).rejects.toThrow("needs `text`");
});

test("a chat that doesn't exist yet opens by its id when the source can open it; a group it never saw, or a name, doesn't", async () => {
  const wa = source("whatsapp", [line("!ana:life.local", "Test Ana")], true);
  const read = (to: string) =>
    resolveDraft({ channel: "whatsapp", text: hi, to }, NOW, [wa]);
  expect(await read("66123456@s.whatsapp.net")).toEqual({
    channel: "whatsapp",
    chat: "66123456@s.whatsapp.net",
    text: hi,
    to: "Test Kit (66123456@s.whatsapp.net)",
  });
  await expect(read("120@g.us")).rejects.toThrow(
    "a group it never saw can't be opened"
  );
  await expect(read("Nobody Known")).rejects.toThrow("no chat");
  // A chat Life has no messages of can't be replied in or mention anyone.
  await expect(
    resolveDraft(
      {
        channel: "whatsapp",
        onMessage: "x",
        text: hi,
        to: "66123456@s.whatsapp.net",
      },
      NOW,
      [wa]
    )
  ).rejects.toThrow("isn't a message of");
});

const ana = (over: Partial<SourceEvent> = {}) => ({
  ...line("!ana:life.local", "Test Ana"),
  id: "sendnet:!ana:life.local/$e1",
  sender: "ana-handle",
  text: "x".repeat(400),
  ...over,
});

test("the message replied or reacted to is stamped as its sender and first 300 characters; one the chat doesn't hold is refused", async () => {
  const net = source("sendnet", [
    ana(),
    ana({ fromMe: true, id: "m2", sender: "me" }),
  ]);
  const base = { channel: "sendnet", to: "Test Ana" };
  const reply = await resolveDraft(
    { ...base, onMessage: ana().id, text: hi },
    NOW,
    [net]
  );
  expect(reply.quoted).toEqual({ sender: "ana-handle", text: "x".repeat(300) });
  expect(
    (
      await resolveDraft({ ...base, onMessage: "m2", reaction: "👍" }, NOW, [
        net,
      ])
    ).quoted?.sender
  ).toBe("me");
  await expect(
    resolveDraft({ ...base, onMessage: "sendnet:!other/$e9", text: hi }, NOW, [
      net,
    ])
  ).rejects.toThrow("isn't a message of Test Ana");
});

test("a mention names a sender who wrote in the chat, never him", async () => {
  const net = source("sendnet", [
    ana(),
    ana({ fromMe: true, id: "m2", sender: "me" }),
  ]);
  const base = { channel: "sendnet", text: "Hi @Ana", to: "Test Ana" };
  const ok = await resolveDraft(
    { ...base, mentions: [{ name: "Ana", sender: "ana-handle" }] },
    NOW,
    [net]
  );
  expect(ok.mentions).toEqual([{ name: "Ana", sender: "ana-handle" }]);
  await Promise.all(
    ["someone-else", "me"].map((sender) =>
      expect(
        resolveDraft({ ...base, mentions: [{ name: "Ana", sender }] }, NOW, [
          net,
        ])
      ).rejects.toThrow("never wrote in Test Ana")
    )
  );
});

/** A made-up file on disk. */
const fileWith = (bytes: string, name = "menu.txt") => {
  const dir = join(tmpdir(), `draft-${crypto.randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { dir, path };
};

test("a file is stamped by its real path, name, size, type and digest; one that isn't a file, or that the chat refuses, is refused", async () => {
  const seen: Parameters<SendPath["refusal"]>[0][] = [];
  const net = source("sendnet", [ana()], false, (d) => {
    seen.push(d);
    return Promise.resolve(
      d.file?.mime === "image/png"
        ? "this chat takes no image/png files"
        : undefined
    );
  });
  const { dir, path } = fileWith("lunch menu");
  const link = join(dir, "link.txt");
  symlinkSync(path, link);
  const ask = (file: string) =>
    resolveDraft({ channel: "sendnet", file, to: "Test Ana" }, NOW, [net]);
  const stored = await ask(link);
  expect(stored.file).toEqual({
    mime: "text/plain",
    name: "link.txt",
    path: realpathSync(path),
    sha256: digest("sha256", Buffer.from("lunch menu"), 64),
    size: 10,
  });
  expect(new TextDecoder().decode(seen[0]?.file?.bytes)).toBe("lunch menu");
  await expect(ask(dir)).rejects.toThrow("isn't a file Life can send");
  await expect(ask(join(dir, "none.txt"))).rejects.toThrow("no file at");
  const png = fileWith("not really", "photo.png");
  await expect(ask(png.path)).rejects.toThrow(
    "can't send this: this chat takes no image/png files"
  );
  rmSync(dir, { force: true, recursive: true });
  rmSync(png.dir, { force: true, recursive: true });
});

test("the send reads the file again, and sends only the bytes he saw: a file changed since, or gone, sends nothing", async () => {
  const sent: Parameters<SendPath["send"]>[] = [];
  const net = source(
    "sendnet",
    [ana()],
    false,
    async () => undefined,
    (...a) => {
      sent.push(a);
      return Promise.resolve("$sent");
    }
  );
  const { dir, path } = fileWith("lunch menu");
  const stored = await resolveDraft(
    { channel: "sendnet", file: path, text: hi, to: "Test Ana" },
    NOW,
    [net]
  );
  expect(
    await sendDraft(stored, "dec_000000000001", { since: NOW }, [net])
  ).toBe("$sent");
  expect(sent[0]?.[0]).toMatchObject({
    chat: "!ana:life.local",
    file: { mime: "text/plain", name: "menu.txt" },
    text: hi,
  });
  expect(sent[0]?.[1]).toBe("dec_000000000001");
  writeFileSync(path, "dinner menu");
  await expect(
    sendDraft(stored, "dec_000000000002", { since: NOW }, [net])
  ).rejects.toThrow("not sent: the file changed since the card was asked");
  rmSync(path);
  await expect(
    sendDraft(stored, "dec_000000000003", { since: NOW }, [net])
  ).rejects.toThrow("not sent: the file is gone");
  expect(sent).toHaveLength(1);
  rmSync(dir, { force: true, recursive: true });
});

test("the chat's refusal is asked again at the send; a stored draft without a chat sends nothing", async () => {
  let refuse: string | undefined;
  const net = source("sendnet", [ana()], false, async () => refuse);
  const stored = await resolveDraft(
    { channel: "sendnet", text: hi, to: "Test Ana" },
    NOW,
    [net]
  );
  refuse = "this chat takes no replies";
  await expect(
    sendDraft(stored, "dec_000000000004", { since: NOW }, [net])
  ).rejects.toThrow("not sent: this chat takes no replies");
  const { chat: _, ...asked } = stored;
  await expect(
    sendDraft(asked, "dec_000000000005", { since: NOW }, [net])
  ).rejects.toThrow("no chat to send into");
});

test("a mail draft has no chat: its addresses as given, and a reply quotes the mail it answers with its subject", async () => {
  const sent: Outgoing[] = [];
  const mail: Descriptor = {
    ...source("mail", [
      {
        ...line("thread-1", "Friday?"),
        id: "mail:abc@mail.example.com",
        sender: "ana@example.com",
        text: `Friday?\n${"y".repeat(400)}`,
      },
    ]),
    kind: "mail",
    send: {
      block: async () => undefined,
      holds: () => [],
      limitMs: () => 1000,
      refusal: (d) => {
        sent.push(d);
        return Promise.resolve(undefined);
      },
      send: async () => "g1",
    },
  } as Descriptor;
  const draft = {
    channel: "mail",
    from: "me@example.com",
    subject: "Re: Friday?",
    text: "Yes",
    to: "ana@example.com",
  };
  expect(await resolveDraft(draft, NOW, [mail])).toEqual(draft);
  const reply = await resolveDraft(
    { ...draft, onMessage: "mail:abc@mail.example.com" },
    NOW,
    [mail]
  );
  expect(reply.chat).toBeUndefined();
  expect(reply.quoted).toMatchObject({
    sender: "ana@example.com",
    subject: "Friday?",
  });
  expect(reply.quoted?.text).toHaveLength(300);
  expect(sent.at(-1)).toMatchObject({
    from: "me@example.com",
    to: "ana@example.com",
  });
  await expect(
    resolveDraft({ ...draft, onMessage: "mail:none@x" }, NOW, [mail])
  ).rejects.toThrow("isn't a message of mail");
  expect(await sendDraft(reply, "t", { since: NOW }, [mail])).toBe("g1");
});

test("a message in the chat since the card (theirs or his own) sends nothing; one before it does not; steps come in order; mail skips the check", async () => {
  const asked = new Date("2026-11-18T09:00:00.000Z");
  const at = (iso: string, fromMe = false): SourceEvent => ({
    ...ana(),
    at: iso,
    fromMe,
    id: iso,
  });
  const steps: string[] = [];
  const sent: string[] = [];
  const net = (events: SourceEvent[]) =>
    source(
      "sendnet",
      events,
      false,
      async () => undefined,
      (_d, _txn, handed) => {
        handed?.();
        sent.push("went");
        return Promise.resolve("$ev");
      }
    );
  const stored = await resolveDraft(
    { channel: "sendnet", text: hi, to: "Test Ana" },
    NOW,
    [net([ana()])]
  );
  const opts = { onStep: (x: string) => steps.push(x), since: asked };
  for (const late of [
    at("2026-11-18T09:05:00.000Z"),
    at("2026-11-18T09:05:00.000Z", true),
  ]) {
    // biome-ignore lint/performance/noAwaitInLoops: two refusals, in order
    await expect(sendDraft(stored, "t1", opts, [net([late])])).rejects.toThrow(
      "not sent: someone wrote in"
    );
  }
  expect(sent).toEqual([]);
  expect(steps).toEqual([]);
  expect(
    await sendDraft(stored, "t2", opts, [net([at("2026-11-18T08:59:00.000Z")])])
  ).toBe("$ev");
  expect(steps).toEqual(["chat_checked", "handed", "confirmed"]);
  // After his last attempt that went nowhere, only what is newer blocks.
  expect(
    await sendDraft(
      stored,
      "t3",
      { since: new Date("2026-11-18T09:10:00.000Z") },
      [net([at("2026-11-18T09:05:00.000Z")])]
    )
  ).toBe("$ev");
});

test("a send that can never go says so: the file gone, the chat's refusal, a channel that is off", async () => {
  const net = source("sendnet", [ana()], false, async () => undefined);
  const stored = await resolveDraft(
    { channel: "sendnet", text: hi, to: "Test Ana" },
    NOW,
    [net]
  );
  const off = await sendDraft(stored, "t", { since: NOW }, []).catch((e) => e);
  expect(off).toMatchObject({ retry: false });
  const blocked = source("sendnet", [ana()], false);
  blocked.send = {
    ...(blocked.send as SendPath),
    block: async () => "the bridge is down",
  };
  const later = await sendDraft(stored, "t", { since: NOW }, [blocked]).catch(
    (e) => e
  );
  expect(later.message).toBe("not sent: the bridge is down");
  expect(later.retry).toBeUndefined();
});
