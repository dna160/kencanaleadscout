package main

// WA is everything the gateway needs from WhatsApp. The real implementation
// wraps whatsmeow (linked device, LID-aware); tests use a fake.

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/store/sqlstore"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	waLog "go.mau.fi/whatsmeow/util/log"
	"google.golang.org/protobuf/proto"
)

// ErrNotOnWhatsApp is permanent: the number has no WhatsApp account.
var ErrNotOnWhatsApp = errors.New("recipient is not on WhatsApp")

type CheckResult struct {
	PN         string `json:"pn"`
	OnWhatsApp bool   `json:"on_whatsapp"`
	JID        string `json:"jid,omitempty"`
	LID        string `json:"lid,omitempty"`
}

type PairState struct {
	Paired    bool   `json:"paired"`
	JID       string `json:"jid,omitempty"`
	QR        string `json:"qr,omitempty"`
	ExpiresIn int    `json:"expires_in,omitempty"`
	Error     string `json:"error,omitempty"`
}

type WA interface {
	Connected() bool
	LoggedIn() bool
	OwnJID() string
	NewMessageID() string
	// Typing shows "typing…" in the chat before a send (PRD §10.4).
	Typing(ctx context.Context, toPN string, on bool) error
	Send(ctx context.Context, toPN, text, messageID string) error
	// SendImage uploads the image to WhatsApp's media servers and sends it with
	// an optional caption.
	SendImage(ctx context.Context, toPN, caption, mime string, data []byte, messageID string) error
	Check(ctx context.Context, pns []string) ([]CheckResult, error)
	Pair(ctx context.Context) PairState
	PairPhone(ctx context.Context, phone string) (string, error)
}

// pnJID turns "+6281234567890" into 6281234567890@s.whatsapp.net.
func pnJID(pn string) (types.JID, error) {
	digits := strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		return -1
	}, pn)
	if len(digits) < 8 {
		return types.JID{}, fmt.Errorf("invalid phone %q", pn)
	}
	return types.NewJID(digits, types.DefaultUserServer), nil
}

// ── whatsmeow ────────────────────────────────────────────────────────────────

type MeowWA struct {
	client *whatsmeow.Client
	log    waLog.Logger

	mu        sync.Mutex
	qrCode    string
	qrExpires time.Time
	qrErr     string
	qrRunning bool
}

// NewMeowWA opens the session from the Postgres store (schema wa_store), so a
// redeploy never needs re-pairing (PRD §10.1).
func NewMeowWA(ctx context.Context, container *sqlstore.Container, log waLog.Logger, onEvent func(any)) (*MeowWA, error) {
	device, err := container.GetFirstDevice(ctx)
	if err != nil {
		return nil, fmt.Errorf("load device: %w", err)
	}
	c := whatsmeow.NewClient(device, log.Sub("client"))
	w := &MeowWA{client: c, log: log}
	c.AddEventHandler(func(evt any) { onEvent(evt) })
	return w, nil
}

// Start connects. Without a paired device it starts the QR flow first, as
// whatsmeow requires (GetQRChannel before Connect).
func (w *MeowWA) Start(ctx context.Context) error {
	if w.client.Store.ID == nil {
		return w.startQR(ctx)
	}
	return w.client.Connect()
}

func (w *MeowWA) startQR(ctx context.Context) error {
	w.mu.Lock()
	if w.qrRunning {
		w.mu.Unlock()
		return nil
	}
	w.qrRunning = true
	w.mu.Unlock()

	ch, err := w.client.GetQRChannel(ctx)
	if err != nil {
		w.mu.Lock()
		w.qrRunning = false
		w.mu.Unlock()
		return err
	}
	go func() {
		for item := range ch {
			w.mu.Lock()
			switch item.Event {
			case "code":
				w.qrCode, w.qrErr = item.Code, ""
				w.qrExpires = time.Now().Add(item.Timeout)
			case "success":
				w.qrCode, w.qrErr = "", ""
			default:
				w.qrCode = ""
				if item.Error != nil {
					w.qrErr = item.Error.Error()
				} else {
					w.qrErr = item.Event
				}
			}
			w.mu.Unlock()
		}
		w.mu.Lock()
		w.qrRunning = false
		w.mu.Unlock()
	}()
	return w.client.Connect()
}

