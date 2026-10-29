import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The Worker serves /v1/* and /demo/token; in `vite dev`, send them to a local `wrangler dev`.
  server: { proxy: { "/demo/token": "http://localhost:8787", "/v1": { target: "ws://localhost:8787", ws: true } } },
  build: {
    rollupOptions: {
      output: {
        // Libraries change less often than the site: separate chunks stay cached across deploys.
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router)[\\/]/.test(id)) return "react";
          if (/[\\/]node_modules[\\/](@junco|@radix-ui|@floating-ui|tailwind-merge|tailwind-variants|clsx)[\\/]/.test(id)) return "ui";
        },
      },
    },
  },
});
