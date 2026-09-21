import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { prepareLicenses } from "./prepare-licenses.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This milestone packages on Apple Silicon macOS only.");
const require = createRequire(resolve(root, "apps/desktop/package.json"));
const { build, Platform, Arch } = require("electron-builder");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const dirty =
  execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim().length > 0;
const out = resolve(root, "artifacts");
await mkdir(out, { recursive: true });
await mkdir(resolve(root, "apps/desktop/build"), { recursive: true });
await prepareLicenses(root);
await copyFile(
  resolve(root, "THIRD_PARTY_NOTICES.md"),
  resolve(root, "apps/desktop/build/licenses/THIRD_PARTY_NOTICES.md"),
);
const files = await build({
  projectDir: resolve(root, "apps/desktop"),
  targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
  publish: "never",
  config: {
    appId: "ren.cosine.koyori",
    productName: "Koyori",
    extraMetadata: { version },
    directories: { output: out, buildResources: "build" },
    files: ["out/**/*", "package.json"],
    extraResources: [{ from: "build/licenses", to: "licenses" }],
    asar: true,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
    artifactName: "Koyori-${version}-${arch}.${ext}",
    mac: {
      category: "public.app-category.productivity",
      icon: resolve(root, "brand/logo.png"),
      identity: null,
      notarize: false,
    },
  },
});
const artifacts = [];
for (const file of files) {
  if (!/\.(dmg|zip)$/.test(file)) continue;
  const data = await readFile(file);
  artifacts.push({
    file: file.split("/").at(-1),
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: data.byteLength,
  });
}
await writeFile(
  resolve(out, "candidate.json"),
  JSON.stringify(
    {
      version,
      commit: sha,
      dirty,
      platform: "darwin",
      arch: "arm64",
      distribution: "local-candidate",
      signing: "unsigned",
      artifacts,
    },
    null,
    2,
  ),
);
console.log("Local unsigned candidate built. No Release was published.");
