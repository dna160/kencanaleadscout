/**
 * "Pesan" tab: WhatsApp-style conversations on the notification number, and
 * admin replies with their guards. Needs DATABASE_URL (skips without it).
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["NOTIFY_ADMIN_TOKEN"] = "admin-token-chat";

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wpchat";
const CUST = "+6281357000001"; // wrote in
const QUIET = "+6281357000002"; // only ever received notifications
const REP = "+6281357000009";
const TOKEN = { "x-notify-token": "admin-token-chat", "x-notify-actor": "Rina" };
const enc = (p: string) => encodeURIComponent(p);

describe.skipIf(!hasDb)("Pesan tab API", async () => {
  const dbmod = await import("../src/db/client.js");
  const routes = await import("../src/routes/notify-chat.js");
  const channel = await import("../src/notify/channel.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");
  const { lockNotifySettings } = await import("./helpers/settingsLock.js");

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  let unlock: () => Promise<void> = async () => undefined;
  const sent: { to: string; text: string }[] = [];
  const app = Fastify();

  async function cleanup(): Promise<void> {
    await db`delete from notify_ledger where to_number in (${CUST}, ${QUIET}, ${REP})`;
    await db`delete from notify_inbound where message_id like ${`${P}%`}`;
    await db`delete from notify_chat_reads where phone_e164 in (${CUST}, ${QUIET}, ${REP})`;
    await db`delete from notify_contacts where phone_e164 in (${CUST}, ${QUIET}, ${REP})`;
    await db`delete from notify_sales_contacts where erp_sales_id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
    await db`update notify_settings set kill_switch = false where id = 1`;
  }
  async function out(to: string, body: string, minutesAgo: number, extra: { status?: string; mode?: string; milestone?: string; read?: boolean } = {}) {
    await db`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status,
                                 idempotency_key, sent_at, read_at)
      values (${extra.mode ?? "live"}, ${extra.milestone ?? "so_received"}, ${`${P}/SO-1`}, 'customer', ${to}, ${body}, 'gateway',
              ${extra.status ?? "sent"}, ${`${P}:${Math.random()}`}, now() - make_interval(mins => ${minutesAgo}),
              ${extra.read ? new Date() : null})`;
  }
  async function inbound(from: string, text: string, minutesAgo: number) {
    await db`
      insert into notify_inbound (message_id, from_pn, text, action, so_no, received_at)
      values (${`${P}-${Math.random()}`}, ${from}, ${text}, 'forwarded', ${`${P}/SO-1`}, now() - make_interval(mins => ${minutesAgo}))`;
  }
  const list = async (q = "") => (await app.inject({ method: "GET", url: `/api/notify/chats${q}` })).json();
  const thread = async (p: string) => (await app.inject({ method: "GET", url: `/api/notify/chats/${enc(p)}` })).json();
  const replyTo = (p: string, text: string, headers: Record<string, string> = TOKEN) =>
    app.inject({ method: "POST", url: `/api/notify/chats/${enc(p)}/reply`, headers, payload: { text } });

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    unlock = await lockNotifySettings();
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runNotifyMigrations(db);
    channel.setChannelForTests({
      mode: "stub",
      async send(m) {
        sent.push({ to: m.to, text: m.text });
        return { status: "stubbed", providerMessageId: `stub-${sent.length}`, error: null };
      },
      async health() {
        return { connected: true, detail: "" };
      },
    });
    await app.register(routes.notifyChatRoutes);
  }, 120_000);
  beforeEach(async () => {
    sent.length = 0;
    await cleanup();
    await db`insert into erp_so_header (id, po_no, customer_name_text) values (${`${P}-h1`}, ${`${P}/SO-1`}, ${"FITRAH JAYA CHAT"})`;
    await db`insert into notify_sales_contacts (erp_sales_id, sales_name, phone_e164) values (${`${P}-rep`}, ${"Free Antony"}, ${REP})`;
  });
  afterAll(async () => {
    await cleanup();
    channel.setChannelForTests(null);
    await unlock();
    await dbmod.closeDatabase();
  });

  it("lists one conversation per number, newest first, with name, last message and unread count", async () => {
    await out(CUST, "Pesanan Anda telah kami terima", 30, { read: true });
    await inbound(CUST, "sudah sampai mana?", 10);
    await inbound(CUST, "halo?", 5);
    await out(QUIET, "Pesanan telah dijadwalkan", 20);
    await out(REP, "[SHADOW] …", 15, { mode: "shadow" });
    const r = await list("?q=" + enc("chat"));
    const mine = r.rows.filter((c: { phone: string }) => [CUST, QUIET].includes(c.phone));
    expect(mine.map((c: { phone: string }) => c.phone)).toEqual([CUST, QUIET]);
    expect(mine[0]).toMatchObject({ customer: "FITRAH JAYA CHAT", text: "halo?", dir: "in", unread: 2, wrote_in: true });
    expect(mine[1]).toMatchObject({ unread: 0, wrote_in: false, dir: "out" });
    const all = await list();
    expect(all.rows.find((c: { phone: string }) => c.phone === REP)).toMatchObject({ rep_name: "Free Antony" });
    expect(all.unreadTotal).toBeGreaterThanOrEqual(2);
  });

  it("search matches a local number, an SO number and a rep name", async () => {
    await out(CUST, "x", 5);
    await out(REP, "y", 5);
    const phones = async (q: string) => (await list("?q=" + enc(q))).rows.map((c: { phone: string }) => c.phone);
    expect(await phones("0813-5700-0001")).toContain(CUST);
    expect(await phones(`${P}/SO-1`)).toContain(CUST);
    expect(await phones("free antony")).toEqual([REP]);
  });

  it("the thread merges both directions in time order; opening it marks it read", async () => {
    await out(CUST, "Pesanan Anda telah kami terima", 30, { read: true });
    await inbound(CUST, "sudah sampai mana?", 10);
    await out(CUST, "Pengiriman dijadwalkan", 2, { milestone: "delivery_scheduled", status: "queued" });
    const t = await thread(CUST);
    expect(t.messages.map((m: { dir: string; text: string }) => [m.dir, m.text])).toEqual([
      ["out", "Pesanan Anda telah kami terima"],
      ["in", "sudah sampai mana?"],
      ["out", "Pengiriman dijadwalkan"],
    ]);
    expect(t.messages[0].read_at).not.toBeNull();
    expect(t.canReply).toBe(true);
    await app.inject({ method: "POST", url: `/api/notify/chats/${enc(CUST)}/read`, headers: TOKEN, payload: {} });
    expect((await list("?q=" + enc("chat"))).rows.find((c: { phone: string }) => c.phone === CUST).unread).toBe(0);
  });

  it("an admin reply is sent, logged with who sent it, and shows in the thread", async () => {
    await inbound(CUST, "bisa dikirim besok?", 5);
    expect((await replyTo(CUST, "Baik Pak, kami cek dulu.", {})).statusCode).toBe(401);
    expect((await replyTo(CUST, "   ")).statusCode).toBe(400);
    expect((await replyTo(CUST, "x".repeat(2001))).statusCode).toBe(400);
    const r = await replyTo(CUST, "Baik Pak, kami cek dulu.");
    expect(r.statusCode).toBe(200);
    expect(sent).toEqual([{ to: CUST, text: "Baik Pak, kami cek dulu." }]);
    const [row] = await db`
      select milestone, status, meta->>'by' as by, so_no from notify_ledger where to_number = ${CUST} and milestone = 'manual_reply'`;
    expect(row).toMatchObject({ milestone: "manual_reply", status: "stubbed", by: "Rina", so_no: `${P}/SO-1` });
    const t = await thread(CUST);
    expect(t.messages.at(-1)).toMatchObject({ dir: "out", text: "Baik Pak, kami cek dulu.", milestone: "manual_reply", by: "Rina" });
  });

  it("replies are refused to numbers that never wrote in, opted-out numbers, and while the kill switch is on", async () => {
    await out(QUIET, "Pesanan Anda telah kami terima", 5);
    expect((await replyTo(QUIET, "Halo")).statusCode).toBe(409);
    expect((await thread(QUIET)).replyBlockedReason).toContain("sudah mengirim pesan");

    await inbound(CUST, "STOP", 3);
    await db`insert into notify_contacts (phone_e164, consent_state, opted_out_at) values (${CUST}, 'opted_out', now())`;
    expect((await replyTo(CUST, "Halo")).statusCode).toBe(409);
    expect((await thread(CUST))).toMatchObject({ optedOut: true, canReply: false });
    await db`update notify_contacts set consent_state = 'explicit' where phone_e164 = ${CUST}`;

    await db`update notify_settings set kill_switch = true where id = 1`;
    const k = await replyTo(CUST, "Halo");
    expect(k.statusCode).toBe(409);
    expect(k.json().error).toContain("Saklar darurat");
    await db`update notify_settings set kill_switch = false where id = 1`;
    expect((await replyTo(CUST, "Halo")).statusCode).toBe(200);
    expect(sent).toHaveLength(1);
  });

  it("rejects an invalid number in the path", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notify/chats/021-555" })).statusCode).toBe(400);
  });
});
