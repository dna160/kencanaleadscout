/**
 * Kabar Pesanan WP-3 — read-only views of the order backbone.
 *
 * GET /api/orders/events?so_no=&type=&limit=   the event log, newest first
 * GET /api/orders/sync-status                  order-lane cursors/errors + event counts
 *
 * Payloads carry no phone numbers (derive.ts), so these are safe to expose to
 * the same audience as /notify's Riwayat.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";
import { isOrderLaneEnabled, orderLaneStatus } from "../erp/orderSync.js";

const TYPES = new Set(["so.created", "production.requested", "do.created", "do.cancelled", "so.late"]);

export async function orderEventRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/orders/events", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const q = req.query as { so_no?: string; type?: string; limit?: string };
    const soNo = typeof q.so_no === "string" && q.so_no.trim() ? q.so_no.trim() : null;
    const type = typeof q.type === "string" && TYPES.has(q.type) ? q.type : null;
    if (q.type && !type) return reply.code(400).send({ error: `type harus salah satu dari: ${[...TYPES].join(", ")}.` });
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 100));
    const rows = await db`
      select id::text, event_key, event_type, so_no, subject_ref, occurred_at, detected_at, payload, source
        from order_events
       where (${soNo}::text is null or so_no = ${soNo})
         and (${type}::text is null or event_type = ${type})
       order by id desc
       limit ${limit}
    `;
    return { rows };
  });

  app.get("/api/orders/sync-status", async (_req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const [lane, counts, state] = await Promise.all([
      orderLaneStatus(db),
      db<{ event_type: string; n: number; last_detected: Date | null }[]>`
        select event_type, count(*)::int as n, max(detected_at) as last_detected
          from order_events group by event_type order by event_type
      `,
      db<{ swept_until: Date | null; late_swept_at: Date | null }[]>`
        select swept_until, late_swept_at from order_event_state where id = 1
      `,
    ]);
    return { laneEnabled: isOrderLaneEnabled(), lane, events: counts, sweep: state[0] ?? null };
  });
}
