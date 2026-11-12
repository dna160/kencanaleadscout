/**
 * Kabar Pesanan WP-4: notification rules, planner and dispatcher.
 *
 * Pure rules always run. The planner/dispatcher run end to end against
 * Postgres (skipped without DATABASE_URL) with a recording channel: mirror rows
 * → order events (WP-3) → outbox → "sent".
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Channel, OutboundMessage, SendResult } from "../src/notify/channel.js";
import { renderCustomerMessage, renderShadow, sampleContext } from "../src/notify/messages.js";
import {
  erpAgeHours,
  isDirectShip,
  isExcludedCustomer,
  maskE164,
  nextSendWindow,
  outboxKey,
  parseRecipientPhones,
  resolveRecipient,
  wibDayStart,
} from "../src/notify/rules.js";

describe("notification rules (pure)", () => {
  it("parses one or several mobiles from kontak_penerima, dropping landlines and junk", () => {
    expect(parseRecipientPhones("0812-8311-4455")).toEqual(["+6281283114455"]);
    expect(parseRecipientPhones("0812-8311-4455 / 0813-0000-1111")).toEqual(["+6281283114455", "+6281300001111"]);
    expect(parseRecipientPhones("021-5551234 & 0813-0000-1111")).toEqual(["+6281300001111"]);
    expect(parseRecipientPhones("0812-8311-4455 dan 0812-8311-4455")).toEqual(["+6281283114455"]);
    expect(parseRecipientPhones("-")).toEqual([]);
    expect(parseRecipientPhones(null)).toEqual([]);
  });
  it("an override beats the SO's own number", () => {
    expect(resolveRecipient("0819-1234-5678", "0812-8311-4455")).toEqual({ phone: "+6281912345678", source: "override", alternates: [] });
    expect(resolveRecipient(null, "0812-8311-4455/0813-0000-1111")).toEqual({
      phone: "+6281283114455",
      source: "kontak_penerima",
      alternates: ["+6281300001111"],
    });
    expect(resolveRecipient(null, "")).toEqual({ phone: null, source: null, alternates: [] });
    expect(maskE164("+6281283114455")).toBe("0812-****-4455");
  });
  it("excludes related parties by whole word, case-insensitive", () => {
    const x = ["Anugerah Kencana Panelindo", "KMI", "Kencana SY Build"];
    expect(isExcludedCustomer("PT KMI", x)).toBe(true);
    expect(isExcludedCustomer("pt anugerah kencana panelindo", x)).toBe(true);
    expect(isExcludedCustomer("SKMI JAYA", x)).toBe(false);
    expect(isExcludedCustomer("FITRAH JAYA", x)).toBe(false);
    expect(isExcludedCustomer(null, x)).toBe(false);
  });
  it("direct-ship is customer_final ≠ customer_name", () => {
    expect(isDirectShip("1", "2")).toBe(true);
    expect(isDirectShip("1", "1")).toBe(false);
    expect(isDirectShip("1", null)).toBe(false);
  });
  it("sending window is [07, 20) WIB; outside it the next opening is returned", () => {
    expect(nextSendWindow(new Date("2026-11-10T03:00:00Z"), 7, 20)).toBeNull(); // 10:00 WIB
    expect(nextSendWindow(new Date("2026-11-09T23:00:00Z"), 7, 20)!.toISOString()).toBe("2026-11-10T00:00:00.000Z"); // 06:00 → 07:00 WIB
    expect(nextSendWindow(new Date("2026-11-10T14:00:00Z"), 7, 20)!.toISOString()).toBe("2026-11-11T00:00:00.000Z"); // 21:00 → next 07:00
    expect(wibDayStart(new Date("2026-11-10T18:00:00Z")).toISOString()).toBe("2026-11-10T17:00:00.000Z");
  });
  it("event age reads the mirror's WIB wall-clock timestamps correctly", () => {
    // Mirror holds 10:00 WIB as 10:00Z; real now is 05:00Z = 12:00 WIB ⇒ 2 h old.
    expect(erpAgeHours(new Date("2026-11-10T10:00:00Z"), new Date("2026-11-10T05:00:00Z"))).toBe(2);
    expect(erpAgeHours(null, new Date())).toBeNull();
  });
  it("outbox keys separate mode, step, subject and role", () => {
    expect(outboxKey("on", "delivery_scheduled", "77930", "customer")).toBe("notify:on:delivery_scheduled:77930:customer");
    expect(outboxKey("shadow", "so_received", "SO.1", "customer")).not.toBe(outboxKey("on", "so_received", "SO.1", "customer"));
  });
  it("merged step 3 says received AND scheduled; shadow wraps the exact customer text", () => {
    const ctx = sampleContext(new Date("2026-11-10T03:00:00Z"), "Rahmanto", "0813-1111-2222");
    expect(renderCustomerMessage("delivery_scheduled", ctx, { mergedReceived: true })).toContain(
      "Pesanan Anda nomor *SO.26/UJI-0001* telah kami terima dan telah dijadwalkan untuk dikirim.",
    );
    const text = renderCustomerMessage("so_received", ctx);
    const sh = renderShadow("so_received", "SO.1", "Di mode live: terkirim ke 0812-****-4455.", text);
    expect(sh.startsWith("[SHADOW]")).toBe(true);
    expect(sh).toContain(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp4disp";

class RecordingChannel implements Channel {
  readonly mode = "stub" as const;
  sent: OutboundMessage[] = [];
  fail = false;
  async send(m: OutboundMessage): Promise<SendResult> {
    this.sent.push(m);
    return this.fail
      ? { status: "failed", providerMessageId: null, error: "gateway HTTP 500" }
      : { status: "sent", providerMessageId: `p-${this.sent.length}`, error: null };
  }
  async health() {
    return { connected: true, detail: "" };
  }
}

describe.skipIf(!hasDb)("planner + dispatcher over the real schema", async () => {
  const dbmod = await import("../src/db/client.js");
  const store = await import("../src/events/store.js");
  const lane = await import("../src/erp/orderSync.js");
  const disp = await import("../src/notify/dispatcher.js");
  const routes = await import("../src/routes/notify.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runEventMigrations } = await import("../src/db/migrateEvents.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");
  const { lockNotifySettings } = await import("./helpers/settingsLock.js");
  let unlock: () => Promise<void> = async () => undefined;

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let ch: RecordingChannel;
  let seq = 0;
  /** A unique, valid Indonesian mobile per call, so tests never share a number. */
  const phone = () => `08129${String(++seq).padStart(3, "0")}${String(Date.now() % 10000).padStart(4, "0")}`;
  const e164 = (local: string) => `+62${local.slice(1)}`;
  const REP = "081377700001";

  const deps = (over: Partial<Parameters<typeof disp.defaultDispatchDeps>[0]> = {}) =>
    disp.defaultDispatchDeps({
      db,
      channel: ch,
      mode: "on",
      holds: { so_received: 0, production_started: 0, delivery_scheduled: 0 },
      fromHour: 0,
      untilHour: 24,
      dailyCap: 3,
      maxEventAgeHours: 24,
      // events.test.ts sweeps the whole mirror in parallel, so other suites'
      // orders become events here too and are planned alongside ours. The
      // production batch (20 per tick) could then leave OUR rows for the next
      // tick, which a test that dispatches once would read as "never sent".
      batch: 1000,
      pauseReason: async () => null,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      ...over,
    })!;

  async function cleanup(): Promise<void> {
    // Only planner rows (other suites write live rows of their own in parallel).
    await db`delete from notify_ledger where mode in ('live', 'shadow') and idempotency_key like 'notify:%'`;
    await db`delete from order_events where so_no like ${`${P}%`}`;
    await db`delete from erp_so_line where id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`delete from erp_do_header where id like ${`${P}%`}`;
    await db`delete from erp_sales where id like ${`${P}%`}`;
    await db`delete from notify_sales_contacts where erp_sales_id like ${`${P}%`}`;
    await db`delete from notify_customer_overrides where customer_name_id like ${`${P}%`}`;
    await db`delete from notify_contacts where phone_e164 like '+62812%' or phone_e164 like '+62813777%'`;
    await db`update notify_settings set live_mode = null, kill_switch = false, milestones_enabled = '{}'::jsonb where id = 1`;
  }

  /** An SO in the mirror, with the rep's phone registered. Returns its SO number. */
  async function seedSo(
    tag: string,
    o: { kontak?: string | null; customer?: string; customerId?: string; finalId?: string; createdHoursAgo?: number } = {},
  ): Promise<string> {
    const so = `${P}/${tag}`;
    const cid = o.customerId ?? `${P}-c-${tag}`;
    await db`
      insert into erp_so_header (id, po_no, so_number, customer_name_id, customer_final_id, customer_name_text,
                                 sales_name_id, sales_name_text, penerima, kontak_penerima, status_order, erp_created_at)
      values (${`${P}-h-${tag}`}, ${so}, ${so}, ${cid}, ${o.finalId ?? cid}, ${o.customer ?? "FITRAH JAYA"},
              ${`${P}-rep`}, ${"Free Antony"}, ${"Bp. Panji"}, ${o.kontak === undefined ? phone() : o.kontak}, ${"Wating"},
              now() + interval '7 hours' - make_interval(hours => ${o.createdHoursAgo ?? 0}))
    `;
    await db`
      insert into erp_so_line (id, po_no, brand_text, warna_text, th, th_panel, qty_order, qty_balance, approval, sku_key)
      values (${`${P}-l-${tag}`}, ${so}, ${"ALCOPAN"}, ${"PURE WHITE"}, ${0.21}, ${4}, ${10}, ${10}, ${"Approved"}, ${`${P}|k`})
    `;
    return so;
  }
  async function seedDo(tag: string, so: string, cancel = "No"): Promise<string> {
    const id = `${P}-d-${tag}`;
    await db`
      insert into erp_do_header (id, so_no, no_sj, sj_date, cara_kirim, cancel_order, do_created_at, erp_updated_at)
      values (${id}, ${so}, ${`KP/DO-${tag}`}, current_date + 1, ${"di Antar"}, ${cancel}, now() + interval '7 hours', now())
      on conflict (id) do update set cancel_order = excluded.cancel_order, synced_at = now()
    `;
    return id;
  }
  async function derive(headerTags: string[] = [], doIds: string[] = []): Promise<void> {
    await store.deriveForTouched(db, {
      ...lane.emptyTouched(),
      so_header: headerTags.map((t) => `${P}-h-${t}`),
      do_header: doIds,
    });
  }
  const ledger = async (so: string) =>
    db<{ milestone: string; recipient_role: string; status: string; cancel_reason: string | null; to_number: string | null; body: string | null; mode: string; meta: Record<string, unknown> }[]>`
      select milestone, recipient_role, status, cancel_reason, to_number, body, mode, meta
        from notify_ledger where so_no = ${so} order by id`;
  const sentTo = (n: string) => ch.sent.filter((m) => m.to === n);

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    unlock = await lockNotifySettings();
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runEventMigrations(db);
    await runNotifyMigrations(db);
  }, 120_000);
  beforeEach(async () => {
    await cleanup();
    ch = new RecordingChannel();
    await db`insert into erp_sales (id, sales_name, active) values (${`${P}-rep`}, ${"Free Antony"}, ${"Yes"})`;
    await db`insert into notify_sales_contacts (erp_sales_id, phone_e164) values (${`${P}-rep`}, ${e164(REP)})`;
  });
  afterAll(async () => {
    await cleanup();
    await unlock();
    await dbmod.closeDatabase();
  });

  it("ON: the customer gets the message (with the one-time intro), the rep gets the exact text as CC", async () => {
    const d = deps();
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("on1", { kontak: "0812-9100-0001" });
    await derive(["on1"]);
    const r = await disp.dispatchOnce(d);
    expect(r.paused).toBeNull();
    const toCustomer = sentTo("+6281291000001");
    expect(toCustomer).toHaveLength(1);
    expect(toCustomer[0]!.text).toContain(`Pesanan Anda nomor *${so}* telah kami terima`);
    expect(toCustomer[0]!.text).toContain("nomor resmi notifikasi");
    expect(toCustomer[0]!.text).toContain("Free Antony (0813-7770-0001)");
    const cc = sentTo(e164(REP));
    expect(cc).toHaveLength(1);
    expect(cc[0]!.text).toContain("Salinan Kabar Pesanan");
    expect(cc[0]!.text).toContain(toCustomer[0]!.text);
    expect((await ledger(so)).map((l) => [l.recipient_role, l.status])).toEqual([["customer", "sent"], ["sales_cc", "sent"]]);

    // Replay: planning and dispatching again sends nothing new.
    await derive(["on1"]);
    await disp.dispatchOnce(d);
    expect(ch.sent.filter((m) => m.to === "+6281291000001" || m.to === e164(REP))).toHaveLength(2);
  });

  it("SHADOW: only the rep is messaged, with the live verdict; the customer number is never used", async () => {
    await disp.syncMode(db, "shadow", new Date());
    const so = await seedSo("sh1", { kontak: "0812-9100-0002" });
    await derive(["sh1"]);
    await disp.dispatchOnce(deps({ mode: "shadow" }));
    expect(sentTo("+6281291000002")).toEqual([]);
    const toRep = sentTo(e164(REP));
    expect(toRep).toHaveLength(1);
    expect(toRep[0]!.text.startsWith("[SHADOW]")).toBe(true);
    expect(toRep[0]!.text).toContain("Di mode live: terkirim ke 0812-****-0002");
    expect(toRep[0]!.text).toContain(`telah kami terima`);
    expect((await ledger(so)).map((l) => [l.mode, l.recipient_role, l.status])).toEqual([["shadow", "customer", "sent"]]);
  });

  it("step 1 still on hold when the DO lands ⇒ ONE merged message, step 1 cancelled as merged", async () => {
    const d = deps({ holds: { so_received: 10, production_started: 0, delivery_scheduled: 0 } });
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("mg1", { kontak: "0812-9100-0003" });
    await derive(["mg1"]);
    const doId = await seedDo("mg1", so);
    await derive([], [doId]);
    await disp.dispatchOnce(d);
    const msgs = sentTo("+6281291000003");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toContain(`Pesanan Anda nomor *${so}* telah kami terima dan telah dijadwalkan untuk dikirim.`);
    const rows = await ledger(so);
    expect(rows.filter((r) => r.milestone === "so_received").map((r) => [r.status, r.cancel_reason])).toEqual([
      ["cancelled", "merged"],
      ["cancelled", "merged"],
    ]);
    expect(rows.filter((r) => r.milestone === "delivery_scheduled").every((r) => r.status === "sent")).toBe(true);
  });

  it("a DO cancelled before sending is never announced; after sending, the rep is told", async () => {
    const d = deps({ holds: { so_received: 0, production_started: 0, delivery_scheduled: 30 } });
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("dc1", { kontak: "0812-9100-0004" });
    const doId = await seedDo("dc1", so);
    await derive([], [doId]);
    await disp.dispatchOnce(d); // planned, held 30 min
    await seedDo("dc1", so, "Yes");
    await derive([], [doId]);
    await disp.dispatchOnce(d);
    const rows = (await ledger(so)).filter((r) => r.milestone === "delivery_scheduled");
    expect(rows.map((r) => [r.status, r.cancel_reason])).toEqual([["cancelled", "do_cancelled"], ["cancelled", "do_cancelled"]]);
    expect(sentTo("+6281291000004")).toEqual([]);

    // Second DO: sent first, then cancelled ⇒ rep notice, customer not re-messaged.
    const d2 = deps();
    const doId2 = await seedDo("dc2", so);
    await derive([], [doId2]);
    await disp.dispatchOnce(d2);
    expect(sentTo("+6281291000004")).toHaveLength(1);
    await seedDo("dc2", so, "Yes");
    await derive([], [doId2]);
    await disp.dispatchOnce(d2);
    const notice = sentTo(e164(REP)).find((m) => m.text.includes("DO dibatalkan"));
    expect(notice?.text).toContain(`KP/DO-dc2`);
    expect(sentTo("+6281291000004")).toHaveLength(1);
  });

  it("no number on the SO ⇒ customer row unreachable, the rep's CC says so", async () => {
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("un1", { kontak: null });
    await derive(["un1"]);
    await disp.dispatchOnce(deps());
    const rows = await ledger(so);
    expect(rows.map((r) => [r.recipient_role, r.status])).toEqual([["customer", "unreachable"], ["sales_cc", "sent"]]);
    expect(sentTo(e164(REP))[0]!.text).toContain("Pelanggan TIDAK menerima pesan ini");
  });

  it("opted-out numbers are skipped; a number shared by ≥3 customers is held for review", async () => {
    await disp.syncMode(db, "on", new Date());
    await db`insert into notify_contacts (phone_e164, consent_state, opted_out_at) values ('+6281291000005', 'opted_out', now())`;
    const so1 = await seedSo("op1", { kontak: "0812-9100-0005" });
    for (const t of ["sh-a", "sh-b", "sh-c"]) await seedSo(t, { kontak: "0812-9100-0006" });
    await derive(["op1", "sh-a"]);
    await disp.dispatchOnce(deps());
    expect((await ledger(so1)).map((r) => [r.recipient_role, r.status, r.cancel_reason])).toEqual([
      ["customer", "cancelled", "opted_out"],
      ["sales_cc", "cancelled", "opted_out"],
    ]);
    expect((await ledger(`${P}/sh-a`)).map((r) => r.status)).toEqual(["held", "held"]);
    expect(sentTo("+6281291000005")).toEqual([]);
    expect(sentTo("+6281291000006")).toEqual([]);
  });

  it("related parties, direct-ship and muted customers are never messaged", async () => {
    await disp.syncMode(db, "on", new Date());
    const a = await seedSo("ex1", { customer: "PT KMI" });
    const b = await seedSo("ex2", { customerId: `${P}-c-x`, finalId: `${P}-c-y` });
    const c = await seedSo("ex3", { customerId: `${P}-c-muted` });
    await db`insert into notify_customer_overrides (customer_name_id, muted) values (${`${P}-c-muted`}, true)`;
    await derive(["ex1", "ex2", "ex3"]);
    await disp.dispatchOnce(deps());
    expect((await ledger(a))[0]!.cancel_reason).toBe("excluded_customer");
    expect((await ledger(b))[0]!.cancel_reason).toBe("direct_ship");
    expect((await ledger(c))[0]!.cancel_reason).toBe("muted");
    expect(ch.sent.filter((m) => m.to !== e164(REP) && m.text.includes(P))).toEqual([]);
  });

  it("outside the sending window the row waits (pending, due at the next opening)", async () => {
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("qh1");
    await derive(["qh1"]);
    const h = (new Date().getUTCHours() + 7) % 24; // current WIB hour
    await disp.dispatchOnce(deps({ fromHour: (h + 2) % 24, untilHour: (h + 3) % 24 || 24 }));
    const [row] = await db<{ status: string; due_at: Date; meta: Record<string, unknown> }[]>`
      select status, due_at, meta from notify_ledger where so_no = ${so} and recipient_role = 'customer'`;
    expect(row!.status).toBe("pending");
    expect(row!.meta["deferred"]).toBe("quiet_hours");
    expect(row!.due_at.getTime()).toBeGreaterThan(Date.now());
    expect(ch.sent).toEqual([]);
  });

  it("the daily cap per phone defers the overflow to tomorrow", async () => {
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("cap1", { kontak: "0812-9100-0007" });
    const doId = await seedDo("cap1", so);
    await derive(["cap1"], [doId]);
    await disp.dispatchOnce(deps({ dailyCap: 1 }));
    expect(sentTo("+6281291000007")).toHaveLength(1);
    const deferred = (await ledger(so)).filter((r) => r.recipient_role === "customer" && r.status === "pending");
    expect(deferred).toHaveLength(1);
    expect(deferred[0]!.meta["deferred"]).toBe("daily_cap");
  });

  it("an event about an old movement is skipped (no catch-up blast)", async () => {
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("old1", { createdHoursAgo: 72 });
    await derive(["old1"]);
    await disp.dispatchOnce(deps());
    expect((await ledger(so)).map((r) => [r.status, r.cancel_reason])).toEqual([["skipped", "stale_event"]]);
  });

  it("changing mode starts afresh: earlier events are not planned, the old mode's pending rows are cancelled", async () => {
    await disp.syncMode(db, "shadow", new Date());
    const so = await seedSo("mc1");
    await derive(["mc1"]);
    await disp.planEvents(deps({ mode: "shadow", holds: { so_received: 60, production_started: 0, delivery_scheduled: 0 } }));
    expect((await ledger(so)).map((r) => [r.mode, r.status])).toEqual([["shadow", "pending"]]);
    const st = await disp.syncMode(db, "on", new Date());
    expect(st.changed).toBe(true);
    await disp.dispatchOnce(deps());
    expect((await ledger(so)).map((r) => [r.mode, r.status, r.cancel_reason])).toEqual([["shadow", "cancelled", "mode_changed"]]);
  });

  it("a failed send is retried with backoff, never lost; a pause processes nothing", async () => {
    await disp.syncMode(db, "on", new Date());
    const so = await seedSo("f1", { kontak: "0812-9100-0008" });
    await derive(["f1"]);
    ch.fail = true;
    await disp.dispatchOnce(deps());
    const [r] = await db<{ status: string; error: string; attempts: number; due_at: Date }[]>`
      select status, error, attempts, due_at from notify_ledger where so_no = ${so} and recipient_role = 'customer'`;
    expect(r).toMatchObject({ status: "pending", error: "gateway HTTP 500", attempts: 1 });
    expect(r!.due_at.getTime()).toBeGreaterThan(Date.now());

    const before = ch.sent.length;
    await db`update notify_ledger set due_at = now() - interval '1 minute' where so_no = ${so}`;
    const p = await disp.dispatchOnce(deps({ pauseReason: async () => "mirror_stale" }));
    expect(p).toMatchObject({ paused: "mirror_stale", processed: 0 });
    expect(ch.sent.length).toBe(before);
  });

  it("the kill switch pauses sending (rows wait); a step switched off is recorded as skipped", async () => {
    await disp.syncMode(db, "on", new Date());
    await db`update notify_settings set kill_switch = true, milestones_enabled = '{"production_started": false}'::jsonb where id = 1`;
    const so = await seedSo("ks1", { kontak: "0812-9100-0009" });
    await derive(["ks1"]);
    const r = await disp.dispatchOnce(deps());
    expect(r.paused).toBe("kill_switch");
    expect(sentTo("+6281291000009")).toEqual([]);
    expect((await ledger(so)).every((l) => l.status === "pending")).toBe(true);

    await db`
      insert into order_events (event_key, event_type, so_no, subject_ref, occurred_at, payload)
      values (${`production.requested:${so}:WO-X`}, 'production.requested', ${so}, 'r1', now() + interval '7 hours', '{}'::jsonb)`;
    await disp.planEvents(deps());
    const prod = (await ledger(so)).filter((l) => l.milestone === "production_started");
    expect(prod.map((l) => [l.status, l.cancel_reason])).toEqual([["skipped", "milestone_off"]]);

    await db`update notify_settings set kill_switch = false where id = 1`;
    await disp.dispatchOnce(deps());
    expect(sentTo("+6281291000009")).toHaveLength(1);
  });

  it("a held shared-number message released by an admin is sent despite the guard", async () => {
    await disp.syncMode(db, "on", new Date());
    for (const t of ["rl-a", "rl-b", "rl-c"]) await seedSo(t, { kontak: "0812-9100-0010" });
    await derive(["rl-a"]);
    await disp.dispatchOnce(deps());
    const [held] = await db<{ id: string }[]>`
      select id::text from notify_ledger where so_no = ${`${P}/rl-a`} and recipient_role = 'customer' and status = 'held'`;
    expect(held).toBeDefined();
    await db`update notify_ledger set status = 'pending', due_at = now(), meta = meta || '{"released": true}'::jsonb where id = ${held!.id}`;
    await db`update notify_ledger set status = 'pending', due_at = now() where so_no = ${`${P}/rl-a`} and recipient_role = 'sales_cc'`;
    await disp.dispatchOnce(deps());
    expect(sentTo("+6281291000010")).toHaveLength(1);
  });

  it("OFF plans and sends nothing", async () => {
    await seedSo("off1");
    await derive(["off1"]);
    expect(await disp.dispatchOnce(deps({ mode: "off" }))).toEqual({ paused: "off", planned: 0, processed: 0 });
    expect(await ledger(`${P}/off1`)).toEqual([]);
  });

  it("rep phones: PUT validates and stores, GET lists Selaras reps with their CC number", async () => {
    const app = Fastify();
    await app.register(routes.notifyRoutes);
    const bad = await app.inject({ method: "PUT", url: `/api/notify/sales-contacts/${P}-rep`, payload: { phone: "021-555" } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: "PUT", url: `/api/notify/sales-contacts/${P}-rep`, payload: { phone: "0813-7770-0009", ccEnabled: false } });
    expect(ok.json()).toMatchObject({ phone: "+6281377700009", ccEnabled: false });
    const list = (await app.inject({ method: "GET", url: "/api/notify/sales-contacts" })).json().rows;
    expect(list.find((r: { erp_sales_id: string }) => r.erp_sales_id === `${P}-rep`)).toMatchObject({
      sales_name: "Free Antony",
      phone_e164: "+6281377700009",
      cc_enabled: false,
    });
    const cfg = (await app.inject({ method: "GET", url: "/api/notify/config" })).json();
    expect(cfg.live).toHaveProperty("mode");
  });
});
