import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The Worker serves /v1/* and /demo/token; in `vite dev`, send them to a local `wrangler dev`.
  server: { proxy: { "/demo/token": "http://localhost:8787", "/v1": { target: "ws://localhost:8787", ws: true } } },
});
