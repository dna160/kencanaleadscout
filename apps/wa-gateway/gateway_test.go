package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

// ── fakes ────────────────────────────────────────────────────────────────────

type fakeWA struct {
	mu        sync.Mutex
	connected bool
	loggedIn  bool
	sent      []string // "to|text|id"
	typing    int
	sendErr   error
	seq       int
}

func (f *fakeWA) Connected() bool { return f.connected }
func (f *fakeWA) LoggedIn() bool  { return f.loggedIn }
func (f *fakeWA) OwnJID() string  { return "6281100000000@s.whatsapp.net" }
func (f *fakeWA) NewMessageID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.seq++
	return "3EB0" + strings.Repeat("0", 3) + string(rune('A'+f.seq))
}
func (f *fakeWA) Typing(context.Context, string, bool) error { f.typing++; return nil }
func (f *fakeWA) Send(_ context.Context, to, text, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sent = append(f.sent, to+"|"+text+"|"+id)
	return nil
}
func (f *fakeWA) SendImage(_ context.Context, to, caption, mime string, data []byte, id string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.sendErr != nil {
		return f.sendErr
	}
	f.sent = append(f.sent, fmt.Sprintf("IMG %s|%s|%s|%d|%s", to, caption, mime, len(data), id))
	return nil
}
func (f *fakeWA) Check(_ context.Context, pns []string) ([]CheckResult, error) {
	out := []CheckResult{}
	for _, p := range pns {
		out = append(out, CheckResult{PN: p, OnWhatsApp: p != "+6281299999999"})
	}
	return out, nil
}
func (f *fakeWA) Pair(context.Context) PairState                    { return PairState{QR: "2@abc", ExpiresIn: 20} }
func (f *fakeWA) PairPhone(context.Context, string) (string, error) { return "ABCD-EFGH", nil }

type recNotifier struct {
	mu     sync.Mutex
	events []Event
}

func (r *recNotifier) Notify(e Event) { r.mu.Lock(); r.events = append(r.events, e); r.mu.Unlock() }

type nopWake struct{}

func (nopWake) Wake() {}

const secret = "test-secret-0123456789"

func newAPI(wa WA, st Store) *httptest.Server {
	a := &API{Secret: secret, Store: st, WA: wa, Sender: nopWake{}, Now: time.Now}
	return httptest.NewServer(a.Routes())
}

func post(t *testing.T, srv *httptest.Server, path string, body any, auth bool) (int, map[string]any) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest(http.MethodPost, srv.URL+path, bytes.NewReader(b))
	req.Header.Set("content-type", "application/json")
	if auth {
		req.Header.Set("x-gateway-secret", secret)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

// ── API ──────────────────────────────────────────────────────────────────────

func TestSendNeedsSecret(t *testing.T) {
	srv := newAPI(&fakeWA{}, NewMemStore())
	defer srv.Close()
	code, _ := post(t, srv, "/send", map[string]string{"to_pn": "+6281234567890", "text": "hi", "idempotency_key": "k"}, false)
	if code != http.StatusUnauthorized {
		t.Fatalf("want 401, got %d", code)
	}
	res, _ := http.Get(srv.URL + "/healthz")
	if res.StatusCode != 200 {
		t.Fatalf("healthz must be open, got %d", res.StatusCode)
	}
}

func TestSendQueuesAndDedupesOnIdempotencyKey(t *testing.T) {
	st := NewMemStore()
	srv := newAPI(&fakeWA{}, st)
	defer srv.Close()
	body := map[string]string{"to_pn": "+6281234567890", "text": "Halo", "idempotency_key": "notify:on:so_received:SO.1:customer"}
	code, a := post(t, srv, "/send", body, true)
	if code != 200 || a["queued"] != true || a["duplicate"] != false || a["message_id"] == "" {
		t.Fatalf("first send: %d %v", code, a)
	}
	_, b := post(t, srv, "/send", body, true)
	if b["message_id"] != a["message_id"] || b["duplicate"] != true {
		t.Fatalf("duplicate must return the original message: %v vs %v", a, b)
	}
	if d, _ := st.QueueDepth(context.Background()); d != 1 {
		t.Fatalf("queue depth %d, want 1", d)
	}
}

func TestSendValidates(t *testing.T) {
	srv := newAPI(&fakeWA{}, NewMemStore())
	defer srv.Close()
	for _, body := range []map[string]string{
		{"to_pn": "081234567890", "text": "x", "idempotency_key": "k"}, // not E.164
		{"to_pn": "+6281234567890", "text": "  ", "idempotency_key": "k"},
		{"to_pn": "+6281234567890", "text": "x"},
	} {
		if code, _ := post(t, srv, "/send", body, true); code != http.StatusBadRequest {
			t.Fatalf("%v: want 400, got %d", body, code)
		}
	}
}

func TestCheckAndHealth(t *testing.T) {
	wa := &fakeWA{connected: true, loggedIn: true}
	srv := newAPI(wa, NewMemStore())
	defer srv.Close()
	b, _ := json.Marshal(map[string]any{"pns": []string{"+6281234567890", "+6281299999999"}})
	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/check", bytes.NewReader(b))
	req.Header.Set("x-gateway-secret", secret)
	res, _ := http.DefaultClient.Do(req)
	var out []CheckResult
	_ = json.NewDecoder(res.Body).Decode(&out)
	if len(out) != 2 || !out[0].OnWhatsApp || out[1].OnWhatsApp {
		t.Fatalf("check: %+v", out)
	}
	req, _ = http.NewRequest(http.MethodGet, srv.URL+"/health", nil)
	req.Header.Set("x-gateway-secret", secret)
	res, _ = http.DefaultClient.Do(req)
	var h map[string]any
	_ = json.NewDecoder(res.Body).Decode(&h)
	if h["connected"] != true || h["logged_in"] != true || h["queue_depth"].(float64) != 0 {
		t.Fatalf("health: %v", h)
	}
}

// ── Sender ───────────────────────────────────────────────────────────────────

func newSender(wa WA, st Store, n Notifier, cfg SenderConfig) *Sender {
	s := NewSender(cfg, st, wa, n)
	s.sleep = func(context.Context, time.Duration) bool { return true }
	return s
}

func TestSenderWaitsWhileDisconnected(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{}
	_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: "k", MessageID: "m1", ToPN: "+6281234567890", Body: "hi"})
	s := newSender(wa, st, &recNotifier{}, SenderConfig{Idle: time.Second})
	if _, attempted := s.Step(context.Background()); attempted || len(wa.sent) != 0 {
		t.Fatal("must not send while disconnected")
	}
	if st.Get("k").Status != "queued" {
		t.Fatal("item must stay queued")
	}
}

