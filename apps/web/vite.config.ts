import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// `IRONLORE_PROXY_TARGET` lets the fresh-install Playwright e2e
// point Vite's dev proxy at an isolated Hono process on a non-3000
// port. Production / regular dev leaves it unset and gets the
// documented `127.0.0.1:3000` default.
const proxyTarget = process.env.IRONLORE_PROXY_TARGET ?? "http://127.0.0.1:3000";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/api": {
        target: proxyTarget,
        changeOrigin: true,
        ws: true,
      },
      "/health": proxyTarget,
      "/ready": proxyTarget,
    },
  },
  optimizeDeps: {
    include: ["pdfjs-dist"],
  },
  build: {
    outDir: "dist/client",
    sourcemap: true,
  },
});
