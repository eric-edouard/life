// Your server's API for the scripts: LIFELOG_SERVER_URL (required), with the device token in the file
// VOICE_TOKEN_FILE names (the root checkout's .env.device-token without it).
import { checkouts } from "./dsyms";

async function deviceToken() {
  const file =
    process.env.VOICE_TOKEN_FILE ??
    `${(await checkouts())[0]}/.env.device-token`;
  return (await Bun.file(file).text()).trim();
}

export async function serverFetch(path: string, init: RequestInit = {}) {
  const server = process.env.LIFELOG_SERVER_URL;
  if (!server) {
    throw new Error("set LIFELOG_SERVER_URL to your server's address");
  }
  const res = await fetch(`${server}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${await deviceToken()}`,
      "content-type": "application/json",
    },
  });
  if (!res.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} answered ${res.status}`);
  }
  return res;
}
