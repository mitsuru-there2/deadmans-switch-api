import { defineConfig } from "vite";
import { voidPlugin } from "void";
export default defineConfig(({ command, mode }) => ({
  resolve: {
    alias: {
      "dms-runtime-app": new URL(
        command === "serve" && mode === "e2e"
          ? "./tests/e2e/runtime-app.ts"
          : "./src/runtime-app.ts",
        import.meta.url,
      ).pathname,
    },
  },
  cacheDir: process.env.DMS_TEST_CACHE_DIR,
  assetsInclude: ["**/*.cer"],
  plugins: [voidPlugin({ persistTo: process.env.DMS_TEST_STATE_DIR })],
  optimizeDeps: {
    include: [
      "better-auth",
      "better-auth/adapters/drizzle",
      "better-auth/plugins",
      "drizzle-orm",
      "drizzle-orm/d1",
      "drizzle-orm/sqlite-core",
      "hono",
      "hono/body-limit",
      "hono/cors",
      "hono/http-exception",
      "hono/secure-headers",
      "hono/validator",
      "zod",
      "react",
      "@react-email/components",
      "@react-email/render",
      "@apple/app-store-server-library",
      "jose",
    ],
  },
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
}));
