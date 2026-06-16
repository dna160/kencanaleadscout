import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { enrichRow } from "../src/index.js";
import { extractCandidates } from "../src/extract.js";
import type { FetchedPage } from "../src/types.js";

const fixture = readFileSync(
  fileURLToPath(new URL("./fixtures/wa-float.html", import.meta.url)),
  "utf8",
);

describe("extractCandidates", () => {
  it("finds the wa.me float button as a wa_link candidate", () => {
    const candidates = extractCandidates(fixture);
    const wa = candidates.find((c) => c.source === "wa_link");
    expect(wa).toBeDefined();
    expect(wa!.raw).toContain("6281234567890");
  });

  it("also captures the visible-text landline (to be rejected later)", () => {
    const candidates = extractCandidates(fixture);
    // The (021) number is a tel-shaped string but not mobile-shaped, so it
    // should NOT appear as a text_regex mobile candidate.
    expect(candidates.some((c) => c.source === "text_regex")).toBe(false);
  });
});

describe("enrichRow against the wa-float fixture", () => {
  it("returns the WA number at confidence 'high'", async () => {
    // Inject a fetcher that serves the fixture for the homepage and 404s the
    // rest, so the test is hermetic (no network).
    const fakeFetch = async (url: string): Promise<FetchedPage> => {
      if (url === "https://contoh.co.id") {
        return { url, finalUrl: url, html: fixture, ok: true };
      }
      return { url, finalUrl: url, html: "", ok: false, error: "HTTP 404" };
    };

    const res = await enrichRow(
      { Company: "PT Contoh Konstruksi", Website: "contoh.co.id" },
      { fetchPage: fakeFetch },
    );

    expect(res.wa_found).toBe(true);
    expect(res.wa_numbers).toContain("+6281234567890");
    expect(res.source).toBe("wa_link");
    expect(res.confidence).toBe("high");
    // The (021) landline must be rejected by normalization.
    expect(res.wa_numbers).not.toContain("+62215551234");
  });
});
