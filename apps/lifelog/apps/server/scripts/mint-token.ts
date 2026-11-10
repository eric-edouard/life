// Mints a token; only its hash goes into the server env. Rotate by minting again.
//   bun run mint-token              the phone's device token, DEVICE_TOKEN_HASH, and its pairing link
//                                   (PUBLIC_BASE_URL) to open on the iPhone or show as a QR code
//   bun run mint-token mac          the Mac helper's token (its secrets.json), MAC_TOKEN_HASH; it
//                                   opens only the socket (GET /quiet-ranges/socket)
//   bun run mint-token read         a reader's token, READ_TOKEN_HASH: the contract's reads
//   bun run mint-token corrections  a reader's token, CORRECTIONS_TOKEN_HASH: reads and corrections
//                                   (docs/voice-source.md)
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../src/config";

const KINDS = {
  corrections: ["the reader's settings", "CORRECTIONS_TOKEN_HASH"],
  device: ["the pairing link below", "DEVICE_TOKEN_HASH"],
  mac: ["the Mac helper's secrets.json", "MAC_TOKEN_HASH"],
  map: ["the voice map URL fragment", "MAP_TOKEN_HASH"],
  read: ["the reader's settings", "READ_TOKEN_HASH"],
} as const;

export function mintToken(kind: string) {
  if (!(kind in KINDS)) {
    throw new Error(`mint-token ${Object.keys(KINDS).join("|")}`);
  }
  const [where, variable] = KINDS[kind as keyof typeof KINDS];
  const token = randomBytes(32).toString("base64url");
  return { hash: sha256Hex(token), token, variable, where };
}

if (import.meta.main) {
  const kind = process.argv[2] ?? "device";
  const { hash, token, variable, where } = mintToken(kind);
  console.log(`token (put it in ${where}, store it nowhere else): ${token}`);
  console.log(`${variable}=${hash}`);
  const server = process.env.PUBLIC_BASE_URL;
  if (kind === "device" && server && !server.startsWith("https://")) {
    console.log(
      "no pairing link: the phone pairs only with an https:// PUBLIC_BASE_URL"
    );
  } else if (kind === "device" && server) {
    const link = new URL("lifelog://pair");
    link.search = new URLSearchParams({ token, url: server }).toString();
    console.log(
      `pairing link (open it on the iPhone, or as a QR code): ${link}`
    );
  }
}
