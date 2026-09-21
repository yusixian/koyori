import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["packages/**/*.test.ts", "apps/desktop/**/*.test.ts", "apps/cli/**/*.test.ts"] },
});
