// Sets the owner's sign-in for AI access: `OWNER_PASSWORD=... bun run owner you@example.com`.
// Run against the production DATABASE_PATH with the same AUTH_SECRET and LIFE_URL as the server.
import { authFor, setOwner } from "@lifelog/auth";
import { connect } from "@lifelog/db";
import { authSettings, loadConfig } from "../src/config";

const config = loadConfig(process.env);
const [email] = process.argv.slice(2);
const password = process.env.OWNER_PASSWORD;
const auth = authFor(authSettings(config), connect(config.DATABASE_PATH));
if (!(email && password && auth)) {
  throw new Error(
    "usage: AUTH_SECRET=... LIFE_URL=... OWNER_PASSWORD=... bun run owner <email>"
  );
}
await setOwner(auth, email, password);
console.log(`owner ${email} can sign in`);
process.exit(0);
