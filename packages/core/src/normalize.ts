/**
 * Phone normalization + validation (microPRD §3c).
 *
 * Rule: only WhatsApp-capable Indonesian mobiles survive. They normalize to
 * `+628…`. Anything resolving to a fixed-line area code (e.g. `+6221…`) is a
 * landline and is discarded — it cannot receive WhatsApp.
 *
 * We use the `/max` metadata bundle because the default (min) bundle does not
 * carry number-type data, so `getType()` would return `undefined` and we could
 * not tell a Jakarta landline apart from a mobile.
 */
import { parsePhoneNumberFromString } from "libphonenumber-js/max";

/** Belt-and-suspenders: a clearly-mobile E.164 Indonesian number. */
const ID_MOBILE_E164 = /^\+628\d{7,11}$/;

/**
 * Reduce a raw candidate to digits and an optional leading `+`.
 * Strips spaces, dashes, dots, and any surrounding text (e.g. a `wa.me/` prefix).
 */
function cleanDigits(raw: string): string {
  return String(raw).replace(/[^\d+]/g, "");
}

/**
 * Normalize one raw candidate to E.164, or return `null` if it is not a
 * valid WhatsApp-capable Indonesian mobile.
 *
 * @example normalizeNumber("0812-3456-7890") // "+6281234567890"
 * @example normalizeNumber("021-5551234")    // null  (landline)
 */
export function normalizeNumber(raw: string): string | null {
  const cleaned = cleanDigits(raw);
  if (cleaned.replace(/\+/g, "").length < 8) return null;

  // Choose how to feed libphonenumber:
  //  - "+..."  -> already international
  //  - "62..." -> Indonesian country code missing its "+"
  //  - else    -> national format, parse with default region ID
  let parsed;
  if (cleaned.startsWith("+")) {
    parsed = parsePhoneNumberFromString(cleaned);
  } else if (cleaned.startsWith("62")) {
    parsed = parsePhoneNumberFromString("+" + cleaned);
  } else {
    parsed = parsePhoneNumberFromString(cleaned, "ID");
  }

  if (parsed && parsed.isValid()) {
    const type = parsed.getType();
    if (type === "MOBILE" || type === "FIXED_LINE_OR_MOBILE") {
      return parsed.number; // E.164, e.g. "+6281234567890"
    }
    // Valid but a landline (FIXED_LINE / others) -> reject.
    return null;
  }

  // Fallback: libphonenumber rejected it, but if it already looks like a
  // canonical +628 mobile, trust it (metadata can lag new mobile ranges).
  const guess = parsed?.number ?? (cleaned.startsWith("+") ? cleaned : "+" + cleaned.replace(/^0/, "62"));
  return ID_MOBILE_E164.test(guess) ? guess : null;
}

/**
 * Normalize a list of raw candidates, dropping invalids and de-duplicating
 * while preserving first-seen order.
 */
export function normalizeAll(raws: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of raws) {
    const n = normalizeNumber(raw);
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

/** True when a string is a valid WA-capable Indonesian mobile in E.164. */
export function isWaCapable(raw: string): boolean {
  return normalizeNumber(raw) !== null;
}

/**
 * Strict E.164 check used by the Part B API to validate captured WA numbers
 * (microPRD §15). Reuses the same regex contract the spec calls out.
 */
export function isValidWaE164(value: string): boolean {
  return ID_MOBILE_E164.test(String(value).trim());
}