func TestSenderSendsWithTypingAndAcks(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{connected: true, loggedIn: true}
	n := &recNotifier{}
	_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: "k", MessageID: "m1", ToPN: "+6281234567890", Body: "hi"})
	s := newSender(wa, st, n, SenderConfig{MinGap: 8 * time.Second, MaxGap: 25 * time.Second, Idle: time.Second, MaxAttempts: 3})
	wait, attempted := s.Step(context.Background())
	if !attempted || len(wa.sent) != 1 || wa.sent[0] != "+6281234567890|hi|m1" {
		t.Fatalf("sent: %v", wa.sent)
	}
	if wa.typing != 2 {
		t.Fatalf("typing on+off expected, got %d", wa.typing)
	}
	if wait < 8*time.Second || wait >= 25*time.Second {
		t.Fatalf("pacing gap %v outside [8s,25s)", wait)
	}
	if st.Get("k").Status != "sent" || len(n.events) != 1 || n.events[0].Status != "server_ack" || n.events[0].MessageID != "m1" {
		t.Fatalf("state %+v events %+v", st.Get("k"), n.events)
	}
}

func TestSenderRetriesThenFails(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{connected: true, loggedIn: true, sendErr: errors.New("timeout")}
	n := &recNotifier{}
	_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: "k", MessageID: "m1", ToPN: "+6281234567890", Body: "hi"})
	s := newSender(wa, st, n, SenderConfig{Idle: time.Second, MaxAttempts: 2})
	s.Step(context.Background())
	if st.Get("k").Status != "queued" {
		t.Fatalf("first failure must requeue, got %s", st.Get("k").Status)
	}
	s.Step(context.Background())
	if it := st.Get("k"); it.Status != "failed" || it.Error != "timeout" {
		t.Fatalf("second failure must fail: %+v", it)
	}
	if len(n.events) != 1 || n.events[0].Status != "failed" {
		t.Fatalf("events: %+v", n.events)
	}
}

func TestSenderNotOnWhatsAppIsPermanent(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{connected: true, loggedIn: true, sendErr: ErrNotOnWhatsApp}
	n := &recNotifier{}
	_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: "k", MessageID: "m1", ToPN: "+6281234567890", Body: "hi"})
	newSender(wa, st, n, SenderConfig{Idle: time.Second, MaxAttempts: 5}).Step(context.Background())
	if it := st.Get("k"); it.Status != "failed" || it.Error != "not_on_whatsapp" {
		t.Fatalf("%+v", it)
	}
	if n.events[0].Error != "not_on_whatsapp" {
		t.Fatalf("%+v", n.events)
	}
}

