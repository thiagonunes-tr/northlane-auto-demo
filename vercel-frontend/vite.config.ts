import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The dev server proxies /api to whichever Worker is running. Point it at the
// local `npm run dev` origin by default so a checkout needs no cloud account.
const API_ORIGIN = process.env.NORTHLANE_API_ORIGIN ?? "http://127.0.0.1:3000";

export default defineConfig({
  publicDir: "../public",
  plugins: [react()],
  resolve: {
    dedupe: ["react", "react-dom"],
  },
  server: {
    proxy: {
      "/api/": {
        target: API_ORIGIN,
        changeOrigin: true,
        secure: true,
      },
    },
  },
});
