/**
 * Kabar Pesanan — config + test pipeline API (MVP, stub channel by default).
 *
 * GET  /api/notify/config        — system number, channel mode/health, trigger rules
 * PUT  /api/notify/config        — set the system WhatsApp number        [token]
 * GET  /api/notify/order?so_no=  — read-only preview of a real SO from Selaras
 * POST /api/notify/test          — render + send ONE milestone to a test number,
 *                                  CC the sales number                   [token]
 * GET  /api/notify/ledger        — recent messages (test + live)
 *
 * [token] = needs `x-notify-token` when NOTIFY_ADMIN_TOKEN is set.
 *
 * Test sends go ONLY to the numbers typed into the form, never to the phone
 * stored on the SO. That number is shown masked so the tester can see who
 * would receive the message once live triggers are switched on.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { getChannel } from "../notify/channel.js";
import { ErpLookupError, erpLookupAvailable, lookupOrder, type LookupResult } from "../notify/erpLookup.js";
import {
  MILESTONE_INFO,
  MILESTONES,
  isMilestone,
  renderCustomerMessage,
  renderSalesCc,
  sampleContext,
  type Milestone,
  type OrderContext,
} from "../notify/messages.js";

/** "+6281234567890" → "0812-3456-7890" for display inside a message. */
export function toLocalDisplay(e164: string): string {
  const local = e164.replace(/^\+62/, "0");
  return local.length >= 10 ? `${local.slice(0, 4)}-${local.slice(4, 8)}-${local.slice(8)}` : local;
}

function nowWib(): Date {
  return new Date(Date.now() + 7 * 3600 * 1000);
}

