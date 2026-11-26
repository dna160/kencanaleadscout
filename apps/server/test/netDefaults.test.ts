/**
 * The ERP outage of Nov 2026: Node's 250 ms per-address connect window was
 * shorter than Selaras's round trip from Railway. The server raises it.
 */
import net from "node:net";
import { describe, expect, it } from "vitest";
import { applyNetDefaults, DEFAULT_CONNECT_ATTEMPT_MS } from "../src/netDefaults.js";

describe("outbound connection defaults", () => {
  it("each address gets 5 s to connect, not Node's 250 ms", () => {
    expect(applyNetDefaults({})).toBe(DEFAULT_CONNECT_ATTEMPT_MS);
    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5_000);
  });
  it("NET_CONNECT_ATTEMPT_MS overrides it within sane bounds", () => {
    expect(applyNetDefaults({ NET_CONNECT_ATTEMPT_MS: "8000" })).toBe(8_000);
    expect(applyNetDefaults({ NET_CONNECT_ATTEMPT_MS: "10" })).toBe(DEFAULT_CONNECT_ATTEMPT_MS);
    expect(applyNetDefaults({ NET_CONNECT_ATTEMPT_MS: "abc" })).toBe(DEFAULT_CONNECT_ATTEMPT_MS);
  });
});
