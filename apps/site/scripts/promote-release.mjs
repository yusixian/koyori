import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getReleaseChannel, parseReleaseManifest } from "@koyori/core";
import { expectedPublicArtifactNames } from "../../../scripts/package-desktop-config.mjs";
import { createPreviewCatalog, verifyPublishInput } from "../../../scripts/release-preview.mjs";

const execFileAsync = promisify(execFile);
const repository = "yusixian/koyori";
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/u;

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

function requireReleaseAsset(release, name) {
  if (
    !Array.isArray(release.assets) ||
    release.assets.filter((asset) => asset.name === name).length !== 1
  ) {
    throw new Error(`Published Release must contain exactly one ${name} asset.`);
  }
}

export async function promotePreviewRelease({ tag, root = siteRoot, runGh = gh }) {
  if (typeof tag !== "string" || !/^v[0-9A-Za-z.+-]+$/u.test(tag)) {
    throw new Error("Provide a safe v-prefixed preview tag.");
  }
  const version = tag.slice(1);
  if (getReleaseChannel(version) !== "preview")
    throw new Error("The tag is not a preview version.");

  const release = JSON.parse(
    await runGh([
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "tagName,isDraft,isPrerelease,publishedAt,assets",
    ]),
  );
  if (release.tagName !== tag || release.isDraft !== false || release.isPrerelease !== true) {
    throw new Error("The matching Preview Release is not public.");
  }
  const commit = (
    await runGh(["api", `repos/${repository}/commits/${tag}`, "--jq", ".sha"])
  ).trim();
  if (!commitPattern.test(commit)) throw new Error("The Release tag did not resolve to a commit.");

  const notesPath = resolve(root, `../../docs/releases/v${version}.md`);
  const notes = await stat(notesPath).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!notes?.isFile()) {
    throw new Error(`The release notes are missing: ${notesPath}`);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "koyori-site-release-"));
  const targetPath = join(root, "public/releases/preview-mac-arm64.json");
  let stagedPath;
  try {
    await runGh([
      "release",
      "download",
      tag,
      "--repo",
      repository,
      "--pattern",
      "candidate.json",
      "--dir",
      temporaryDirectory,
    ]);
    const candidatePath = join(temporaryDirectory, "candidate.json");
    const candidate = JSON.parse(await readFile(candidatePath, "utf8"));
    const expectedFiles = [
      "candidate.json",
      "acceptance.json",
      ...expectedPublicArtifactNames(version, candidate.notarized === true),
    ];
    if (!Array.isArray(release.assets) || release.assets.length !== expectedFiles.length) {
      throw new Error("The published Release does not contain the exact accepted asset set.");
    }
    for (const name of expectedFiles) requireReleaseAsset(release, name);
    for (const name of expectedFiles.filter((file) => file !== "candidate.json")) {
      await runGh([
        "release",
        "download",
        tag,
        "--repo",
        repository,
        "--pattern",
        name,
        "--dir",
        temporaryDirectory,
      ]);
    }
    await verifyPublishInput({
      root: resolve(root, "../.."),
      directory: temporaryDirectory,
      commit,
      version,
      requireCurrentVersion: false,
    });
    const catalogPath = join(temporaryDirectory, "catalog.json");
    await createPreviewCatalog({
      candidatePath,
      publishedAt: release.publishedAt,
      outputPath: catalogPath,
    });
    const catalog = parseReleaseManifest(JSON.parse(await readFile(catalogPath, "utf8")));
    if (catalog.version !== version || catalog.commit !== commit) {
      throw new Error("The catalog does not match the published tag and commit.");
    }
    const current = await readFile(targetPath, "utf8").catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    const next = `${JSON.stringify(catalog, null, 2)}\n`;
    if (current !== null) {
      const previous = parseReleaseManifest(JSON.parse(current));
      if (previous.version === version && current !== next) {
        throw new Error("This version is already promoted with different catalog bytes.");
      }
      if (current === next) return { catalog, changed: false };
    }
    await mkdir(dirname(targetPath), { recursive: true });
    stagedPath = join(dirname(targetPath), `.preview-mac-arm64-${randomUUID()}.json`);
    await writeFile(stagedPath, next, { encoding: "utf8", flag: "wx" });
    await rename(stagedPath, targetPath);
    stagedPath = undefined;
    return { catalog, changed: true };
  } finally {
    if (stagedPath) await rm(stagedPath, { force: true });
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--tag") {
    throw new Error("Usage: pnpm --filter @koyori/site promote:release --tag v<VERSION>");
  }
  const result = await promotePreviewRelease({ tag: process.argv[3] });
  console.log(
    `${result.changed ? "Promoted" : "Already promoted"} ${result.catalog.version}: ${result.catalog.download.sha256}`,
  );
}
