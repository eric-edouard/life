import { expect, test } from "bun:test";
import { personPicturesOf, pictureFileOf } from "./person-pictures";

const DIGEST_JPG = /^[0-9a-f]{32}\.jpg$/;
const jpg = (n: number) => new Uint8Array([0xff, 0xd8, n]);
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

test("Contacts first, then each source in order, the same picture once, one no handle places is dropped", () => {
  const { files, index } = personPicturesOf(
    [{ bytes: jpg(1), card: "card-anna" }],
    [
      {
        pictures: [
          { bytes: png(2), handles: ["+15550001"] },
          { bytes: jpg(1), handles: ["+15550001"] },
          { bytes: jpg(9), handles: ["+15559999"] },
        ],
        source: "whatsapp",
      },
      {
        pictures: [{ bytes: jpg(3), handles: ["anna.ig"] }],
        source: "instagram",
      },
    ],
    {
      canon: (ref) => (ref === "person:con_anna" ? "person:anna" : ref),
      contacts: [{ card: "card-anna", id: "con_anna" }],
      resolve: (h) =>
        h === "+15550001" || h === "anna.ig" ? "person:anna" : null,
    }
  );
  expect(index["person:anna"]).toEqual([
    { file: pictureFileOf(jpg(1)), source: "contacts" },
    { file: pictureFileOf(png(2)), source: "whatsapp" },
    { file: pictureFileOf(jpg(3)), source: "instagram" },
  ]);
  expect(Object.keys(index)).toEqual(["person:anna"]);
  expect(files.size).toBe(3);
});

test("a picture's file is named by its bytes and its format", () => {
  expect(pictureFileOf(jpg(1))).toMatch(DIGEST_JPG);
  expect(pictureFileOf(png(1))).toEndWith(".png");
  expect(pictureFileOf(jpg(1))).not.toBe(pictureFileOf(jpg(2)));
});
