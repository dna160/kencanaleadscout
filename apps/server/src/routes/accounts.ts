/**
 * [D] Accounts (pipeline) routes — Module D PRD §11.
 *
 * GET    /api/accounts               — list with filters (stage, rep, area, type, q)
 * GET    /api/accounts/:id           — account card (+ action history, stage history, scheduled)
 * PATCH  /api/accounts/:id/stage     — change pipeline stage (writes stage_history)
 * POST   /api/accounts/:id/actions   — record touchpoint (kunjungan/telepon/received_order/note)
 * POST   /api/accounts/:id/schedule  — create scheduled follow-up
 * PATCH  /api/scheduled/:sid/done    — mark scheduled action complete
 * GET    /api/reps/:id/myday         — My Day: overdue / today / upcoming + at-risk
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

const VALID_STAGES_PROJECT   = new Set(["prospek", "penawaran", "negosiasi", "won", "gugur"]);
const VALID_STAGES_REPEATING = new Set(["aktif", "perlu_followup", "at_risk", "hibernasi"]);
const VALID_ACTION_TYPES     = new Set(["kunjungan", "telepon", "received_order", "note"]);

function allValidStages(): Set<string> {
  return new Set([...VALID_STAGES_PROJECT, ...VALID_STAGES_REPEATING]);
}

export async function accountsRoutes(app: FastifyInstance): Promise<void> {
  // ── List accounts ─────────────────────────────────────────────────────────
  app.get<{ Querystring: Record<string, string> }>("/api/accounts", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q        = request.query;
    const stage    = q.stage    ? decodeURIComponent(q.stage)    : null;
    const rep_id   = q.rep_id   ? Number(q.rep_id)               : null;
    const area     = q.area     ? decodeURIComponent(q.area)     : null;
    const acct_type = q.type   ? decodeURIComponent(q.type)     : null;
    const search   = q.q        ? `%${q.q}%`                     : null;
    const limit    = Math.min(Number(q.limit)  || 50, 200);
    const offset   = Number(q.offset) || 0;
    const sortUrgency = q.sort === "urgency";

    const rows = await db`
      select
        c.id, c.store_name, c.category, c.area, c.address,
        c.account_type, c.stage, c.last_contact_at, c.first_seen_at,
        sp.full_name as owner_name, sp.code as owner_code,
        (
          select count(*) from actions a where a.account_id = c.id
        )::int as action_count
      from customers c
      left join salespeople sp on sp.id = c.owner_id
      where true
        ${stage     ? db`and c.stage = ${stage}`                               : db``}
        ${rep_id    ? db`and c.owner_id = ${rep_id}`                           : db``}
        ${area      ? db`and lower(c.area) = lower(${area})`                  : db``}
        ${acct_type ? db`and c.account_type = ${acct_type}`                   : db``}
        ${search    ? db`and (lower(c.store_name) like lower(${search}) or lower(c.area) like lower(${search}))` : db``}
      order by ${sortUrgency
        ? db`case c.stage when 'at_risk' then 1 when 'perlu_followup' then 2 when 'negosiasi' then 3 when 'penawaran' then 4 when 'prospek' then 5 when 'aktif' then 6 when 'won' then 7 when 'gugur' then 8 when 'hibernasi' then 9 else 10 end, c.last_contact_at asc nulls first`
        : db`c.last_contact_at desc nulls last`},
      c.store_name
      limit ${limit} offset ${offset}
    `;

    return { count: rows.length, accounts: rows };
  });

  // ── Account card ──────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/accounts/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const [account] = await db`
      select
        c.id, c.store_name, c.category, c.area, c.address, c.postal_code,
        c.account_type, c.stage, c.last_contact_at, c.first_seen_at,
        sp.id as owner_id, sp.full_name as owner_name, sp.code as owner_code
      from customers c
      left join salespeople sp on sp.id = c.owner_id
      where c.id = ${id}
    `;
    if (!account) return reply.code(404).send({ error: "Account not found." });

    const [actions, history, scheduled] = await Promise.all([
      db`
        select a.id, a.action_type, a.invoice_number, a.notes, a.actioned_at,
               sp.full_name as salesperson_name, sp.code as salesperson_code
        from actions a
        left join salespeople sp on sp.id = a.salesperson_id
        where a.account_id = ${id}
        order by a.actioned_at desc
        limit 50
      `,
      db`
        select sh.id, sh.old_stage, sh.new_stage, sh.changed_at,
               sp.full_name as changed_by_name
        from stage_history sh
        left join salespeople sp on sp.id = sh.changed_by
        where sh.account_id = ${id}
        order by sh.changed_at desc
        limit 20
      `,
      db`
        select sa.id, sa.action_type, sa.scheduled_for, sa.notes, sa.completed_at,
               sp.full_name as salesperson_name, sp.code as salesperson_code
        from scheduled_actions sa
        left join salespeople sp on sp.id = sa.salesperson_id
        where sa.account_id = ${id}
          and sa.completed_at is null
        order by sa.scheduled_for asc
        limit 20
      `,
    ]);

    return { account, actions, stage_history: history, scheduled };
  });

  // ── Change stage ──────────────────────────────────────────────────────────
  app.patch<{
    Params: { id: string };
    Body: { stage: string; changed_by?: number };
  }>("/api/accounts/:id/stage", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const new_stage  = String(request.body?.stage ?? "").trim().toLowerCase();
    const changed_by = request.body?.changed_by ? Number(request.body.changed_by) : null;

    if (!allValidStages().has(new_stage))
      return reply.code(400).send({ error: `Invalid stage. Valid: ${[...allValidStages()].join(", ")}` });

    const [current] = await db<{ id: number; stage: string; account_type: string }[]>`
      select id, stage, account_type from customers where id = ${id}
    `;
    if (!current) return reply.code(404).send({ error: "Account not found." });

    const validSet = current.account_type === "project" ? VALID_STAGES_PROJECT : VALID_STAGES_REPEATING;
    if (!validSet.has(new_stage))
      return reply.code(400).send({
        error: `Stage "${new_stage}" is not valid for account_type "${current.account_type}".`,
      });

    await Promise.all([
      db`update customers set stage = ${new_stage} where id = ${id}`,
      db`
        insert into stage_history (account_id, old_stage, new_stage, changed_by)
        values (${id}, ${current.stage}, ${new_stage}, ${changed_by})
      `,
    ]);

    const [updated] = await db`select id, store_name, stage, account_type from customers where id = ${id}`;
    return { ok: true, account: updated };
  });

  // ── Record action ─────────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/accounts/:id/actions", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b              = request.body ?? {};
    const action_type    = String(b.action_type ?? "").trim().toLowerCase();
    const salesperson_id = b.salesperson_id ? Number(b.salesperson_id) : null;
    const invoice_number = b.invoice_number ? String(b.invoice_number).trim() : null;
    const notes          = b.notes          ? String(b.notes).trim()          : null;

    if (!VALID_ACTION_TYPES.has(action_type))
      return reply.code(400).send({ error: `action_type must be one of: ${[...VALID_ACTION_TYPES].join(", ")}` });

    if (action_type === "received_order" && !invoice_number)
      return reply.code(400).send({ error: "invoice_number is required for received_order." });

    const [account] = await db<{ id: number }[]>`select id from customers where id = ${id}`;
    if (!account) return reply.code(404).send({ error: "Account not found." });

    const [action] = await db`
      insert into actions (account_id, salesperson_id, action_type, invoice_number, notes)
      values (${id}, ${salesperson_id}, ${action_type}, ${invoice_number}, ${notes})
      returning *
    `;

    // Update last_contact_at and optionally set owner if none.
    await db`
      update customers
      set
        last_contact_at = now(),
        owner_id = coalesce(owner_id, ${salesperson_id})
      where id = ${id}
    `;

    return { ok: true, action };
  });

  // ── Schedule follow-up ────────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/accounts/:id/schedule", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b              = request.body ?? {};
    const scheduled_for_raw = b.scheduled_for ? String(b.scheduled_for) : null;
    const salesperson_id    = b.salesperson_id ? Number(b.salesperson_id) : null;
    const action_type       = b.action_type    ? String(b.action_type).trim().toLowerCase() : "followup";
    const notes             = b.notes          ? String(b.notes).trim() : null;

    if (!scheduled_for_raw)
      return reply.code(400).send({ error: "scheduled_for is required." });
    const scheduled_for = new Date(scheduled_for_raw);
    if (Number.isNaN(scheduled_for.getTime()))
      return reply.code(400).send({ error: "scheduled_for must be a valid ISO datetime." });

    const [account] = await db<{ id: number }[]>`select id from customers where id = ${id}`;
    if (!account) return reply.code(404).send({ error: "Account not found." });

    const [scheduled] = await db`
      insert into scheduled_actions (account_id, salesperson_id, action_type, scheduled_for, notes)
      values (${id}, ${salesperson_id}, ${action_type}, ${scheduled_for}, ${notes})
      returning *
    `;
    return { ok: true, scheduled };
  });

  // ── Mark scheduled action done ────────────────────────────────────────────
  app.patch<{ Params: { sid: string } }>("/api/scheduled/:sid/done", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const sid = Number(request.params.sid);
    if (!Number.isInteger(sid) || sid < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const [updated] = await db`
      update scheduled_actions set completed_at = now()
      where id = ${sid} and completed_at is null
      returning *
    `;
    if (!updated) return reply.code(404).send({ error: "Scheduled action not found or already done." });
    return { ok: true, scheduled: updated };
  });

  // ── My Day ────────────────────────────────────────────────────────────────
  app.get<{ Params: { id: string } }>("/api/reps/:id/myday", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const rep_id = Number(request.params.id);
    if (!Number.isInteger(rep_id) || rep_id < 1)
      return reply.code(400).send({ error: "Invalid rep id." });

    const WIB_MS   = 7 * 3600 * 1000;
    const nowUTC   = new Date();
    const shifted  = new Date(nowUTC.getTime() + WIB_MS);
    const todayStartUTC = new Date(
      Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - WIB_MS
    );
    const todayEndUTC   = new Date(todayStartUTC.getTime() + 24 * 3600 * 1000);
    const sevenDaysOut  = new Date(todayEndUTC.getTime()   + 6  * 24 * 3600 * 1000);

    const [overdue, today, upcoming, atRisk, stats, portfolioRows, wonRows, resolvedEscalations, todayVisits] = await Promise.all([
      // Overdue: past due, not completed, for this rep
      db`
        select sa.id, sa.account_id, sa.action_type, sa.scheduled_for, sa.notes,
               c.store_name, c.area, c.category, c.stage, c.account_type
        from scheduled_actions sa
        join customers c on c.id = sa.account_id
        where sa.salesperson_id = ${rep_id}
          and sa.completed_at is null
          and sa.scheduled_for < ${todayStartUTC}
        order by sa.scheduled_for asc
        limit 50
      `,
      // Today: due today, not completed
      db`
        select sa.id, sa.account_id, sa.action_type, sa.scheduled_for, sa.notes,
               c.store_name, c.area, c.category, c.stage, c.account_type
        from scheduled_actions sa
        join customers c on c.id = sa.account_id
        where sa.salesperson_id = ${rep_id}
          and sa.completed_at is null
          and sa.scheduled_for >= ${todayStartUTC}
          and sa.scheduled_for <  ${todayEndUTC}
        order by sa.scheduled_for asc
        limit 50
      `,
      // Upcoming: next 7 days
      db`
        select sa.id, sa.account_id, sa.action_type, sa.scheduled_for, sa.notes,
               c.store_name, c.area, c.category, c.stage, c.account_type
        from scheduled_actions sa
        join customers c on c.id = sa.account_id
        where sa.salesperson_id = ${rep_id}
          and sa.completed_at is null
          and sa.scheduled_for >= ${todayEndUTC}
          and sa.scheduled_for <  ${sevenDaysOut}
        order by sa.scheduled_for asc
        limit 50
      `,
      // At-risk accounts owned by this rep
      db`
        select c.id, c.store_name, c.area, c.category, c.stage, c.account_type, c.last_contact_at
        from customers c
        where c.owner_id = ${rep_id}
          and c.stage in ('at_risk', 'perlu_followup')
        order by c.last_contact_at asc nulls first
        limit 20
      `,
      // Quick stats for today
      db`
        select
          (select count(*) from visits v
           where v.salesperson_id = ${rep_id}
             and v.visited_at >= ${todayStartUTC}
             and v.visited_at <  ${todayEndUTC}
          )::int as today_visits,
          (select count(*) from scheduled_actions sa
           where sa.salesperson_id = ${rep_id}
             and sa.completed_at is null
             and sa.scheduled_for < ${todayStartUTC}
          )::int as overdue_count,
          (select count(*) from customers c
           where c.owner_id = ${rep_id}
             and c.stage in ('at_risk', 'perlu_followup')
          )::int as at_risk_count
      `,
      // Portfolio counts by stage (Zone 1 chips)
      db`
        select
          count(*)::int                                                                        as total,
          count(*) filter (where stage = 'aktif')::int                                        as aktif,
          count(*) filter (where stage = 'perlu_followup')::int                               as perlu_followup,
          count(*) filter (where stage = 'at_risk')::int                                      as at_risk,
          count(*) filter (where account_type = 'project'
                                and stage not in ('won','gugur'))::int                         as project_active,
          count(*) filter (where stage = 'hibernasi')::int                                    as hibernasi,
          count(*) filter (where stage = 'won')::int                                          as won_total
        from customers
        where owner_id = ${rep_id}
      `,
      // Won this month (stage transitions)
      db`
        select count(*)::int as won_this_month
        from stage_history sh
        join customers c on c.id = sh.account_id
        where sh.new_stage = 'won'
          and c.owner_id = ${rep_id}
          and sh.changed_at >= date_trunc('month', now())
      `,
      // Resolved escalations not yet acknowledged by the rep
      db`
        select id, store_name, category, area, address, notes,
               resolved_contact_name, resolved_contact_phone, resolved_notes,
               resolved_by, resolved_at
        from escalations
        where salesperson_id = ${rep_id}
          and status = 'resolved'
          and followed_up_at is null
        order by resolved_at desc
        limit 20
      `,
      // Visits logged today by this rep (for "Kunjungan Hari Ini" feed)
      db`
        select v.id, v.store_name, v.category, v.area, v.pic_name,
               v.notes, v.activity_type, v.visited_at, v.customer_id,
               c.stage, c.account_type
        from visits v
        left join customers c on c.id = v.customer_id
        where v.salesperson_id = ${rep_id}
          and v.visited_at >= ${todayStartUTC}
          and v.visited_at <  ${todayEndUTC}
        order by v.visited_at desc
        limit 50
      `,
    ]);

    const pc = portfolioRows[0] ?? {};
    return {
      overdue,
      today,
      upcoming,
      at_risk: atRisk,
      stats:   stats[0] ?? { today_visits: 0, overdue_count: 0, at_risk_count: 0 },
      portfolio_counts: {
        total:          pc.total          ?? 0,
        aktif:          pc.aktif          ?? 0,
        perlu_followup: pc.perlu_followup ?? 0,
        at_risk:        pc.at_risk        ?? 0,
        project_active: pc.project_active ?? 0,
        won_this_month: wonRows[0]?.won_this_month ?? 0,
        won_total:      pc.won_total      ?? 0,
        hibernasi:      pc.hibernasi      ?? 0,
      },
      resolved_escalations: resolvedEscalations,
      today_visits:         todayVisits,
    };
  });
}

/**
 * Background cadence engine: advances repeating account stages based on
 * last_contact_at. Runs once on startup then every hour.
 * Aktif → perlu_followup after 14d, perlu_followup → at_risk after 28d.
 * Never auto-advances hibernasi.
 */