const sendTimes: number[] = [];
function rateLimited(): boolean {
  const cutoff = Date.now() - 10 * 60 * 1000;
  while (sendTimes.length && sendTimes[0]! < cutoff) sendTimes.shift();
  if (sendTimes.length >= config.notify.testSendsPer10Min) return true;
  sendTimes.push(Date.now());
  return false;
}
/** Test hook. */
export function resetNotifyRateLimit(): void {
  sendTimes.length = 0;
}

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (!required) return true;
  if (req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

async function readSystemNumber(): Promise<{ systemNumber: string | null; updatedAt: string | null }> {
  const db = getSql();
  if (!db) return { systemNumber: null, updatedAt: null };
  try {
    const [row] = await db<{ system_number: string | null; updated_at: Date }[]>`
      select system_number, updated_at from notify_settings where id = 1
    `;
    return { systemNumber: row?.system_number ?? null, updatedAt: row?.updated_at?.toISOString() ?? null };
  } catch {
    return { systemNumber: null, updatedAt: null };
  }
}

interface TestBody {
  milestone?: unknown;
  customerNumber?: unknown;
  salesNumber?: unknown;
  salesName?: unknown;
  soNo?: unknown;
  introduce?: unknown;
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

export async function notifyRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/config", async () => {
    const channel = getChannel();
    const [{ systemNumber, updatedAt }, health] = await Promise.all([readSystemNumber(), channel.health()]);
    return {
      systemNumber,
      systemNumberDisplay: systemNumber ? toLocalDisplay(systemNumber) : null,
      updatedAt,
      channel: { mode: channel.mode, ...health },
      adminTokenRequired: Boolean(config.notify.adminToken),
      erpLookupAvailable: erpLookupAvailable(),
      databaseAvailable: Boolean(getSql()),
      milestones: MILESTONES.map((m) => ({ key: m, ...MILESTONE_INFO[m] })),
    };
  });

  app.put("/api/notify/config", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const raw = str((req.body as { systemNumber?: unknown } | null)?.systemNumber);
    const e164 = raw ? normalizeNumber(raw) : null;
    if (raw && !e164) return reply.code(400).send({ error: "Nomor sistem bukan nomor HP Indonesia yang valid." });
    await db`update notify_settings set system_number = ${e164}, updated_at = now() where id = 1`;
    return { systemNumber: e164, systemNumberDisplay: e164 ? toLocalDisplay(e164) : null };
  });

  app.get("/api/notify/order", async (req, reply) => {
    const soNo = str((req.query as { so_no?: unknown }).so_no);
    if (!soNo) return reply.code(400).send({ error: "Isi nomor SO." });
    try {
      const r = await lookupOrder(soNo, { salesWa: null, salesNameOverride: null });
      return {
        soNo: r.context.soNo,
        customerName: r.context.customerName,
        recipientName: r.context.recipientName,
        salesName: r.context.salesName,
        items: r.context.items,
        production: r.context.production,
        delivery: r.context.delivery,
        erpRecipientPhoneMasked: r.erpRecipientPhoneMasked,
        paymentTerm: r.paymentTerm,
        statusOrder: r.statusOrder,
      };
    } catch (err) {
      if (err instanceof ErpLookupError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/notify/test", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const channel = getChannel();
    if (channel.mode === "gateway" && !config.notify.adminToken) {
      return reply.code(503).send({ error: "Isi NOTIFY_ADMIN_TOKEN sebelum memakai mode gateway." });
    }

    const body = (req.body ?? {}) as TestBody;
    if (!isMilestone(body.milestone)) {
      return reply.code(400).send({ error: `milestone harus salah satu dari: ${MILESTONES.join(", ")}.` });
    }
    const milestone: Milestone = body.milestone;

    const customer = normalizeNumber(str(body.customerNumber));
    if (!customer) return reply.code(400).send({ error: "Nomor pelanggan (uji) bukan nomor HP Indonesia yang valid." });
    const salesRaw = str(body.salesNumber);
    const sales = salesRaw ? normalizeNumber(salesRaw) : null;
    if (salesRaw && !sales) return reply.code(400).send({ error: "Nomor sales (CC) bukan nomor HP Indonesia yang valid." });
    const salesName = str(body.salesName) || null;
    const soNo = str(body.soNo);

    if (rateLimited()) {
      return reply.code(429).send({ error: "Terlalu banyak kirim uji. Tunggu beberapa menit." });
    }

    const salesWa = sales ? toLocalDisplay(sales) : null;
    let ctx: OrderContext;
    let lookup: LookupResult | null = null;
    const warnings: string[] = [];
    if (soNo) {
      try {
        lookup = await lookupOrder(soNo, { salesWa, salesNameOverride: salesName });
      } catch (err) {
        if (err instanceof ErpLookupError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
      ctx = lookup.context;
    } else {
      ctx = sampleContext(nowWib(), salesName, salesWa);
    }

    const sample = sampleContext(nowWib(), salesName, salesWa);
    if (milestone === "production_started" && ctx.source === "erp" && !ctx.production) {
      warnings.push(
        "SO ini tidak punya Request Produksi (dilayani dari stok). Di mode live, pesan langkah 2 TIDAK akan terkirim untuk SO ini.",
      );
    }
    if (milestone === "delivery_scheduled" && !ctx.delivery) {
      warnings.push("SO ini belum punya Delivery Order. Pesan memakai nomor surat jalan & tanggal contoh.");
      ctx = { ...ctx, delivery: sample.delivery };
    }

    const { systemNumber } = await readSystemNumber();
    const customerText = renderCustomerMessage(milestone, ctx, { introduce: body.introduce === true });
    const outbound: { role: "customer" | "sales_cc"; to: string; text: string }[] = [
      { role: "customer", to: customer, text: customerText },
    ];
    if (sales) {
      outbound.push({
        role: "sales_cc",
        to: sales,
        text: renderSalesCc(milestone, ctx, toLocalDisplay(customer), customerText),
      });
    }

    const db = getSql();
    const results = [];
    for (const o of outbound) {
      const idempotencyKey = `test:${milestone}:${o.role}:${o.to}:${randomUUID()}`;
      const r = await channel.send({ to: o.to, text: o.text, idempotencyKey });
      if (db) {
        try {
          await db`
            insert into notify_ledger
              (mode, milestone, so_no, recipient_role, to_number, from_number, body, channel,
               status, provider_message_id, error, context_source, idempotency_key)
            values
              ('test', ${milestone}, ${ctx.soNo}, ${o.role}, ${o.to}, ${systemNumber}, ${o.text}, ${channel.mode},
               ${r.status}, ${r.providerMessageId}, ${r.error}, ${ctx.source}, ${idempotencyKey})
          `;
        } catch (err) {
          req.log.warn({ err }, "notify ledger write failed");
          warnings.push("Pesan diproses tetapi gagal dicatat di Riwayat.");
        }
      }
      results.push({ role: o.role, to: o.to, toDisplay: toLocalDisplay(o.to), text: o.text, ...r });
    }
    if (!db) warnings.push("Database tidak tersedia: pesan tidak dicatat di Riwayat.");

    return {
      milestone,
      label: MILESTONE_INFO[milestone].label,
      channel: channel.mode,
      from: systemNumber ? toLocalDisplay(systemNumber) : null,
      context: {
        soNo: ctx.soNo,
        customerName: ctx.customerName,
        source: ctx.source,
        erpRecipientPhoneMasked: lookup?.erpRecipientPhoneMasked ?? null,
      },
      warnings,
      messages: results,
    };
  });

  app.get("/api/notify/ledger", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const limit = Math.min(200, Math.max(1, Number((req.query as { limit?: string }).limit) || 50));
    const rows = await db`
      select id, mode, milestone, so_no, recipient_role, to_number, from_number, body, channel,
             status, provider_message_id, error, context_source, created_at
      from notify_ledger
      order by created_at desc
      limit ${limit}
    `;
    return { rows };
  });
}
