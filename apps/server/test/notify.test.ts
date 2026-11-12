/**
 * Kabar Pesanan MVP: message catalogue, test-pipeline routes (stub channel, no
 * database), the read-only Selaras lookup, and the gateway adapter contract.
 */
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/db/client.js", () => ({ getSql: () => null, pingDatabase: async () => false }));

import {
  FOOTER,
  MILESTONES,
  formatDateId,
  formatItems,
  renderCustomerMessage,
  renderSalesCc,
  sampleContext,
  type OrderContext,
} from "../src/notify/messages.js";
import { GatewayChannel, StubChannel, setChannelForTests } from "../src/notify/channel.js";
import { maskPhone, requestItem, soLineItem } from "../src/notify/erpLookup.js";
import { notifyRoutes, resetNotifyRateLimit, toLocalDisplay } from "../src/routes/notify.js";

const NOW = new Date("2026-11-10T10:00:00Z");
const ctx = (over: Partial<OrderContext> = {}): OrderContext => ({ ...sampleContext(NOW, "Rahmanto", "0813-1111-2222"), ...over });

describe("messages", () => {
  it("formats Indonesian dates", () => {
    expect(formatDateId("2026-11-11")).toBe("Rabu, 11 November 2026");
    expect(formatDateId("not a date")).toBe("not a date");
  });

  it("caps item lists at three lines", () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ label: `ITEM ${i}`, qty: i + 1 }));
    const out = formatItems(items);
    expect(out.split("\n")).toHaveLength(4);
    expect(out).toContain("dan 2 item lainnya");
  });

  it.each(MILESTONES)("%s: has SO number, sales contact, footer and no payment language", (m) => {
    const text = renderCustomerMessage(m, ctx());
    expect(text).toContain("SO.26/UJI-0001");
    expect(text).toContain("Rahmanto (0813-1111-2222)");
    expect(text.endsWith(FOOTER)).toBe(true);
    expect(text).not.toMatch(/bayar|lunas|tagihan|harga|\bRp\b|approval|disetujui/i);
  });

  it("so_received says diterima + diproses", () => {
    expect(renderCustomerMessage("so_received", ctx())).toContain("telah kami terima dan sedang diproses");
  });

  it("production_started promises no date", () => {
    const text = renderCustomerMessage("production_started", ctx());
    expect(text).toContain("sedang diproduksi di pabrik kami");
    expect(text).not.toMatch(/(Senin|Selasa|Rabu|Kamis|Jumat|Sabtu|Minggu),/);
  });

  it("delivery_scheduled quotes sj_date and surat jalan", () => {
    const text = renderCustomerMessage("delivery_scheduled", ctx());
    expect(text).toContain("telah dijadwalkan untuk dikirim");
    expect(text).toContain("No. surat jalan: KP/DO-UJI/11/26");
    expect(text).toContain("Jadwal pengiriman: Rabu, 11 November 2026");
  });

  it("delivery_scheduled pickup variant says siap diambil", () => {
    const c = ctx();
    c.delivery = { ...c.delivery!, pickup: true };
    const text = renderCustomerMessage("delivery_scheduled", c);
    expect(text).toContain("sudah siap diambil mulai Rabu, 11 November 2026");
    expect(text).not.toContain("dijadwalkan untuk dikirim");
  });

  it("partial delivery is stated", () => {
    const c = ctx();
    c.delivery = { ...c.delivery!, partial: true };
    expect(renderCustomerMessage("delivery_scheduled", c)).toContain("pengiriman sebagian");
  });

  it("introduction is opt-in", () => {
    expect(renderCustomerMessage("so_received", ctx())).not.toContain("nomor resmi notifikasi");
    expect(renderCustomerMessage("so_received", ctx(), { introduce: true })).toContain("nomor resmi notifikasi");
  });

  it("greets the recipient, falling back to the customer name", () => {
    expect(renderCustomerMessage("so_received", ctx())).toMatch(/^Halo Bapak\/Ibu Budi,/);
    expect(renderCustomerMessage("so_received", ctx({ recipientName: null }))).toMatch(/^Halo Bapak\/Ibu TOKO CONTOH JAYA,/);
  });

  it("sales CC carries the customer number and the exact customer text", () => {
    const cust = renderCustomerMessage("so_received", ctx());
    const cc = renderSalesCc("so_received", ctx(), "0812-3456-7890", cust);
    expect(cc).toContain("Salinan Kabar Pesanan");
    expect(cc).toContain("0812-3456-7890");
    expect(cc).toContain(cust);
  });
});