func TestSenderRespectsCaps(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{connected: true, loggedIn: true}
	for _, k := range []string{"a", "b"} {
		_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: k, MessageID: k, ToPN: "+6281234567890", Body: "hi"})
	}
	s := newSender(wa, st, &recNotifier{}, SenderConfig{Idle: time.Second, MaxAttempts: 3, HourlyCap: 1})
	s.Step(context.Background())
	wait, attempted := s.Step(context.Background())
	if attempted || wait <= 0 || len(wa.sent) != 1 {
		t.Fatalf("hourly cap must hold the second message: wait=%v sent=%v", wait, wa.sent)
	}
	if st.Get("b").Status != "queued" {
		t.Fatal("capped message must stay queued, not dropped")
	}
}

// ── Inbound ──────────────────────────────────────────────────────────────────

func TestInboundTextOnlyFromOthersInDMs(t *testing.T) {
	dm := types.NewJID("6281234567890", types.DefaultUserServer)
	mk := func(fromMe, group bool, chat types.JID, m *waE2E.Message) *events.Message {
		return &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: dm, IsFromMe: fromMe, IsGroup: group}}, Message: m}
	}
	text := &waE2E.Message{Conversation: proto.String("STOP")}
	ext := &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{Text: proto.String("sudah sampai mana?")}}
	if got, ok := Inbound(mk(false, false, dm, text)); !ok || got != "STOP" {
		t.Fatalf("plain text: %q %v", got, ok)
	}
	if got, ok := Inbound(mk(false, false, dm, ext)); !ok || got != "sudah sampai mana?" {
		t.Fatalf("extended text: %q %v", got, ok)
	}
	if _, ok := Inbound(mk(true, false, dm, text)); ok {
		t.Fatal("own messages are not inbound")
	}
	if _, ok := Inbound(mk(false, true, types.NewJID("123", types.GroupServer), text)); ok {
		t.Fatal("groups are not inbound")
	}
	if _, ok := Inbound(mk(false, false, dm, &waE2E.Message{})); ok {
		t.Fatal("media/empty is not inbound")
	}
}

func TestNotifierPostsWithSecret(t *testing.T) {
	got := make(chan *http.Request, 1)
	var body []byte
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body = make([]byte, r.ContentLength)
		_, _ = r.Body.Read(body)
		got <- r
	}))
	defer srv.Close()
	(&HTTPNotifier{URL: srv.URL, Secret: secret, Client: srv.Client()}).Notify(Event{Type: "receipt", MessageID: "m1", Status: "read"})
	select {
	case r := <-got:
		if r.Header.Get("x-gateway-secret") != secret {
			t.Fatal("missing secret")
		}
		var e Event
		_ = json.Unmarshal(body, &e)
		if e.Type != "receipt" || e.Status != "read" || e.TS == "" {
			t.Fatalf("%+v", e)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("no callback")
	}
}

func TestWithSearchPath(t *testing.T) {
	got, err := withSearchPath("postgres://u:p@h:5432/db?sslmode=disable")
	if err != nil || !strings.Contains(got, "search_path=wa_store") || !strings.Contains(got, "sslmode=disable") {
		t.Fatalf("%s %v", got, err)
	}
	if _, err := withSearchPath("mysql://x"); err == nil {
		t.Fatal("non-postgres must be rejected")
	}
}

// ── Postgres store (needs DATABASE_URL) ──────────────────────────────────────

func TestPGStore(t *testing.T) {
	dsn := os.Getenv("DATABASE_URL")
	if dsn == "" {
		t.Skip("DATABASE_URL not set")
	}
	ctx := context.Background()
	boot, err := sql.Open("postgres", dsn)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := boot.Exec(`create schema if not exists wa_store_test`); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = boot.Exec(`drop schema wa_store_test cascade`); boot.Close() }()
	pinned := strings.Replace(mustPath(t, dsn), "search_path=wa_store", "search_path=wa_store_test", 1)
	db, err := sql.Open("postgres", pinned)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	st, err := NewPGStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	a, created, err := st.Enqueue(ctx, OutboxItem{Key: "k1", MessageID: "m1", ToPN: "+6281234567890", Body: "hi"})
	if err != nil || !created || a.Status != "queued" {
		t.Fatalf("%+v %v %v", a, created, err)
	}
	b, created, _ := st.Enqueue(ctx, OutboxItem{Key: "k1", MessageID: "m2", ToPN: "+6281234567890", Body: "other"})
	if created || b.MessageID != "m1" {
		t.Fatalf("dedupe: %+v", b)
	}
	it, _ := st.Next(ctx)
	if it == nil || it.Key != "k1" || it.Attempts != 1 || it.Status != "sending" {
		t.Fatalf("next: %+v", it)
	}
	if again, _ := st.Next(ctx); again != nil {
		t.Fatal("a claimed item must not be handed out twice")
	}
	_ = st.Recover(ctx)              // crash mid-send → back in the queue
	time.Sleep(2 * time.Millisecond) // created_at after k1, so k1 is still first in line
	_, _, _ = st.Enqueue(ctx, OutboxItem{Key: "k2", MessageID: "m3", ToPN: "+6281234567890", Body: "", MediaMime: "image/png", Media: tinyPNG})
	it, _ = st.Next(ctx)
	_ = st.MarkSent(ctx, it.Key, time.Now())
	img, _ := st.Next(ctx)
	if img == nil || img.Key != "k2" || img.MediaMime != "image/png" || !bytes.Equal(img.Media, tinyPNG) {
		t.Fatalf("image round trip: %+v", img)
	}
	_ = st.MarkSent(ctx, img.Key, time.Now())
	if n, _ := st.SentSince(ctx, time.Now().Add(-time.Minute)); n != 2 {
		t.Fatalf("sent since: %d", n)
	}
	if d, _ := st.QueueDepth(ctx); d != 0 {
		t.Fatalf("depth: %d", d)
	}
}

