import assert from "node:assert/strict";
import test from "node:test";
import {
  assertAlphaVersion,
  assertSignedReleaseRequest,
  createCandidateManifest,
  createDesktopBuilderConfig,
  expectedPublicArtifactNames,
  isSignedRelease,
  MAC_MINIMUM_SYSTEM_VERSION,
  validateAlphaUpdateMetadata,
  validateAppUpdateMetadata,
} from "./package-desktop-config.mjs";

const signedEnvironment = {
  KOYORI_SIGNED_RELEASE: "1",
  CSC_LINK: "base64-certificate",
  CSC_KEY_PASSWORD: "password",
  APPLE_API_KEY: "/tmp/AuthKey_TEST.p8",
  APPLE_API_KEY_ID: "TESTKEY",
  APPLE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
};

test("unsigned packaging stays local and cannot discover a signing identity", () => {
  assert.equal(isSignedRelease({}), false);
  assert.equal(isSignedRelease({ KOYORI_SIGNED_RELEASE: "true" }), false);
  const config = createDesktopBuilderConfig({
    root: "/repo",
    outputDirectory: "/repo/artifacts",
    version: "0.1.0-alpha.1",
    signed: false,
  });
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.publish, null);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.equal(config.mac.minimumSystemVersion, MAC_MINIMUM_SYSTEM_VERSION);
  assert.equal(config.dmg.sign, false);
  assert.deepEqual(
    createCandidateManifest({
      version: "0.1.0-alpha.1",
      commit: "1".repeat(40),
      dirty: true,
      signed: false,
      artifacts: [],
    }),
    {
      version: "0.1.0-alpha.1",
      commit: "1".repeat(40),
      dirty: true,
      platform: "darwin",
      arch: "arm64",
      minimumSystemVersion: "13.0",
      distribution: "local-candidate",
      signing: "unsigned",
      notarized: false,
      artifacts: [],
    },
  );
});

test("signed packaging uses the explicit alpha GitHub feed without publishing", () => {
  assert.equal(isSignedRelease(signedEnvironment), true);
  assert.doesNotThrow(() =>
    assertSignedReleaseRequest({
      version: "0.1.0-alpha.10",
      dirty: false,
      environment: signedEnvironment,
    }),
  );
  const config = createDesktopBuilderConfig({
    root: "/repo",
    outputDirectory: "/repo/artifacts",
    version: "0.1.0-alpha.10",
    signed: true,
  });
  assert.equal(config.forceCodeSigning, true);
  assert.equal("identity" in config.mac, false);
  assert.equal(config.mac.hardenedRuntime, true);
  assert.equal(config.mac.notarize, true);
  assert.equal(config.dmg.sign, false);
  assert.deepEqual(config.publish, [
    {
      provider: "github",
      owner: "yusixian",
      repo: "koyori",
      channel: "alpha",
      releaseType: "prerelease",
    },
  ]);
  const candidate = createCandidateManifest({
    version: "0.1.0-alpha.10",
    commit: "a".repeat(40),
    dirty: false,
    signed: true,
    artifacts: [{ file: "example", sha256: "digest", sha512: "digest", bytes: 1 }],
  });
  assert.equal(candidate.distribution, "preview-candidate");
  assert.equal(candidate.signing, "notarized");
  assert.equal(candidate.notarized, true);
  assert.deepEqual(expectedPublicArtifactNames("0.1.0-alpha.10", true), [
    "Koyori-0.1.0-alpha.10-arm64.dmg",
    "Koyori-0.1.0-alpha.10-arm64.dmg.blockmap",
    "Koyori-0.1.0-alpha.10-arm64.zip",
    "Koyori-0.1.0-alpha.10-arm64.zip.blockmap",
    "alpha-mac.yml",
  ]);
});

test("signed packaging rejects dirty state, non-alpha versions, and incomplete credentials", () => {
  for (const invalid of [
    "0.1.0",
    "0.1.0-beta.1",
    "v0.1.0-alpha.1",
    "0.1-alpha.1",
    "01.1.0-alpha.1",
  ]) {
    assert.throws(() => assertAlphaVersion(invalid), /strict alpha SemVer/);
  }
  assert.throws(
    () =>
      assertSignedReleaseRequest({
        version: "0.1.0-alpha.1",
        dirty: true,
        environment: signedEnvironment,
      }),
    /clean Git worktree/,
  );
  assert.throws(
    () =>
      assertSignedReleaseRequest({
        version: "0.1.0-alpha.1",
        dirty: false,
        environment: { ...signedEnvironment, APPLE_API_ISSUER: " " },
      }),
    /APPLE_API_ISSUER/,
  );
});

test("signed update metadata must match the exact GitHub feed and packaged artifacts", () => {
  assert.doesNotThrow(() =>
    validateAppUpdateMetadata({
      provider: "github",
      owner: "yusixian",
      repo: "koyori",
      channel: "alpha",
      updaterCacheDirName: "koyori-updater",
    }),
  );
  assert.throws(
    () =>
      validateAppUpdateMetadata({
        provider: "github",
        owner: "someone-else",
        repo: "koyori",
        channel: "alpha",
      }),
    /owner must be yusixian/,
  );

  const artifacts = [
    { file: "Koyori-0.1.0-alpha.1-arm64.dmg", sha512: "dmg-hash", bytes: 12 },
    { file: "Koyori-0.1.0-alpha.1-arm64.zip", sha512: "zip-hash", bytes: 34 },
  ];
  const metadata = {
    version: "0.1.0-alpha.1",
    files: [
      { url: "Koyori-0.1.0-alpha.1-arm64.zip", sha512: "zip-hash", size: 34 },
      { url: "Koyori-0.1.0-alpha.1-arm64.dmg", sha512: "dmg-hash", size: 12 },
    ],
    path: "Koyori-0.1.0-alpha.1-arm64.zip",
    sha512: "zip-hash",
  };
  assert.doesNotThrow(() =>
    validateAlphaUpdateMetadata({ value: metadata, version: "0.1.0-alpha.1", artifacts }),
  );
  assert.throws(
    () =>
      validateAlphaUpdateMetadata({
        value: {
          ...metadata,
          files: metadata.files.map((entry) =>
            entry.url.endsWith(".dmg") ? { ...entry, size: 13 } : entry,
          ),
        },
        version: "0.1.0-alpha.1",
        artifacts,
      }),
    /integrity metadata does not match/,
  );
  assert.throws(
    () =>
      validateAlphaUpdateMetadata({
        value: { ...metadata, path: "Koyori-0.1.0-alpha.1-arm64.dmg" },
        version: "0.1.0-alpha.1",
        artifacts,
      }),
    /legacy ZIP metadata is inconsistent/,
  );
});
