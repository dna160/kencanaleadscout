# wa-gateway

The WhatsApp channel for Kabar Pesanan (PRD `docs/customer-notifications/PRD.md` §10, WP-5).

It's a self-hosted Go service built on [whatsmeow](https://github.com/tulir/whatsmeow). It runs as a linked device, like WhatsApp Web, on **one dedicated number**: never a rep's number, the main sales number, or the Qontak number.

LeadScout hands it a phone number and a text. The gateway:
- owns the WhatsApp session;
- paces sends;
- turns phone numbers into WhatsApp's internal user IDs (LIDs) and back;
- reports receipts, replies and connection state back to LeadScout.

## Deploy (Railway)

1. **New service** `wa-gateway` in the LeadScout project.
   - Source: this repo, **Root Directory `apps/wa-gateway`**. `railway.toml` here sets the Dockerfile build, a `/healthz` health check and **exactly one replica**.
   - Don't expose it publicly. LeadScout reaches it over private networking.
2. **Variables**

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | the LeadScout Postgres (`${{Postgres.DATABASE_URL}}`). The gateway uses its own schema, `wa_store`. |
   | `WA_GATEWAY_SECRET` | a random string of 16+ characters. Set the same value on LeadScout. |
   | `LEADSCOUT_EVENTS_URL` | `http://<leadscout>.railway.internal:<port>/api/notify/wa-events` |
   | `WA_MIN_GAP_S` / `WA_MAX_GAP_S` | pacing between sends, default `8` / `25` |
   | `WA_HOURLY_CAP` / `WA_DAILY_CAP` | default `40` / `200`. Raise slowly after the shadow weeks. |

3. **On LeadScout:**
   - `NOTIFY_CHANNEL=gateway`
   - `WA_GATEWAY_URL=http://wa-gateway.railway.internal:8080`
   - `WA_GATEWAY_SECRET` (same value as on the gateway)
   - `NOTIFY_ADMIN_TOKEN`
4. **Pair** from `/notify`, or call `GET /api/notify/gateway/pair` with the admin token. Then scan the QR from the dedicated phone: *Linked devices → Link a device*. Alternatively, `POST /api/notify/gateway/pair-phone {"phone": "08…"}` returns an 8-character code to type on the phone instead.

The session survives redeploys. Re-pair only after a `logged_out` event.

## API

All routes need `x-gateway-secret`, except `/healthz`.

| Route | Body → answer |
|---|---|
| `POST /send` | `{to_pn, text, idempotency_key}` → `{message_id, queued, status, duplicate}` |
| `POST /check` | `{pns: [...]}` → `[{pn, on_whatsapp, jid, lid?}]` |
| `GET /health` | → `{connected, logged_in, jid, queue_depth, sent_today, phone_last_seen}` |
| `GET /pair` | → `{paired, jid?, qr?, expires_in?, error?}`. `qr` is the string to render as a QR code. |
| `POST /pair/phone` | `{phone}` → `{code}` |
| `GET /healthz` | liveness |

- **`/send` stores the message before answering**, in table `wa_store.wa_outbox`, so a restart never loses one. A repeated `idempotency_key` within 7 days returns the original `message_id` and sends nothing.
- **Callbacks** go to `LEADSCOUT_EVENTS_URL` as `POST {type, ...}` with the same secret:
  - `receipt` (`server_ack` / `delivered` / `read` / `failed`)
  - `inbound` (`from_pn` and/or `from_lid`, `text`)
  - `logged_out`, `temporary_ban`, `disconnected`, `connected`

## Operating safely (PRD §10.4)

- **One message at a time:** "typing…" first, then a random 8–25 s gap. Hourly and daily caps apply.
- **Nothing is dropped:** while disconnected or logged out, messages wait in the outbox.
- **A number with no WhatsApp account** fails permanently as `not_on_whatsapp`. The gateway looks the number up once before giving up.
- **Don't run two copies on one session.** WhatsApp disconnects the older one (`StreamReplaced`).
- **Keep the primary phone powered and online.** WhatsApp drops a linked device after the primary has been inactive for a long time.

## Develop

```bash
go test ./...                        # unit tests (fake WhatsApp, in-memory outbox)
DATABASE_URL=postgres://… go test ./...   # also the Postgres outbox
```

whatsmeow is pinned to a commit from 2026-10-27 (`go.mod`). Bump it deliberately: WhatsApp protocol changes land there first.
