import { expect, test } from "bun:test";
import { pageTextOf } from "./pi-parity";

test("a fetched page reads as its text: no scripts, styles or tags, entities read, blank runs folded", () => {
  expect(
    pageTextOf(
      "<html><head><style>p{}</style><script>x()</script></head><body>\n  <p>Fish &amp; chips</p>\n\n<p>&lt;3&nbsp;now</p></body></html>"
    )
  ).toBe("Fish & chips\n<3 now");
});
