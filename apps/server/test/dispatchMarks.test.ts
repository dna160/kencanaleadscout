/**
 * Kabar Pesanan PRD §20: "barang dikirim" and "jadwal berubah" from staff
 * marks on the Pengiriman tab, Selaras sj_date edits, and the afternoon
 * reminder of unmarked deliveries.
 *
 * The renderers always run. The marks → events → outbox → "sent" path runs
 * against Postgres (skipped without DATABASE_URL) with a recording channel.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Channel, OutboundMessage, SendResult } from "../src/notify/channel.js";
import { addDaysIso, formatDateId, renderCustomerMessage, renderDispatchReminder, sampleContext } from "../src/notify/messages.js";
import { wibDate } from "../src/notify/rules.js";

describe("dispatch messages (pure)", () => {
  const ctx = sampleContext(new Date("2026-11-17T03:00:00Z"), "Rahmanto", "0813-1111-2222");
  const d = ctx.delivery!; // sjDate 2026-11-18

  it("departed: on its way, with the vehicle and driver from XTable when filled, items and the check-on-arrival line", () => {
    const t = renderCustomerMessage("delivery_departed", ctx, { departure: { vehicle: "B 9012 KCN", driver: "Pak Udin" } });
    expect(t).toContain(`Pesanan *${ctx.soNo}* sedang dalam perjalanan ke alamat Anda.`);
    expect(t).toContain(`No. surat jalan: ${d.sjNo}\nKendaraan: B 9012 KCN · Sopir: Pak Udin`);
    expect(renderCustomerMessage("delivery_departed", ctx, { departure: { vehicle: null, driver: "Pak Udin" } })).toContain("\nSopir: Pak Udin");
    expect(renderCustomerMessage("delivery_departed", ctx)).not.toMatch(/Kendaraan|Sopir/);
    expect(t).toContain("ALCOPAN GLOSSY WHITE 4mm / 0.21 × 10 lembar");
    expect(t).toContain("Mohon periksa kondisi");
    expect(t).toContain("Balas STOP");
  });

  it("08:00 notice says 'dijadwalkan dikirim hari ini', never that the truck has left", () => {
    const t = renderCustomerMessage("delivery_today", ctx);
    expect(t).toContain(`Pesanan *${ctx.soNo}* dijadwalkan dikirim hari ini.`);
    expect(t).toContain(`No. surat jalan: ${d.sjNo}`);
    expect(t).not.toMatch(/perjalanan|berangkat/);
  });

  it("changed: delayed to a new date, delayed with no date yet, and moved earlier", () => {
    const later = renderCustomerMessage("delivery_changed", ctx, { change: { from: "2026-11-18", to: "2026-11-20", told: true } });
    expect(later).toContain(`pengiriman pesanan *${ctx.soNo}* yang dijadwalkan Rabu, 18 November 2026 *tertunda*`);
    expect(later).toContain("Jadwal baru: Jumat, 20 November 2026");
    expect(later).toContain("Mohon maaf atas ketidaknyamanannya.");

    const tbd = renderCustomerMessage("delivery_changed", ctx, { change: { from: "2026-11-18", to: null, told: true } });
    expect(tbd).toContain("*tertunda*");
    expect(tbd).toContain("Jadwal pengiriman yang baru akan kami kabarkan kembali.");

    const earlier = renderCustomerMessage("delivery_changed", ctx, { change: { from: "2026-11-20", to: "2026-11-18", told: true } });
    expect(earlier).toContain("berubah menjadi lebih awal");
    expect(earlier).toContain("Jadwal sebelumnya: Jumat, 20 November 2026");
    expect(earlier).not.toContain("tertunda");
  });

  it("changed, but the customer never had a date: the full schedule instead of 'tertunda'", () => {
    const set = renderCustomerMessage("delivery_changed", ctx, { change: { from: "2026-11-18", to: "2026-11-20", told: false } });
    expect(set).toContain("sudah ditetapkan");
    expect(set).toContain("Jadwal pengiriman: Jumat, 20 November 2026");
    expect(set).not.toContain("tertunda");
    const tbd = renderCustomerMessage("delivery_changed", ctx, { change: { from: null, to: null, told: false } });
    expect(tbd).toContain("sedang kami siapkan untuk dikirim");
    expect(tbd).toContain("akan kami kabarkan kembali");
  });

  it("pickup orders talk about pengambilan, not pengiriman", () => {
    const pick = { ...ctx, delivery: { ...d, pickup: true } };
    const t = renderCustomerMessage("delivery_changed", pick, { change: { from: "2026-11-18", to: "2026-11-19", told: true } });
    expect(t).toContain("pengambilan pesanan");
    expect(t).toContain(`No. DO: ${d.sjNo}`);
  });

  it("the test pipeline (no change given) shows a one-day delay", () => {
    expect(renderCustomerMessage("delivery_changed", ctx)).toContain("Jadwal baru: Kamis, 19 November 2026");
    expect(addDaysIso("2026-11-30", 1)).toBe("2026-12-01");
  });

  it("reminder lists today's unmarked surat jalan, capped at 25 lines", () => {
    const rows = Array.from({ length: 27 }, (_, i) => ({ sjNo: `KP/DO-${i}`, soNo: `SO.${i}`, customer: "TOKO" }));
    const t = renderDispatchReminder("2026-11-17", rows, false);
    expect(t).toContain("belum tercatat berangkat");
    expect(t).toContain("No. kendaraan / sopir belum diisi di XTable");
    expect(t).toContain("Selasa, 17 November 2026");
    expect(t).toContain("• KP/DO-0 — SO.0 — TOKO");
    expect(t).toContain("• dan 2 lainnya");
    expect(renderDispatchReminder("2026-11-17", rows.slice(0, 1), true).startsWith("[SHADOW]")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp20disp";

class RecordingChannel implements Channel {
  readonly mode = "stub" as const;
  sent: OutboundMessage[] = [];
  async send(m: OutboundMessage): Promise<SendResult> {
    this.sent.push(m);
    return { status: "sent", providerMessageId: `p-${this.sent.length}`, error: null };
  }
  async sendContact(c: { to: string; name: string; phone: string; idempotencyKey: string }): Promise<SendResult> {
    this.sent.push({ to: c.to, text: `[KARTU] ${c.name} ${c.phone}`, idempotencyKey: c.idempotencyKey });
    return { status: "sent", providerMessageId: `p-${this.sent.length}`, error: null };
  }
  async health() {
    return { connected: true, detail: "" };
  }
}

describe.skipIf(!hasDb)("dispatch marks over the real schema", async () => {
  const dbmod = await import("../src/db/client.js");
  const store = await import("../src/events/store.js");
  const lane = await import("../src/erp/orderSync.js");
  const disp = await import("../src/notify/dispatcher.js");
  const marks = await import("../src/notify/dispatch.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runEventMigrations } = await import("../src/db/migrateEvents.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");
  const { lockNotifySettings } = await import("./helpers/settingsLock.js");
  let unlock: () => Promise<void> = async () => undefined;

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let ch: RecordingChannel;
  const REP = "+6281377700020";
  const ADMIN = "+6281377700021";
  const today = () => wibDate(new Date());
  const plus = (n: number) => addDaysIso(today(), n);

  const deps = (over: Partial<Parameters<typeof disp.defaultDispatchDeps>[0]> = {}) =>
    disp.defaultDispatchDeps({
      db,
      channel: ch,
      mode: "on",
      holds: {},
      fromHour: 0,
      untilHour: 24,
      dailyCap: 10,
      maxEventAgeHours: 24,
      batch: 1000,
      reminders: false,
      pauseReason: async () => null,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...over,
    })!;

  async function cleanup(): Promise<void> {
    await db`delete from notify_ledger where so_no like ${`${P}%`} or to_number in (${REP}, ${ADMIN})`;
    await db`delete from notify_dispatch_marks where do_id like ${`${P}%`}`;
    await db`delete from notify_dispatch where do_id like ${`${P}%`}`;
    await db`delete from notify_do_holds where do_id like ${`${P}%`}`;
    await db`delete from order_events where so_no like ${`${P}%`}`;
    await db`delete from erp_so_line where id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`delete from erp_do_header where id like ${`${P}%`}`;
    await db`delete from erp_sales where id like ${`${P}%`}`;
    await db`delete from notify_sales_contacts where erp_sales_id like ${`${P}%`}`;
    await db`delete from notify_contacts where phone_e164 like '+6281292%'`;
    await db`
      update notify_settings set live_mode = null, kill_switch = false, milestones_enabled = '{}'::jsonb,
             dispatch_remind_hour = 13, dispatch_remind_numbers = '{}', dispatch_reminded_on = null,
             depart_from_xtable = true, depart_morning_notice = true, morning_notice_hour = 8, morning_noticed_on = null,
             sales_admin_number = null, warehouse_number = null
       where id = 1`;
  }

  /** SO + DO in the mirror; the DO is due `sj` (YYYY-MM-DD). Returns ids. */
  async function seed(tag: string, sj: string, o: { pickup?: boolean } = {}): Promise<{ so: string; doId: string; phone: string; sjNo: string }> {
    const so = `${P}/${tag}`;
    const phone = `081292${String(Math.floor(Math.random() * 1e6)).padStart(6, "0")}`;
    await db`
      insert into erp_so_header (id, po_no, so_number, customer_name_id, customer_final_id, customer_name_text,
                                 sales_name_id, sales_name_text, penerima, kontak_penerima, alamat_kirim, status_order, erp_created_at)
      values (${`${P}-h-${tag}`}, ${so}, ${so}, ${`${P}-c-${tag}`}, ${`${P}-c-${tag}`}, ${"TOKO UJI KIRIM"},
              ${`${P}-rep`}, ${"Free Antony"}, ${"Bp. Panji"}, ${phone}, ${"Jl. Contoh 1"}, ${"Wating"}, now() + interval '7 hours')
    `;
    await db`
      insert into erp_so_line (id, po_no, brand_text, warna_text, th, th_panel, qty_order, qty_balance, approval, sku_key)
      values (${`${P}-l-${tag}`}, ${so}, ${"ALCOPAN"}, ${"PURE WHITE"}, ${0.21}, ${4}, ${10}, ${10}, ${"Approved"}, ${`${P}|k`})
    `;
    const doId = `${P}-d-${tag}`;
    const sjNo = `KP/DO-${P}-${tag}`;
    await db`
      insert into erp_do_header (id, so_no, no_sj, sj_date, cara_kirim, cancel_order, do_created_at, erp_updated_at)
      values (${doId}, ${so}, ${sjNo}, ${sj}::date, ${o.pickup ? "di Ambil" : "di Antar"}, ${"No"}, now() + interval '7 hours', now())
    `;
    await store.deriveForTouched(db, { ...lane.emptyTouched(), do_header: [doId] });
    return { so, doId, phone: `+62${phone.slice(1)}`, sjNo };
  }
  const mark = (doId: string, action: "rescheduled", toDate: string | null = null, now = new Date()) =>
    marks.markDispatch(db, { doId, action, toDate, source: "staff", by: "Tester", now });
  /** The warehouse fills the DO in XTable as the truck leaves; the lane re-reads it (WIB digits as UTC). */
  async function depart(doId: string, f: { vehicle?: string | null; driver?: string | null; daysLate?: number } = {}): Promise<void> {
    await db`
      update erp_do_header set no_kendaraan = ${f.vehicle === undefined ? "B 9012 KCN" : f.vehicle},
             driver = ${f.driver === undefined ? "Pak Udin" : f.driver},
             erp_updated_at = now() + interval '7 hours' + make_interval(days => ${f.daysLate ?? 0}), synced_at = now()
       where id = ${doId}`;
    await store.deriveForTouched(db, { ...lane.emptyTouched(), do_header: [doId] });
  }
  const ledger = async (so: string) =>
    db<{ milestone: string; recipient_role: string; status: string; cancel_reason: string | null; body: string | null }[]>`
      select milestone, recipient_role, status, cancel_reason, body from notify_ledger where so_no = ${so} order by id`;
  // Delivery messages only: each DO also confirms its SO first (PRD §21.1 b), to
  // the customer and (as a CC) to the rep; those are covered in dispatcher.test.ts.
  const sentTo = (n: string) => ch.sent.filter((m) => m.to === n && !m.text.includes("sudah kami konfirmasi"));

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    unlock = await lockNotifySettings();
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runEventMigrations(db);
    await runNotifyMigrations(db);
    await db`update order_event_state set confirmed_since = '2000-01-01' where id = 1`;
  }, 120_000);
  beforeEach(async () => {
    await cleanup();
    ch = new RecordingChannel();
    await db`insert into erp_sales (id, sales_name, active) values (${`${P}-rep`}, ${"Free Antony"}, ${"Yes"})`;
    await db`insert into notify_sales_contacts (erp_sales_id, phone_e164) values (${`${P}-rep`}, ${REP})`;
    await disp.syncMode(db, "on", new Date());
  });
  afterAll(async () => {
    await cleanup();
    await unlock();
    await dbmod.closeDatabase();
  });

  it("vehicle / driver filled in XTable on the day: 'sedang dikirim' with them, no rep CC; a re-edit never resends", async () => {
    const o = await seed("dep1", today());
    await disp.dispatchOnce(deps()); // step 1 · dijadwalkan (customer + CC)
    expect(sentTo(o.phone)).toHaveLength(1);
    await depart(o.doId);
    await disp.dispatchOnce(deps());
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toContain("sedang dalam perjalanan ke alamat Anda.");
    expect(msgs[1]!.text).toContain(`No. surat jalan: ${o.sjNo}\nKendaraan: B 9012 KCN · Sopir: Pak Udin`);
    expect(msgs[1]!.text).not.toContain("nomor resmi notifikasi"); // introduced once, in step 1
    expect(sentTo(REP)).toHaveLength(1); // only step 1's CC
    const rows = await ledger(o.so);
    expect(rows.filter((x) => x.milestone === "delivery_departed").map((x) => [x.recipient_role, x.status])).toEqual([["customer", "sent"]]);

    await depart(o.doId, { vehicle: "B 1111 ZZ" }); // corrected plate: same DO, no second message
    await disp.dispatchOnce(deps());
    expect(sentTo(o.phone)).toHaveLength(2);
    await expect(mark(o.doId, "rescheduled", plus(1))).rejects.toThrow(/sudah berangkat/);
    const list = await marks.listDispatch(db, today());
    expect(list.find((x) => x.do_id === o.doId)).toMatchObject({ departed_on: today(), vehicle: "B 1111 ZZ", dep_status: "sent" });
  });

  it("filled after the delivery day = backfill, recorded not sent; pickups and cancelled DOs never depart", async () => {
    const late = await seed("dep3", plus(-1));
    await depart(late.doId);
    await disp.dispatchOnce(deps());
    const row = (await ledger(late.so)).find((x) => x.milestone === "delivery_departed")!;
    expect([row.status, row.cancel_reason]).toEqual(["skipped", "backfill"]);
    expect(sentTo(late.phone).some((m) => m.text.includes("perjalanan"))).toBe(false);

    const pick = await seed("dep4", today(), { pickup: true });
    await depart(pick.doId);
    const cancelled = await seed("dep6", today());
    await db`update erp_do_header set cancel_order = 'Yes' where id = ${cancelled.doId}`;
    await depart(cancelled.doId);
    const [n] = await db<{ n: number }[]>`
      select count(*)::int as n from order_events where event_type = 'do.departed' and so_no in (${pick.so}, ${cancelled.so})`;
    expect(n!.n).toBe(0);
  });

  it("only the driver filled is enough; the XTable source can be switched off (recorded as skipped)", async () => {
    const o = await seed("dep7", today());
    await db`update notify_settings set depart_from_xtable = false where id = 1`;
    await depart(o.doId, { vehicle: null, driver: "Pak Udin" });
    await disp.dispatchOnce(deps());
    const row = (await ledger(o.so)).find((x) => x.milestone === "delivery_departed")!;
    expect([row.status, row.cancel_reason]).toEqual(["skipped", "source_off"]);
  });

  it("a departure still waiting at the end of its day is dropped, not sent tomorrow", async () => {
    const o = await seed("dep5", today());
    await disp.dispatchOnce(deps());
    await depart(o.doId);
    await disp.planEvents(deps()); // planned today, but not sent (say, the gateway was down)
    const tomorrow = new Date(Date.now() + 86_400_000);
    await disp.dispatchOnce(deps({ now: () => tomorrow }));
    const row = (await ledger(o.so)).find((x) => x.milestone === "delivery_departed")!;
    expect([row.status, row.cancel_reason]).toEqual(["cancelled", "stale_departure"]);
    expect(sentTo(o.phone)).toHaveLength(1);
  });

  it("08:00 notice: today's undeparted deliveries once; skipped at send time if departed, moved or on hold", async () => {
    const a = await seed("mn1", today());
    const b = await seed("mn2", today());
    const c = await seed("mn3", today());
    const gone = await seed("mn4", today());
    await depart(gone.doId); // left before 08:00: no morning message
    await disp.dispatchOnce(deps()); // step 1 for all, departure for `gone`
    await db`update notify_settings set morning_notice_hour = 0 where id = 1`;
    await disp.planMorningNotices(deps({ reminders: true }));
    expect(await disp.planMorningNotices(deps({ reminders: true }))).toBe(0); // once a day
    await mark(b.doId, "rescheduled", plus(1)); // moved before it went out
    await db`insert into notify_do_holds (do_id, so_no) values (${c.doId}, ${c.so})`; // reschedule request open
    await disp.dispatchOnce(deps());
    const morning = async (so: string) =>
      (await ledger(so)).filter((x) => x.milestone === "delivery_today").map((x) => [x.status, x.cancel_reason]);
    expect(await morning(a.so)).toEqual([["sent", null]]);
    expect(sentTo(a.phone).some((m) => m.text.includes("dijadwalkan dikirim hari ini"))).toBe(true);
    expect(await morning(b.so)).toEqual([["cancelled", "date_moved"]]);
    expect(await morning(c.so)).toEqual([["cancelled", "reschedule_hold"]]);
    expect(await morning(gone.so)).toEqual([]);
  });

  it("Ditunda with a new date: 'tertunda' + the new date to the customer, CC to the rep", async () => {
    const o = await seed("del1", today());
    await disp.dispatchOnce(deps());
    await mark(o.doId, "rescheduled", plus(2));
    await disp.dispatchOnce(deps());
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toContain("*tertunda*");
    expect(msgs[1]!.text).toContain("Jadwal baru:");
    const cc = sentTo(REP);
    expect(cc).toHaveLength(2);
    expect(cc[1]!.text).toContain("Jadwal berubah");

    // On the new day it is due again, and can then depart.
    const st = await marks.listDispatch(db, plus(2));
    expect(st.find((x) => x.do_id === o.doId)?.section).toBe("today");
  });

  it("only the latest mark goes out: a second delay before sending replaces the first", async () => {
    const o = await seed("del2", today());
    await disp.dispatchOnce(deps());
    await mark(o.doId, "rescheduled", plus(1));
    await mark(o.doId, "rescheduled", null);
    await disp.dispatchOnce(deps());
    const changed = (await ledger(o.so)).filter((x) => x.milestone === "delivery_changed" && x.recipient_role === "customer");
    expect(changed.map((x) => [x.status, x.cancel_reason])).toEqual([["cancelled", "superseded"], ["sent", null]]);
    expect(sentTo(o.phone)[1]!.text).toContain("akan kami kabarkan kembali");
  });

  it("a delay marked before step 3 went out replaces it with the full schedule", async () => {
    const o = await seed("del3", today());
    await disp.planEvents(deps()); // step 3 planned, not yet sent
    await mark(o.doId, "rescheduled", plus(3));
    await disp.dispatchOnce(deps());
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("sudah ditetapkan");
    expect(msgs[0]!.text).not.toContain("tertunda");
    const step3 = (await ledger(o.so)).filter((x) => x.milestone === "delivery_scheduled");
    expect(step3.every((x) => x.status === "cancelled" && x.cancel_reason === "superseded")).toBe(true);
  });

  it("undo before sending cancels the message and restores the schedule; Selaras marks cannot be undone", async () => {
    const o = await seed("und1", today());
    await disp.dispatchOnce(deps());
    await mark(o.doId, "rescheduled", plus(1));
    await disp.planEvents(deps());
    const res = await marks.undoDispatch(db, o.doId, "Tester");
    expect(res.restored).toBeNull();
    const rows = (await ledger(o.so)).filter((x) => x.milestone === "delivery_changed");
    expect(rows.every((x) => x.status === "cancelled" && x.cancel_reason === "undone")).toBe(true);
    const list = await marks.listDispatch(db, today());
    expect(list.find((x) => x.do_id === o.doId)).toMatchObject({ section: "today", eff_date: today(), last_action: null });
    await expect(marks.undoDispatch(db, o.doId, "Tester")).rejects.toThrow(/Belum ada tanda/);
  });

  it("a Selaras sj_date edit is announced; one equal to what staff already told is not", async () => {
    const o = await seed("erp1", plus(1));
    await disp.dispatchOnce(deps());
    await db`update erp_do_header set sj_date = ${plus(2)}::date where id = ${o.doId}`;
    expect(await marks.sweepErpReschedules(db, new Date())).toBeGreaterThanOrEqual(1);
    await disp.dispatchOnce(deps());
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toContain("*tertunda*");

    await mark(o.doId, "rescheduled", plus(4));
    await db`update erp_do_header set sj_date = ${plus(4)}::date where id = ${o.doId}`;
    await marks.sweepErpReschedules(db, new Date());
    const [n] = await db<{ n: number }[]>`select count(*)::int as n from notify_dispatch_marks where do_id = ${o.doId}`;
    expect(n!.n).toBe(2); // the Selaras edit + the staff delay; the matching edit added nothing
    const [m] = await db<{ source: string }[]>`
      select m.source from notify_dispatch s join notify_dispatch_marks m on m.id = s.last_mark_id where s.do_id = ${o.doId}`;
    expect(m!.source).toBe("staff");
    // The sweep is idempotent.
    await marks.sweepErpReschedules(db, new Date());
    const [n2] = await db<{ n: number }[]>`select count(*)::int as n from notify_dispatch_marks where do_id = ${o.doId}`;
    expect(n2!.n).toBe(2);
  });

  it("13:00 reminder: deliveries with no departure in XTable go to Sales Admin and the warehouse, not reps, once a day", async () => {
    const a = await seed("rem1", today());
    const b = await seed("rem2", today());
    await depart(b.doId);
    await db`
      update notify_settings set dispatch_remind_hour = 0, depart_morning_notice = false,
             sales_admin_number = ${ADMIN}, warehouse_number = ${REP} where id = 1`;
    await disp.dispatchOnce(deps({ reminders: true }));
    for (const n of [ADMIN, REP]) {
      const r = sentTo(n).filter((m) => m.text.includes("belum tercatat berangkat"));
      expect(r).toHaveLength(1);
      expect(r[0]!.text).toContain(a.sjNo);
      expect(r[0]!.text).not.toContain(b.sjNo);
    }
    // The customer is not told anything about the unmarked one.
    expect(sentTo(a.phone).every((m) => !m.text.includes("tertunda") && !m.text.includes("perjalanan"))).toBe(true);
    await disp.dispatchOnce(deps({ reminders: true }));
    expect(sentTo(ADMIN).filter((m) => m.text.includes("belum tercatat berangkat"))).toHaveLength(1);
  });
  // ── PRD §21.5: reschedule requests ──────────────────────────────────────────
  const openHold = (o: { doId: string; so: string }, requested: string | null = null) =>
    db`insert into notify_do_holds (do_id, so_no, requested_date) values (${o.doId}, ${o.so}, ${requested}::date)`;
  const holdOf = async (doId: string) =>
    (await db<{ resolution: string | null; open: boolean }[]>`
      select resolution, resolved_at is null as open from notify_do_holds where do_id = ${doId} order by id desc limit 1`)[0];

  it("an open request holds the unsent step-1 message; Tunda answers it with the full schedule and closes the hold", async () => {
    const o = await seed("h1", plus(1));
    await openHold(o, plus(3));
    await disp.dispatchOnce(deps());
    expect(sentTo(o.phone)).toEqual([]);
    const [mv3] = await db<{ status: string; meta: Record<string, unknown> }[]>`
      select status, meta from notify_ledger where so_no = ${o.so} and milestone = 'delivery_scheduled' and recipient_role = 'customer'`;
    expect([mv3!.status, mv3!.meta["deferred"]]).toEqual(["pending", "reschedule_hold"]);
    await mark(o.doId, "rescheduled", plus(3));
    expect(await holdOf(o.doId)).toEqual({ resolution: "tunda", open: false });
    await disp.dispatchOnce(deps({ now: () => new Date(Date.now() + 16 * 60_000) }));
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain("sudah ditetapkan");
    expect(msgs[0]!.text).toContain(`Jadwal pengiriman: ${formatDateId(plus(3))}`);
  });

  it("an XTable sj_date edit closes the request; 'Tetap sesuai jadwal' closes it with nothing sent; a cancelled DO closes it", async () => {
    const a = await seed("h2", plus(1));
    await disp.dispatchOnce(deps());
    await openHold(a);
    await db`update erp_do_header set sj_date = ${plus(4)}::date where id = ${a.doId}`;
    await marks.sweepErpReschedules(db, new Date());
    expect(await holdOf(a.doId)).toEqual({ resolution: "sj_date_changed", open: false });

    const b = await seed("h3", plus(1));
    await openHold(b);
    const [h] = await db<{ id: string }[]>`select id::text from notify_do_holds where do_id = ${b.doId}`;
    const before = ch.sent.length;
    await marks.keepSchedule(db, h!.id, "Tester");
    expect(await holdOf(b.doId)).toEqual({ resolution: "kept", open: false });
    await expect(marks.keepSchedule(db, h!.id, "Tester")).rejects.toThrow(/sudah ditutup/);
    expect(ch.sent.length).toBe(before);

    const c = await seed("h4", plus(1));
    await openHold(c);
    await db`update erp_do_header set cancel_order = 'Yes' where id = ${c.doId}`;
    await marks.sweepErpReschedules(db, new Date());
    expect(await holdOf(c.doId)).toEqual({ resolution: "do_cancelled", open: false });
  });

  it("a departure is never held: the plate filled in XTable is told even with a request open", async () => {
    const o = await seed("h5", today());
    await disp.dispatchOnce(deps());
    await openHold(o, plus(2));
    await depart(o.doId);
    await disp.dispatchOnce(deps());
    expect(sentTo(o.phone).some((m) => m.text.includes("sedang dalam perjalanan"))).toBe(true);
  });

  it("16:00 the day before: the rep and Sales Admin are reminded once; not before", async () => {
    await db`update notify_settings set dispatch_remind_hour = -1, depart_morning_notice = false, sales_admin_number = ${ADMIN} where id = 1`;
    const o = await seed("h6", plus(2));
    await openHold(o, plus(5));
    const at = (iso: string) => () => new Date(iso);
    const dayBefore = plus(1);
    await disp.dispatchOnce(deps({ reminders: true, now: at(`${dayBefore}T08:59:00Z`) })); // 15:59 WIB
    expect(sentTo(ADMIN)).toEqual([]);
    await disp.dispatchOnce(deps({ reminders: true, now: at(`${dayBefore}T09:01:00Z`) })); // 16:01 WIB
    for (const n of [ADMIN, REP]) {
      const r = sentTo(n).filter((m) => m.text.includes("Permintaan ubah jadwal"));
      expect(r).toHaveLength(1);
      expect(r[0]!.text).toContain(`DO KP/DO-${P}-h6 belum ditindaklanjuti`);
      expect(r[0]!.text).toContain(`diminta: ${formatDateId(plus(5))}`);
    }
    await disp.dispatchOnce(deps({ reminders: true, now: at(`${dayBefore}T10:00:00Z`) }));
    expect(sentTo(ADMIN).filter((m) => m.text.includes("Permintaan ubah jadwal"))).toHaveLength(1);
  });

  it("a DO cancelled and re-issued within 7 days: the new DO says the schedule changed, not a fresh 'dijadwalkan'", async () => {
    const o = await seed("h7", plus(1));
    await disp.dispatchOnce(deps());
    expect(sentTo(o.phone)[0]!.text).toContain("telah dijadwalkan untuk dikirim");
    await db`update erp_do_header set cancel_order = 'Yes', erp_updated_at = now() + interval '7 hours' where id = ${o.doId}`;
    await store.deriveForTouched(db, { ...lane.emptyTouched(), do_header: [o.doId] });
    const newDo = `${P}-d-h7b`;
    await db`
      insert into erp_do_header (id, so_no, no_sj, sj_date, cara_kirim, cancel_order, do_created_at, erp_updated_at)
      values (${newDo}, ${o.so}, ${`KP/DO-${P}-h7b`}, ${plus(3)}::date, ${"di Antar"}, ${"No"}, now() + interval '7 hours', now())`;
    await store.deriveForTouched(db, { ...lane.emptyTouched(), do_header: [newDo] });
    await disp.dispatchOnce(deps());
    const msgs = sentTo(o.phone);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.text).toContain(`yang dijadwalkan ${formatDateId(plus(1))} *tertunda*`);
    expect(msgs[1]!.text).toContain(`No. surat jalan: KP/DO-${P}-h7b\nJadwal baru: ${formatDateId(plus(3))}`);
  });
});
