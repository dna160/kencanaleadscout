package main

// The paced sender (PRD §10.4) and the callback client (PRD §10.2).
//
// One message at a time, with a random 8–25 s gap and "typing…" first; hourly
// and daily caps; nothing is sent while disconnected or logged out. Nothing is
// dropped either: a message waits in the outbox until it can go.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log"
	"math/rand/v2"
	"net/http"
	"time"
)

// ── Callbacks to LeadScout ───────────────────────────────────────────────────

type Event struct {
	Type      string `json:"type"` // receipt | inbound | logged_out | temporary_ban | disconnected | connected
	MessageID string `json:"message_id,omitempty"`
	Status    string `json:"status,omitempty"` // server_ack | delivered | read | failed
	Error     string `json:"error,omitempty"`
	FromPN    string `json:"from_pn,omitempty"`
	FromLID   string `json:"from_lid,omitempty"`
	Text      string `json:"text,omitempty"`
	Code      int    `json:"code,omitempty"`
	ExpiresS  int    `json:"expires_seconds,omitempty"`
	TS        string `json:"ts"`
}

type Notifier interface{ Notify(Event) }

type HTTPNotifier struct {
	URL    string // {LEADSCOUT}/api/notify/wa-events
	Secret string
	Client *http.Client
}

// Notify posts in the background with 3 attempts; a callback never blocks a send.
func (n *HTTPNotifier) Notify(e Event) {
	if n.URL == "" {
		return
	}
	if e.TS == "" {
		e.TS = time.Now().UTC().Format(time.RFC3339)
	}
	go func() {
		body, _ := json.Marshal(e)
		for attempt := 1; attempt <= 3; attempt++ {
			req, _ := http.NewRequest(http.MethodPost, n.URL, bytes.NewReader(body))
			req.Header.Set("content-type", "application/json")
			req.Header.Set("x-gateway-secret", n.Secret)
			res, err := n.Client.Do(req)
			if err == nil {
				res.Body.Close()
				if res.StatusCode < 500 {
					return
				}
			}
			time.Sleep(time.Duration(attempt*attempt) * time.Second)
		}
		log.Printf("callback %s for %s dropped after 3 attempts", e.Type, e.MessageID)
	}()
}

// ── Sender ───────────────────────────────────────────────────────────────────

type SenderConfig struct {
	MinGap, MaxGap time.Duration
	HourlyCap      int
	DailyCap       int
	MaxAttempts    int
	Idle           time.Duration // poll interval when nothing is queued
}

type Sender struct {
	cfg    SenderConfig
	store  Store
	wa     WA
	notify Notifier
	now    func() time.Time
	sleep  func(context.Context, time.Duration) bool
	wake   chan struct{}
}

func NewSender(cfg SenderConfig, store Store, wa WA, n Notifier) *Sender {
	return &Sender{
		cfg: cfg, store: store, wa: wa, notify: n,
		now:   time.Now,
		sleep: sleepCtx,
		wake:  make(chan struct{}, 1),
	}
}

func sleepCtx(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// Wake nudges the loop after an enqueue so it doesn't wait out the idle poll.
func (s *Sender) Wake() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

var wib = time.FixedZone("WIB", 7*3600)

// capWait is how long to wait before another send is allowed (0 = now).
func (s *Sender) capWait(ctx context.Context) (time.Duration, error) {
	now := s.now()
	if s.cfg.HourlyCap > 0 {
		n, err := s.store.SentSince(ctx, now.Add(-time.Hour))
		if err != nil {
			return 0, err
		}
		if n >= s.cfg.HourlyCap {
			return 5 * time.Minute, nil
		}
	}
	if s.cfg.DailyCap > 0 {
		w := now.In(wib)
		dayStart := time.Date(w.Year(), w.Month(), w.Day(), 0, 0, 0, 0, wib)
		n, err := s.store.SentSince(ctx, dayStart)
		if err != nil {
			return 0, err
		}
		if n >= s.cfg.DailyCap {
			return dayStart.Add(24 * time.Hour).Sub(now), nil
		}
	}
	return 0, nil
}

func (s *Sender) gap() time.Duration {
	if s.cfg.MaxGap <= s.cfg.MinGap {
		return s.cfg.MinGap
	}
	return s.cfg.MinGap + time.Duration(rand.Int64N(int64(s.cfg.MaxGap-s.cfg.MinGap)))
}

// Step sends at most one message. It returns how long to wait before the next
// step, and whether a message was attempted.
func (s *Sender) Step(ctx context.Context) (time.Duration, bool) {
	if !s.wa.Connected() || !s.wa.LoggedIn() {
		return 10 * time.Second, false
	}
	if wait, err := s.capWait(ctx); err != nil {
		log.Printf("cap check failed: %v", err)
		return 30 * time.Second, false
	} else if wait > 0 {
		return wait, false
	}
	it, err := s.store.Next(ctx)
	if err != nil {
		log.Printf("outbox read failed: %v", err)
		return 30 * time.Second, false
	}
	if it == nil {
		return s.cfg.Idle, false
	}

	// Typing first, for roughly as long as a person would take (1–4 s).
	_ = s.wa.Typing(ctx, it.ToPN, true)
	typing := time.Duration(min(4000, 1000+len(it.Body)*5)) * time.Millisecond
	if !s.sleep(ctx, typing) {
		_ = s.store.MarkRetry(context.Background(), it.Key, "interrupted")
		return 0, false
	}
	err = s.wa.Send(ctx, it.ToPN, it.Body, it.MessageID)
	_ = s.wa.Typing(ctx, it.ToPN, false)

	switch {
	case err == nil:
		_ = s.store.MarkSent(ctx, it.Key, s.now())
		s.notify.Notify(Event{Type: "receipt", MessageID: it.MessageID, Status: "server_ack"})
	case errors.Is(err, ErrNotOnWhatsApp):
		_ = s.store.MarkFailed(ctx, it.Key, "not_on_whatsapp")
		s.notify.Notify(Event{Type: "receipt", MessageID: it.MessageID, Status: "failed", Error: "not_on_whatsapp"})
	case it.Attempts >= s.cfg.MaxAttempts:
		_ = s.store.MarkFailed(ctx, it.Key, err.Error())
		s.notify.Notify(Event{Type: "receipt", MessageID: it.MessageID, Status: "failed", Error: err.Error()})
	default:
		_ = s.store.MarkRetry(ctx, it.Key, err.Error())
	}
	return s.gap(), true
}

// Run loops until ctx is done.
func (s *Sender) Run(ctx context.Context) {
	if err := s.store.Recover(ctx); err != nil {
		log.Printf("outbox recover failed: %v", err)
	}
	for {
		wait, _ := s.Step(ctx)
		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-s.wake:
			// Only cut an IDLE wait short; pacing gaps are always honoured.
			if wait != s.cfg.Idle {
				select {
				case <-ctx.Done():
					t.Stop()
					return
				case <-t.C:
				}
			}
			t.Stop()
		case <-t.C:
		}
	}
}
