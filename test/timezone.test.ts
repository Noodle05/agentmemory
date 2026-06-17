import { describe, it, expect } from "vitest";
import {
  isValidTimezone,
  formatTimestamp,
  deepConvertTimestamps,
  resolveTimezone,
} from "../src/utils/timezone.js";

// =============================================================================
// isValidTimezone
// =============================================================================

describe("isValidTimezone", () => {
  describe("valid IANA timezones", () => {
    it("accepts Asia/Shanghai", () => {
      expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    });

    it("accepts America/New_York", () => {
      expect(isValidTimezone("America/New_York")).toBe(true);
    });

    it("accepts Europe/London", () => {
      expect(isValidTimezone("Europe/London")).toBe(true);
    });

    it("accepts UTC", () => {
      expect(isValidTimezone("UTC")).toBe(true);
    });

    it("accepts Etc/GMT+5 (POSIX style)", () => {
      expect(isValidTimezone("Etc/GMT+5")).toBe(true);
    });

    it("accepts Australia/Sydney", () => {
      expect(isValidTimezone("Australia/Sydney")).toBe(true);
    });

    it("accepts Pacific/Honolulu", () => {
      expect(isValidTimezone("Pacific/Honolulu")).toBe(true);
    });
  });

  describe("invalid timezones", () => {
    it("rejects Foo/Bar", () => {
      expect(isValidTimezone("Foo/Bar")).toBe(false);
    });

    it("rejects Not/A_Real_Zone", () => {
      expect(isValidTimezone("Not/A_Real_Zone")).toBe(false);
    });

    it("rejects empty string", () => {
      expect(isValidTimezone("")).toBe(false);
    });

    it("rejects whitespace-only string", () => {
      expect(isValidTimezone("   ")).toBe(false);
    });

    it("rejects random garbage", () => {
      expect(isValidTimezone("garbage")).toBe(false);
    });
  });
});

// =============================================================================
// formatTimestamp
// =============================================================================

describe("formatTimestamp", () => {
  describe("basic conversion", () => {
    it("converts UTC to Asia/Shanghai (UTC+8)", () => {
      const result = formatTimestamp("2026-06-17T16:45:07.527Z", "Asia/Shanghai");
      expect(result).toBe("2026-06-18T00:45:07");
    });

    it("converts UTC to America/New_York (UTC-5 in winter)", () => {
      const result = formatTimestamp(
        "2026-01-15T12:00:00.000Z",
        "America/New_York",
      );
      expect(result).toBe("2026-01-15T07:00:00");
    });

    it("converts UTC to Europe/London (UTC+1 in winter)", () => {
      const result = formatTimestamp(
        "2026-01-15T12:00:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-01-15T12:00:00");
    });
  });

  describe("DST handling", () => {
    it("uses EST (UTC-5) for January in America/New_York", () => {
      const result = formatTimestamp(
        "2026-01-15T12:00:00.000Z",
        "America/New_York",
      );
      expect(result).toBe("2026-01-15T07:00:00");
    });

    it("uses EDT (UTC-4) for July in America/New_York", () => {
      const result = formatTimestamp(
        "2026-07-15T12:00:00.000Z",
        "America/New_York",
      );
      expect(result).toBe("2026-07-15T08:00:00");
    });

    it("uses GMT (UTC+0) for January in Europe/London", () => {
      const result = formatTimestamp(
        "2026-01-15T12:00:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-01-15T12:00:00");
    });

    it("uses BST (UTC+1) for July in Europe/London", () => {
      const result = formatTimestamp(
        "2026-07-15T12:00:00.000Z",
        "Europe/London",
      );
      expect(result).toBe("2026-07-15T13:00:00");
    });
  });

  describe("error handling", () => {
    it("returns original string for invalid timezone", () => {
      const result = formatTimestamp(
        "2026-06-17T16:45:07.527Z",
        "Foo/Bar",
      );
      expect(result).toBe("2026-06-17T16:45:07.527Z");
    });

    it("returns original string for unparseable date", () => {
      const result = formatTimestamp("not-a-date", "Asia/Shanghai");
      expect(result).toBe("not-a-date");
    });

    it("returns original string for empty timezone", () => {
      const result = formatTimestamp(
        "2026-06-17T16:45:07.527Z",
        "",
      );
      expect(result).toBe("2026-06-17T16:45:07.527Z");
    });
  });

  describe("epoch boundary", () => {
    it("converts epoch zero correctly", () => {
      const result = formatTimestamp(
        "1970-01-01T00:00:00.000Z",
        "Asia/Shanghai",
      );
      expect(result).toBe("1970-01-01T08:00:00");
    });

    it("converts epoch zero to America/New_York (EST, day before)", () => {
      const result = formatTimestamp(
        "1970-01-01T00:00:00.000Z",
        "America/New_York",
      );
      expect(result).toBe("1969-12-31T19:00:00");
    });
  });
});

