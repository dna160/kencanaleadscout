/**
 * [C] Pipeline & handler routes (microPRD §22, §25).
 *
 * `outcomes` rows with status='won_wa' are pipeline items. `stage` walks
 * captured → messaged → replied → meeting_set → won, with `dead` reachable
 * from any non-terminal stage. Timestamps are stamped server-side, never
 * trusted from the client.
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

const STAGES = ["captured", "messaged", "replied", "meeting_set", "won", "dead"] as const;
type Stage = (typeof STAGES)[number];
const STAGE_SET = new Set<string>(STAGES);
const STAGE_ORDER: Stage[] = ["captured", "messaged", "replied", "meeting_set", "won"];

/** A transition is legal if it's a same-stage no-op (e.g. saving a note),
 *  exactly one step forward, or a move to 'dead' from any non-terminal stage. */
function legalTransition(from: string, to: Stage): boolean {
  if (to === from) return true;
  if (to === "dead") return from !== "won" && from !== "dead";
  const fi = STAGE_ORDER.indexOf(from as Stage);
  const ti = STAGE_ORDER.indexOf(to);
  return fi !== -1 && ti === fi + 1;
}

/** Previous stage in the forward pipeline (used by revert). */
function prevStage(stage: string): Stage | null {
  const idx = STAGE_ORDER.indexOf(stage as Stage);
  return idx > 0 ? (STAGE_ORDER[idx - 1] ?? null) : null;
}

interface PipelineRow {
  lead_id: string;
  company: string | null;
  ask_for: string | null;
  town: string | null;
  priority: string | null;
  status: string;
  stage: string;
  wa_number: string | null;
  handler: string | null;
  pic_name: string | null;
  captured_at: Date | null;
  messaged_at: Date | null;
  replied_at: Date | null;
  meeting_at: Date | null;
  pipe_note: string | null;
  updated_at: Date;
  waiting_ms: string | null;
}

export async function pipelineRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { stage?: string } }>("/api/pipeline", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const stage = request.query.stage;
    if (stage && !STAGE_SET.has(stage)) {
      return reply.code(400).send({ error: `stage must be one of: ${STAGES.join(", ")}.` });
    }

    const rows = await db<PipelineRow[]>`
      select
        l.id as lead_id, l.company, l.ask_for, l.town, l.priority,
        o.status, o.stage, o.wa_number, o.handler, o.pic_name,
        o.captured_at, o.messaged_at, o.replied_at, o.meeting_at, o.pipe_note, o.updated_at,
        case when o.stage = 'messaged' and o.replied_at is null
          then extract(epoch from (now() - o.messaged_at)) * 1000
        end as waiting_ms
      from outcomes o
      join leads l on l.id = o.lead_id
      where o.status = 'won_wa'
        ${stage ? db`and o.stage = ${stage}` : db``}
      order by
        case o.stage
          when 'captured'     then 0
          when 'messaged'     then 1
          when 'replied'      then 2
          when 'meeting_set'  then 3
          when 'won'          then 4
          when 'dead'         then 5
          else 6
        end,
        -- per-stage secondary sort handled client-side; server provides a stable base
        o.updated_at desc
    `;

    const items = rows.map((r) => ({
      lead_id: r.lead_id,
      company: r.company,
      ask_for: r.ask_for,
      town: r.town,
      priority: r.priority,
      stage: r.stage,
      wa_number: r.wa_number,
      handler: r.handler,
      pic_name: r.pic_name,
      captured_at: r.captured_at,
      messaged_at: r.messaged_at,
      replied_at: r.replied_at,
      meeting_at: r.meeting_at,
      pipe_note: r.pipe_note,
      updated_at: r.updated_at,
      waiting_ms: r.waiting_ms == null ? null : Math.round(Number(r.waiting_ms)),
    }));

    return { count: items.length, items };
  });

  app.post<{
    Body: { lead_id?: string; to_stage?: string; meeting_at?: string; pipe_note?: string };
  }>("/api/pipeline/advance", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const lead_id = String(b.lead_id ?? "").trim();
    const to_stage = String(b.to_stage ?? "").trim();
    const pipe_note = b.pipe_note != null ? String(b.pipe_note).trim() : null;

    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });
    if (!STAGE_SET.has(to_stage)) {
      return reply.code(400).send({ error: `to_stage must be one of: ${STAGES.join(", ")}.` });
    }

    let meeting_at: Date | null = null;
    if (to_stage === "meeting_set") {
      const raw = b.meeting_at ? new Date(b.meeting_at) : null;
      if (!raw || Number.isNaN(raw.getTime())) {
        return reply.code(400).send({ error: "meeting_at (a valid datetime) is required for to_stage='meeting_set'." });
      }
      meeting_at = raw;
    }

    const [current] = await db<{ stage: string }[]>`
      select stage from outcomes where lead_id = ${lead_id} and status = 'won_wa'
    `;
    if (!current) return reply.code(404).send({ error: "No captured pipeline item for that lead_id." });
    if (!legalTransition(current.stage, to_stage as Stage)) {
      return reply.code(400).send({ error: `Cannot move from '${current.stage}' to '${to_stage}'.` });
    }

    const [saved] = await db`
      update outcomes set
        stage       = ${to_stage},
        messaged_at = case when ${to_stage} = 'messaged' and messaged_at is null then now() else messaged_at end,
        replied_at  = case when ${to_stage} = 'replied'  and replied_at  is null then now() else replied_at  end,
        meeting_at  = ${to_stage === "meeting_set" ? meeting_at : db`meeting_at`},
        pipe_note   = ${pipe_note ?? db`pipe_note`},
        updated_at  = now()
      where lead_id = ${lead_id} and status = 'won_wa'
      returning *
    `;
    return { ok: true, item: saved };
  });

  app.post<{ Body: { lead_id?: string } }>("/api/pipeline/revert", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const lead_id = String((request.body ?? {}).lead_id ?? "").trim();
    if (!lead_id) return reply.code(400).send({ error: "lead_id is required." });

    const [current] = await db<{ stage: string }[]>`
      select stage from outcomes where lead_id = ${lead_id} and status = 'won_wa'
    `;
    if (!current) return reply.code(404).send({ error: "No pipeline item for that lead_id." });

    const prev = prevStage(current.stage);
    if (!prev) {
      return reply.code(400).send({ error: `Cannot revert from '${current.stage}'.` });
    }

    const fromStage = current.stage;
    const [saved] = await db`
      update outcomes set
        stage      = ${prev},
        messaged_at = case when ${fromStage} = 'messaged'     then null else messaged_at end,
        replied_at  = case when ${fromStage} = 'replied'      then null else replied_at  end,
        meeting_at  = case when ${fromStage} = 'meeting_set'  then null else meeting_at  end,
        updated_at  = now()
      where lead_id = ${lead_id} and status = 'won_wa'
      returning *
    `;
    return { ok: true, item: saved };
  });
}
