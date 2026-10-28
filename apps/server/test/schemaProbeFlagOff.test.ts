/**
 * The DEFAULT, proven with the flag genuinely absent from the environment.
 *
 * `schemaProbe.test.ts` sets `ERP_SCHEMA_PROBE=1` before `config.ts` is
 * evaluated — it has to, because config freezes env into a const at import
 * time — and then flips the resolved flag back off to test the guard. That
 * proves the guard, not the default. This file is the other half: it DELETES the
 * variable, so the probe is off because nobody turned it on, which is the state
 * every ordinary deploy is in.
 *
 * Vitest isolates each test file in its own process, which is what makes the
 * two files able to disagree about one env var.
 *
 * It also proves the two no-config boot states the app must survive
 * (invariant §7.7): no `DATABASE_URL` and no `SELARAS_BASE_URL`.
 */
import { describe, expect, it, vi } from "vitest";
import { MockAgent, setGlobalDispatcher } from "undici";

delete process.env["ERP_SCHEMA_PROBE"];
delete process.env["ERP_SCHEMA_PROBE_DELAY_MS"];
delete process.env["DATABASE_URL"];
delete process.env["SELARAS_BASE_URL"];
delete process.env["SELARAS_SECRET_KEY"];
delete process.env["SELARAS_SECRET_TOKEN"];
delete process.env["SELARAS_TOKEN"];

// Any request at all would be a failure here, so make one impossible.
const agent = new MockAgent();
agent.disableNetConnect();
setGlobalDispatcher(agent);

const { config, hasDatabase, hasErp, hasErpCredentials } = await import("../src/config.js");
const { runErpSchemaProbeOnce, startErpSchemaProbe, stopErpSchemaProbe } = await import("../src/erp/schemaProbe.js");

describe("with ERP_SCHEMA_PROBE unset — the state every ordinary deploy is in", () => {
  it("defaults to off", () => {
    expect(config.erpProbe.enabled).toBe(false);
  });

  it("boots cleanly with no DATABASE_URL and no SELARAS_BASE_URL", () => {
    expect(hasDatabase).toBe(false);
    expect(hasErp).toBe(false);
    expect(hasErpCredentials).toBe(false);
    // The flag guard comes FIRST, so a probe cannot even notice the ERP is
    // absent — which is why an unflagged deploy with no ERP is still silent.
    expect(() => startErpSchemaProbe()).not.toThrow();
  });

  it("is inert: no timer, no log line, no request", async () => {
    const spies = {
      log: vi.spyOn(console, "log").mockImplementation(() => {}),
      info: vi.spyOn(console, "info").mockImplementation(() => {}),
      warn: vi.spyOn(console, "warn").mockImplementation(() => {}),
      error: vi.spyOn(console, "error").mockImplementation(() => {}),
    };
    try {
      startErpSchemaProbe();
      const res = await runErpSchemaProbeOnce();
      expect(res).toMatchObject({ ran: false, skipped: "disabled", requests: 0, probed: [] });
      // 100ms is ten times the test delay and five times nothing at all: if a
      // timer had been armed it would have fired by now.
      await new Promise((r) => setTimeout(r, 100));
      for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of Object.values(spies)) spy.mockRestore();
      stopErpSchemaProbe();
    }
  });

  it("stopping a probe that was never armed is harmless", () => {
    expect(() => stopErpSchemaProbe()).not.toThrow();
    expect(() => stopErpSchemaProbe()).not.toThrow();
  });
});
