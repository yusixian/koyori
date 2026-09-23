export const MAC_MINIMUM_SYSTEM_VERSION = "13.0";

const SIGNING_ENVIRONMENT_KEYS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
];

export function isSignedRelease(environment) {
  return environment.KOYORI_SIGNED_RELEASE === "1";
}

export function assertAlphaVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-alpha\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error(
      `Signed preview builds require a strict alpha SemVer such as 0.1.0-alpha.1; received ${version}.`,
    );
  }
}

export function assertSignedReleaseRequest({ version, dirty, environment }) {
  assertAlphaVersion(version);
  if (dirty) {
    throw new Error("Signed preview builds require a clean Git worktree.");
  }

  const missing = SIGNING_ENVIRONMENT_KEYS.filter((key) => {
    const value = environment[key];
    return typeof value !== "string" || value.trim().length === 0;
  });
  if (missing.length > 0) {
    throw new Error(`Signed preview builds require: ${missing.join(", ")}.`);
  }
}

export function createDesktopBuilderConfig({ root, outputDirectory, version, signed }) {
  const publish = signed
    ? [
        {
          provider: "github",
          owner: "yusixian",
          repo: "koyori",
          channel: "alpha",
          releaseType: "prerelease",
        },
      ]
    : null;

  return {
    appId: "ren.cosine.koyori",
    productName: "Koyori",
    extraMetadata: { version },
    directories: { output: outputDirectory, buildResources: "build" },
    files: ["out/**/*", "package.json"],
    extraResources: [{ from: "build/licenses", to: "licenses" }],
    asar: true,
    forceCodeSigning: signed,
    publish,
    generateUpdatesFilesForAllChannels: false,
    // biome-ignore lint/suspicious/noTemplateCurlyInString: electron-builder expands these placeholders.
    artifactName: "Koyori-${version}-${arch}.${ext}",
    mac: {
      category: "public.app-category.productivity",
      icon: `${root}/brand/logo.png`,
      minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
      type: "distribution",
      hardenedRuntime: signed,
      notarize: signed,
      ...(signed ? {} : { identity: null }),
    },
    // The app inside the image is signed and stapled. electron-builder recommends leaving the
    // DMG container itself unsigned because signing it can conflict with its built-in notarization flow.
    dmg: { sign: false },
  };
}

export function createCandidateManifest({ version, commit, dirty, signed, artifacts }) {
  return {
    version,
    commit,
    dirty,
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: MAC_MINIMUM_SYSTEM_VERSION,
    distribution: signed ? "preview-candidate" : "local-candidate",
    signing: signed ? "notarized" : "unsigned",
    notarized: signed,
    artifacts,
  };
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

export function validateAppUpdateMetadata(value) {
  const metadata = requireRecord(value, "app-update.yml");
  const expected = {
    provider: "github",
    owner: "yusixian",
    repo: "koyori",
    channel: "alpha",
  };
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (metadata[key] !== expectedValue) {
      throw new Error(`app-update.yml ${key} must be ${expectedValue}.`);
    }
  }
}

export function validateAlphaUpdateMetadata({ value, version, artifacts }) {
  const metadata = requireRecord(value, "alpha-mac.yml");
  if (metadata.version !== version) {
    throw new Error(`alpha-mac.yml version must be ${version}.`);
  }
  if (!Array.isArray(metadata.files) || metadata.files.length !== 2) {
    throw new Error("alpha-mac.yml must describe exactly the DMG and ZIP artifacts.");
  }

  const expectedFiles = [`Koyori-${version}-arm64.dmg`, `Koyori-${version}-arm64.zip`];
  const artifactsByName = new Map(artifacts.map((artifact) => [artifact.file, artifact]));
  const metadataByName = new Map();
  for (const entryValue of metadata.files) {
    const entry = requireRecord(entryValue, "alpha-mac.yml file entry");
    if (typeof entry.url !== "string" || metadataByName.has(entry.url)) {
      throw new Error("alpha-mac.yml contains an invalid or duplicate artifact URL.");
    }
    metadataByName.set(entry.url, entry);
  }

  for (const fileName of expectedFiles) {
    const artifact = artifactsByName.get(fileName);
    const entry = metadataByName.get(fileName);
    if (!artifact || !entry) {
      throw new Error(`alpha-mac.yml is missing ${fileName}.`);
    }
    if (entry.sha512 !== artifact.sha512 || entry.size !== artifact.bytes) {
      throw new Error(`alpha-mac.yml integrity metadata does not match ${fileName}.`);
    }
  }

  const zipName = `Koyori-${version}-arm64.zip`;
  const zip = artifactsByName.get(zipName);
  if (metadata.path !== zipName || metadata.sha512 !== zip?.sha512) {
    throw new Error("alpha-mac.yml legacy ZIP metadata is inconsistent.");
  }
}

export function expectedPublicArtifactNames(version, signed) {
  const base = `Koyori-${version}-arm64`;
  const names = [`${base}.dmg`, `${base}.dmg.blockmap`, `${base}.zip`, `${base}.zip.blockmap`];
  if (signed) names.push("alpha-mac.yml");
  return names;
}
