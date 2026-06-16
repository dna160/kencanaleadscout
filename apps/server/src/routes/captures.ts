/**
 * [B] GET /api/captures — the full actionable WA list for the champion dashboard.
 *
 * Unions two sources per lead:
 *  - "confirmed": a rep logged status='won_wa' during a call (outcomes.wa_number).
 *  - "scraped": the WA-Harvest scraper found a number for that company but no
 *    rep has confirmed it yet (enrichments, no won_wa outcome).
 * Confirmed always wins when both exist for the same lead.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

interface CaptureRow {
  id: string;
  day: number;
  rep: string;
  priority: string | null;
  company: string | null;
  o_status: string | null;
  o_wa_number: string | null;
  o_updated_at: Date | null;
  scraped_wa: string | null;
  scraped_confidence: string | null;
  scraped_source: string | null;
  scraped_updated_at: Date | null;
}

export async function capturesRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/captures", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rows = await db<CaptureRow[]>`
      select
        l.id, l.day, l.rep, l.priority, l.company,
        o.status      as o_status,
        o.wa_number   as o_wa_number,
        o.updated_at  as o_updated_at,
        e.wa_numbers  as scraped_wa,
        e.confidence  as scraped_confidence,
        e.source      as scraped_source,
        e.updated_at  as scraped_updated_at
      from leads l
      left join outcomes o on o.lead_id = l.id
      left join enrichments e
        on e.company_norm = btrim(regexp_replace(lower(l.company), '[^a-z0-9]+', ' ', 'g'))
      where (o.status = 'won_wa' and o.wa_number is not null) or e.wa_numbers is not null
      order by l.day asc, l.priority asc, l.company asc
    `;

    const captures = rows.map((r) => {
      const confirmed = r.o_status === "won_wa" && r.o_wa_number;
      return {
        lead_id: r.id,
        day: r.day,
        rep: r.rep,
        priority: r.priority,
        company: r.company,
        wa_number: confirmed ? r.o_wa_number : (r.scraped_wa?.split(",")[0]?.trim() ?? null),
        status: confirmed ? "confirmed" : "scraped",
        source: confirmed ? "call" : r.scraped_source,
        confidence: confirmed ? "confirmed" : r.scraped_confidence,
        updated_at: confirmed ? r.o_updated_at : r.scraped_updated_at,
      };
    });

    return { count: captures.length, captures };
  });
}
