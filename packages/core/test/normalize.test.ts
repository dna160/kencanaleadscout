import { describe, expect, it } from "vitest";
import { isValidWaE164, normalizeAll, normalizeNumber } from "../src/normalize.js";

/**
 * These are the make-or-break cases from microPRD §7. Only WA-capable
 * Indonesian mobiles may survive; landlines and junk must be rejected.
 */
describe("normalizeNumber — accepts valid mobiles", () => {
  it.each([
    ["0812-3456-7890", "+6281234567890"],
    ["+62 812 3456 7890", "+6281234567890"],
    ["62 877 8888 9999", "+6287788889999"],
    ["wa.me/6281234567890", "+6281234567890"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeNumber(input)).toBe(expected);
  });
});

describe("normalizeNumber — rejects landlines & junk", () => {
  it.each([
    ["021-5551234"], // Jakarta landline
    ["+622150231100"], // Jakarta landline in E.164
    ["not a phone 123"], // not a phone
    ["+971501234567"], // valid mobile, but not Indonesian (UAE)
    ["+14155552671"], // valid mobile, but not Indonesian (US)
  ])("%s -> REJECTED", (input) => {
    expect(normalizeNumber(input)).toBeNull();
  });
});

describe("normalizeAll", () => {
  it("dedupes and drops invalids, preserving order", () => {
    const out = normalizeAll([
      "0812-3456-7890",
      "+62 812 3456 7890", // dup of the first
      "021-5551234", // landline -> dropped
      "62 877 8888 9999",
    ]);
    expect(out).toEqual(["+6281234567890", "+6287788889999"]);
  });
});

describe("isValidWaE164", () => {
  it("accepts canonical +628 mobiles", () => {
    expect(isValidWaE164("+6281234567890")).toBe(true);
  });
  it("rejects landlines and malformed input", () => {
    expect(isValidWaE164("+622150231100")).toBe(false);
    expect(isValidWaE164("081234567890")).toBe(false);
    expect(isValidWaE164("")).toBe(false);
  });
});
