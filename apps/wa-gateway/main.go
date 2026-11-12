// wa-gateway — Kabar Pesanan's WhatsApp channel (PRD §10, WP-5).
//
// A linked device (WhatsApp Web multi-device) on ONE dedicated number, via
// whatsmeow. The session lives in Postgres schema `wa_store`, so a redeploy
// never needs re-pairing. LeadScout talks to it over Railway internal
// networking; it calls LeadScout back with receipts, inbound replies and
// connection state.
//
// Env:
//
//	DATABASE_URL          Postgres (the same Railway Postgres as LeadScout)
//	WA_GATEWAY_SECRET     shared secret, both directions (x-gateway-secret)
//	LEADSCOUT_EVENTS_URL  e.g. http://leadscout.railway.internal:8080/api/notify/wa-events
//	PORT                  default 8080
//	WA_MIN_GAP_S / WA_MAX_GAP_S   pacing, default 8 / 25
//	WA_HOURLY_CAP / WA_DAILY_CAP  default 40 / 200
package main

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
)

const schema = "wa_store"

func envInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v >= 0 {
		return v
	}
	return def
}

// withSearchPath pins every connection to the wa_store schema.
func withSearchPath(dsn string) (string, error) {
	u, err := url.Parse(dsn)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") {
		return "", errors.New("DATABASE_URL must be a postgres:// URL")
	}
	q := u.Query()
	q.Set("search_path", schema)
	u.RawQuery = q.Encode()
	return u.String(), nil
}

