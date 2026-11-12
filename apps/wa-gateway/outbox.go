package main

// The gateway's outbox: every accepted /send is persisted BEFORE the HTTP
// answer, so a restart never loses a message LeadScout believes is queued, and
// the idempotency key dedupes for 7 days (PRD §10.2).

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"time"
)

type OutboxItem struct {
	Key       string
	MessageID string
	ToPN      string
	Body      string
	MediaMime string // set when the item is an image; Body is then its caption
	Media     []byte
	Status    string // queued | sending | sent | failed
	Attempts  int
	Error     string
	CreatedAt time.Time
	SentAt    *time.Time
}

type Store interface {
	// Enqueue inserts a new item, or returns the existing one for a known key
	// (created=false). The caller's MessageID is used only on insert.
	Enqueue(ctx context.Context, it OutboxItem) (stored OutboxItem, created bool, err error)
	// Next claims the oldest queued item (status → sending), or nil.
	Next(ctx context.Context) (*OutboxItem, error)
	MarkSent(ctx context.Context, key string, at time.Time) error
	// MarkRetry puts an item back in the queue with an error note.
	MarkRetry(ctx context.Context, key string, errMsg string) error
	MarkFailed(ctx context.Context, key string, errMsg string) error
	// SentSince counts items sent at or after t (for the hourly/daily caps).
	SentSince(ctx context.Context, t time.Time) (int, error)
	QueueDepth(ctx context.Context) (int, error)
	// Purge removes items older than the dedupe window.
	Purge(ctx context.Context, olderThan time.Time) (int64, error)
	// Recover returns items stuck in "sending" (a crash mid-send) to the queue.
	Recover(ctx context.Context) error
}

// ── Postgres ─────────────────────────────────────────────────────────────────

type PGStore struct{ db *sql.DB }

func NewPGStore(ctx context.Context, db *sql.DB) (*PGStore, error) {
	_, err := db.ExecContext(ctx, `
		create table if not exists wa_outbox (
			idempotency_key text primary key,
			message_id      text not null,
			to_pn           text not null,
			body            text not null,
			status          text not null default 'queued',
			attempts        int not null default 0,
			error           text,
			created_at      timestamptz not null default now(),
			sent_at         timestamptz
		);
		alter table wa_outbox add column if not exists media_mime text;
		alter table wa_outbox add column if not exists media bytea;
		create index if not exists wa_outbox_queue_idx on wa_outbox (created_at) where status in ('queued', 'sending');
		create index if not exists wa_outbox_sent_idx on wa_outbox (sent_at);
	`)
	if err != nil {
		return nil, err
	}
	return &PGStore{db: db}, nil
}

func scanItem(row interface{ Scan(...any) error }) (*OutboxItem, error) {
	var it OutboxItem
	var errMsg, mime sql.NullString
	var sent sql.NullTime
	if err := row.Scan(&it.Key, &it.MessageID, &it.ToPN, &it.Body, &it.Status, &it.Attempts, &errMsg, &it.CreatedAt, &sent, &mime, &it.Media); err != nil {
		return nil, err
	}
	it.Error = errMsg.String
	it.MediaMime = mime.String
	if sent.Valid {
		t := sent.Time
		it.SentAt = &t
	}
	return &it, nil
}

const itemCols = `idempotency_key, message_id, to_pn, body, status, attempts, error, created_at, sent_at, media_mime, media`

func (s *PGStore) Enqueue(ctx context.Context, it OutboxItem) (OutboxItem, bool, error) {
	row := s.db.QueryRowContext(ctx, `
		insert into wa_outbox (idempotency_key, message_id, to_pn, body, media_mime, media)
		values ($1, $2, $3, $4, nullif($5, ''), $6)
		on conflict (idempotency_key) do nothing
		returning `+itemCols, it.Key, it.MessageID, it.ToPN, it.Body, it.MediaMime, it.Media)
	got, err := scanItem(row)
	if err == nil {
		return *got, true, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return OutboxItem{}, false, err
	}
	got, err = scanItem(s.db.QueryRowContext(ctx, `select `+itemCols+` from wa_outbox where idempotency_key = $1`, it.Key))
	if err != nil {
		return OutboxItem{}, false, err
	}
	return *got, false, nil
}

