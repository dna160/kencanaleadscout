package main

// HTTP API (PRD §10.2). Internal networking only; every route but /healthz
// needs `x-gateway-secret`.
//
//	POST /send        {to_pn, text, idempotency_key} → {message_id, queued}
//	POST /check       {pns: []}                      → [{pn, on_whatsapp, jid, lid?}]
//	GET  /health                                     → {connected, logged_in, jid, queue_depth, sent_today}
//	GET  /pair                                       → {paired, jid?, qr?, expires_in?}
//	POST /pair/phone  {phone}                        → {code}
//	GET  /healthz     (no auth; Railway liveness)

import (
	"context"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

type API struct {
	Secret string
	Store  Store
	WA     WA
	Sender interface{ Wake() }
	Now    func() time.Time
}

func (a *API) authed(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		got := r.Header.Get("x-gateway-secret")
		if a.Secret == "" || subtle.ConstantTimeCompare([]byte(got), []byte(a.Secret)) != 1 {
			writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		h(w, r)
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func readJSON(r *http.Request, v any) error { return readJSONLimit(r, v, 64<<10) }

func readJSONLimit(r *http.Request, v any, limit int64) error {
	defer r.Body.Close()
	dec := json.NewDecoder(http.MaxBytesReader(nil, r.Body, limit))
	return dec.Decode(v)
}

// MaxOutboundImageBytes caps an image sent through /send (decoded size).
const MaxOutboundImageBytes = 15 << 20

// imageMimes are the only media types /send accepts, checked against the bytes.
var imageMimes = map[string]bool{"image/jpeg": true, "image/png": true, "image/webp": true}

func (a *API) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	})
	mux.HandleFunc("POST /send", a.authed(a.send))
	mux.HandleFunc("POST /check", a.authed(a.check))
	mux.HandleFunc("GET /health", a.authed(a.health))
	mux.HandleFunc("GET /pair", a.authed(a.pair))
	mux.HandleFunc("POST /pair/phone", a.authed(a.pairPhone))
	return mux
}

type sendReq struct {
	ToPN           string `json:"to_pn"`
	Text           string `json:"text"`
	IdempotencyKey string `json:"idempotency_key"`
	// Optional image: base64 bytes + declared type. Text becomes its caption.
	ImageB64 string `json:"image_b64,omitempty"`
	Mime     string `json:"mime,omitempty"`
}

func (a *API) send(w http.ResponseWriter, r *http.Request) {
	var req sendReq
	if err := readJSONLimit(r, &req, 24<<20); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "body is not JSON"})
		return
	}
	req.Text = strings.TrimSpace(req.Text)
	if _, err := pnJID(req.ToPN); err != nil || !strings.HasPrefix(req.ToPN, "+") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "to_pn must be E.164, e.g. +6281234567890"})
		return
	}
	var media []byte
	if req.ImageB64 != "" {
		b, err := base64.StdEncoding.DecodeString(req.ImageB64)
		if err != nil || len(b) == 0 || len(b) > MaxOutboundImageBytes {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "image_b64 must be base64, at most 15 MB"})
			return
		}
		// Trust the bytes, not the label.
		sniffed := http.DetectContentType(b)
		if !imageMimes[sniffed] {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "image must be JPEG, PNG or WebP"})
			return
		}
		media, req.Mime = b, sniffed
	}
	if (media == nil && req.Text == "") || len(req.Text) > 4000 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "text must be 1–4000 characters (or send an image)"})
		return
	}
	if req.IdempotencyKey == "" || len(req.IdempotencyKey) > 300 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "idempotency_key is required"})
		return
	}
	it, created, err := a.Store.Enqueue(r.Context(), OutboxItem{
		Key: req.IdempotencyKey, MessageID: a.WA.NewMessageID(), ToPN: req.ToPN, Body: req.Text,
		MediaMime: req.Mime, Media: media,
	})
	if err != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "outbox unavailable"})
		return
	}
	if created {
		a.Sender.Wake()
	}
	// A duplicate key answers with the ORIGINAL message: nothing is sent twice.
	writeJSON(w, http.StatusOK, map[string]any{
		"message_id": it.MessageID,
		"queued":     it.Status == "queued" || it.Status == "sending",
		"status":     it.Status,
		"duplicate":  !created,
	})
}

func (a *API) check(w http.ResponseWriter, r *http.Request) {
	var req struct {
		PNs []string `json:"pns"`
	}
	if err := readJSON(r, &req); err != nil || len(req.PNs) == 0 || len(req.PNs) > 50 {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "pns must hold 1–50 numbers"})
		return
	}
	if !a.WA.Connected() || !a.WA.LoggedIn() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "not connected"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	res, err := a.WA.Check(ctx, req.PNs)
	if err != nil {
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *API) health(w http.ResponseWriter, r *http.Request) {
	depth, _ := a.Store.QueueDepth(r.Context())
	n := a.Now().In(wib)
	sentToday, _ := a.Store.SentSince(r.Context(), time.Date(n.Year(), n.Month(), n.Day(), 0, 0, 0, 0, wib))
	writeJSON(w, http.StatusOK, map[string]any{
		"connected":       a.WA.Connected(),
		"logged_in":       a.WA.LoggedIn(),
		"jid":             a.WA.OwnJID(),
		"queue_depth":     depth,
		"sent_today":      sentToday,
		"phone_last_seen": nil, // not exposed by whatsmeow; reserved by the contract
	})
}

func (a *API) pair(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.WA.Pair(r.Context()))
}

func (a *API) pairPhone(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Phone string `json:"phone"`
	}
	if err := readJSON(r, &req); err != nil || req.Phone == "" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "phone is required"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	code, err := a.WA.PairPhone(ctx, req.Phone)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]string{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"code": code})
}
