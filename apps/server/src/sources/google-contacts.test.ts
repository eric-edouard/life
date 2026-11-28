import { expect, test } from "bun:test";
import type { GoogleAccount } from "../core/gog";
import { CONTACTS_SCOPE, readGoogleContacts } from "./google-contacts";

const ANA = "ana@example.test";
const account = (over: Partial<GoogleAccount> = {}): GoogleAccount => ({
  address: ANA,
  scopes: [CONTACTS_SCOPE],
  services: ["contacts"],
  valid: true,
  ...over,
});

/** A made-up gog: the first page of `pages` per account, and the calls it was given. */
function gog(
  pages: { contacts: object[]; nextPageToken?: string }[],
  fail = false
) {
  const calls: string[][] = [];
  let page = 0;
  const run = (cmd: string[]) => {
    calls.push(cmd);
    if (fail) {
      return Promise.resolve({
        code: 1,
        stderr: "gog: invalid_grant",
        stdout: "",
      });
    }
    const answer = pages[page] ?? { contacts: [] };
    page += 1;
    return Promise.resolve({
      code: 0,
      stderr: "",
      stdout: JSON.stringify(answer),
    });
  };
  return { calls, run };
}

test("a person's card is its name and handles, its id Google's resource name", async () => {
  const g = gog([
    {
      contacts: [
        {
          email: "Ana@Example.test",
          name: "Ana Duarte",
          phone: "+33 6 12 34 56 78",
          resource: "people/c1",
        },
        { name: "No handle", resource: "people/c2" },
      ],
    },
  ]);
  const cards = await readGoogleContacts([account()], { run: g.run });
  expect(cards).toEqual([
    {
      addresses: [],
      birthday: null,
      company: null,
      handles: ["ana@example.test", "+33 6 12 34 56 78"],
      id: "google:people/c1",
      labels: {},
      name: "Ana Duarte",
      profiles: [],
      related: [],
      work: null,
    },
  ]);
  expect(g.calls[0]).toEqual([
    "gog",
    "contacts",
    "list",
    "--max=1000",
    "--readonly",
    `--account=${ANA}`,
    "--json",
    "--no-input",
  ]);
});

test("every page is read, each asking for the one before it", async () => {
  const g = gog([
    {
      contacts: [
        { email: "bo@example.test", name: "Bo", resource: "people/c3" },
      ],
      nextPageToken: "p2",
    },
    {
      contacts: [
        { email: "cy@example.test", name: "Cy", resource: "people/c4" },
      ],
      nextPageToken: "",
    },
  ]);
  const cards = await readGoogleContacts([account()], { run: g.run });
  expect(cards.map((c) => c.id)).toEqual([
    "google:people/c3",
    "google:people/c4",
  ]);
  expect(g.calls.map((c) => c.includes("--page=p2"))).toEqual([false, true]);
  expect(g.calls).toHaveLength(2);
});

test("an account whose grant doesn't carry Contacts, or whose token failed, is never read", async () => {
  const g = gog([{ contacts: [] }]);
  expect(
    await readGoogleContacts(
      [account({ scopes: ["https://www.googleapis.com/auth/gmail.readonly"] })],
      { run: g.run }
    )
  ).toEqual([]);
  expect(
    await readGoogleContacts([account({ valid: false })], { run: g.run })
  ).toEqual([]);
  expect(g.calls).toEqual([]);
});

test("an account gog can't read is logged and gives no card", async () => {
  const g = gog([], true);
  expect(await readGoogleContacts([account()], { run: g.run })).toEqual([]);
  expect(g.calls).toHaveLength(1);
});
