import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  assertManualPreviewRequest,
  assertSignedReleaseRequest,
  createCandidateManifest,
  createDesktopBuilderConfig,
  expectedPublicArtifactNames,
  isManualPreview,
  isSignedRelease,
  MAC_MINIMUM_SYSTEM_VERSION,
  validateAlphaUpdateMetadata,
  validateAppUpdateMetadata,
} from "./package-desktop-config.mjs";
import { prepareLicenses } from "./prepare-licenses.mjs";

const root = resolve(import.meta.dirname, "..");
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This milestone packages on Apple Silicon macOS only.");
const require = createRequire(resolve(root, "apps/desktop/package.json"));
const { build, Platform, Arch } = require("electron-builder");
const { version } = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
const sha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const status = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const dirty = status.length > 0;
const signed = isSignedRelease(process.env);
const manualPreview = isManualPreview(process.env);
if (signed) {
  assertSignedReleaseRequest({ version, dirty, environment: process.env });
  const apiKey = await stat(process.env.APPLE_API_KEY).catch(() => null);
  if (!apiKey?.isFile()) {
    throw new Error("APPLE_API_KEY must name a readable private-key file.");
  }
}
if (manualPreview) assertManualPreviewRequest({ version, dirty, environment: process.env });
const out = resolve(root, "artifacts");
const appUpdatePath = resolve(out, "mac-arm64/Koyori.app/Contents/Resources/app-update.yml");
await mkdir(out, { recursive: true });
await mkdir(resolve(root, "apps/desktop/build"), { recursive: true });
const artifactNames = expectedPublicArtifactNames(version, signed);
for (const file of new Set([
  ...artifactNames,
  "alpha-mac.yml",
  "candidate.json",
  "candidate.json.tmp",
])) {
  await unlink(resolve(out, file)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
await unlink(appUpdatePath).catch((error) => {
  if (error?.code !== "ENOENT") throw error;
});
await prepareLicenses(root);
await copyFile(
  resolve(root, "THIRD_PARTY_NOTICES.md"),
  resolve(root, "apps/desktop/build/licenses/THIRD_PARTY_NOTICES.md"),
);
await build({
  projectDir: resolve(root, "apps/desktop"),
  targets: Platform.MAC.createTarget(["dmg", "zip"], Arch.arm64),
  publish: "never",
  config: createDesktopBuilderConfig({ root, outputDirectory: out, version, signed }),
});

const appPath = resolve(out, "mac-arm64/Koyori.app");
const dmgPath = resolve(out, `Koyori-${version}-arm64.dmg`);
const plist = resolve(appPath, "Contents/Info.plist");
const executable = resolve(appPath, "Contents/MacOS/Koyori");
const plistValue = (key) =>
  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plist], {
    encoding: "utf8",
  }).trim();
const assertEqual = (actual, expected, description) => {
  if (actual !== expected)
    throw new Error(`${description} must be ${expected}; received ${actual}.`);
};

assertEqual(plistValue("CFBundleIdentifier"), "ren.cosine.koyori", "Bundle identifier");
assertEqual(plistValue("CFBundleShortVersionString"), version, "Bundle version");
assertEqual(plistValue("CFBundleVersion"), version, "Bundle build version");
assertEqual(
  plistValue("LSMinimumSystemVersion"),
  MAC_MINIMUM_SYSTEM_VERSION,
  "Minimum macOS version",
);
assertEqual(
  execFileSync("/usr/bin/lipo", ["-archs", executable], { encoding: "utf8" }).trim(),
  "arm64",
  "Executable architecture",
);
execFileSync("/usr/bin/hdiutil", ["verify", dmgPath], { stdio: "inherit" });

const artifacts = [];
for (const fileName of artifactNames) {
  const file = resolve(out, fileName);
  const data = await readFile(file);
  artifacts.push({
    file: fileName,
    sha256: createHash("sha256").update(data).digest("hex"),
    sha512: createHash("sha512").update(data).digest("base64"),
    bytes: data.byteLength,
  });
}

if (signed) {
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath], {
    stdio: "inherit",
  });
  execFileSync("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", appPath], {
    stdio: "inherit",
  });
  execFileSync("/usr/bin/xcrun", ["stapler", "validate", appPath], { stdio: "inherit" });
  const signatureInspection = spawnSync(
    "/usr/bin/codesign",
    ["--display", "--verbose=4", appPath],
    { encoding: "utf8" },
  );
  const signatureDetails = `${signatureInspection.stdout ?? ""}\n${signatureInspection.stderr ?? ""}`;
  if (
    signatureInspection.status !== 0 ||
    !/^Authority=Developer ID Application:/m.test(signatureDetails) ||
    !/^TeamIdentifier=(?!not set$)\S+$/m.test(signatureDetails) ||
    !/flags=.*\(runtime\)/m.test(signatureDetails)
  ) {
    throw new Error("The app is not signed with a hardened Developer ID Application identity.");
  }

  validateAppUpdateMetadata(parseYaml(await readFile(appUpdatePath, "utf8")));
  validateAlphaUpdateMetadata({
    value: parseYaml(await readFile(resolve(out, "alpha-mac.yml"), "utf8")),
    version,
    artifacts,
  });
} else {
  const unexpectedUpdateConfig = await stat(appUpdatePath).catch(() => null);
  if (unexpectedUpdateConfig) {
    throw new Error("Unsigned candidates must not contain app-update.yml.");
  }
}
const candidatePath = resolve(out, "candidate.json");
const candidateTemporaryPath = `${candidatePath}.tmp`;
await writeFile(
  candidateTemporaryPath,
  JSON.stringify(
    createCandidateManifest({
      version,
      commit: sha,
      dirty,
      signed,
      manualPreview,
      artifacts,
    }),
    null,
    2,
  ),
);
await rename(candidateTemporaryPath, candidatePath);
console.log(
  signed
    ? "Signed and notarized preview candidate built and verified. No Release was published."
    : manualPreview
      ? "Unsigned manual preview candidate built and verified. No Release was published."
      : "Local unsigned candidate built. No Release was published.",
);