func main() {
	dsn := os.Getenv("DATABASE_URL")
	secret := os.Getenv("WA_GATEWAY_SECRET")
	if dsn == "" || len(secret) < 16 {
		log.Fatal("DATABASE_URL and WA_GATEWAY_SECRET (16+ chars) are required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()

	// The schema must exist before a connection can pin search_path to it.
	boot, err := sql.Open("postgres", dsn)
	if err != nil {
		log.Fatal(err)
	}
	if _, err := boot.ExecContext(ctx, `create schema if not exists `+schema); err != nil {
		log.Fatalf("create schema: %v", err)
	}
	boot.Close()

	pinned, err := withSearchPath(dsn)
	if err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("postgres", pinned)
	if err != nil {
		log.Fatal(err)
	}
	db.SetMaxOpenConns(5)

	waLogger := waLog.Stdout("wa", "INFO", false)
	container := sqlstore.NewWithDB(db, "postgres", waLogger.Sub("store"))
	if err := container.Upgrade(ctx); err != nil {
		log.Fatalf("session store upgrade: %v", err)
	}
	store, err := NewPGStore(ctx, db)
	if err != nil {
		log.Fatalf("outbox: %v", err)
	}

	notifier := &HTTPNotifier{
		URL:    os.Getenv("LEADSCOUT_EVENTS_URL"),
		Secret: secret,
		Client: &http.Client{Timeout: 30 * time.Second}, // photos make callbacks larger
	}
	if notifier.URL == "" {
		log.Print("LEADSCOUT_EVENTS_URL not set: receipts and replies will not reach LeadScout")
	}

	var wa *MeowWA
	wa, err = NewMeowWA(ctx, container, waLogger, func(evt any) { handleEvent(ctx, wa, notifier, evt) })
	if err != nil {
		log.Fatal(err)
	}
	if err := wa.Start(ctx); err != nil {
		log.Printf("connect failed (will be retried by whatsmeow): %v", err)
	}

	sender := NewSender(SenderConfig{
		MinGap:      time.Duration(envInt("WA_MIN_GAP_S", 8)) * time.Second,
		MaxGap:      time.Duration(envInt("WA_MAX_GAP_S", 25)) * time.Second,
		HourlyCap:   envInt("WA_HOURLY_CAP", 40),
		DailyCap:    envInt("WA_DAILY_CAP", 200),
		MaxAttempts: 3,
		Idle:        5 * time.Second,
	}, store, wa, notifier)
	go sender.Run(ctx)

	go func() { // dedupe window: 7 days (PRD §10.2)
		for {
			if n, err := store.Purge(ctx, time.Now().Add(-7*24*time.Hour)); err == nil && n > 0 {
				log.Printf("purged %d outbox rows older than 7 days", n)
			}
			if !sleepCtx(ctx, time.Hour) {
				return
			}
		}
	}()

	api := &API{Secret: secret, Store: store, WA: wa, Sender: sender, Now: time.Now}
	srv := &http.Server{
		Addr:              ":" + strconv.Itoa(envInt("PORT", 8080)),
		Handler:           api.Routes(),
		ReadHeaderTimeout: 10 * time.Second,
	}
	go func() {
		<-ctx.Done()
		sh, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sh)
		wa.client.Disconnect()
	}()
	log.Printf("wa-gateway listening on %s (paired=%v)", srv.Addr, wa.OwnJID() != "")
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}

// fetchImage downloads an inbound photo for the callback. A failure is
// reported, not fatal: LeadScout still records that a photo arrived.
func fetchImage(ctx context.Context, wa *MeowWA, img *waE2E.ImageMessage) (*EventMedia, string) {
	if img.GetFileLength() > MaxInboundImageBytes {
		return nil, "too_large"
	}
	dctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	data, err := wa.DownloadImage(dctx, img)
	if err != nil {
		log.Printf("image download failed: %v", err)
		return nil, "download_failed"
	}
	if len(data) > MaxInboundImageBytes {
		return nil, "too_large"
	}
	mime := img.GetMimetype()
	if mime == "" {
		mime = http.DetectContentType(data)
	}
	return &EventMedia{Mime: mime, DataB64: base64.StdEncoding.EncodeToString(data), Size: len(data)}, ""
}

// handleEvent forwards what LeadScout needs (PRD §10.2 callbacks).
func handleEvent(ctx context.Context, wa *MeowWA, n Notifier, evt any) {
	switch e := evt.(type) {
	case *events.Receipt:
		status := ""
		switch e.Type {
		case "": // ReceiptTypeDelivered
			status = "delivered"
		case "read", "read-self":
			status = "read"
		default:
			return
		}
		if e.IsFromMe && e.Type != "read-self" {
			// Our own other devices; not a customer receipt.
			return
		}
		for _, id := range e.MessageIDs {
			n.Notify(Event{Type: "receipt", MessageID: string(id), Status: status})
		}
	case *events.Message:
		if wa == nil {
			return
		}
		var ev Event
		if img, ok := InboundImage(e); ok {
			ev = Event{Type: "inbound", MessageID: string(e.Info.ID), Text: img.GetCaption()}
			ev.Media, ev.MediaError = fetchImage(ctx, wa, img)
		} else if text, ok := Inbound(e); ok {
			ev = Event{Type: "inbound", MessageID: string(e.Info.ID), Text: text}
		} else {
			return
		}
		pn, lid := wa.ResolvePN(ctx, e.Info.Sender, e.Info.SenderAlt)
		ev.FromLID = lid
		if pn != "" {
			ev.FromPN = "+" + pn
		}
		n.Notify(ev)
	case *events.LoggedOut:
		log.Printf("LOGGED OUT (reason %v): re-pair from /notify", e.Reason)
		n.Notify(Event{Type: "logged_out", Code: int(e.Reason)})
	case *events.TemporaryBan:
		log.Printf("TEMPORARY BAN: %s", e.String())
		n.Notify(Event{Type: "temporary_ban", Code: int(e.Code), ExpiresS: int(e.Expire.Seconds())})
	case *events.StreamReplaced:
		log.Print("stream replaced: another process connected with this session")
		n.Notify(Event{Type: "disconnected", Error: "stream_replaced"})
	case *events.Disconnected:
		n.Notify(Event{Type: "disconnected"})
	case *events.Connected:
		n.Notify(Event{Type: "connected"})
	case *events.PairSuccess:
		log.Printf("paired as %s", e.ID)
		n.Notify(Event{Type: "connected", Text: fmt.Sprintf("paired:%s", strings.SplitN(e.ID.String(), "@", 2)[0])})
	}
}
