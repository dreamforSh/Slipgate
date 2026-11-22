import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Override to point the dev server at a BFF / edge on non-default ports.
const bffTarget = process.env.SLIPGATE_BFF_URL ?? "http://127.0.0.1:19082";
const edgeTarget = process.env.SLIPGATE_EDGE_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [vue()],
  define: {
    // vue-i18n: Composition API only, JIT message compilation (no eval, CSP-safe).
    __VUE_I18N_FULL_INSTALL__: true,
    __VUE_I18N_LEGACY_API__: false,
    __INTLIFY_JIT_COMPILATION__: true,
    __INTLIFY_PROD_DEVTOOLS__: false,
  },
  server: {
    port: 5173,
    proxy: {
      "/api": bffTarget,
      "/webhooks": bffTarget,
      "/healthz": edgeTarget,
      "/readyz": edgeTarget,
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