describe("erp row mapping", () => {
  it("1203 line: total_thickness_acp is panel, th_alu_skin is skin", () => {
    expect(
      soLineItem({ brand_text: "ALCOPAN", warna_text: "GLOSSY WHITE", total_thickness_acp: "4", th_alu_skin: "0.21", qty_order: "10.00" }),
    ).toEqual({ label: "ALCOPAN GLOSSY WHITE 4mm / 0.21", qty: 10 });
  });
  it("1236 request: th_alu_skin is panel ('Tebal'), alu is skin", () => {
    expect(
      requestItem({ sticker_text: "MACO", warna_text: "GREY WHITE", th_alu_skin: "4", alu: "0.30", qty_lembar: "100.00" }),
    ).toEqual({ label: "MACO GREY WHITE 4mm / 0.3", qty: 100 });
  });
  it("masks the first number of a multi-number field", () => {
    expect(maskPhone("0812-8311-4455 / 0813-0000-1111")).toBe("0812-****-4455");
    expect(maskPhone(null)).toBeNull();
  });
});

describe("routes (stub channel, no database)", () => {
  const build = async () => {
    const app = Fastify();
    await app.register(notifyRoutes);
    return app;
  };
  beforeEach(() => {
    setChannelForTests(new StubChannel());
    resetNotifyRateLimit();
  });
  afterEach(() => setChannelForTests(null));

  it("config lists the three milestones with trigger rules", async () => {
    const app = await build();
    const r = await app.inject({ method: "GET", url: "/api/notify/config" });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.channel.mode).toBe("stub");
    expect(body.milestones.map((m: { key: string }) => m.key)).toEqual([...MILESTONES]);
    expect(body.milestones[2].trigger).toContain("tbl_1082");
    // Linking is offered once the gateway is configured; here it is not.
    expect(body.gateway).toEqual({ configured: false, linked: false, detail: "Gateway belum terpasang." });
  });

  it("sends to the customer and CCs sales, all stubbed", async () => {
    const app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/notify/test",
      payload: { milestone: "delivery_scheduled", customerNumber: "0812-3456-7890", salesNumber: "+62 813 1111 2222", salesName: "Rahmanto" },
    });
    expect(r.statusCode).toBe(200);
    const b = r.json();
    expect(b.messages).toHaveLength(2);
    expect(b.messages[0]).toMatchObject({ role: "customer", to: "+6281234567890", status: "stubbed" });
    expect(b.messages[1]).toMatchObject({ role: "sales_cc", to: "+6281311112222", status: "stubbed" });
    expect(b.messages[0].text).toContain("Rahmanto (0813-1111-2222)");
    expect(b.context.source).toBe("sample");
    expect(b.warnings.join(" ")).toContain("Database tidak tersedia");
  });

  it("sales CC is optional", async () => {
    const app = await build();
    const r = await app.inject({ method: "POST", url: "/api/notify/test", payload: { milestone: "so_received", customerNumber: "081234567890" } });
    expect(r.json().messages).toHaveLength(1);
  });

  it("rejects bad milestone, landline and bad CC", async () => {
    const app = await build();
    const bad = (payload: object) => app.inject({ method: "POST", url: "/api/notify/test", payload });
    expect((await bad({ milestone: "paid", customerNumber: "081234567890" })).statusCode).toBe(400);
    expect((await bad({ milestone: "so_received", customerNumber: "021-5551234" })).statusCode).toBe(400);
    expect((await bad({ milestone: "so_received", customerNumber: "081234567890", salesNumber: "123" })).statusCode).toBe(400);
  });

  it("SO lookup without ERP configured is a clear 503", async () => {
    const app = await build();
    const r = await app.inject({
      method: "POST",
      url: "/api/notify/test",
      payload: { milestone: "so_received", customerNumber: "081234567890", soNo: "SO.26/12821" },
    });
    expect(r.statusCode).toBe(503);
  });

  it("formats local display numbers", () => {
    expect(toLocalDisplay("+6281234567890")).toBe("0812-3456-7890");
  });
});

