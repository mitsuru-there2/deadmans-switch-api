import { defineConfig } from "void/config";

export default defineConfig({
  target: "cloudflare",
  routing: { isr: false, notFound: "none" },
  inference: {
    appType: "void",
    bindings: { db: true, email: true },
    scanDirs: ["src", "routes", "crons", "queues"],
  },
  worker: { compatibility_date: "2026-10-12", compatibility_flags: ["nodejs_compat"] },
  cloudflare: {
    name: "deadmans-switch-api",
    workers_dev: false,
    preview_urls: false,
    observability: { enabled: false },
  },
});
