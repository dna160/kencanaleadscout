/**
 * Kabar Pesanan — the Pengiriman tab (PRD §20).
 *
 * GET  /api/notify/dispatch?date=YYYY-MM-DD   deliveries for that WIB day (default today)
 * POST /api/notify/dispatch/mark              {doIds[], action: delayed, date?}            [token]
 * POST /api/notify/dispatch/undo              {doId}                                       [token]
 * POST /api/notify/holds/:id/keep            "Tetap sesuai jadwal": close a reschedule request [token]
 * PUT  /api/notify/dispatch/settings          partial: reminder, departure source, contacts, reply agent [token]
 *
 * Writes record who acted from `x-notify-actor` (the name typed on /notify).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { normalizeNumber } from "@kencana/core";
import { config } from "../config.js";
import { getSql } from "../db/client.js";
import { DispatchError, keepSchedule, listDispatch, markDispatch, undoDispatch } from "../notify/dispatch.js";
import { wibDate } from "../notify/rules.js";

function authorized(req: FastifyRequest, reply: FastifyReply): boolean {
  const required = config.notify.adminToken;
  if (!required) return true;
  if (req.headers["x-notify-token"] === required) return true;
  void reply.code(401).send({ error: "Token admin Kabar Pesanan salah atau belum diisi." });
  return false;
}

function actor(req: FastifyRequest): string {
  const a = req.headers["x-notify-actor"];
  return typeof a === "string" && a.trim() ? a.trim().slice(0, 60) : "admin";
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export async function notifyDispatchRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/notify/dispatch", async (req, reply) => {
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const today = wibDate(new Date());
    const q = (req.query as { date?: string }).date;
    const date = typeof q === "string" && ISO.test(q) ? q : today;
    const [rows, settings] = await Promise.all([listDispatch(db, date), readSettings(db)]);
    return {
      date,
      today,
      mode: config.notify.live,
      // `remind` kept for the page's older readers.
      remind: { hour: settings.remindHour, numbers: settings.remindNumbers, remindedOn: settings.remindedOn },
      settings,
      rows,
    };
  });

  app.post("/api/notify/dispatch/mark", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const body = (req.body ?? {}) as { doIds?: unknown; action?: unknown; date?: unknown };
    const ids = Array.isArray(body.doIds) ? body.doIds.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
    if (!ids.length || ids.length > 200) return reply.code(400).send({ error: "Pilih 1–200 surat jalan." });
    if (body.action === "departed") {
      // PRD §21.3: "sedang dikirim" now comes from XTable (vehicle / driver on the DO).
      return reply.code(400).send({ error: "Tanda Berangkat sudah tidak dipakai: isi No. kendaraan / sopir pada DO di XTable." });
    }
    if (body.action !== "delayed") return reply.code(400).send({ error: "action harus delayed." });
    const date = body.date == null || body.date === "" ? null : body.date;
    if (date !== null && (typeof date !== "string" || !ISO.test(date))) {
      return reply.code(400).send({ error: "Tanggal baru harus berformat YYYY-MM-DD." });
    }
    const by = actor(req);
    const now = new Date();
    const results = [];
    for (const doId of [...new Set(ids)]) {
      try {
        const r = await markDispatch(db, {
          doId,
          action: "rescheduled",
          toDate: date as string | null,
          source: "staff",
          by,
          now,
        });
        results.push({ ...r, ok: true });
      } catch (err) {
        if (!(err instanceof DispatchError)) throw err;
        results.push({ doId, ok: false, error: err.message });
      }
    }
    req.log.info({ actor: by, action: body.action, date, n: ids.length, ok: results.filter((r) => r.ok).length }, "dispatch marked");
    return { results };
  });

  app.post("/api/notify/dispatch/undo", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const doId = (req.body as { doId?: unknown } | null)?.doId;
    if (typeof doId !== "string" || !doId) return reply.code(400).send({ error: "doId wajib diisi." });
    try {
      const r = await undoDispatch(db, doId, actor(req));
      req.log.info({ actor: actor(req), doId }, "dispatch mark undone");
      return { ok: true, ...r };
    } catch (err) {
      if (err instanceof DispatchError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post("/api/notify/holds/:id/keep", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const id = (req.params as { id: string }).id;
    if (!/^\d+$/.test(id)) return reply.code(400).send({ error: "id tidak valid." });
    try {
      await keepSchedule(db, id, actor(req));
      req.log.info({ actor: actor(req), holdId: id }, "reschedule request kept");
      return { ok: true };
    } catch (err) {
      if (err instanceof DispatchError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  /**
   * Konfigurasi for delivery and replies (PRD §20, §21.3, §21.4). Partial:
   * only the fields sent are changed. Numbers are normalized to E.164; an
   * empty string clears a single number.
   */
  app.put("/api/notify/dispatch/settings", async (req, reply) => {
    if (!authorized(req, reply)) return;
    const db = getSql();
    if (!db) return reply.code(503).send({ error: "Database tidak tersedia." });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const set: Record<string, unknown> = {};
    const hourField = (key: string, col: string, min: number) => {
      if (b[key] === undefined) return null;
      const h = Number(b[key]);
      if (!Number.isInteger(h) || h < min || h > 23) return `${key} harus ${min}–23.`;
      set[col] = h;
      return null;
    };
    const boolField = (key: string, col: string) => {
      if (b[key] === undefined) return null;
      if (typeof b[key] !== "boolean") return `${key} harus true/false.`;
      set[col] = b[key];
      return null;
    };
    const oneNumber = (key: string, col: string) => {
      if (b[key] === undefined) return null;
      const raw = typeof b[key] === "string" ? (b[key] as string).trim() : "";
      if (!raw) {
        set[col] = null;
        return null;
      }
      const e = normalizeNumber(raw);
      if (!e) return `${raw} bukan nomor HP Indonesia yang valid.`;
      set[col] = e;
      return null;
    };
    const errors = [
      hourField("remindHour", "dispatch_remind_hour", -1),
      hourField("morningHour", "morning_notice_hour", 5),
      boolField("departFromXtable", "depart_from_xtable"),
      boolField("morningNotice", "depart_morning_notice"),
      boolField("replyAgent", "reply_agent"),
      oneNumber("salesAdminNumber", "sales_admin_number"),
      oneNumber("warehouseNumber", "warehouse_number"),
      oneNumber("escalationNumber", "escalation_number"),
    ].filter(Boolean);
    if (b["replyDebounceS"] !== undefined) {
      const d = Number(b["replyDebounceS"]);
      if (!Number.isInteger(d) || d < 0 || d > 900) errors.push("replyDebounceS harus 0–900 detik.");
      else set["reply_debounce_s"] = d;
    }
    if (b["remindNumbers"] !== undefined) {
      const raw = Array.isArray(b["remindNumbers"]) ? b["remindNumbers"] : [];
      const numbers: string[] = [];
      for (const n of raw) {
        if (typeof n !== "string" || !n.trim()) continue;
        const e = normalizeNumber(n.trim());
        if (!e) errors.push(`${n} bukan nomor HP Indonesia yang valid.`);
        else if (!numbers.includes(e)) numbers.push(e);
      }
      if (numbers.length > 10) errors.push("Paling banyak 10 nomor.");
      set["dispatch_remind_numbers"] = numbers;
    }
    if (errors.length) return reply.code(400).send({ error: errors[0] });
    if (Object.keys(set).length) {
      await db`update notify_settings set ${db(set)}, updated_at = now() where id = 1`;
    }
    req.log.info({ actor: actor(req), fields: Object.keys(set) }, "notify delivery/reply settings changed");
    return { settings: await readSettings(db) };
  });
}

