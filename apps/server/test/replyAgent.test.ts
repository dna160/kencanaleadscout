/**
 * Kabar Pesanan PRD §21.4 / §21.5: the reply agent.
 *
 * The model is replaced by fixtures (one verdict per category, plus a mixed
 * burst); what is tested is everything around it: the 90 s burst wait, what
 * the model is shown, sanitizing its answer, routing to the rep / Sales Admin
 * / escalation, the customer notice + contact card and its 24 h window, the
 * reschedule hold, and failing open.
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Channel, ContactCard, OutboundMessage, SendResult } from "../src/notify/channel.js";
import {
  CATEGORIES,
  customerNotice,
  pickDo,
  repMessage,
  sanitize,
  type ClassifyInput,
  type OpenOrder,
  type ReplyClass,
} from "../src/notify/replyAgent.js";

const verdict = (over: Partial<ReplyClass> = {}): ReplyClass => ({
  category: "status",
  urgency: "normal",
  so_no: null,
  do_no: null,
  requested_date: null,
  summary: "Pelanggan menanyakan kapan barang dikirim.",
  needs_human: true,
  ...over,
});
const ORDERS: OpenOrder[] = [
  {
    soNo: "SO.26/1",
    items: ["ALCOPAN PURE WHITE 4mm / 0.21 × 10"],
    lastMilestone: "delivery_scheduled",
    dos: [
      { doId: "d1", noSj: "KP/DO-1", date: "2026-11-24", departed: false, pickup: false },
      { doId: "d0", noSj: "KP/DO-0", date: "2026-11-20", departed: true, pickup: false },
    ],
  },
  { soNo: "SO.26/2", items: [], lastMilestone: null, dos: [{ doId: "d2", noSj: "KP/DO-2", date: "2026-11-26", departed: false, pickup: false }] },
];

describe("reply agent (pure)", () => {
  it("sanitize keeps only the customer's own SO / DO numbers and a real date, and only for ubah_jadwal", () => {
    expect(sanitize(verdict({ so_no: "SO.26/1", do_no: "KP/DO-9" }), ORDERS)).toMatchObject({ so_no: "SO.26/1", do_no: null });
    expect(sanitize(verdict({ so_no: "SO.99/X" }), ORDERS).so_no).toBeNull();
    expect(sanitize(verdict({ category: "ubah_jadwal", requested_date: "2026-11-27" }), ORDERS).requested_date).toBe("2026-11-27");
    expect(sanitize(verdict({ category: "ubah_jadwal", requested_date: "Kamis" }), ORDERS).requested_date).toBeNull();
    expect(sanitize(verdict({ requested_date: "2026-11-27" }), ORDERS).requested_date).toBeNull();
    expect(sanitize(verdict({ category: "ack", needs_human: true }), ORDERS).needs_human).toBe(false);
    expect(sanitize(verdict({ summary: "x".repeat(900) }), ORDERS).summary).toHaveLength(600);
  });

  it("the DO of a reschedule request: the one named, else the next undelivered one (of the SO first)", () => {
    expect(pickDo(ORDERS, "KP/DO-2", null, "2026-11-23")!.noSj).toBe("KP/DO-2");
    expect(pickDo(ORDERS, null, "SO.26/1", "2026-11-23")!.noSj).toBe("KP/DO-1");
    expect(pickDo(ORDERS, null, null, "2026-11-25")!.noSj).toBe("KP/DO-2");
    expect(pickDo([], null, null, "2026-11-23")).toBeNull();
  });

  it("customer notice: automated service, the rep by name, plus the complaint / reschedule line", () => {
    const t = customerNotice("Rina Wijaya", "komplain");
    expect(t).toContain("*layanan otomatis* PT Kencana Panelindo dan tidak dipantau langsung");
    expect(t).toContain("teruskan ke *Rina Wijaya*, sales yang menangani pesanan Anda. Silakan hubungi beliau melalui kontak berikut.");
    expect(t).toContain("Keluhan Anda sudah kami catat");
    expect(customerNotice("Rina", "ubah_jadwal")).toContain("Permintaan perubahan jadwal Anda sudah kami teruskan");
    expect(customerNotice(null, "status")).toContain("tim sales kami");
    expect(customerNotice(null, "status")).not.toContain("kontak berikut");
  });

  it("rep message: header by category, the schedule line for ubah_jadwal, summary, originals verbatim", () => {
    const t = repMessage({
      category: "ubah_jadwal",
      customer: "TOKO A",
      phone: "+6281234567890",
      soNo: "SO.26/1",
      summary: "Minta diundur ke Kamis.",
      schedule: { noSj: "KP/DO-1", current: "2026-11-24", requested: "2026-11-26" },
      originals: ["pak bisa diundur kamis?", "📷 gudang penuh"],
      photos: 1,
      agentFailed: false,
    });
    expect(t.split("\n")[0]).toBe("🟠 *UBAH JADWAL* · TOKO A (0812-3456-7890) · SO SO.26/1");
    expect(t).toContain("DO KP/DO-1 · jadwal sekarang Selasa, 24 November 2026 · diminta Kamis, 26 November 2026");
    expect(t).toContain("Ringkasan: Minta diundur ke Kamis.");
    expect(t).toContain("Pesan asli di bawah ini. Mohon hubungi pelanggan langsung.");
    expect(t).toContain("pak bisa diundur kamis?\n📷 gudang penuh\n📷 1 foto");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp7d";

class RecordingChannel implements Channel {
  readonly mode = "stub" as const;
  sent: (OutboundMessage & { card?: ContactCard })[] = [];
  async send(m: OutboundMessage): Promise<SendResult> {
    this.sent.push(m);
    return { status: "sent", providerMessageId: `p-${this.sent.length}`, error: null };
  }
  async sendContact(c: ContactCard): Promise<SendResult> {
    this.sent.push({ to: c.to, text: `[KARTU] ${c.name}`, idempotencyKey: c.idempotencyKey, card: c });
    return { status: "sent", providerMessageId: `p-${this.sent.length}`, error: null };
  }
  async health() {
    return { connected: true, detail: "" };
  }
}

describe.skipIf(!hasDb)("reply agent over the real schema", async () => {
  const dbmod = await import("../src/db/client.js");
  const agent = await import("../src/notify/replyAgent.js");
  const inbound = await import("../src/notify/inbound.js");
  const chatRoutes = await import("../src/routes/notify-chat.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runEventMigrations } = await import("../src/db/migrateEvents.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");
  const { lockNotifySettings } = await import("./helpers/settingsLock.js");
  const { wibDate } = await import("../src/notify/rules.js");
  const { addDaysIso } = await import("../src/notify/messages.js");
  let unlock: () => Promise<void> = async () => undefined;
  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let ch: RecordingChannel;
  let seen: ClassifyInput[] = [];
  let next: ReplyClass | Error = verdict();

  const REP = "+6281377700070";
  const ADMIN = "+6281377700071";
  const ESC = "+6281377700072";
  const today = () => wibDate(new Date());
  // A tiny real PNG.
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  let n = 0;
  async function customer(tag: string, o: { repPhone?: string | null } = {}): Promise<{ phone: string; so: string; doId: string }> {
    const phone = `+6281293${String(++n).padStart(3, "0")}${String(Date.now() % 1000).padStart(3, "0")}`;
    const so = `${P}/${tag}`;
    const rep = `${P}-rep-${tag}`;
    await db`insert into erp_sales (id, sales_name, active) values (${rep}, ${"Rina Wijaya"}, ${"Yes"})`;
    if (o.repPhone !== null) await db`insert into notify_sales_contacts (erp_sales_id, phone_e164) values (${rep}, ${o.repPhone ?? REP})`;
    await db`
      insert into erp_so_header (id, po_no, so_number, customer_name_text, sales_name_id, sales_name_text, kontak_penerima, erp_created_at)
      values (${`${P}-h-${tag}`}, ${so}, ${so}, ${"TOKO UJI BALAS"}, ${rep}, ${"Rina Wijaya"}, ${phone}, now())`;
    await db`
      insert into erp_so_line (id, po_no, brand_text, warna_text, th, th_panel, qty_order, qty_balance, approval, sku_key)
      values (${`${P}-l-${tag}`}, ${so}, ${"ALCOPAN"}, ${"PURE WHITE"}, ${0.21}, ${4}, ${10}, ${10}, ${"Approved"}, ${`${P}|k`})`;
    const doId = `${P}-d-${tag}`;
    await db`
      insert into erp_do_header (id, so_no, no_sj, sj_date, cara_kirim, cancel_order)
      values (${doId}, ${so}, ${`KP/DO-${P}-${tag}`}, ${addDaysIso(today(), 1)}::date, ${"di Antar"}, ${"No"})`;
    // The customer was told about this SO, so a reply can be matched to it.
    await db`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status, idempotency_key, sent_at)
      values ('live', 'delivery_scheduled', ${so}, 'customer', ${phone}, ${"Pesanan dijadwalkan"}, 'stub', 'sent',
              ${`${P}:${tag}:${n}`}, now() - interval '1 hour')`;
    return { phone, so, doId };
  }
  let mid = 0;
  const say = (phone: string, text: string, at = new Date(), photo = false) =>
    inbound.handleInbound(
      db,
      ch,
      { type: "inbound", from_pn: phone, text, message_id: `${P}-m-${Date.now()}-${++mid}`, ...(photo ? { media: { mime: "image/png", data_b64: PNG } } : {}) },
      at,
    );
  const later = (s: number) => new Date(Date.now() + s * 1000);
  const to = (n: string) => ch.sent.filter((m) => m.to === n);
  const kases = (phone: string) =>
    db<{ category: string; source: string; handled_at: Date | null; hold_id: string | null; routed_to: string[]; inbound_ids: string[] }[]>`
      select category, source, handled_at, hold_id::text, routed_to, inbound_ids from notify_reply_cases where phone_e164 = ${phone} order by id`;

  async function cleanup(): Promise<void> {
    await db`delete from notify_reply_cases where so_no like ${`${P}%`} or phone_e164 like '+6281293%'`;
    await db`delete from notify_do_holds where do_id like ${`${P}%`}`;
    await db`delete from notify_inbound where from_pn like '+6281293%'`;
    await db`delete from notify_ledger where so_no like ${`${P}%`} or to_number like '+6281293%' or to_number in (${REP}, ${ADMIN}, ${ESC})`;
    await db`delete from notify_contacts where phone_e164 like '+6281293%'`;
    await db`delete from erp_do_header where id like ${`${P}%`}`;
    await db`delete from erp_so_line where id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`delete from notify_sales_contacts where erp_sales_id like ${`${P}%`}`;
    await db`delete from erp_sales where id like ${`${P}%`}`;
    await db`
      update notify_settings set reply_agent = true, reply_debounce_s = 90, sales_admin_number = ${ADMIN},
             escalation_number = ${ESC}, kill_switch = false where id = 1`;
  }

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
    seen = [];
    next = verdict();
    agent.setClassifierForTests(async (input) => {
      seen.push(input);
      if (next instanceof Error) throw next;
      return next;
    });
  });
  afterAll(async () => {
    agent.setClassifierForTests(null);
    await cleanup();
    await db`update notify_settings set sales_admin_number = null, escalation_number = null where id = 1`;
    await unlock();
    await dbmod.closeDatabase();
  });

  it("waits for the burst to go quiet (90 s), then makes ONE call with the burst, the thread and the open orders", async () => {
    const c = await customer("b1");
    expect((await say(c.phone, "pak")).action).toBe("pending_agent");
    expect((await say(c.phone, "barangnya kapan sampai?")).action).toBe("pending_agent");
    expect(await agent.processReplies(db, ch, later(30))).toBe(0); // still typing
    expect(ch.sent).toEqual([]);
    expect(await agent.processReplies(db, ch, later(91))).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.burst.map((b) => b.text)).toEqual(["pak", "barangnya kapan sampai?"]);
    expect(seen[0]!.thread).toEqual([{ from: "kencana", text: "Pesanan dijadwalkan" }]);
    expect(seen[0]!.orders[0]).toMatchObject({ soNo: c.so, lastMilestone: "delivery_scheduled" });
    expect(seen[0]!.orders[0]!.dos[0]).toMatchObject({ doId: c.doId, departed: false });
    expect(JSON.stringify(seen[0])).not.toContain(c.phone.slice(-6)); // the number itself is not sent to the model
    expect((await kases(c.phone)).map((k) => k.inbound_ids.length)).toEqual([2]);
    expect(await agent.processReplies(db, ch, later(200))).toBe(0); // done once
  });

  it.each(CATEGORIES.filter((x) => x !== "ack"))("%s: the rep gets the header and summary, the customer the notice and the rep's card", async (category) => {
    const c = await customer(`cat-${category}`);
    next = verdict({ category, summary: `Ringkasan ${category}.` });
    await say(c.phone, `pesan ${category}`);
    await agent.processReplies(db, ch, later(91));
    const rep = to(REP);
    expect(rep).toHaveLength(1);
    expect(rep[0]!.text).toContain(`TOKO UJI BALAS`);
    expect(rep[0]!.text).toContain(`Ringkasan: Ringkasan ${category}.`);
    expect(rep[0]!.text).toContain(`pesan ${category}`);
    const cust = to(c.phone);
    expect(cust.map((m) => (m.card ? "card" : "text"))).toEqual(["text", "card"]);
    expect(cust[1]!.card).toMatchObject({ name: "Rina Wijaya", phone: REP });
    expect(to(ESC)).toHaveLength(category === "komplain" ? 1 : 0);
    expect(to(ADMIN)).toHaveLength(category === "ubah_jadwal" ? 1 : 0);
  });

  it("komplain with photos: photos follow as photos to the rep and the escalation number", async () => {
    const c = await customer("kp1");
    next = verdict({ category: "komplain", urgency: "tinggi", summary: "Panel lecet saat diterima." });
    await say(c.phone, "barangnya lecet");
    await say(c.phone, "ini fotonya", new Date(), true);
    await agent.processReplies(db, ch, later(91));
    for (const n of [REP, ESC]) {
      const m = to(n);
      expect(m[0]!.text.startsWith("🔴 *KOMPLAIN*")).toBe(true);
      expect(m[0]!.text).toContain("📷 1 foto");
      expect(m[1]!.media?.mime).toBe("image/png");
      expect(m[1]!.text).toBe("📷 ini fotonya");
    }
    expect(to(c.phone)[0]!.text).toContain("Keluhan Anda sudah kami catat");
  });

  it("ack is logged only: nothing to the rep or the customer, the case is closed", async () => {
    const c = await customer("ack1");
    next = verdict({ category: "ack", urgency: "rendah" });
    await say(c.phone, "ok terima kasih 👍");
    await agent.processReplies(db, ch, later(91));
    expect(ch.sent).toEqual([]);
    const [k] = await kases(c.phone);
    expect(k).toMatchObject({ category: "ack" });
    expect(k!.handled_at).not.toBeNull();
  });

  it("the customer notice goes once per 24 h; a komplain or ubah_jadwal always gets one", async () => {
    const c = await customer("w1");
    await say(c.phone, "kapan dikirim?");
    await agent.processReplies(db, ch, later(91));
    await say(c.phone, "halo?", later(100));
    await agent.processReplies(db, ch, later(200));
    expect(to(c.phone).filter((m) => !m.card)).toHaveLength(1);
    expect(to(REP)).toHaveLength(2); // the rep still gets every burst
    next = verdict({ category: "komplain" });
    await say(c.phone, "kurang 2 lembar", later(210));
    await agent.processReplies(db, ch, later(310));
    expect(to(c.phone).filter((m) => !m.card)).toHaveLength(2);
  });

  it("ubah_jadwal: the rep and Sales Admin get the DO line; a hold opens on the customer's next DO", async () => {
    const c = await customer("uj1");
    const want = addDaysIso(today(), 3);
    next = verdict({ category: "ubah_jadwal", requested_date: want, summary: "Minta diundur." });
    await say(c.phone, "bisa diundur?");
    await agent.processReplies(db, ch, later(91));
    for (const n of [REP, ADMIN]) expect(to(n)[0]!.text).toContain(`DO KP/DO-${P}-uj1 · jadwal sekarang`);
    const [h] = await db<{ do_id: string; requested_date: string; resolved_at: Date | null }[]>`
      select do_id, to_char(requested_date, 'YYYY-MM-DD') as requested_date, resolved_at from notify_do_holds where do_id = ${c.doId}`;
    expect(h).toMatchObject({ do_id: c.doId, requested_date: want, resolved_at: null });
    expect((await kases(c.phone))[0]!.hold_id).not.toBeNull();
    expect(to(c.phone)[0]!.text).toContain("Permintaan perubahan jadwal Anda");
  });

  it("fails open: a model error routes the originals as 'lainnya' with a note, never drops them", async () => {
    const c = await customer("fo1");
    next = new Error("overloaded");
    await say(c.phone, "tolong telpon saya");
    await agent.processReplies(db, ch, later(91));
    expect(to(REP)[0]!.text.startsWith("💬 *PESAN PELANGGAN*")).toBe(true);
    expect(to(REP)[0]!.text).toContain("agen tidak tersedia");
    expect(to(REP)[0]!.text).toContain("tolong telpon saya");
    expect((await kases(c.phone))[0]).toMatchObject({ category: "lainnya", source: "fallback" });
  });

  it("no rep number: Sales Admin gets it, and the customer gets no card", async () => {
    const c = await customer("nr1", { repPhone: null });
    await say(c.phone, "kapan dikirim?");
    await agent.processReplies(db, ch, later(91));
    expect(to(ADMIN)).toHaveLength(1);
    expect(to(c.phone).map((m) => Boolean(m.card))).toEqual([false]);
    expect(to(c.phone)[0]!.text).toContain("tim sales kami");
  });

  it("agent off in Konfigurasi: replies are forwarded at once, as before", async () => {
    await db`update notify_settings set reply_agent = false where id = 1`;
    const c = await customer("off1");
    expect((await say(c.phone, "halo")).action).toBe("forwarded");
    expect(to(REP)).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it("Pesan shows the verdict and the Ditangani toggle needs the token", async () => {
    const c = await customer("ui1");
    next = verdict({ category: "komplain", summary: "Warna salah." });
    await say(c.phone, "warnanya salah");
    await agent.processReplies(db, ch, later(91));
    const app = Fastify();
    await app.register(chatRoutes.notifyChatRoutes);
    const list = (await app.inject({ method: "GET", url: `/api/notify/chats?q=${encodeURIComponent(c.phone.slice(-6))}` })).json();
    expect(list.rows[0]).toMatchObject({ case_category: "komplain", case_summary: "Warna salah.", case_handled: false });
    const thread = (await app.inject({ method: "GET", url: `/api/notify/chats/${encodeURIComponent(c.phone)}` })).json();
    const id = thread.cases[0].id;
    const r = await app.inject({ method: "POST", url: `/api/notify/cases/${id}/handled`, payload: { handled: true } });
    // No NOTIFY_ADMIN_TOKEN in tests ⇒ open; the route records the actor.
    expect(r.statusCode).toBe(200);
    const [k] = await db<{ handled_by: string }[]>`select handled_by from notify_reply_cases where id = ${id}`;
    expect(k!.handled_by).toBe("admin");
  });
});
