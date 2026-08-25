import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { sites } from "./build/sites-vite-plugin";

// Placeholders until the D1 database is provisioned. Local `npm run dev` uses
// Miniflare's own on-disk SQLite and ignores the id entirely; a real deploy
// must set both variables to the values Cloudflare hands back.
const PRODUCTION_DATABASE_NAME = "northlane-auto-demo-db";
const PRODUCTION_DATABASE_ID = "00000000-0000-0000-0000-000000000000";

// A staging deploy must not share production's D1 row: the demo state is a
// single global row, so one shared database means a preview mutates production.
// Set both variables together.
const DATABASE_NAME = process.env.D1_DATABASE_NAME ?? PRODUCTION_DATABASE_NAME;
const DATABASE_ID = process.env.D1_DATABASE_ID ?? PRODUCTION_DATABASE_ID;

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";

const localBindingConfig = {
  main: "./worker/index.ts",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [{ binding: d1, database_name: DATABASE_NAME, database_id: DATABASE_ID }]
    : [],
  r2_buckets: r2
    ? [{ binding: r2, bucket_name: "site-creator-r2" }]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: isCodexSeatbeltSandbox
      ? { watch: { useFsEvents: false, usePolling: true } }
      : undefined,
    plugins: [
      vinext(),
      sites(),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        config: localBindingConfig,
      }),
    ],
  };
});
