import { expect, test } from "bun:test";
import { openingCalls } from "./sign-in-browser";

test("the sign-in page is the bridge's browser before it loads (LinkedIn revoked a session signed in as another, 14 min after each link)", () => {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0";
  expect(
    openingCalls({ url: "https://example.com/login", user_agent: ua })
  ).toEqual([
    ["Network.setUserAgentOverride", { userAgent: ua }],
    ["Page.navigate", { url: "https://example.com/login" }],
  ]);
  expect(openingCalls({}).map(([m]) => m)).toEqual(["Page.navigate"]);
});
