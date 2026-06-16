/**
 * [B] POST /api/outcome — upsert a call result, keyed by lead_id.
 *
 * Validation (microPRD §15): when status='won_wa', wa_number is required and
 * must be a valid +628… mobile (reuses packages/core normalize).
 */
import type { FastifyInstance } from "fastify";
import { isValidWaE164 } from "@kencana/core";
import { getSql } from "../db/client.js";

const STATUSES = new Set(["won_wa", "warm", "not_interested", "no_answer", "dead"]);
const REPS = new Set(["Rep A", "Rep B"]);

interface Body {
  lead_id?: string;
  status?: string;
  wa_number?: string;
  pic_name?: string;
  sample_sent?: boolean;
  updated_by?: string;
}

export async function outcomeRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Body }>("/api/outcome", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const lead_id = String(b.lead_id ?? "").trim();
    const status = String(b.status ?? "").trim();
    const updated_by = String(b.updated_by ?? "").trim();
    const wa_number = b.wa_number ? String(b.wa_number).trim() : null;
    const pic_name = b.pic_name ? String(b.pic_name).trim() : null;
    const sample_sent = Boolean(b.sample_sent);

    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });
    if (!STATUSES.has(status)) {
      return reply.code(400).send({ error: `status must be one of: ${[...STATUSES].join(", ")}.` });
    }
    if (!REPS.has(updated_by)) {
      return reply.code(400).send({ error: "updated_by must be 'Rep A' or 'Rep B'." });
    }
    if (status === "won_wa") {
      if (!wa_number || !isValidWaE164(wa_number)) {
        return reply
          .code(400)
          .send({ error: "A valid WhatsApp number (+628…) is required to capture a lead." });
      }
    }

    try {
      const [saved] = await db`
        insert into outcomes (lead_id, status, wa_number, pic_name, sample_sent, updated_by, updated_at)
        values (${lead_id}, ${status}, ${wa_number}, ${pic_name}, ${sample_sent}, ${updated_by}, now())
        on conflict (lead_id) do update set
          status      = excluded.status,
          wa_number   = excluded.wa_number,
          pic_name    = excluded.pic_name,
          sample_sent = excluded.sample_sent,
          updated_by  = excluded.updated_by,
          updated_at  = now()
        returning *
      `;
      return { ok: true, outcome: saved };
    } catch (err) {
      // Most likely a FK violation: unknown lead_id.
      app.log.error({ err, lead_id }, "outcome upsert failed");
      return reply.code(400).send({ error: "Could not save outcome (unknown lead?)." });
    }
  });
}