export async function startCadenceEngine(): Promise<void> {
  const db = getSql();
  if (!db) return;

  async function tick(): Promise<void> {
    const sql = getSql();
    if (!sql) return;
    try {
      const now14 = new Date(Date.now() - 14 * 24 * 3600 * 1000);
      const now28 = new Date(Date.now() - 28 * 24 * 3600 * 1000);

      // aktif → perlu_followup
      const toFollowup = await sql<{ id: number }[]>`
        update customers
        set stage = 'perlu_followup'
        where account_type = 'repeating'
          and stage = 'aktif'
          and (last_contact_at is null or last_contact_at < ${now14})
        returning id
      `;

      // perlu_followup → at_risk
      const toAtRisk = await sql<{ id: number }[]>`
        update customers
        set stage = 'at_risk'
        where account_type = 'repeating'
          and stage = 'perlu_followup'
          and (last_contact_at is null or last_contact_at < ${now28})
        returning id
      `;

      if (toFollowup.length > 0 || toAtRisk.length > 0) {
        for (const r of toFollowup) {
          await sql`insert into stage_history (account_id, old_stage, new_stage, changed_by) values (${r.id}, 'aktif', 'perlu_followup', null)`;
        }
        for (const r of toAtRisk) {
          await sql`insert into stage_history (account_id, old_stage, new_stage, changed_by) values (${r.id}, 'perlu_followup', 'at_risk', null)`;
        }
        console.info(`[cadence] advanced ${toFollowup.length} → perlu_followup, ${toAtRisk.length} → at_risk`);
      }
    } catch (err) {
      console.error("[cadence] tick error:", err);
    }
  }

  // Run once on boot, then every hour.
  void tick();
  setInterval(() => void tick(), 60 * 60 * 1000);
}
