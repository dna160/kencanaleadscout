/**
 * Kabar Pesanan WP-6: the admin API behind the /notify tabs.
 * Needs DATABASE_URL (skips without it). Takes the notify_settings lock so it
 * never flips a switch while dispatcher.test.ts is dispatching.
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["NOTIFY_ADMIN_TOKEN"] = "admin-token-wp6";

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp6adm";
const TOKEN = { "x-notify-token": "admin-token-wp6", "x-notify-actor": "Rina (Sales Admin)" };

describe.skipIf(!hasDb)("notify admin API", async () => {
  const dbmod = await import("../src/db/client.js");
  const routes = await import("../src/routes/notify-admin.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");
  const { lockNotifySettings } = await import("./helpers/settingsLock.js");

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let unlock: () => Promise<void> = async () => undefined;
  const app = Fastify();

  async function cleanup(): Promise<void> {
    await db`delete from notify_ledger where idempotency_key like ${`${P}:%`}`;
    await db`delete from notify_customer_overrides where customer_name_id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`update notify_settings set kill_switch = false, milestones_enabled = '{}'::jsonb, switches_set_by = null where id = 1`;
  }
  async function row(o: { status: string; mode?: string; role?: string; meta?: object }): Promise<string> {
    const role = o.role ?? "customer";
    const key = `${P}:${Math.random()}:${role}`;
    const [r] = await db<{ id: string }[]>`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status,
                                 idempotency_key, due_at, sent_at, meta)
      values (${o.mode ?? "live"}, 'so_received', ${`${P}/SO-1`}, ${role}, '+6281399000001', 'Halo', 'stub', ${o.status},
              ${key}, now() + interval '10 minutes', ${o.status === "sent" ? new Date() : null}, ${db.json(o.meta ?? {})})
      returning id::text`;
    return r!.id;
  }
  const act = (id: string, body: object, headers: Record<string, string> = TOKEN) =>
    app.inject({ method: "POST", url: `/api/notify/outbox/${id}/action`, headers, payload: body });

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    unlock = await lockNotifySettings();
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runNotifyMigrations(db);
    await app.register(routes.notifyAdminRoutes);
  }, 120_000);
  beforeEach(cleanup);
  afterAll(async () => {
    await cleanup();
    await unlock();
    await dbmod.closeDatabase();
  });

  it("switches need the token, record who changed them, and show on GET /live", async () => {
    expect((await app.inject({ method: "PUT", url: "/api/notify/live", payload: { killSwitch: true } })).statusCode).toBe(401);
    const put = await app.inject({
      method: "PUT", url: "/api/notify/live", headers: TOKEN,
      payload: { killSwitch: true, milestones: { production_started: false, bogus: false } },
    });
    expect(put.statusCode).toBe(200);
    const live = (await app.inject({ method: "GET", url: "/api/notify/live" })).json();
    expect(live.killSwitch).toBe(true);
    expect(live.switchesSetBy).toContain("Rina (Sales Admin)");
    expect(live.milestones).toEqual([
      { key: "so_received", enabled: true },
      { key: "production_started", enabled: false },
      { key: "delivery_scheduled", enabled: true },
    ]);
    expect(live).toHaveProperty("channel.mode");
    expect(live).toHaveProperty("lane.enabled");
  });

  it("outbox views and actions: send now, release a held row (and its CC), cancel, grade", async () => {
    const pending = await row({ status: "pending" });
    const held = await row({ status: "held" });
    const heldCc = await db<{ id: string }[]>`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, channel, status, idempotency_key)
      select mode, milestone, so_no, 'sales_cc', channel, 'held', replace(idempotency_key, ':customer', ':sales_cc')
        from notify_ledger where id = ${held} returning id::text`;
    const shadow = await row({ status: "sent", mode: "shadow" });

    const views = async (v: string) =>
      (await app.inject({ method: "GET", url: `/api/notify/outbox?view=${v}` })).json().rows.map((r: { id: string }) => r.id);
    expect(await views("pending")).toContain(pending);
    expect(await views("held")).toContain(held);
    expect((await app.inject({ method: "GET", url: "/api/notify/outbox?view=nope" })).statusCode).toBe(400);

    expect((await act(pending, { action: "send_now" }, {})).statusCode).toBe(401);
    expect((await act(pending, { action: "send_now" })).statusCode).toBe(200);
    const [p] = await db<{ due_at: Date; meta: Record<string, unknown> }[]>`select due_at, meta from notify_ledger where id = ${pending}`;
    expect(p!.due_at.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    expect(p!.meta["sendNowBy"]).toBe("Rina (Sales Admin)");

    expect((await act(held, { action: "release" })).statusCode).toBe(200);
    const [h] = await db<{ status: string; meta: Record<string, unknown> }[]>`select status, meta from notify_ledger where id = ${held}`;
    expect(h).toMatchObject({ status: "pending", meta: { released: true } });
    const [hc] = await db<{ status: string }[]>`select status from notify_ledger where id = ${heldCc[0]!.id}`;
    expect(hc!.status).toBe("pending");
    // Releasing twice is a conflict, not a silent success.
    expect((await act(held, { action: "release" })).statusCode).toBe(409);

    expect((await act(pending, { action: "cancel" })).statusCode).toBe(200);
    const [c] = await db<{ status: string; cancel_reason: string }[]>`select status, cancel_reason from notify_ledger where id = ${pending}`;
    expect(c).toEqual({ status: "cancelled", cancel_reason: "admin_cancel" });

    expect((await act(shadow, { action: "grade", verdict: "maybe" })).statusCode).toBe(400);
    expect((await act(shadow, { action: "grade", verdict: "salah", note: "tanggal keliru" })).statusCode).toBe(200);
    const sh = (await app.inject({ method: "GET", url: "/api/notify/shadow?days=1" })).json();
    const mine = sh.rows.find((r: { id: string }) => r.id === shadow);
    expect(mine.meta.grade).toMatchObject({ verdict: "salah", note: "tanggal keliru", by: "Rina (Sales Admin)" });
    expect(sh.summary.salah).toBeGreaterThanOrEqual(1);
    expect(sh.summary.gate).toBe(99);
  });

  it("customer search, override with a replacement number, mute, and removal", async () => {
    await db`
      insert into erp_so_header (id, po_no, customer_name_id, customer_name_text, po_date)
      values (${`${P}-h1`}, ${`${P}/SO-1`}, ${`${P}-c1`}, ${"FITRAH JAYA WP6"}, current_date)`;
    const found = (await app.inject({ method: "GET", url: "/api/notify/customers?q=jaya wp6" })).json().rows;
    expect(found).toEqual([expect.objectContaining({ customer_name_id: `${P}-c1`, customer: "FITRAH JAYA WP6", sos: 1 })]);

    const bad = await app.inject({ method: "PUT", url: `/api/notify/overrides/${P}-c1`, headers: TOKEN, payload: { phone: "021-555" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({
      method: "PUT", url: `/api/notify/overrides/${P}-c1`, headers: TOKEN,
      payload: { phone: "0813-9900-0002", muted: true, reason: "minta lewat email saja" },
    });
    expect(ok.json()).toEqual({ ok: true, phone: "+6281399000002" });
    const list = (await app.inject({ method: "GET", url: "/api/notify/overrides" })).json().rows;
    expect(list.find((r: { customer_name_id: string }) => r.customer_name_id === `${P}-c1`)).toMatchObject({
      customer: "FITRAH JAYA WP6", muted: true, phone_e164: "+6281399000002", set_by: "Rina (Sales Admin)",
    });
    await app.inject({ method: "PUT", url: `/api/notify/overrides/${P}-c1`, headers: TOKEN, payload: { remove: true } });
    expect((await db`select 1 from notify_customer_overrides where customer_name_id = ${`${P}-c1`}`).length).toBe(0);
  });

  it("the pairing QR needs the token and a gateway channel", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notify/gateway/pair-svg" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/notify/gateway/pair-svg", headers: TOKEN })).statusCode).toBe(409);
  });
});