func (w *MeowWA) Connected() bool { return w.client.IsConnected() }
func (w *MeowWA) LoggedIn() bool  { return w.client.IsLoggedIn() }
func (w *MeowWA) OwnJID() string {
	if w.client.Store.ID == nil {
		return ""
	}
	return w.client.Store.ID.String()
}
func (w *MeowWA) NewMessageID() string { return string(w.client.GenerateMessageID()) }

func (w *MeowWA) Typing(ctx context.Context, toPN string, on bool) error {
	jid, err := pnJID(toPN)
	if err != nil {
		return err
	}
	state := types.ChatPresencePaused
	if on {
		state = types.ChatPresenceComposing
	}
	return w.client.SendChatPresence(ctx, jid, state, types.ChatPresenceMediaText)
}

// Send addresses by phone number; whatsmeow resolves the LID through its store
// (PRD §10.3). A number with no known LID is looked up once via IsOnWhatsApp
// (which records the mapping) before giving up as not-on-WhatsApp.
func (w *MeowWA) Send(ctx context.Context, toPN, text, messageID string) error {
	jid, err := pnJID(toPN)
	if err != nil {
		return err
	}
	msg := &waE2E.Message{Conversation: proto.String(text)}
	extra := whatsmeow.SendRequestExtra{ID: types.MessageID(messageID)}
	_, err = w.client.SendMessage(ctx, jid, msg, extra)
	if errors.Is(err, whatsmeow.ErrRecipientNotOnWhatsApp) {
		res, cerr := w.client.IsOnWhatsApp(ctx, []string{"+" + jid.User})
		if cerr != nil {
			return fmt.Errorf("check before resend: %w", cerr)
		}
		if len(res) == 0 || !res[0].IsIn {
			return ErrNotOnWhatsApp
		}
		_, err = w.client.SendMessage(ctx, jid, msg, extra)
		if errors.Is(err, whatsmeow.ErrRecipientNotOnWhatsApp) {
			return ErrNotOnWhatsApp
		}
	}
	return err
}

func (w *MeowWA) SendImage(ctx context.Context, toPN, caption, mime string, data []byte, messageID string) error {
	jid, err := pnJID(toPN)
	if err != nil {
		return err
	}
	up, err := w.client.Upload(ctx, data, whatsmeow.MediaImage)
	if err != nil {
		return fmt.Errorf("upload image: %w", err)
	}
	msg := &waE2E.Message{ImageMessage: &waE2E.ImageMessage{
		Caption:       proto.String(caption),
		Mimetype:      proto.String(mime),
		URL:           proto.String(up.URL),
		DirectPath:    proto.String(up.DirectPath),
		MediaKey:      up.MediaKey,
		FileEncSHA256: up.FileEncSHA256,
		FileSHA256:    up.FileSHA256,
		FileLength:    proto.Uint64(up.FileLength),
	}}
	_, err = w.client.SendMessage(ctx, jid, msg, whatsmeow.SendRequestExtra{ID: types.MessageID(messageID)})
	if errors.Is(err, whatsmeow.ErrRecipientNotOnWhatsApp) {
		return ErrNotOnWhatsApp
	}
	return err
}

// DownloadImage fetches and decrypts an inbound image.
func (w *MeowWA) DownloadImage(ctx context.Context, img *waE2E.ImageMessage) ([]byte, error) {
	return w.client.Download(ctx, img)
}

