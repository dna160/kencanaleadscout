/**
 * [D] Managed enum lists — categories + areas (microPRD §3, §8).
 *
 * GET    /api/lists/categories      — all active categories
 * GET    /api/lists/areas           — all active areas
 * POST   /api/lists/:listType       — Handler+: add value
 * PATCH  /api/lists/:listType/:id   — Handler+: rename or deactivate
 */
import type { FastifyInstance } from "fastify";
import { getSql } from "../db/client.js";

type ListType = "categories" | "areas";
const DB_TYPE: Record<ListType, string> = { categories: "category", areas: "area" };

export async function listsRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/lists/categories", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const rows = await db<{ id: number; value: string }[]>`
      select id, value from visit_lists
      where type = 'category' and active = true
      order by value
    `;
    return { type: "categories", values: rows.map((r) => r.value), items: rows };
  });

  app.get("/api/lists/areas", async (_request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });
    const rows = await db<{ id: number; value: string }[]>`
      select id, value from visit_lists
      where type = 'area' and active = true
      order by value
    `;
    return { type: "areas", values: rows.map((r) => r.value), items: rows };
  });

  // POST /api/lists/:listType — add a new value
  app.post<{
    Params: { listType: string };
    Body: { value?: string };
  }>("/api/lists/:listType", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const listType = request.params.listType as ListType;
    if (!(listType in DB_TYPE))
      return reply.code(400).send({ error: "listType must be 'categories' or 'areas'." });

    const value = String(request.body?.value ?? "").trim();
    if (!value) return reply.code(400).send({ error: "value is required." });

    const type = DB_TYPE[listType];
    try {
      const [saved] = await db`
        insert into visit_lists (type, value)
        values (${type}, ${value})
        on conflict (type, lower(value)) do update set active = true
        returning *
      `;
      return { ok: true, item: saved };
    } catch (err) {
      app.log.error({ err }, "list insert failed");
      return reply.code(400).send({ error: "Could not add list value." });
    }
  });

  // PATCH /api/lists/:listType/:id — rename or deactivate
  app.patch<{
    Params: { listType: string; id: string };
    Body: { value?: string; active?: boolean };
  }>("/api/lists/:listType/:id", async (request, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database not configured." });

    const listType = request.params.listType as ListType;
    if (!(listType in DB_TYPE))
      return reply.code(400).send({ error: "listType must be 'categories' or 'areas'." });

    const id = Number(request.params.id);
    if (!Number.isInteger(id) || id < 1)
      return reply.code(400).send({ error: "Invalid id." });

    const b      = request.body ?? {};
    const value  = "value"  in b ? (String(b.value ?? "").trim() || null) : null;
    const active = "active" in b ? Boolean(b.active) : undefined;
    const type   = DB_TYPE[listType];

    const [saved] = await db`
      update visit_lists set
        value  = ${value  != null ? value  : db`value`},
        active = ${active !== undefined ? active : db`active`}
      where id = ${id} and type = ${type}
      returning *
    `;
    if (!saved) return reply.code(404).send({ error: "List item not found." });
    return { ok: true, item: saved };
  });
}
