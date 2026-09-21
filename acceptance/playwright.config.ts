import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".",
  testMatch: "desktop.spec.ts",
  workers: 1,
  timeout: 60_000,
  reporter: "list",
  use: { trace: "retain-on-failure" },
});
