/**
 * Escalation routes — leads the rep cannot visit; sourced by eskalasi team.
 *
 * POST  /api/escalations              — create escalation
 * GET   /api/escalations              — list (?status=pending|resolved, ?rep_id=)
 * PATCH /api/escalations/:id/resolve  — mark resolved with contact info
 * PATCH /api/escalations/:id/followup — rep acknowledges, removes from My Day
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

export async function escalationsRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: Record<string, unknown> }>("/api/escalations", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const b = request.body ?? {};
    const salesperson_id = b.salesperson_id ? Number(b.salesperson_id) : null;
    const store_name     = b.store_name ? String(b.store_name).trim() : "";
    const category       = b.category   ? String(b.category).trim()   : null;
    const area           = b.area       ? String(b.area).trim()       : null;
    const address        = b.address    ? String(b.address).trim()    : null;
    const notes          = b.notes      ? String(b.notes).trim()      : null;

    if (!salesperson_id || !Number.isInteger(salesperson_id) || salesperson_id < 1)
      return reply.code(400).send({ error: "salesperson_id is required." });
    if (!store_name)
      return reply.code(400).send({ error: "store_name is required." });

    const [escalation] = await db`
      insert into escalations (salesperson_id, store_name, category, area, address, notes)
      values (${salesperson_id}, ${store_name}, ${category}, ${area}, ${address}, ${notes})
      returning *
    `;
    return { ok: true, escalation };
  });

  app.get<{ Querystring: Record<string, string> }>("/api/escalations", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const q      = request.query;
    const status = q.status || null;
    const rep_id = q.rep_id ? Number(q.rep_id) : null;

    const rows = await db`
      select e.*, sp.full_name as salesperson_name, sp.code as salesperson_code
      from escalations e
      join salespeople sp on sp.id = e.salesperson_id
      where true
        ${status ? db`and e.status = ${status}` : db``}
        ${rep_id ? db`and e.salesperson_id = ${rep_id}` : db``}
      order by e.created_at desc
      limit 200
    `;
    return { count: rows.length, escalations: rows };
  });

  app.patch<{
    Params: { id: string };
    Body: Record<string, unknown>;
  }>("/api/escalations/:id/resolve", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b = request.body ?? {};
    const contact_name   = b.resolved_contact_name  ? String(b.resolved_contact_name).trim()  : null;
    const contact_phone  = b.resolved_contact_phone ? String(b.resolved_contact_phone).trim() : null;
    const resolved_notes = b.resolved_notes         ? String(b.resolved_notes).trim()         : null;
    const resolved_by    = b.resolved_by            ? String(b.resolved_by).trim()            : null;

    const [updated] = await db`
      update escalations set
        status                 = 'resolved',
        resolved_contact_name  = ${contact_name},
        resolved_contact_phone = ${contact_phone},
        resolved_notes         = ${resolved_notes},
        resolved_by            = ${resolved_by},
        resolved_at            = now()
      where id = ${id} and status = 'pending'
      returning *
    `;
    if (!updated) return reply.code(404).send({ error: "Not found or already resolved." });
    return { ok: true, escalation: updated };
  });

  app.patch<{ Params: { id: string } }>("/api/escalations/:id/followup", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const [updated] = await db`
      update escalations set followed_up_at = now()
      where id = ${id} and followed_up_at is null
      returning id
    `;
    if (!updated) return reply.code(404).send({ error: "Not found or already followed up." });
    return { ok: true };
  });
}
