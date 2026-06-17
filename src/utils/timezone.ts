const TIMESTAMP_EXACT_NAMES = new Set([
  "timestamp",
  "forgetAfter",
  "validFrom",
  "validTo",
  "windowStart",
  "windowEnd",
]);

function isTimestampField(key: string): boolean {
  return TIMESTAMP_EXACT_NAMES.has(key) || key.endsWith("At");
}

export function isValidTimezone(tz: string): boolean {
  if (!tz) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function formatTimestamp(isoString: string, timezone: string): string {
  if (!timezone || !isValidTimezone(timezone)) return isoString;
  try {
    const date = new Date(isoString);
    if (isNaN(date.getTime())) return isoString;
    const formatted = date.toLocaleString("sv-SE", { timeZone: timezone });
    return formatted.replace(" ", "T");
  } catch {
    return isoString;
  }
}

export function deepConvertTimestamps(
  obj: unknown,
  timezone: string,
  _depth: number = 0,
): unknown {
  if (_depth > 20) return obj;
  if (!timezone || !isValidTimezone(timezone)) return obj;
  if (obj === null || obj === undefined) return obj;
  if (obj instanceof Date) return obj;
  if (Array.isArray(obj)) {
    return obj.map((item) => deepConvertTimestamps(item, timezone, _depth + 1));
  }
  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isTimestampField(key) && typeof value === "string") {
        result[key] = formatTimestamp(value, timezone);
      } else {
        result[key] = deepConvertTimestamps(value, timezone, _depth + 1);
      }
    }
    return result;
  }
  return obj;
}

export function resolveTimezone(
  ...sources: Array<string | undefined | null>
): string | null {
  for (const source of sources) {
    if (source && typeof source === "string" && source.trim().length > 0) {
      const trimmed = source.trim();
      if (isValidTimezone(trimmed)) return trimmed;
    }
  }
  return null;
}
