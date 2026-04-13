import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3000",
        changeOrigin: true,
      },
      "/health": "http://127.0.0.1:3000",
      "/ready": "http://127.0.0.1:3000",
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
