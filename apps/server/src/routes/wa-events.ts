/**
 * Kabar Pesanan WP-5 — the gateway's callbacks and the pairing proxy.
 *
 * POST /api/notify/wa-events            from wa-gateway, `x-gateway-secret`
 * GET  /api/notify/gateway/pair         QR string to render       [admin token]
 * POST /api/notify/gateway/pair-phone   {phone} → 8-char code      [admin token]
 *
 * The callback always answers 2xx once authenticated, even when handling an
 * event fails (logged): a gateway retry would not fix a LeadScout-side bug,
 * and receipts/replies are idempotent anyway.
 */
import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { getChannel, getGatewayAdmin } from "../notify/channel.js";
import { applyReceipt, applyState, handleInbound, type GatewayEvent } from "../notify/inbound.js";
import { redactSecrets } from "../erp/selarasClient.js";

function secretOk(given: unknown): boolean {
  const want = config.notify.gatewaySecret;
  if (!want || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

function adminOk(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (required && req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

const STATE_EVENTS = new Set(["logged_out", "temporary_ban", "disconnected", "connected"]);

export async function waEventRoutes(app: FastifyInstance): Promise<void> {
  app.post("/api/notify/wa-events", async (req, reply) => {
    if (!config.notify.gatewaySecret) return reply.code(503).send({ error: "WA_GATEWAY_SECRET not set" });
    if (!secretOk(req.headers["x-gateway-secret"])) return reply.code(401).send({ error: "unauthorized" });
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "database unavailable" });
    const e = (req.body ?? {}) as GatewayEvent;
    if (typeof e.type !== "string") return reply.code(400).send({ error: "type is required" });
    try {
      if (e.type === "receipt") return { ok: true, updated: await applyReceipt(db, e) };
      if (e.type === "inbound") return { ok: true, ...(await handleInbound(db, getChannel(), e)) };
      if (STATE_EVENTS.has(e.type)) {
        await applyState(db, e);
        if (e.type !== "connected") req.log.warn({ event: e.type, code: e.code }, "wa-gateway reported a problem");
        return { ok: true };
      }
      return { ok: true, ignored: e.type };
    } catch (err) {
      req.log.error({ err: redactSecrets(err), type: e.type }, "wa-event handling failed");
      return { ok: false };
    }
  });

  app.get("/api/notify/gateway/pair", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const gw = getGatewayAdmin();
    if (!gw) return reply.code(409).send({ error: "NOTIFY_CHANNEL bukan gateway." });
    try {
      return await gw.pair();
    } catch (err) {
      return reply.code(502).send({ error: redactSecrets(err) });
    }
  });

  app.post("/api/notify/gateway/pair-phone", async (req, reply) => {
    if (!adminOk(req, reply)) return;
    const gw = getGatewayAdmin();
    if (!gw) return reply.code(409).send({ error: "NOTIFY_CHANNEL bukan gateway." });
    const raw = (req.body as { phone?: unknown } | null)?.phone;
    const phone = typeof raw === "string" ? normalizeNumber(raw) : null;
    if (!phone) return reply.code(400).send({ error: "Nomor bukan nomor HP Indonesia yang valid." });
    try {
      return await gw.pairPhone(phone);
    } catch (err) {
      return reply.code(502).send({ error: redactSecrets(err) });
    }
  });
}
