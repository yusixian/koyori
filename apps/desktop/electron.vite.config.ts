import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

const { version } = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../../package.json"), "utf8"),
);
export default defineConfig({
  main: {
    build: {
      externalizeDeps: { exclude: ["@koyori/core"] },
      rollupOptions: {
        input: {
          index: resolve(import.meta.dirname, "src/main/index.ts"),
          "scan-worker": resolve(import.meta.dirname, "src/main/scan-worker.ts"),
          "usage-worker": resolve(import.meta.dirname, "src/main/usage-worker.ts"),
        },
      },
    },
  },
  preload: { build: { rollupOptions: { output: { format: "cjs", entryFileNames: "index.cjs" } } } },
  renderer: {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
  },
});
