import { expect, test } from "bun:test";
import type { Contact } from "../sources/contacts";
import { reachOf } from "./reach";

// Made-up people, phones and addresses only.

const card: Contact = {
  addresses: [],
  birthday: null,
  company: null,
  handles: [
    "+33 6 00 00 00 01",
    "cam@example.com",
    "cam@studio.example",
    "cam.old@example.com",
  ],
  id: "card-cam",
  labels: {
    "+33 6 00 00 00 01": "Mobile",
    "cam.old@example.com": "Old",
    "cam@example.com": "Home",
    "cam@studio.example": "Work",
  },
  name: "Cam Testa",
  profiles: [],
  related: [],
  work: null,
};

test("reach: per app every account once, newest first; a title is the name shown there, else Contacts' label, else none", () => {
  const reach = reachOf({
    cards: [card],
    party: {
      handles: {
        email: ["cam@example.com"],
        phone: [],
        telegram: "cam_testa",
        whatsapp: ["+33600000001", "+33600000002"],
      },
    },
    seen: [
      {
        handle: "+33600000002",
        lastAt: "2026-11-17T09:14:00.000Z",
        shownName: "Cam (studio)",
        source: "whatsapp",
      },
      {
        handle: "+33600000001",
        lastAt: "2026-11-10T09:14:00.000Z",
        source: "whatsapp",
      },
    ],
  });
  expect(reach.map((r) => r.network)).toEqual([
    "whatsapp",
    "imessage",
    "telegram",
    "mail",
    "call",
  ]);
  const [whatsapp, messages, telegram, mail, call] = reach;
  expect(whatsapp?.accounts).toEqual([
    {
      handle: "+33600000002",
      lastAt: "2026-11-17T09:14:00.000Z",
      open: { lands: "chat", url: "https://wa.me/33600000002" },
      title: "Cam (studio)",
    },
    // Seen with no name of its own: Contacts' label.
    {
      handle: "+33600000001",
      lastAt: "2026-11-10T09:14:00.000Z",
      open: { lands: "chat", url: "https://wa.me/33600000001" },
      title: "Mobile",
    },
  ]);
  expect(messages?.accounts).toEqual([
    {
      handle: "+33 6 00 00 00 01",
      open: { lands: "chat", url: "sms:+33600000001" },
      title: "Mobile",
    },
  ]);
  expect(telegram?.accounts[0]?.open.url).toBe("https://t.me/cam_testa");
  // Three labelled mails, the directory's written once.
  expect(mail?.accounts.map((a) => [a.title, a.open.url])).toEqual([
    ["Home", "mailto:cam@example.com"],
    ["Work", "mailto:cam@studio.example"],
    ["Old", "mailto:cam.old@example.com"],
  ]);
  expect(call).toMatchObject({ label: "Call" });
  expect(call?.accounts.map((a) => a.open)).toEqual([
    { lands: "call", url: "tel:+33600000001" },
    { lands: "call", url: "tel:+33600000002" },
  ]);
});

test("reach: nothing that opens, no app at all; an account with no title is shown by its handle", () => {
  expect(reachOf({ cards: [], seen: [] })).toEqual([]);
  expect(
    reachOf({
      cards: [],
      party: { handles: { email: ["a@b.example"], phone: [], whatsapp: [] } },
      seen: [],
    })
  ).toEqual([
    {
      accounts: [
        {
          handle: "a@b.example",
          open: { lands: "chat", url: "mailto:a@b.example" },
        },
      ],
      label: "Mail",
      network: "mail",
    },
  ]);
});
