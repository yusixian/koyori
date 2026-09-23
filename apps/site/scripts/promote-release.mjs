import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { getReleaseChannel, parseReleaseManifest } from "@koyori/core";
import { createPreviewCatalog } from "../../../scripts/release-preview.mjs";

const execFileAsync = promisify(execFile);
const repository = "yusixian/koyori";
const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const commitPattern = /^[0-9a-f]{40}$/u;

async function gh(args) {
  const { stdout } = await execFileAsync("gh", args, { maxBuffer: 4 * 1024 * 1024 });
  return stdout.trim();
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
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
  const dmgName = `Koyori-${version}-arm64.dmg`;
  for (const name of ["candidate.json", "acceptance.json", dmgName]) {
    requireReleaseAsset(release, name);
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
    for (const name of ["candidate.json", "acceptance.json", dmgName]) {
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
    const candidatePath = join(temporaryDirectory, "candidate.json");
    const acceptancePath = join(temporaryDirectory, "acceptance.json");
    const candidateDigest = await sha256(candidatePath);
    const acceptance = JSON.parse(await readFile(acceptancePath, "utf8"));
    if (
      acceptance.schemaVersion !== 1 ||
      acceptance.version !== version ||
      acceptance.commit !== commit ||
      acceptance.candidateSha256 !== candidateDigest
    ) {
      throw new Error("Published acceptance.json does not match candidate.json and the tag.");
    }
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
    const dmgPath = join(temporaryDirectory, dmgName);
    const dmgInfo = await stat(dmgPath);
    if (
      !dmgInfo.isFile() ||
      dmgInfo.size !== catalog.download.bytes ||
      (await sha256(dmgPath)) !== catalog.download.sha256
    ) {
      throw new Error("The downloaded Release DMG does not match the catalog size and SHA-256.");
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
