package main

// Contact cards (PRD §21.4): the customer gets the rep's card, so one tap opens
// a chat with the rep. Sent as a whatsmeow ContactMessage carrying a vCard 3.0
// whose TEL has a `waid`, which is what makes WhatsApp show "Message".

import (
	"errors"
	"strings"
)

// VCardMime marks an outbox item as a contact card: Media holds the vCard and
// Body the display name. No schema change: the image columns carry it.
const VCardMime = "text/vcard"

// vcardEscape escapes a vCard 3.0 text value (RFC 2426 §4).
func vcardEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, ";", `\;`, ",", `\,`, "\r\n", `\n`, "\n", `\n`, "\r", `\n`)
	return r.Replace(s)
}

// BuildVCard makes the card for an E.164 number: TEL;type=CELL;waid=628…:+62 8…
func BuildVCard(name, phoneE164 string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 100 {
		return "", errors.New("contact.name must be 1–100 characters")
	}
	jid, err := pnJID(phoneE164)
	if err != nil || !strings.HasPrefix(phoneE164, "+") {
		return "", errors.New("contact.phone must be E.164, e.g. +6281234567890")
	}
	digits := jid.User
	display := "+" + digits
	if strings.HasPrefix(digits, "62") && len(digits) > 4 {
		display = "+62 " + digits[2:]
	}
	n := vcardEscape(name)
	return "BEGIN:VCARD\r\nVERSION:3.0\r\n" +
		"N:;" + n + ";;;\r\n" +
		"FN:" + n + "\r\n" +
		"TEL;type=CELL;type=VOICE;waid=" + digits + ":" + display + "\r\n" +
		"END:VCARD", nil
}
