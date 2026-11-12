/**
 * Kabar Pesanan — outbound channel.
 *
 * One interface, two implementations:
 *  - StubChannel (default): sends nothing. Returns status "stubbed" so the
 *    pipeline, ledger and UI can be exercised end-to-end before any WhatsApp
 *    number is paired.
 *  - GatewayChannel: POSTs to the whatsmeow sidecar (`apps/wa-gateway`, PRD §10).
 *    The gateway owns the WhatsApp session, LID↔PN mapping, pacing and
 *    receipts; this side only hands it a phone number and text.
 *
 * Switching is config only (NOTIFY_CHANNEL), so the live deriver never knows
 * which one it is talking to.
 */
import { config } from "../config.js";

export interface OutboundMessage {
  /** E.164, e.g. "+6281234567890". */
  to: string;
  text: string;
  /** Repeated sends with the same key must not produce a second WhatsApp message. */
  idempotencyKey: string;
  /** Optional image; `text` is then its caption. */
  media?: { mime: string; dataB64: string };
}

export type SendStatus = "stubbed" | "queued" | "sent" | "failed";

export interface SendResult {
  status: SendStatus;
  providerMessageId: string | null;
  error: string | null;
}

export interface ChannelHealth {
  connected: boolean;
  detail: string;
}

export interface Channel {
  readonly mode: "stub" | "gateway";
  send(msg: OutboundMessage): Promise<SendResult>;
  health(): Promise<ChannelHealth>;
}

export class StubChannel implements Channel {
  readonly mode = "stub" as const;
  private seq = 0;
  async send(_msg: OutboundMessage): Promise<SendResult> {
    this.seq += 1;
    return { status: "stubbed", providerMessageId: `stub-${Date.now()}-${this.seq}`, error: null };
  }
  async health(): Promise<ChannelHealth> {
    return {
      connected: false,
      detail: "Mode STUB: pesan tidak dikirim ke WhatsApp. Isi pesan dicatat di Riwayat.",
    };
  }
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export class GatewayChannel implements Channel {
  readonly mode = "gateway" as const;
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly timeoutMs = 15_000,
  ) {}

  private url(path: string): string {
    return `${this.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    if (!this.baseUrl) return { status: "failed", providerMessageId: null, error: "WA_GATEWAY_URL belum diisi." };
    try {
      const res = await this.fetchImpl(this.url("/send"), {
        method: "POST",
        headers: { "content-type": "application/json", "x-gateway-secret": this.secret },
        body: JSON.stringify({
          to_pn: msg.to,
          text: msg.text,
          idempotency_key: msg.idempotencyKey,
          ...(msg.media ? { image_b64: msg.media.dataB64, mime: msg.media.mime } : {}),
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      const body = (await res.json().catch(() => ({}))) as { message_id?: string; error?: string; queued?: boolean };
      if (!res.ok) {
        return { status: "failed", providerMessageId: null, error: body.error ?? `gateway HTTP ${res.status}` };
      }
      return { status: body.queued ? "queued" : "sent", providerMessageId: body.message_id ?? null, error: null };
    } catch (err) {
      return { status: "failed", providerMessageId: null, error: `gateway tidak terjangkau: ${(err as Error).message}` };
    }
  }

  async health(): Promise<ChannelHealth> {
    if (!this.baseUrl) return { connected: false, detail: "WA_GATEWAY_URL belum diisi." };
    try {
      const res = await this.fetchImpl(this.url("/health"), {
        method: "GET",
        headers: { "x-gateway-secret": this.secret },
        signal: AbortSignal.timeout(5_000),
      });
      const body = (await res.json().catch(() => ({}))) as { connected?: boolean; logged_in?: boolean };
      const ok = res.ok && Boolean(body.connected) && Boolean(body.logged_in);
      return { connected: ok, detail: ok ? "Gateway terhubung dan nomor tertaut." : "Gateway hidup tetapi nomor belum tertaut." };
    } catch (err) {
      return { connected: false, detail: `Gateway tidak terjangkau: ${(err as Error).message}` };
    }
  }
}

export interface PairState {
  paired: boolean;
  jid?: string;
  qr?: string;
  expires_in?: number;
  error?: string;
}

/** Gateway-only extras (pairing, number check) used by the /notify admin routes. */
export class GatewayAdmin {
  constructor(
    private readonly baseUrl: string,
    private readonly secret: string,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 30_000): Promise<T> {
    if (!this.baseUrl) throw new Error("WA_GATEWAY_URL belum diisi.");
    const res = await this.fetchImpl(`${this.baseUrl.replace(/\/+$/, "")}${path}`, {
      method,
      headers: { "x-gateway-secret": this.secret, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) throw new Error(data.error ?? `gateway HTTP ${res.status}`);
    return data;
  }

  pair(): Promise<PairState> {
    return this.call<PairState>("GET", "/pair");
  }
  pairPhone(phoneE164: string): Promise<{ code: string }> {
    return this.call<{ code: string }>("POST", "/pair/phone", { phone: phoneE164 });
  }
  check(pns: string[]): Promise<{ pn: string; on_whatsapp: boolean; jid?: string; lid?: string }[]> {
    return this.call("POST", "/check", { pns });
  }
}

/** The gateway's address and secret are set: it can be linked and checked. */
export function gatewayConfigured(): boolean {
  return Boolean(config.notify.gatewayUrl && config.notify.gatewaySecret);
}

/**
 * Linking the number works as soon as the gateway is configured, whatever the
 * send channel: an admin links the device first (Konfigurasi), and the channel
 * decides separately whether messages go through it.
 */
export function getGatewayAdmin(): GatewayAdmin | null {
  return gatewayConfigured() ? new GatewayAdmin(config.notify.gatewayUrl, config.notify.gatewaySecret) : null;
}

/** The gateway's own link status, independent of the send channel. */
export async function gatewayLinkStatus(): Promise<{ configured: boolean; linked: boolean; detail: string }> {
  if (!gatewayConfigured()) return { configured: false, linked: false, detail: "Gateway belum terpasang." };
  const h = await new GatewayChannel(config.notify.gatewayUrl, config.notify.gatewaySecret).health();
  return { configured: true, linked: h.connected, detail: h.detail };
}

let cached: Channel | null = null;

/** The configured channel (memoized). Stub unless NOTIFY_CHANNEL=gateway. */
export function getChannel(): Channel {
  if (cached) return cached;
  cached =
    config.notify.channel === "gateway"
      ? new GatewayChannel(config.notify.gatewayUrl, config.notify.gatewaySecret)
      : new StubChannel();
  return cached;
}

/** Test hook. */
export function setChannelForTests(c: Channel | null): void {
  cached = c;
}
