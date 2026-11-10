import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// The proxy serves ui/dist at "/", so the build must use relative asset paths
// and a stable output folder. Dev mode talks to the running proxy on 8787.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  base: "./",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: "assets",
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8787",
      "/health": "http://127.0.0.1:8787",
      "/v1": "http://127.0.0.1:8787",
      "/auth-callback": "http://127.0.0.1:8787",
    },
  },
});
