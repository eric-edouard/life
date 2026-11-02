import { expect, test } from "bun:test";
import { chromeArgs } from "./sign-in-browser";

test("the sign-in Chrome claims the bridge's browser, hints off (LinkedIn revoked a session signed in as another, 14 min after each link)", () => {
  const ua = "Mozilla/5.0 (X11; Linux x86_64) Chrome/141.0.0.0";
  const args = chromeArgs(
    { url: "https://example.com/login", user_agent: ua },
    "/tmp/p"
  );
  expect(args).toContain(`--user-agent=${ua}`);
  expect(args).toContain("--disable-features=UserAgentClientHint");
  expect(args.at(-1)).toBe("https://example.com/login");
  expect(
    chromeArgs({}, "/tmp/p").some((a) => a.startsWith("--user-agent"))
  ).toBe(false);
});
