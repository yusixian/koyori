import { describe, expect, it } from "vitest";
import { normalizeServiceUrl, parseServiceSettings } from "./services-store";

describe("local service bookmarks", () => {
  it("accepts web URLs and limits plain HTTP to loopback hosts", () => {
    expect(normalizeServiceUrl("https://example.com/dashboard")).toBe(
      "https://example.com/dashboard",
    );
    expect(normalizeServiceUrl("http://127.0.0.2:3000/")).toBe("http://127.0.0.2:3000/");
    expect(() => normalizeServiceUrl("http://example.com/")).toThrow();
    expect(() => normalizeServiceUrl("file:///tmp/private")).toThrow();
    expect(() => normalizeServiceUrl("https://user:secret@example.com/")).toThrow();
    expect(() => normalizeServiceUrl("https://example.com/?token=secret")).toThrow();
  });

  it("refuses invalid persisted bookmarks rather than silently dropping them", () => {
    expect(() =>
      parseServiceSettings({
        version: 1,
        services: [
          {
            id: "one",
            name: "Personal",
            url: "javascript:alert(1)",
            createdAt: "2026-09-23T00:00:00.000Z",
            updatedAt: "2026-09-23T00:00:00.000Z",
          },
        ],
      }),
    ).toThrow("原文件已保留");
  });
});