func mustPath(t *testing.T, dsn string) string {
	p, err := withSearchPath(dsn)
	if err != nil {
		t.Fatal(err)
	}
	return p
}

// ── Images ───────────────────────────────────────────────────────────────────

// A real 1×1 PNG, so content sniffing sees genuine image bytes.
var tinyPNG, _ = base64.StdEncoding.DecodeString(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")

func TestSendAcceptsAnImageAndSniffsIt(t *testing.T) {
	st := NewMemStore()
	srv := newAPI(&fakeWA{}, st)
	defer srv.Close()
	ok := map[string]string{"to_pn": "+6281234567890", "text": "Foto barang", "idempotency_key": "img1",
		"image_b64": base64.StdEncoding.EncodeToString(tinyPNG), "mime": "image/jpeg"}
	if code, out := post(t, srv, "/send", ok, true); code != 200 || out["queued"] != true {
		t.Fatalf("image send: %d %v", code, out)
	}
	if it := st.Get("img1"); it.MediaMime != "image/png" || len(it.Media) != len(tinyPNG) || it.Body != "Foto barang" {
		t.Fatalf("stored with the SNIFFED type and bytes: %+v", it.MediaMime)
	}
	noCaption := map[string]string{"to_pn": "+6281234567890", "idempotency_key": "img2",
		"image_b64": base64.StdEncoding.EncodeToString(tinyPNG)}
	if code, _ := post(t, srv, "/send", noCaption, true); code != 200 {
		t.Fatalf("an image needs no caption, got %d", code)
	}
	for _, bad := range []map[string]string{
		{"to_pn": "+6281234567890", "idempotency_key": "b1", "image_b64": "%%%not-base64"},
		{"to_pn": "+6281234567890", "idempotency_key": "b2", "image_b64": base64.StdEncoding.EncodeToString([]byte("%PDF-1.4 not an image"))},
	} {
		if code, _ := post(t, srv, "/send", bad, true); code != http.StatusBadRequest {
			t.Fatalf("%v: want 400, got %d", bad["idempotency_key"], code)
		}
	}
}

func TestSenderSendsImagesAsImages(t *testing.T) {
	st := NewMemStore()
	wa := &fakeWA{connected: true, loggedIn: true}
	_, _, _ = st.Enqueue(context.Background(), OutboxItem{Key: "k", MessageID: "m1", ToPN: "+6281234567890",
		Body: "Foto", MediaMime: "image/png", Media: tinyPNG})
	newSender(wa, st, &recNotifier{}, SenderConfig{Idle: time.Second, MaxAttempts: 3}).Step(context.Background())
	want := fmt.Sprintf("IMG +6281234567890|Foto|image/png|%d|m1", len(tinyPNG))
	if len(wa.sent) != 1 || wa.sent[0] != want {
		t.Fatalf("sent %v, want %s", wa.sent, want)
	}
}

func TestInboundImageOnlyInDirectChats(t *testing.T) {
	dm := types.NewJID("6281234567890", types.DefaultUserServer)
	img := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{Caption: proto.String("barang rusak"), Mimetype: proto.String("image/jpeg")}}
	mk := func(group, viewOnce bool) *events.Message {
		chat := dm
		if group {
			chat = types.NewJID("123", types.GroupServer)
		}
		return &events.Message{Info: types.MessageInfo{MessageSource: types.MessageSource{Chat: chat, Sender: dm, IsGroup: group}},
			Message: img, IsViewOnce: viewOnce}
	}
	if got, ok := InboundImage(mk(false, false)); !ok || got.GetCaption() != "barang rusak" {
		t.Fatal("a photo in a DM must be picked up with its caption")
	}
	if _, ok := InboundImage(mk(true, false)); ok {
		t.Fatal("group photos are not inbound")
	}
	if _, ok := InboundImage(mk(false, true)); ok {
		t.Fatal("view-once photos are not kept")
	}
	if _, ok := Inbound(mk(false, false)); ok {
		t.Fatal("a photo is not a text message")
	}
}
