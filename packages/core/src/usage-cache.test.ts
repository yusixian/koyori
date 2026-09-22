import { describe, expect, it } from "vitest";

import {
  boundUsageImportCache,
  createUsageImportCache,
  isUsageImportCache,
  MAX_USAGE_CACHE_BYTES,
  sameUsageFileFingerprint,
  type UsageFileCacheEntry,
  usageFileCacheKey,
  usageFileFingerprint,
} from "./usage-cache.ts";

function entry(): UsageFileCacheEntry {
  const sourceId = "source";
  const file = "sessions/example.jsonl";
  return {
    sourceId,
    client: "claude-code",
    rootPath: "/history",
    file,
    fingerprint: usageFileFingerprint({ dev: 1, ino: 2, size: 3, mtimeMs: 4, ctimeMs: 5 }),
    parsed: {
      reservedRecords: 1,
      recordsRead: 1,
      malformedLines: 0,
      messageRecords: 1,
      clientVersions: ["2.1.278"],
      firstRecord: { at: "2026-09-20T10:00:00.000Z", ms: 1_758_362_400_000 },
      lastRecord: { at: "2026-09-20T10:00:00.000Z", ms: 1_758_362_400_000 },
      calls: [
        {
          skillName: "sample",
          toolUseId: "tool-1",
          fallbackUuid: null,
          blockIndex: 0,
          at: "2026-09-20T10:00:00.000Z",
          sessionId: "session",
          agentId: null,
          evidence: { sourceId, file, line: 1 },
        },
      ],
      requests: [],
      results: [],
      limitations: [],
    },
    issues: [],
  };
}

describe("usage import cache", () => {
  it("validates a bounded cache and rejects untrusted paths, fingerprints, and private extra data", () => {
    const item = entry();
    const key = usageFileCacheKey(item.sourceId, item.client, item.rootPath, item.file);
    const cache = boundUsageImportCache([[key, item]]);

    expect(isUsageImportCache(cache)).toBe(true);
    expect(isUsageImportCache(createUsageImportCache())).toBe(true);
    expect(
      isUsageImportCache({
        ...cache,
        files: { ...cache.files, [key]: { ...item, file: "../outside.jsonl" } },
      }),
    ).toBe(false);
    expect(
      isUsageImportCache({
        ...cache,
        files: {
          ...cache.files,
          [key]: { ...item, fingerprint: { ...item.fingerprint, size: 99 } },
        },
      }),
    ).toBe(false);
    expect(
      isUsageImportCache({
        ...cache,
        files: {
          ...cache.files,
          [key]: { ...item, parsed: { ...item.parsed, messageBody: "private" } },
        },
      }),
    ).toBe(false);
    expect(JSON.stringify(cache)).not.toContain("tool args");
  });

  it("changes the fingerprint for append, truncation, or inode replacement", () => {
    const initial = usageFileFingerprint({ dev: 1, ino: 2, size: 10, mtimeMs: 20, ctimeMs: 30 });
    expect(
      sameUsageFileFingerprint(
        initial,
        usageFileFingerprint({ dev: 1, ino: 2, size: 11, mtimeMs: 21, ctimeMs: 31 }),
      ),
    ).toBe(false);
    expect(
      sameUsageFileFingerprint(
        initial,
        usageFileFingerprint({ dev: 1, ino: 2, size: 5, mtimeMs: 22, ctimeMs: 32 }),
      ),
    ).toBe(false);
    expect(
      sameUsageFileFingerprint(
        initial,
        usageFileFingerprint({ dev: 1, ino: 3, size: 10, mtimeMs: 20, ctimeMs: 30 }),
      ),
    ).toBe(false);
  });

  it("drops entries that would exceed the serialized cache bound", () => {
    const item = entry();
    item.issues = [
      {
        sourceId: item.sourceId,
        file: item.file,
        code: "malformed",
        message: "x".repeat(MAX_USAGE_CACHE_BYTES),
      },
    ];
    const key = usageFileCacheKey(item.sourceId, item.client, item.rootPath, item.file);

    expect(boundUsageImportCache([[key, item]])).toEqual(createUsageImportCache());
  });
});
