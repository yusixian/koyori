import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { verifyArchiveInputs } from "./release-preview.mjs";

const { values } = parseArgs({
  options: {
    candidate: { type: "string" },
    commit: { type: "string" },
    output: { type: "string" },
  },
});
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Public archive acceptance requires Apple Silicon macOS.");
}
if (!values.candidate || !values.commit || !values.output) {
  throw new Error("Expected --candidate, --commit and --output.");
}
const candidatePath = resolve(values.candidate);
const testedArchives = await verifyArchiveInputs({ candidatePath, commit: values.commit });
const temporary = await mkdtemp(join(tmpdir(), "koyori-archive-acceptance-"));

try {
  for (const archive of testedArchives) {
    const archivePath = join(dirname(candidatePath), archive.file);
    const destination = join(temporary, archive.file.endsWith(".zip") ? "zip" : "dmg");
    let mounted = false;
    try {
      if (archive.file.endsWith(".zip")) {
        execFileSync("/usr/bin/ditto", ["-x", "-k", archivePath, destination], {
          stdio: "inherit",
        });
      } else {
        await mkdir(destination);
        execFileSync(
          "/usr/bin/hdiutil",
          ["attach", "-readonly", "-nobrowse", "-mountpoint", destination, archivePath],
          { stdio: "inherit" },
        );
        mounted = true;
      }
      const application = join(destination, archive.application);
      const executable = join(application, "Contents/MacOS/Koyori");
      if (!(await lstat(application)).isDirectory() || !(await lstat(executable)).isFile()) {
        throw new Error(`${archive.file} does not contain the expected application.`);
      }
      const installedApplication = join(
        temporary,
        archive.file.endsWith(".zip") ? "installed-zip" : "installed-dmg",
        archive.application,
      );
      await mkdir(dirname(installedApplication), { recursive: true });
      execFileSync("/usr/bin/ditto", [application, installedApplication], { stdio: "inherit" });
      if (mounted) {
        execFileSync("/usr/bin/hdiutil", ["detach", destination], { stdio: "inherit" });
        mounted = false;
      }
      const installedExecutable = join(installedApplication, "Contents/MacOS/Koyori");
      if (!(await lstat(installedExecutable)).isFile()) {
        throw new Error(`${archive.file} did not install the expected application.`);
      }
      execFileSync("pnpm", ["test:desktop"], {
        stdio: "inherit",
        env: { ...process.env, KOYORI_EXECUTABLE: installedExecutable },
      });
    } finally {
      if (mounted) {
        execFileSync("/usr/bin/hdiutil", ["detach", destination], { stdio: "inherit" });
      }
    }
  }
  // Recheck the archive bytes after the tests before recording the accepted files.
  await verifyArchiveInputs({ candidatePath, commit: values.commit });
  await writeFile(resolve(values.output), `${JSON.stringify({ testedArchives }, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
