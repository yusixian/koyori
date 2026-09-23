import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const LICENSE_NAME = /^(?:licen[cs]e|copying|notice)(?:$|[._-])/i;
const LICENSE_FALLBACKS = new Map([
  [
    "lazy-val@1.0.5",
    {
      fileName: "LICENSE",
      relativePath: "third-party/licenses/lazy-val@1.0.5.MIT.txt",
      license: "MIT",
    },
  ],
]);

async function readPackage(packageDirectory) {
  const value = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  if (!value.name || !value.version) throw new Error("Installed package metadata is incomplete.");
  return value;
}

async function resolveDependency(packageDirectory, dependencyName) {
  const packageJson = join(packageDirectory, "package.json");
  const require = createRequire(packageJson);
  let entry;
  try {
    entry = require.resolve(`${dependencyName}/package.json`);
  } catch {
    try {
      entry = require.resolve(dependencyName);
    } catch {
      throw new Error(`Required production dependency ${dependencyName} is not installed.`);
    }
  }

  let current = (await stat(entry)).isDirectory() ? entry : dirname(entry);
  while (dirname(current) !== current) {
    try {
      const metadata = await readPackage(current);
      if (metadata.name === dependencyName) return realpath(current);
    } catch {
      // Keep walking from the resolved entry to its owning package root.
    }
    current = dirname(current);
  }
  throw new Error(`Cannot locate package metadata for ${dependencyName}.`);
}

async function licenseFiles(packageDirectory) {
  const entries = await readdir(packageDirectory, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && LICENSE_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function safePackageDirectory(name, version) {
  return `${name
    .replace(/^@/, "")
    .replaceAll("/", "__")
    .replace(/[^a-zA-Z0-9._-]/g, "_")}@${version.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
}

async function requireNonemptyFile(path, label) {
  try {
    const details = await stat(path);
    if (details.isFile() && details.size > 0) return;
  } catch {
    // The stable error below avoids writing machine paths into build output.
  }
  throw new Error(`${label} is missing or empty.`);
}

export async function prepareLicenses(root) {
  const rootDirectory = await realpath(resolve(root));
  const desktopDirectory = join(rootDirectory, "apps/desktop");
  const desktopPackage = await readPackage(desktopDirectory);
  const rootLicense = join(rootDirectory, "LICENSE");
  await requireNonemptyFile(rootLicense, "Koyori license");

  const packages = new Map();
  const pending = Object.keys(desktopPackage.dependencies ?? {}).map((name) => ({
    from: desktopDirectory,
    name,
    optional: false,
  }));
  while (pending.length > 0) {
    const next = pending.shift();
    let packageDirectory;
    try {
      packageDirectory = await resolveDependency(next.from, next.name);
    } catch (error) {
      if (next.optional) continue;
      throw error;
    }
    const metadata = await readPackage(packageDirectory);
    const key = `${metadata.name}@${metadata.version}`;
    if (packages.has(key)) continue;
    packages.set(key, { directory: packageDirectory, metadata });
    for (const name of Object.keys(metadata.dependencies ?? {}))
      pending.push({ from: packageDirectory, name, optional: false });
    for (const name of Object.keys(metadata.optionalDependencies ?? {}))
      pending.push({ from: packageDirectory, name, optional: true });
  }

  const electronDirectory = await resolveDependency(desktopDirectory, "electron");
  const electronMetadata = await readPackage(electronDirectory);
  if (typeof electronMetadata.license !== "string" || electronMetadata.license.trim() === "")
    throw new Error("Electron has no license metadata.");
  const electronLicense = join(electronDirectory, "dist/LICENSE");
  const electronNotices = join(electronDirectory, "dist/LICENSES.chromium.html");
  await requireNonemptyFile(electronLicense, "Electron distribution license");
  await requireNonemptyFile(electronNotices, "Electron Chromium notices");

  const packagePlans = [];
  for (const { directory, metadata } of packages.values()) {
    const workspacePackage =
      metadata.name.startsWith("@koyori/") &&
      [join(rootDirectory, "packages"), join(rootDirectory, "apps")].includes(dirname(directory));
    const fallbackCandidate = LICENSE_FALLBACKS.get(`${metadata.name}@${metadata.version}`);
    const license = workspacePackage ? "MIT" : (metadata.license ?? fallbackCandidate?.license);
    if (typeof license !== "string" || license.trim() === "")
      throw new Error(`${metadata.name}@${metadata.version} has no license metadata.`);
    let files = workspacePackage ? [] : await licenseFiles(directory);
    let fallback;
    if (!workspacePackage && files.length === 0) {
      if (!fallbackCandidate)
        throw new Error(`${metadata.name}@${metadata.version} has no packaged license file.`);
      await requireNonemptyFile(
        join(rootDirectory, fallbackCandidate.relativePath),
        `${metadata.name}@${metadata.version} fallback license`,
      );
      fallback = fallbackCandidate;
      files = [fallbackCandidate.fileName];
    }
    packagePlans.push({
      directory,
      files,
      fallback,
      license,
      name: metadata.name,
      version: metadata.version,
      workspacePackage,
    });
  }
  packagePlans.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  const outputDirectory = join(desktopDirectory, "build/licenses");
  await rm(outputDirectory, { recursive: true, force: true });
  await mkdir(join(outputDirectory, "packages"), { recursive: true });
  await copyFile(rootLicense, join(outputDirectory, "KOYORI-LICENSE"));
  await copyFile(electronLicense, join(outputDirectory, "ELECTRON-LICENSE"));
  await copyFile(electronNotices, join(outputDirectory, "ELECTRON-THIRD-PARTY-LICENSES.html"));

  const manifestPackages = [];
  for (const plan of packagePlans) {
    const files = [];
    if (plan.workspacePackage) {
      files.push("KOYORI-LICENSE");
    } else {
      const destination = join("packages", safePackageDirectory(plan.name, plan.version));
      await mkdir(join(outputDirectory, destination), { recursive: true });
      for (const file of plan.files) {
        const source = plan.fallback
          ? join(rootDirectory, plan.fallback.relativePath)
          : join(plan.directory, file);
        await copyFile(source, join(outputDirectory, destination, file));
        files.push(join(destination, file).split(sep).join("/"));
      }
    }
    manifestPackages.push({ name: plan.name, version: plan.version, license: plan.license, files });
  }
  manifestPackages.push({
    name: electronMetadata.name,
    version: electronMetadata.version,
    license: electronMetadata.license,
    files: ["ELECTRON-LICENSE", "ELECTRON-THIRD-PARTY-LICENSES.html"],
  });
  manifestPackages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(`${right.name}@${right.version}`),
  );
  await writeFile(
    join(outputDirectory, "manifest.json"),
    `${JSON.stringify({ packages: manifestPackages }, null, 2)}\n`,
  );
  return { outputDirectory, packages: manifestPackages };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await prepareLicenses(resolve(import.meta.dirname, ".."));
    console.log(`Prepared licenses for ${result.packages.length} packages.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : "License preparation failed.");
    process.exitCode = 1;
  }
}