export interface DeliverySettings {
  remindHour: number;
  remindNumbers: string[];
  remindedOn: string | null;
  departFromXtable: boolean;
  morningNotice: boolean;
  morningHour: number;
  salesAdminNumber: string | null;
  warehouseNumber: string | null;
  escalationNumber: string | null;
  replyAgent: boolean;
  replyDebounceS: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export async function readSettings(db: any): Promise<DeliverySettings> {
  const [s] = await db`
    select dispatch_remind_hour, dispatch_remind_numbers, to_char(dispatch_reminded_on, 'YYYY-MM-DD') as reminded_on,
           depart_from_xtable, depart_morning_notice, morning_notice_hour,
           sales_admin_number, warehouse_number, escalation_number, reply_agent, reply_debounce_s
      from notify_settings where id = 1`;
  return {
    remindHour: s?.dispatch_remind_hour ?? 13,
    remindNumbers: s?.dispatch_remind_numbers ?? [],
    remindedOn: s?.reminded_on ?? null,
    departFromXtable: s?.depart_from_xtable ?? true,
    morningNotice: s?.depart_morning_notice ?? true,
    morningHour: s?.morning_notice_hour ?? 8,
    salesAdminNumber: s?.sales_admin_number ?? null,
    warehouseNumber: s?.warehouse_number ?? null,
    escalationNumber: s?.escalation_number ?? null,
    replyAgent: s?.reply_agent ?? true,
    replyDebounceS: s?.reply_debounce_s ?? 90,
  };
}