describe("admin token", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("writes need x-notify-token when NOTIFY_ADMIN_TOKEN is set", async () => {
    vi.stubEnv("NOTIFY_ADMIN_TOKEN", "s3cret");
    vi.resetModules();
    const { notifyRoutes: routes } = await import("../src/routes/notify.js");
    const app = Fastify();
    await app.register(routes);
    const payload = { milestone: "so_received", customerNumber: "081234567890" };
    expect((await app.inject({ method: "POST", url: "/api/notify/test", payload })).statusCode).toBe(401);
    const ok = await app.inject({ method: "POST", url: "/api/notify/test", payload, headers: { "x-notify-token": "s3cret" } });
    expect(ok.statusCode).toBe(200);
  });
});

describe("lookupOrder against a fake Selaras", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });
  it("builds context from 1202/1203/1236/1082 and never exposes the raw phone", async () => {
    vi.stubEnv("SELARAS_BASE_URL", "https://erp.test/kencana/api");
    vi.stubEnv("SELARAS_SECRET_KEY", "k");
    vi.stubEnv("SELARAS_SECRET_TOKEN", "t");
    vi.resetModules();
    const { lookupOrder } = await import("../src/notify/erpLookup.js");
    const seen: string[] = [];
    const fake = async (url: string, init: RequestInit) => {
      seen.push(url);
      expect((init.headers as Record<string, string>)["x-secret-key"]).toBe("k");
      const table = /\/table\/([^?]+)/.exec(url)![1];
      const data: Record<string, unknown[]> = {
        tbl_1202_SOSalesOrderNID: [{ po_no: "SO.26/12821", customer_name_label: "FITRAH JAYA", penerima: "Bp. Panji", kontak_penerima: "0812-8311-4455", sales_name_label: "Free Antony", top_limit: "Cash before Delivery", status_order: "Half Done" }],
        tbl_1203_SOSalesOrderDetailNID: [{ brand_text: "ALCOPAN", warna_text: "PURE WHITE", total_thickness_acp: "4", th_alu_skin: "0.21", qty_order: "5" }],
        tbl_1236_DBRequestProduksiID: [{ so_ms: "SO", wo_no: "WO.26/00041", sticker_text: "ALCOPAN", warna_text: "PURE WHITE", th_alu_skin: "4", alu: "0.21", qty_lembar: "5" }, { so_ms: "MS", wo_no: "WO.26/00041" }],
        tbl_1082_SOLogisticPID: [{ no_sj: "KP/DO-13224/11/26", sj_date: "2026-11-11", cara_kirim_label: "di Ambil", cancel_order: "No" }],
      };
      return new Response(JSON.stringify({ success: true, data: data[table!] ?? [] }), { status: 200 });
    };
    const r = await lookupOrder("SO.26/12821", { salesWa: null, salesNameOverride: null, fetchImpl: fake });
    expect(seen[0]).toContain("po_no=SO.26%2F12821");
    expect(r.context).toMatchObject({ soNo: "SO.26/12821", customerName: "FITRAH JAYA", recipientName: "Bp. Panji", salesName: "Free Antony", source: "erp" });
    expect(r.context.production?.items).toHaveLength(1);
    expect(r.context.delivery).toMatchObject({ sjNo: "KP/DO-13224/11/26", sjDate: "2026-11-11", pickup: true, partial: true });
    expect(r.erpRecipientPhoneMasked).toBe("0812-****-4455");
    expect(JSON.stringify(r)).not.toContain("8311-4455");
  });
});

describe("GatewayChannel", () => {
  it("posts phone, text and idempotency key with the shared secret", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ message_id: "3EB0ABC" }), { status: 200 });
    };
    const ch = new GatewayChannel("http://wa-gateway:8080/", "gw", fake);
    const r = await ch.send({ to: "+6281234567890", text: "hi", idempotencyKey: "k1" });
    expect(r).toEqual({ status: "sent", providerMessageId: "3EB0ABC", error: null });
    expect(calls[0]!.url).toBe("http://wa-gateway:8080/send");
    expect((calls[0]!.init.headers as Record<string, string>)["x-gateway-secret"]).toBe("gw");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ to_pn: "+6281234567890", text: "hi", idempotency_key: "k1" });
  });
  it("reports failure without throwing", async () => {
    const ch = new GatewayChannel("http://x", "gw", async () => { throw new Error("ECONNREFUSED"); });
    const r = await ch.send({ to: "+6281234567890", text: "hi", idempotencyKey: "k" });
    expect(r.status).toBe("failed");
    expect(r.error).toContain("ECONNREFUSED");
  });
});
