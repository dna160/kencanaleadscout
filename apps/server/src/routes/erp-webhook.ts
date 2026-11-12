/**
 * POST /api/erp/webhook — Kabar Pesanan PRD §5.0 (WP-2).
 *
 * Ready for the day the Selaras vendor ships outbound webhooks (OQ-7; the API
 * has none today). The contract we will ask for:
 *
 *   POST /api/erp/webhook
 *   x-selaras-signature: <hex HMAC-SHA256 of the raw body, key ERP_WEBHOOK_SECRET>
 *                        ("sha256=<hex>" also accepted)
 *   { "table": "tbl_1082_SOLogisticPID", "id": "77930", "action": "insert" | "update" | "delete" }
 *
 * The payload is a POINTER, never data: LeadScout re-reads that one row from
 * the ERP and writes it through the same path the 60 s poll uses, so a forged
 * or stale payload can at worst cause one extra read. The poll stays on as the
 * safety net for missed webhooks.
 *
 * Disabled (503) until ERP_WEBHOOK_SECRET is set.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { config, hasErp, hasErpCredentials } from "../config.js";
import { getSql } from "../db/client.js";
import { LANE_TABLES, refreshOrderRow, type LaneTable } from "../erp/orderSync.js";
import { endpointOf, redactSecrets } from "../erp/selarasClient.js";

/** Accepts the logical name ("do_header") or the ERP table name ("tbl_1082_SOLogisticPID"). */
export function resolveLaneTable(name: unknown): LaneTable | null {
  if (typeof name !== "string") return null;
  const n = name.trim();
  for (const t of LANE_TABLES) {
    if (t === n || endpointOf(t).toLowerCase() === n.toLowerCase()) return t;
  }
  return null;
}

export function signWebhook(secret: string, rawBody: string): string {
  return createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
}

export function verifyWebhookSignature(secret: string, rawBody: string, header: unknown): boolean {
  if (!secret || typeof header !== "string") return false;
  const given = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(given)) return false;
  const expected = Buffer.from(signWebhook(secret, rawBody), "hex");
  return timingSafeEqual(expected, Buffer.from(given, "hex"));
}

export async function erpWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Scoped to this plugin (Fastify encapsulation): keep the body as the exact
  // string that was signed. Re-serialising parsed JSON would not reproduce it.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    done(null, body);
  });

  app.post("/api/erp/webhook", async (req, reply) => {
    const secret = config.orders.webhookSecret;
    if (!secret) return reply.code(503).send({ error: "ERP webhook is disabled (ERP_WEBHOOK_SECRET not set)." });

    const raw = typeof req.body === "string" ? req.body : "";
    if (!verifyWebhookSignature(secret, raw, req.headers["x-selaras-signature"])) {
      return reply.code(401).send({ error: "bad signature" });
    }

    let payload: { table?: unknown; id?: unknown; action?: unknown };
    try {
      payload = JSON.parse(raw) as typeof payload;
    } catch {
      return reply.code(400).send({ error: "body is not JSON" });
    }
    const table = resolveLaneTable(payload?.table);
    const id = payload?.id == null ? "" : String(payload.id).trim();
    const action = typeof payload?.action === "string" ? payload.action.toLowerCase() : "update";
    if (!table) return reply.code(400).send({ error: `unknown table; expected one of ${LANE_TABLES.join(", ")}` });
    if (!id) return reply.code(400).send({ error: "missing id" });

    if (!getSql()) return reply.code(503).send({ error: "database unavailable" });
    if (!hasErp || !hasErpCredentials) return reply.code(503).send({ error: "ERP not configured" });

    try {
      const r = await refreshOrderRow(table, id, { deleted: action === "delete" });
      return { ok: true, table, id, found: r.found, markedDeleted: r.markedDeleted };
    } catch (err) {
      req.log.warn({ table, id }, "erp webhook refresh failed");
      // 502 so the sender retries; the 60 s poll will pick the row up anyway.
      return reply.code(502).send({ error: redactSecrets(err) });
    }
  });
}
