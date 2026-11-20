import { expect, test } from "bun:test";
import { PICTURE_PX, pictureFileOf } from "./party";
import { personPicturesOf, pictureIdOf } from "./person-pictures";

const DIGEST = /^[0-9a-f]{32}$/;
const jpg = (n: number) => new Uint8Array([0xff, 0xd8, n]);
const png = (n: number) => new Uint8Array([0x89, 0x50, 0x4e, 0x47, n]);

test("Contacts first, then each source in order, the same picture once, one no handle places is dropped", () => {
  const { files, index } = personPicturesOf(
    [{ bytes: jpg(1), card: { handles: [], id: "card-anna" } }],
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
      ownerOfCard: (card) =>
        card.id === "card-anna" ? "person:anna" : undefined,
      resolve: (h) =>
        h === "+15550001" || h === "anna.ig" ? "person:anna" : null,
    }
  );
  expect(index["person:anna"]).toEqual([
    { id: pictureIdOf(jpg(1)), source: "contacts" },
    { id: pictureIdOf(png(2)), source: "whatsapp" },
    { id: pictureIdOf(jpg(3)), source: "instagram" },
  ]);
  expect(Object.keys(index)).toEqual(["person:anna"]);
  expect(files.size).toBe(3);
});

test("a picture's id is its original bytes' digest alone, whatever their format", () => {
  expect(pictureIdOf(jpg(1))).toMatch(DIGEST);
  expect(pictureIdOf(png(1))).toMatch(DIGEST);
  expect(pictureIdOf(jpg(1))).not.toBe(pictureIdOf(jpg(2)));
});

test("a kept picture's file names its size, so an older full-size file of the same id is never served as it", () => {
  const id = pictureIdOf(jpg(1));
  expect(pictureFileOf(id)).toBe(`${id}-${PICTURE_PX}.jpg`);
  expect(pictureFileOf(id)).not.toBe(`${id}.jpg`);
});
