import { reactRouter } from "@react-router/dev/vite";
import tailwindcss from "@tailwindcss/vite";
import { fumadocsMdx } from "fumadocs-mdx/vite";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [fumadocsMdx(), tailwindcss(), reactRouter()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./app", import.meta.url)),
    },
    noExternal: ["fumadocs-core", "fumadocs-ui"],
  },
});
