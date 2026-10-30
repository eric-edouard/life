import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The web app's build, served by apps/server/src/host/http/web.ts: hashed files under /app/ (the brand owns /assets/).
export default defineConfig({
  build: { assetsDir: "app", emptyOutDir: true, outDir: "dist" },
  plugins: [react(), tailwindcss()],
  // `vite` in apps/web against a running Life: its API on the public port.
  server: { proxy: { "/api": "http://127.0.0.1:46200" } },
});
