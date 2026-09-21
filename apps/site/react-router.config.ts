import type { Config } from "@react-router/dev/config";
import { readdir } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

async function collectDocs(directory: string, root = directory): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await collectDocs(absolutePath, root)));
      continue;
    }
    if (extname(entry.name) !== ".mdx") continue;

    const segments = relative(root, absolutePath)
      .slice(0, -extname(entry.name).length)
      .split(sep);
    const slug = segments.at(-1) === "index" ? segments.slice(0, -1) : segments;
    paths.push(slug.length === 0 ? "/docs" : `/docs/${slug.join("/")}`);
  }

  return paths;
}

export default {
  ssr: false,
  async prerender({ getStaticPaths }) {
    const paths = new Set([
      ...getStaticPaths(),
      "/",
      "/download",
      "/changelog",
      "/search",
      ...(await collectDocs("content/docs")),
    ]);
    return [...paths];
  },
} satisfies Config;