func (w *MeowWA) Check(ctx context.Context, pns []string) ([]CheckResult, error) {
	q := make([]string, 0, len(pns))
	for _, p := range pns {
		jid, err := pnJID(p)
		if err != nil {
			continue
		}
		q = append(q, "+"+jid.User)
	}
	res, err := w.client.IsOnWhatsApp(ctx, q)
	if err != nil {
		return nil, err
	}
	out := make([]CheckResult, 0, len(res))
	for _, r := range res {
		cr := CheckResult{PN: r.Query, OnWhatsApp: r.IsIn}
		if r.IsIn {
			cr.JID = r.JID.String()
			if lid, err := w.client.Store.LIDs.GetLIDForPN(ctx, r.JID); err == nil && !lid.IsEmpty() {
				cr.LID = lid.String()
			}
		}
		out = append(out, cr)
	}
	return out, nil
}

func (w *MeowWA) Pair(ctx context.Context) PairState {
	if w.client.Store.ID != nil {
		return PairState{Paired: true, JID: w.client.Store.ID.String()}
	}
	w.mu.Lock()
	running := w.qrRunning
	w.mu.Unlock()
	if !running {
		// The previous QR session timed out: start a fresh one.
		w.client.Disconnect()
		if err := w.startQR(context.Background()); err != nil {
			return PairState{Error: err.Error()}
		}
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	st := PairState{QR: w.qrCode, Error: w.qrErr}
	if w.qrCode != "" {
		st.ExpiresIn = int(time.Until(w.qrExpires).Seconds())
	}
	return st
}

// PairPhone returns the 8-character code to type on the phone (Linked devices →
// Link with phone number instead), the alternative to scanning a QR.
func (w *MeowWA) PairPhone(ctx context.Context, phone string) (string, error) {
	if w.client.Store.ID != nil {
		return "", errors.New("already paired")
	}
	jid, err := pnJID(phone)
	if err != nil {
		return "", err
	}
	if !w.client.IsConnected() {
		if err := w.startQR(context.Background()); err != nil {
			return "", err
		}
	}
	return w.client.PairPhone(ctx, jid.User, true, whatsmeow.PairClientChrome, "Chrome (Linux)")
}

// ResolvePN returns the phone-number JID for an inbound sender: the sender
// itself when it is a phone JID, else SenderAlt, else the persisted LID map.
func (w *MeowWA) ResolvePN(ctx context.Context, sender, alt types.JID) (pn string, lid string) {
	if sender.Server == types.HiddenUserServer {
		lid = sender.User
		if alt.Server == types.DefaultUserServer {
			return alt.User, lid
		}
		if p, err := w.client.Store.LIDs.GetPNForLID(ctx, sender); err == nil && !p.IsEmpty() {
			return p.User, lid
		}
		return "", lid
	}
	if alt.Server == types.HiddenUserServer {
		lid = alt.User
	}
	return sender.User, lid
}

// isDirect is true for a 1:1 message from someone else (not own messages,
// groups, broadcasts or status updates).
func isDirect(evt *events.Message) bool {
	return evt != nil && !evt.Info.IsFromMe && !evt.Info.IsGroup && !evt.Info.Chat.IsBroadcastList() &&
		evt.Info.Chat.Server != types.BroadcastServer && evt.Message != nil
}

// MaxInboundImageBytes caps what is downloaded and forwarded to LeadScout.
const MaxInboundImageBytes = 15 << 20

// InboundImage returns the photo in a 1:1 message, if any. View-once photos
// are not forwarded: the sender chose for them not to be kept.
func InboundImage(evt *events.Message) (*waE2E.ImageMessage, bool) {
	if !isDirect(evt) || evt.IsViewOnce {
		return nil, false
	}
	img := evt.Message.GetImageMessage()
	return img, img != nil
}

// Inbound extracts the plain text of a 1:1 message, or ok=false for anything
// the gateway does not forward as text (own messages, groups, broadcasts, media).
func Inbound(evt *events.Message) (text string, ok bool) {
	if !isDirect(evt) {
		return "", false
	}
	m := evt.Message
	if t := m.GetConversation(); t != "" {
		return t, true
	}
	if t := m.GetExtendedTextMessage().GetText(); t != "" {
		return t, true
	}
	return "", false
}
