/**
 * [B] GET /api/stats — champion aggregates (microPRD §15).
 *
 * Definitions: dialed = outcomes with any status; captured = status 'won_wa';
 * capture_rate = captured / dialed (0 when dialed = 0).
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

const rate = (captured: number, dialed: number): number =>
  dialed > 0 ? Math.round((captured / dialed) * 1000) / 1000 : 0;

export async function statsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/stats", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const [totalsRow] = await db<
      { assigned: string; dialed: string; captured: string; samples: string }[]
    >`
      select
        (select count(*) from leads)                                            as assigned,
        (select count(*) from outcomes)                                         as dialed,
        (select count(*) from outcomes where status = 'won_wa')                 as captured,
        (select count(*) from outcomes where sample_sent = true)                as samples
    `;

    const byRep = await db<{ rep: string; dialed: string; captured: string }[]>`
      select l.rep,
             count(o.lead_id)                                          as dialed,
             count(o.lead_id) filter (where o.status = 'won_wa')       as captured
      from leads l
      join outcomes o on o.lead_id = l.id
      group by l.rep
      order by l.rep
    `;

    const byDay = await db<{ day: number; dialed: string; captured: string }[]>`
      select l.day,
             count(o.lead_id)                                          as dialed,
             count(o.lead_id) filter (where o.status = 'won_wa')       as captured
      from leads l
      join outcomes o on o.lead_id = l.id
      group by l.day
      order by l.day
    `;

    const byTier = await db<{ priority: string; dialed: string; captured: string }[]>`
      select l.priority,
             count(o.lead_id)                                          as dialed,
             count(o.lead_id) filter (where o.status = 'won_wa')       as captured
      from leads l
      join outcomes o on o.lead_id = l.id
      group by l.priority
      order by l.priority
    `;

    const recent = await db<
      { company: string; wa_number: string; rep: string; updated_at: Date }[]
    >`
      select l.company, o.wa_number, l.rep, o.updated_at
      from outcomes o
      join leads l on l.id = o.lead_id
      where o.status = 'won_wa'
      order by o.updated_at desc
      limit 15
    `;

    const assigned = Number(totalsRow?.assigned ?? 0);
    const dialed = Number(totalsRow?.dialed ?? 0);
    const captured = Number(totalsRow?.captured ?? 0);
    const samples = Number(totalsRow?.samples ?? 0);

    return {
      totals: { assigned, dialed, captured, capture_rate: rate(captured, dialed), samples },
      by_rep: byRep.map((r) => ({
        rep: r.rep,
        dialed: Number(r.dialed),
        captured: Number(r.captured),
        capture_rate: rate(Number(r.captured), Number(r.dialed)),
      })),
      by_day: byDay.map((r) => ({
        day: r.day,
        dialed: Number(r.dialed),
        captured: Number(r.captured),
      })),
      by_tier: byTier.map((r) => ({
        priority: r.priority,
        dialed: Number(r.dialed),
        captured: Number(r.captured),
        capture_rate: rate(Number(r.captured), Number(r.dialed)),
      })),
      recent: recent.map((r) => ({
        company: r.company,
        wa_number: r.wa_number,
        rep: r.rep,
        updated_at: r.updated_at,
      })),
    };
  });
}
