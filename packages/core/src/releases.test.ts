import { describe, expect, it } from "vitest";

import { getReleaseChannel, parseReleaseManifest, type ReleaseManifest } from "./releases.ts";

const VERSION = "0.1.0-alpha.2";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const SHA256 = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function manifest(overrides: Partial<ReleaseManifest> = {}): ReleaseManifest {
  const base: ReleaseManifest = {
    schemaVersion: 1,
    version: VERSION,
    channel: "preview",
    commit: COMMIT,
    publishedAt: "2026-09-22T12:00:00.000Z",
    platform: "darwin",
    arch: "arm64",
    minimumSystemVersion: "13.0",
    signing: "unsigned",
    installation: "manual",
    releaseNotesUrl: `https://github.com/yusixian/koyori/releases/tag/v${VERSION}`,
    download: {
      url: `https://github.com/yusixian/koyori/releases/download/v${VERSION}/Koyori-${VERSION}-arm64.dmg`,
      sha256: SHA256,
      bytes: 1_024,
    },
  };
  return { ...base, ...overrides };
}

function inputManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...manifest(),
    ...overrides,
  };
}

describe("parseReleaseManifest", () => {
  it("accepts an exact preview manifest and preserves its contract fields", () => {
    const parsed = parseReleaseManifest(inputManifest());

    expect(parsed).toEqual(manifest());
  });

  it.each([
    ["v1.2.3", "stable"],
    ["1.2.3", "preview"],
  ] as const)("rejects channel/version mismatch for %s/%s", (version, channel) => {
    const value = inputManifest({
      version,
      channel,
      releaseNotesUrl: `https://github.com/yusixian/koyori/releases/tag/v${version}`,
      download: {
        ...manifest().download,
        url: `https://github.com/yusixian/koyori/releases/download/v${version}/Koyori-${version}-arm64.dmg`,
      },
    });

    expect(() => parseReleaseManifest(value)).toThrow(/strict SemVer|preview|leading v/);
  });

  it("rejects unknown input, extra fields, unsafe URLs, and malformed artifact metadata without echoing input", () => {
    const secret = "https://attacker.invalid/private?token=secret#fragment";
    const cases: unknown[] = [
      "secret manifest input",
      { ...inputManifest(), extra: "unsupported" },
      inputManifest({ releaseNotesUrl: secret }),
      inputManifest({
        download: { ...manifest().download, url: `${manifest().download.url}?token=secret` },
      }),
      inputManifest({ commit: "not-a-commit" }),
      inputManifest({ download: { ...manifest().download, sha256: "short" } }),
      inputManifest({ download: { ...manifest().download, bytes: 0 } }),
      inputManifest({ download: { ...manifest().download, bytes: 1024 * 1024 * 1024 + 1 } }),
      inputManifest({ minimumSystemVersion: "13.0-beta" }),
      inputManifest({ publishedAt: "not-an-iso-date" }),
    ];

    for (const value of cases) {
      try {
        parseReleaseManifest(value);
        throw new Error("expected parser to reject input");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(/^Invalid release manifest:/);
        expect((error as Error).message).not.toContain("secret");
        expect((error as Error).message).not.toContain("attacker.invalid");
      }
    }
  });

  it("accepts stable manifests only with stable SemVer and exact stable URLs", () => {
    const version = "0.1.0";
    const value = inputManifest({
      version,
      channel: "stable",
      releaseNotesUrl: `https://github.com/yusixian/koyori/releases/tag/v${version}`,
      download: {
        ...manifest().download,
        url: `https://github.com/yusixian/koyori/releases/download/v${version}/Koyori-${version}-arm64.dmg`,
      },
    });

    expect(parseReleaseManifest(value)).toMatchObject({ version, channel: "stable" });
  });

  it("allows automatic installation only with notarized signing", () => {
    const value = inputManifest({ installation: "automatic", signing: "notarized" });

    expect(parseReleaseManifest(value)).toMatchObject({
      installation: "automatic",
      signing: "notarized",
    });
  });

  it.each(["unsigned", "signed"] as const)(
    "rejects automatic installation with %s signing",
    (signing) => {
      expect(() =>
        parseReleaseManifest(inputManifest({ installation: "automatic", signing })),
      ).toThrow(/automatic installation requires notarized signing/);
    },
  );
});

describe("getReleaseChannel", () => {
  it("classifies installed versions by SemVer prerelease state", () => {
    expect(getReleaseChannel("0.1.0-alpha.10")).toBe("preview");
    expect(getReleaseChannel("0.1.0")).toBe("stable");
    expect(() => getReleaseChannel("v0.1.0")).toThrow("Invalid release manifest");
  });
});
