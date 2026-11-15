import { expect, test } from "bun:test";
import { readBplist } from "./bplist";

// Made-up lists written by `plutil -convert binary1`.
test("a binary property list reads its numbers, strings, data, arrays and dictionaries", () => {
  const list = Buffer.from(
    "YnBsaXN0MDDXAQIDBAUGBwgJCgsMDxBRdFFkUXJRblRsaXN0UWZRcwlDAQIDIz/4AAAAAAAAEQEsog0OEAFReAhlAGgA6QBsAGwAbwgXGRsdHyQmKCktNjk8PkBBAAAAAAAAAQEAAAAAAAAAEQAAAAAAAAAAAAAAAAAAAEw=",
    "base64"
  );
  expect(readBplist(list)).toEqual({
    d: new Uint8Array([1, 2, 3]),
    f: false,
    list: [1, "x"],
    n: 300,
    r: 1.5,
    s: "héllo",
    t: true,
  });
});

test("anything but a binary property list throws", () => {
  expect(() => readBplist(Buffer.from("<plist/>"))).toThrow(
    "not a binary property list"
  );
});
