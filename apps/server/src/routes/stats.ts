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

    // [C] Funnel (microPRD §23, §27): cumulative counts (has the item ever
    // reached this stage), not "currently sitting at this stage."
    const [funnelRow] = await db<
      {
        captured: string;
        messaged: string;
        replied: string;
        meeting_set: string;
        won: string;
        dead: string;
        median_to_message_ms: string | null;
        median_to_reply_ms: string | null;
      }[]
    >`
      select
        (select count(*) from outcomes where status = 'won_wa')        as captured,
        (select count(*) from outcomes where messaged_at is not null)  as messaged,
        (select count(*) from outcomes where replied_at is not null)   as replied,
        (select count(*) from outcomes where meeting_at is not null)   as meeting_set,
        (select count(*) from outcomes where stage = 'won')            as won,
        (select count(*) from outcomes where stage = 'dead')           as dead,
        (select percentile_cont(0.5) within group (order by extract(epoch from (messaged_at - captured_at)) * 1000)
           from outcomes where messaged_at is not null and captured_at is not null) as median_to_message_ms,
        (select percentile_cont(0.5) within group (order by extract(epoch from (replied_at - messaged_at)) * 1000)
           from outcomes where replied_at is not null and messaged_at is not null)  as median_to_reply_ms
    `;

    const byTierReply = await db<{ priority: string; messaged: string; replied: string }[]>`
      select l.priority,
             count(*) filter (where o.messaged_at is not null) as messaged,
             count(*) filter (where o.replied_at is not null)  as replied
      from outcomes o
      join leads l on l.id = o.lead_id
      where o.status = 'won_wa'
      group by l.priority
      order by l.priority
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
      funnel: {
        captured: Number(funnelRow?.captured ?? 0),
        messaged: Number(funnelRow?.messaged ?? 0),
        replied: Number(funnelRow?.replied ?? 0),
        meeting_set: Number(funnelRow?.meeting_set ?? 0),
        won: Number(funnelRow?.won ?? 0),
        dead: Number(funnelRow?.dead ?? 0),
        median_to_message_ms: funnelRow?.median_to_message_ms == null ? null : Math.round(Number(funnelRow.median_to_message_ms)),
        median_to_reply_ms: funnelRow?.median_to_reply_ms == null ? null : Math.round(Number(funnelRow.median_to_reply_ms)),
        by_tier_reply_rate: byTierReply.map((r) => {
          const messaged = Number(r.messaged);
          const replied = Number(r.replied);
          return { priority: r.priority, messaged, replied, reply_rate: rate(replied, messaged) };
        }),
      },
    };
  });
}