// =============================================================================
// deepConvertTimestamps
// =============================================================================

describe("deepConvertTimestamps", () => {
  const tz = "Asia/Shanghai";

  describe("flat objects", () => {
    it("converts exact-match timestamp fields", () => {
      const input = {
        timestamp: "2026-06-17T16:45:07.527Z",
        name: "test",
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.timestamp).toBe("2026-06-18T00:45:07");
      expect(result.name).toBe("test");
    });

    it("converts fields ending in At", () => {
      const input = {
        createdAt: "2026-06-17T16:45:07.527Z",
        updatedAt: "2026-06-17T16:45:07.527Z",
        startedAt: "2026-06-17T16:45:07.527Z",
        endedAt: "2026-06-17T16:45:07.527Z",
        name: "test",
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.createdAt).toBe("2026-06-18T00:45:07");
      expect(result.updatedAt).toBe("2026-06-18T00:45:07");
      expect(result.startedAt).toBe("2026-06-18T00:45:07");
      expect(result.endedAt).toBe("2026-06-18T00:45:07");
      expect(result.name).toBe("test");
    });

    it("converts all exact-match timestamp field names", () => {
      const input = {
        forgetAfter: "2026-06-17T16:45:07.527Z",
        validFrom: "2026-06-17T16:45:07.527Z",
        validTo: "2026-06-17T16:45:07.527Z",
        windowStart: "2026-06-17T16:45:07.527Z",
        windowEnd: "2026-06-17T16:45:07.527Z",
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.forgetAfter).toBe("2026-06-18T00:45:07");
      expect(result.validFrom).toBe("2026-06-18T00:45:07");
      expect(result.validTo).toBe("2026-06-18T00:45:07");
      expect(result.windowStart).toBe("2026-06-18T00:45:07");
      expect(result.windowEnd).toBe("2026-06-18T00:45:07");
    });

    it("does NOT convert non-timestamp string fields", () => {
      const input = {
        description: "A timestamp-like string 2026-06-17T16:45:07.527Z",
        title: "2026-06-17T16:45:07.527Z",
        name: "test",
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.description).toBe(
        "A timestamp-like string 2026-06-17T16:45:07.527Z",
      );
      expect(result.title).toBe("2026-06-17T16:45:07.527Z");
      expect(result.name).toBe("test");
    });
  });

  describe("nested objects", () => {
    it("converts timestamps in nested objects", () => {
      const input = {
        session: {
          startedAt: "2026-06-17T16:45:07.527Z",
          endedAt: "2026-06-17T17:45:07.527Z",
        },
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      const session = result.session as Record<string, unknown>;
      expect(session.startedAt).toBe("2026-06-18T00:45:07");
      expect(session.endedAt).toBe("2026-06-18T01:45:07");
    });

    it("converts timestamps in deeply nested objects", () => {
      const input = {
        level1: {
          level2: {
            level3: {
              createdAt: "2026-06-17T16:45:07.527Z",
            },
          },
        },
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      const l1 = result.level1 as Record<string, unknown>;
      const l2 = l1.level2 as Record<string, unknown>;
      const l3 = l2.level3 as Record<string, unknown>;
      expect(l3.createdAt).toBe("2026-06-18T00:45:07");
    });
  });

  describe("arrays", () => {
    it("converts timestamps in array of objects", () => {
      const input = [
        { timestamp: "2026-06-17T16:45:07.527Z", name: "first" },
        { timestamp: "2026-06-17T17:45:07.527Z", name: "second" },
      ];
      const result = deepConvertTimestamps(input, tz) as Array<
        Record<string, unknown>
      >;
      expect(result[0].timestamp).toBe("2026-06-18T00:45:07");
      expect(result[0].name).toBe("first");
      expect(result[1].timestamp).toBe("2026-06-18T01:45:07");
      expect(result[1].name).toBe("second");
    });

    it("handles nested arrays", () => {
      const input = {
        items: [
          { nested: [{ createdAt: "2026-06-17T16:45:07.527Z" }] },
        ],
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      const items = result.items as Array<Record<string, unknown>>;
      const nested = items[0].nested as Array<Record<string, unknown>>;
      expect(nested[0].createdAt).toBe("2026-06-18T00:45:07");
    });
  });

  describe("null and undefined handling", () => {
    it("returns null as-is", () => {
      expect(deepConvertTimestamps(null, tz)).toBeNull();
    });

    it("returns undefined as-is", () => {
      expect(deepConvertTimestamps(undefined, tz)).toBeUndefined();
    });

    it("preserves null field values", () => {
      const input = { createdAt: null, name: "test" };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.createdAt).toBeNull();
      expect(result.name).toBe("test");
    });

    it("preserves undefined field values", () => {
      const input: Record<string, unknown> = {
        createdAt: undefined,
        name: "test",
      };
      const result = deepConvertTimestamps(input, tz) as Record<string, unknown>;
      expect(result.createdAt).toBeUndefined();
      expect(result.name).toBe("test");
    });
  });

  describe("depth limit", () => {
    it("stops converting beyond depth 20", () => {
      // Build a deeply nested object with a timestamp field at depth 22
      let deep: Record<string, unknown> = {
        createdAt: "2026-06-17T16:45:07.527Z",
      };
      for (let i = 0; i < 22; i++) {
        deep = { nested: deep };
      }
      const result = deepConvertTimestamps(deep, tz) as Record<string, unknown>;
      // The timestamp at depth 22 should NOT be converted (original UTC)
      let current = result;
      for (let i = 0; i < 22; i++) {
        current = current.nested as Record<string, unknown>;
      }
      expect(current.createdAt).toBe("2026-06-17T16:45:07.527Z");
    });

    it("handles circular references without infinite recursion", () => {
      const obj: Record<string, unknown> = {
        name: "test",
        createdAt: "2026-06-17T16:45:07.527Z",
      };
      obj.self = obj;
      // Should not throw or hang — depth limit kicks in
      const result = deepConvertTimestamps(obj, tz) as Record<string, unknown>;
      expect(result.name).toBe("test");
      expect(result.createdAt).toBe("2026-06-18T00:45:07");
    });
  });

  describe("primitive passthrough", () => {
    it("returns strings as-is", () => {
      expect(deepConvertTimestamps("hello", tz)).toBe("hello");
    });

    it("returns numbers as-is", () => {
      expect(deepConvertTimestamps(42, tz)).toBe(42);
    });

    it("returns booleans as-is", () => {
      expect(deepConvertTimestamps(true, tz)).toBe(true);
    });

    it("returns Date objects as-is (no conversion)", () => {
      const d = new Date("2026-06-17T16:45:07.527Z");
      const result = deepConvertTimestamps(d, tz);
      expect(result).toBe(d);
    });
  });

  describe("timezone edge cases", () => {
    it("returns input unchanged when timezone is empty", () => {
      const input = { createdAt: "2026-06-17T16:45:07.527Z", name: "test" };
      const result = deepConvertTimestamps(input, "");
      expect(result).toEqual(input);
    });

    it("returns input unchanged when timezone is invalid", () => {
      const input = { createdAt: "2026-06-17T16:45:07.527Z", name: "test" };
      const result = deepConvertTimestamps(input, "Foo/Bar");
      expect(result).toEqual(input);
    });
  });
});

// =============================================================================
// resolveTimezone
// =============================================================================

describe("resolveTimezone", () => {
  it("returns the first valid timezone", () => {
    expect(resolveTimezone("Asia/Shanghai", "America/New_York")).toBe(
      "Asia/Shanghai",
    );
  });

  it("skips invalid sources and returns first valid", () => {
    expect(resolveTimezone("Foo/Bar", "Asia/Shanghai")).toBe("Asia/Shanghai");
  });

  it("skips null sources", () => {
    expect(resolveTimezone(null, undefined, "UTC")).toBe("UTC");
  });

  it("skips undefined sources", () => {
    expect(resolveTimezone(undefined, "Europe/London")).toBe("Europe/London");
  });

  it("skips empty string sources", () => {
    expect(resolveTimezone("", "America/New_York")).toBe("America/New_York");
  });

  it("skips whitespace-only sources", () => {
    expect(resolveTimezone("   ", "UTC")).toBe("UTC");
  });

  it("returns null when all sources are invalid", () => {
    expect(resolveTimezone("Invalid", null, "")).toBeNull();
  });

  it("returns null when no sources provided", () => {
    expect(resolveTimezone()).toBeNull();
  });

  it("returns null when all sources are null/undefined/empty", () => {
    expect(resolveTimezone(null, undefined, "")).toBeNull();
  });

  it("trims whitespace from valid timezone", () => {
    expect(resolveTimezone("  Asia/Shanghai  ")).toBe("Asia/Shanghai");
  });

  it("handles mixed valid and invalid in various positions", () => {
    expect(
      resolveTimezone(null, "Bad/Zone", undefined, "", "Europe/London", "UTC"),
    ).toBe("Europe/London");
  });
});