func (s *PGStore) Next(ctx context.Context) (*OutboxItem, error) {
	it, err := scanItem(s.db.QueryRowContext(ctx, `
		update wa_outbox set status = 'sending', attempts = attempts + 1
		 where idempotency_key = (
		   select idempotency_key from wa_outbox where status = 'queued'
		    order by created_at limit 1 for update skip locked)
		returning `+itemCols))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return it, err
}

func (s *PGStore) MarkSent(ctx context.Context, key string, at time.Time) error {
	_, err := s.db.ExecContext(ctx, `update wa_outbox set status = 'sent', sent_at = $2, error = null where idempotency_key = $1`, key, at)
	return err
}

func (s *PGStore) MarkRetry(ctx context.Context, key, errMsg string) error {
	_, err := s.db.ExecContext(ctx, `update wa_outbox set status = 'queued', error = $2 where idempotency_key = $1`, key, errMsg)
	return err
}

func (s *PGStore) MarkFailed(ctx context.Context, key, errMsg string) error {
	_, err := s.db.ExecContext(ctx, `update wa_outbox set status = 'failed', error = $2 where idempotency_key = $1`, key, errMsg)
	return err
}

func (s *PGStore) SentSince(ctx context.Context, t time.Time) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `select count(*) from wa_outbox where sent_at >= $1`, t).Scan(&n)
	return n, err
}

func (s *PGStore) QueueDepth(ctx context.Context) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `select count(*) from wa_outbox where status in ('queued', 'sending')`).Scan(&n)
	return n, err
}

func (s *PGStore) Purge(ctx context.Context, olderThan time.Time) (int64, error) {
	res, err := s.db.ExecContext(ctx, `delete from wa_outbox where created_at < $1 and status in ('sent', 'failed')`, olderThan)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *PGStore) Recover(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `update wa_outbox set status = 'queued' where status = 'sending'`)
	return err
}

// ── In memory (tests) ────────────────────────────────────────────────────────

type MemStore struct {
	mu    sync.Mutex
	items map[string]*OutboxItem
	order []string
}

func NewMemStore() *MemStore { return &MemStore{items: map[string]*OutboxItem{}} }

func (m *MemStore) Enqueue(_ context.Context, it OutboxItem) (OutboxItem, bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if ex, ok := m.items[it.Key]; ok {
		return *ex, false, nil
	}
	it.Status = "queued"
	it.CreatedAt = time.Now()
	m.items[it.Key] = &it
	m.order = append(m.order, it.Key)
	return it, true, nil
}

func (m *MemStore) Next(_ context.Context) (*OutboxItem, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range m.order {
		if it := m.items[k]; it.Status == "queued" {
			it.Status = "sending"
			it.Attempts++
			cp := *it
			return &cp, nil
		}
	}
	return nil, nil
}

func (m *MemStore) set(key string, f func(*OutboxItem)) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if it, ok := m.items[key]; ok {
		f(it)
	}
	return nil
}

func (m *MemStore) MarkSent(_ context.Context, key string, at time.Time) error {
	return m.set(key, func(it *OutboxItem) { it.Status = "sent"; it.SentAt = &at; it.Error = "" })
}
func (m *MemStore) MarkRetry(_ context.Context, key, e string) error {
	return m.set(key, func(it *OutboxItem) { it.Status = "queued"; it.Error = e })
}
func (m *MemStore) MarkFailed(_ context.Context, key, e string) error {
	return m.set(key, func(it *OutboxItem) { it.Status = "failed"; it.Error = e })
}
func (m *MemStore) SentSince(_ context.Context, t time.Time) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, it := range m.items {
		if it.SentAt != nil && !it.SentAt.Before(t) {
			n++
		}
	}
	return n, nil
}
func (m *MemStore) QueueDepth(_ context.Context) (int, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, it := range m.items {
		if it.Status == "queued" || it.Status == "sending" {
			n++
		}
	}
	return n, nil
}
func (m *MemStore) Purge(_ context.Context, _ time.Time) (int64, error) { return 0, nil }
func (m *MemStore) Recover(_ context.Context) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, it := range m.items {
		if it.Status == "sending" {
			it.Status = "queued"
		}
	}
	return nil
}

func (m *MemStore) Get(key string) OutboxItem {
	m.mu.Lock()
	defer m.mu.Unlock()
	return *m.items[key]
}
