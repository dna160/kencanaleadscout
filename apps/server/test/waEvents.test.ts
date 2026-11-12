/**
 * Kabar Pesanan WP-5 (LeadScout side): gateway callbacks — receipts, STOP /
 * MULAI, LID learning, shadow grading, reply forwarding — and the pairing proxy.
 */
import Fastify from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env["WA_GATEWAY_SECRET"] = "gw-secret-0123456789";
process.env["NOTIFY_ADMIN_TOKEN"] = "admin-token-wp5";

const { autoReplyText, forwardText, sniffImage } = await import("../src/notify/inbound.js");

/** A real 1×1 PNG, and the first bytes of a JPEG and a WebP. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]);
const WEBP = new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 ");
const { GatewayAdmin } = await import("../src/notify/channel.js");

describe("image detection (pure)", () => {
  it("trusts the bytes, not the label", () => {
    expect(sniffImage(Buffer.from(PNG_B64, "base64"))).toBe("image/png");
    expect(sniffImage(JPEG)).toBe("image/jpeg");
    expect(sniffImage(WEBP)).toBe("image/webp");
    expect(sniffImage(new TextEncoder().encode("%PDF-1.7"))).toBeNull();
    expect(sniffImage(new Uint8Array())).toBeNull();
  });
  it("GatewayChannel sends an image as image_b64 + mime, text as its caption", async () => {
    const { GatewayChannel } = await import("../src/notify/channel.js");
    let body: Record<string, unknown> = {};
    const ch = new GatewayChannel("http://gw", "s", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ message_id: "m1", queued: true }), { status: 200 });
    });
    await ch.send({ to: "+6281234567890", text: "Foto", idempotencyKey: "k", media: { mime: "image/png", dataB64: PNG_B64 } });
    expect(body).toEqual({ to_pn: "+6281234567890", text: "Foto", idempotency_key: "k", image_b64: PNG_B64, mime: "image/png" });
  });
});

describe("reply texts and the gateway admin client (pure)", () => {
  it("the auto-reply names the rep when known", () => {
    expect(autoReplyText("Free Antony", "0813-5600-0001")).toContain("sales Anda, Free Antony (0813-5600-0001)");
    expect(autoReplyText(null, null)).toContain("kami teruskan ke sales Anda;");
    // Admins can now answer from the Pesan tab: the number must not claim to be unmonitored.
    expect(autoReplyText("Free Antony", null)).not.toMatch(/tidak dipantau/);
    expect(forwardText("FITRAH JAYA", "+6281355000001", "SO.1", "sudah sampai mana?")).toBe(
      "💬 *Balasan pelanggan* — FITRAH JAYA (0813-5500-0001) · SO SO.1\n\nsudah sampai mana?",
    );
  });
  it("GatewayAdmin calls /pair and /pair/phone with the secret", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const gw = new GatewayAdmin("http://wa-gateway:8080/", "s", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify(url.endsWith("/pair") ? { paired: false, qr: "2@x" } : { code: "ABCD-EFGH" }), { status: 200 });
    });
    expect(await gw.pair()).toEqual({ paired: false, qr: "2@x" });
    expect(await gw.pairPhone("+6281100000000")).toEqual({ code: "ABCD-EFGH" });
    expect(calls.map((c) => c.url)).toEqual(["http://wa-gateway:8080/pair", "http://wa-gateway:8080/pair/phone"]);
    expect((calls[0]!.init.headers as Record<string, string>)["x-gateway-secret"]).toBe("s");
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const hasDb = Boolean(process.env.DATABASE_URL);
const P = "wp5in";
const CUST = "+6281355000001";
const REP = "+6281356000001";

describe.skipIf(!hasDb)("gateway callbacks over the real schema", async () => {
  const dbmod = await import("../src/db/client.js");
  const routes = await import("../src/routes/wa-events.js");
  const notifyRoutes = await import("../src/routes/notify.js");
  const channel = await import("../src/notify/channel.js");
  const { runErpStockMigrations } = await import("../src/db/migrateErpStock.js");
  const { runOrderMigrations } = await import("../src/db/migrateOrders.js");
  const { runNotifyMigrations } = await import("../src/db/migrateNotify.js");

  let db: NonNullable<ReturnType<typeof dbmod.getSql>>;
  const sent: { to: string; text: string; media?: { mime: string; dataB64: string } }[] = [];
  const ch = {
    mode: "stub" as const,
    async send(m: { to: string; text: string; media?: { mime: string; dataB64: string } }) {
      sent.push({ to: m.to, text: m.text, ...(m.media ? { media: m.media } : {}) });
      return { status: "stubbed" as const, providerMessageId: `stub-${sent.length}`, error: null };
    },
    async health() {
      return { connected: true, detail: "" };
    },
  };

  const app = Fastify();
  const post = (body: unknown, secret = "gw-secret-0123456789") =>
    app.inject({ method: "POST", url: "/api/notify/wa-events", headers: { "x-gateway-secret": secret }, payload: body as object });
  let mid = 0;
  const msgId = () => `${P}-msg-${Date.now()}-${++mid}`;

  async function cleanup(): Promise<void> {
    await db`delete from notify_ledger where idempotency_key like ${`${P}:%`} or to_number in (${CUST}, ${REP}, '+6281355000002', '+6281355000003')`;
    await db`delete from notify_media where id in (select media_id from notify_inbound where message_id like ${`${P}%`})`;
    await db`delete from notify_inbound where message_id like ${`${P}%`}`;
    await db`delete from notify_contacts where phone_e164 like '+6281355%' or phone_e164 like '+6281356%'`;
    await db`delete from notify_sales_contacts where erp_sales_id like ${`${P}%`}`;
    await db`delete from erp_so_header where id like ${`${P}%`}`;
  }

  beforeAll(async () => {
    const s = dbmod.getSql();
    if (!s) throw new Error("DATABASE_URL is set but getSql() returned null");
    db = s;
    await runErpStockMigrations(db);
    await runOrderMigrations(db);
    await runNotifyMigrations(db);
    channel.setChannelForTests(ch);
    await app.register(routes.waEventRoutes);
    await app.register(notifyRoutes.notifyRoutes);
  }, 60_000);
  beforeEach(async () => {
    sent.length = 0;
    await cleanup();
    await db`insert into notify_sales_contacts (erp_sales_id, sales_name, phone_e164) values (${`${P}-rep`}, ${"Free Antony"}, ${REP})`;
    await db`
      insert into erp_so_header (id, po_no, so_number, customer_name_text, sales_name_id, sales_name_text, kontak_penerima)
      values (${`${P}-h1`}, ${`${P}/SO-1`}, ${`${P}/SO-1`}, ${"FITRAH JAYA"}, ${`${P}-rep`}, ${"Free Antony"}, ${"0813-5500-0001"})
    `;
  });
  afterAll(async () => {
    await cleanup();
    channel.setChannelForTests(null);
    await dbmod.closeDatabase();
  });

  /** A notification the customer already received (what a reply answers). */
  async function seedSent(o: { mode: "live" | "shadow"; to: string; pmid?: string; status?: string }): Promise<void> {
    await db`
      insert into notify_ledger (mode, milestone, so_no, recipient_role, to_number, body, channel, status,
                                 provider_message_id, idempotency_key, sent_at)
      values (${o.mode}, 'so_received', ${`${P}/SO-1`}, 'customer', ${o.to}, ${"Halo"}, 'gateway', ${o.status ?? "sent"},
              ${o.pmid ?? null}, ${`${P}:${o.mode}:${o.to}:${Math.random()}`}, now() - interval '1 hour')
    `;
  }

  it("rejects a wrong secret", async () => {
    expect((await post({ type: "receipt" }, "nope")).statusCode).toBe(401);
    expect((await post({})).statusCode).toBe(400);
  });

  it("receipts move the ledger row: queued → sent → read; failed records the reason", async () => {
    await seedSent({ mode: "live", to: CUST, pmid: `${P}-m1`, status: "queued" });
    await post({ type: "receipt", message_id: `${P}-m1`, status: "server_ack" });
    await post({ type: "receipt", message_id: `${P}-m1`, status: "read", ts: "2026-11-12T03:00:00Z" });
    const [r] = await db`select status, read_at, delivered_at from notify_ledger where provider_message_id = ${`${P}-m1`}`;
    expect(r).toMatchObject({ status: "sent" });
    expect((r!.read_at as Date).toISOString()).toBe("2026-11-12T03:00:00.000Z");
    expect(r!.delivered_at).not.toBeNull();

    await seedSent({ mode: "live", to: CUST, pmid: `${P}-m2`, status: "queued" });
    const res = await post({ type: "receipt", message_id: `${P}-m2`, status: "failed", error: "not_on_whatsapp" });
    expect(res.json()).toEqual({ ok: true, updated: 1 });
    const [f] = await db`select status, error from notify_ledger where provider_message_id = ${`${P}-m2`}`;
    expect(f).toEqual({ status: "failed", error: "not_on_whatsapp" });
  });

  it("STOP opts the number out once and confirms; MULAI opts back in", async () => {
    const id = msgId();
    expect((await post({ type: "inbound", message_id: id, from_pn: CUST, text: "stop" })).json()).toMatchObject({ action: "opted_out" });
    const [c] = await db`select consent_state, opted_out_at from notify_contacts where phone_e164 = ${CUST}`;
    expect(c!.consent_state).toBe("opted_out");
    expect(sent).toEqual([{ to: CUST, text: expect.stringContaining("tidak akan menerima notifikasi") }]);
    // The gateway retrying the same callback changes nothing.
    expect((await post({ type: "inbound", message_id: id, from_pn: CUST, text: "stop" })).json()).toMatchObject({ action: "duplicate" });
    expect(sent).toHaveLength(1);

    expect((await post({ type: "inbound", message_id: msgId(), from_pn: CUST, text: "MULAI" })).json()).toMatchObject({ action: "opted_in" });
    const [c2] = await db`select consent_state, opted_out_at from notify_contacts where phone_e164 = ${CUST}`;
    expect(c2).toEqual({ consent_state: "explicit", opted_out_at: null });
  });

  it("learns LID↔phone, then resolves a LID-only sender; an unknown LID is kept, nothing sent", async () => {
    await post({ type: "inbound", message_id: msgId(), from_pn: "+6281355000002", from_lid: "987654321", text: "BERHENTI" });
    const [c] = await db`select lid from notify_contacts where phone_e164 = '+6281355000002'`;
    expect(c!.lid).toBe("987654321");
    const r = (await post({ type: "inbound", message_id: msgId(), from_lid: "987654321", text: "mulai" })).json();
    expect(r).toMatchObject({ action: "opted_in", phone: "+6281355000002" });

    const before = sent.length;
    expect((await post({ type: "inbound", message_id: msgId(), from_lid: "111", text: "halo" })).json()).toMatchObject({ action: "unresolved" });
    expect(sent.length).toBe(before);
  });

  it("a rep's BENAR/SALAH grades their latest shadow message", async () => {
    await seedSent({ mode: "shadow", to: REP });
    const r = (await post({ type: "inbound", message_id: msgId(), from_pn: REP, text: "SALAH: tanggal kirim keliru" })).json();
    expect(r).toMatchObject({ action: "shadow_grade" });
    const [row] = await db`select meta from notify_ledger where mode = 'shadow' and to_number = ${REP}`;
    expect((row!.meta as { grade: unknown }).grade).toMatchObject({ verdict: "salah", note: "tanggal kirim keliru" });
    expect(sent).toEqual([]); // no ack spam to reps
  });

  it("a customer reply is forwarded to the SO's rep, with one auto-reply per 24 h", async () => {
    await seedSent({ mode: "live", to: CUST });
    const r1 = (await post({ type: "inbound", message_id: msgId(), from_pn: CUST, text: "sudah sampai mana?" })).json();
    expect(r1).toMatchObject({ action: "forwarded", soNo: `${P}/SO-1` });
    expect(sent.map((s) => s.to)).toEqual([REP, CUST]);
    expect(sent[0]!.text).toContain("Balasan pelanggan");
    expect(sent[0]!.text).toContain("sudah sampai mana?");
    expect(sent[1]!.text).toContain("Free Antony (0813-5600-0001)");

    await post({ type: "inbound", message_id: msgId(), from_pn: CUST, text: "halo?" });
    expect(sent.map((s) => s.to)).toEqual([REP, CUST, REP]); // forwarded again, no second auto-reply
    const kinds = await db`select milestone from notify_ledger where to_number in (${CUST}, ${REP}) and idempotency_key like 'system:%' order by id`;
    expect(kinds.map((k) => k.milestone)).toEqual(["reply_forward", "auto_reply", "reply_forward"]);
  });

  it("a customer's photo is stored, forwarded to the rep AS a photo, and shown with its caption", async () => {
    await seedSent({ mode: "live", to: CUST });
    const id = msgId();
    const big = "A".repeat(2 * 1024 * 1024); // the callback route must accept multi-MB bodies
    const r = await post({ type: "inbound", message_id: id, from_pn: CUST, text: "barang sampai rusak",
      media: { mime: "image/jpeg", data_b64: PNG_B64, size: 70 }, padding: big });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ action: "forwarded" });
    const [row] = await db`select kind, media_id, media_error, text from notify_inbound where message_id = ${id}`;
    expect(row).toMatchObject({ kind: "image", media_error: null, text: "barang sampai rusak" });
    const [m] = await db`select mime, size, caption from notify_media where id = ${row!.media_id}`;
    expect(m).toEqual({ mime: "image/png", size: 70, caption: "barang sampai rusak" }); // sniffed, not the label
    const toRep = sent.find((x) => x.to === REP)!;
    expect(toRep.media).toEqual({ mime: "image/png", dataB64: PNG_B64 });
    expect(toRep.text).toContain("📷 Foto dari pelanggan");
    expect(toRep.text).toContain("barang sampai rusak");
    const [fwd] = await db`select media_id from notify_ledger where to_number = ${REP} and milestone = 'reply_forward'`;
    expect(fwd!.media_id).toBe(row!.media_id);

    // The gateway retrying the same callback stores nothing new.
    await post({ type: "inbound", message_id: id, from_pn: CUST, text: "barang sampai rusak", media: { data_b64: PNG_B64 } });
    expect((await db`select 1 from notify_media where caption = 'barang sampai rusak' and id = ${row!.media_id}`).length).toBe(1);
    expect(sent.filter((x) => x.to === REP)).toHaveLength(1);
  });

  it("a photo captioned STOP is a photo, not an opt-out; a fake image is refused but still reported", async () => {
    await seedSent({ mode: "live", to: CUST });
    const r = await post({ type: "inbound", message_id: msgId(), from_pn: CUST, text: "STOP", media: { data_b64: PNG_B64 } });
    expect(r.json()).toMatchObject({ action: "forwarded" });
    expect(await db`select 1 from notify_contacts where phone_e164 = ${CUST} and consent_state = 'opted_out'`).toHaveLength(0);

    const pdf = Buffer.from("%PDF-1.7 not an image").toString("base64");
    const id = msgId();
    await post({ type: "inbound", message_id: id, from_pn: CUST, text: "", media: { mime: "image/jpeg", data_b64: pdf } });
    const [row] = await db`select kind, media_id, media_error from notify_inbound where message_id = ${id}`;
    expect(row).toEqual({ kind: "image", media_id: null, media_error: "not_an_image" });
    expect(sent.filter((x) => x.to === REP).at(-1)!.text).toContain("tidak dapat diteruskan (not_an_image)");

    const id2 = msgId();
    await post({ type: "inbound", message_id: id2, from_pn: CUST, text: "", media_error: "too_large" });
    const [r2] = await db`select kind, media_error from notify_inbound where message_id = ${id2}`;
    expect(r2).toEqual({ kind: "image", media_error: "too_large" });
  });

  it("a message from a number we never notified is stored, not answered", async () => {
    expect((await post({ type: "inbound", message_id: msgId(), from_pn: "+6281355000003", text: "info harga?" })).json()).toMatchObject({ action: "unmatched" });
    expect(sent).toEqual([]);
  });

  it("connection state is recorded and shown on /api/notify/config", async () => {
    await post({ type: "temporary_ban", code: 101, expires_seconds: 3600 });
    const cfg = (await app.inject({ method: "GET", url: "/api/notify/config" })).json();
    expect(cfg.live.gateway).toMatchObject({ state: "temporary_ban", detail: "code 101, expires in 3600 s" });
    await post({ type: "connected" });
    expect((await app.inject({ method: "GET", url: "/api/notify/config" })).json().live.gateway.state).toBe("connected");
  });

  it("the pairing proxy needs the admin token and a gateway channel", async () => {
    expect((await app.inject({ method: "GET", url: "/api/notify/gateway/pair" })).statusCode).toBe(401);
    const r = await app.inject({ method: "GET", url: "/api/notify/gateway/pair", headers: { "x-notify-token": "admin-token-wp5" } });
    expect(r.statusCode).toBe(409); // NOTIFY_CHANNEL is stub here
  });
});
