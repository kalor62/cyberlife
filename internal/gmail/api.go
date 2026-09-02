package gmail

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"mime"
	"net/mail"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	gmailapi "google.golang.org/api/gmail/v1"

	"github.com/kalor62/cyberlife/internal/logging"
)

const (
	threadPageSize = 50
	// One threads.get or labels.get costs 10 of the 250 quota units Gmail allows
	// per user per second, so ~25 in flight is the ceiling before it answers 429.
	metadataConcurrency = 20
	inlineImageCap      = 2 * 1024 * 1024
)

type Label struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Color     string `json:"color,omitempty"`
	TextColor string `json:"textColor,omitempty"`
	Unread    int64  `json:"unread"`
	Total     int64  `json:"total"`
	Hidden    bool   `json:"hidden"`
}

type ThreadSummary struct {
	ID        string   `json:"id"`
	Snippet   string   `json:"snippet"`
	Subject   string   `json:"subject"`
	From      string   `json:"from"`
	FromEmail string   `json:"fromEmail"`
	DateUnix  int64    `json:"dateUnix"`
	DateText  string   `json:"dateText"`
	Unread    bool     `json:"unread"`
	Starred   bool     `json:"starred"`
	MsgCount  int      `json:"msgCount"`
	LabelIDs  []string `json:"labelIds"`
}

type ThreadPage struct {
	Threads        []ThreadSummary `json:"threads"`
	NextPageToken  string          `json:"nextPageToken"`
	ResultEstimate int64           `json:"resultEstimate"`
}

type AttachmentMeta struct {
	MessageID    string `json:"messageId"`
	AttachmentID string `json:"attachmentId"`
	Filename     string `json:"filename"`
	MimeType     string `json:"mimeType"`
	Size         int64  `json:"size"`
}

type MessageDetail struct {
	ID          string           `json:"id"`
	From        string           `json:"from"`
	To          string           `json:"to"`
	Cc          string           `json:"cc"`
	DateText    string           `json:"dateText"`
	Subject     string           `json:"subject"`
	BodyHTML    string           `json:"bodyHtml"`
	BodyText    string           `json:"bodyText"`
	Unread      bool             `json:"unread"`
	Attachments []AttachmentMeta `json:"attachments"`
}

type ThreadDetail struct {
	ID       string          `json:"id"`
	Messages []MessageDetail `json:"messages"`
}

func ListLabels(svc *gmailapi.Service) ([]Label, error) {
	resp, err := svc.Users.Labels.List("me").Do()
	if err != nil {
		return nil, err
	}
	labels := make([]Label, 0, len(resp.Labels))
	for _, l := range resp.Labels {
		// Hidden labels stay in the list: they are still applied to mail, so the
		// thread rows need them to resolve a chip. Only the sidebar drops them.
		label := Label{ID: l.Id, Name: l.Name, Type: l.Type, Hidden: l.LabelListVisibility == "labelHide"}
		if l.Color != nil {
			label.Color = l.Color.BackgroundColor
			label.TextColor = l.Color.TextColor
		}
		labels = append(labels, label)
	}
	// Unread counts cost one labels.get each and are the slowest part of opening
	// Mail. Only the sidebar shows them, and the sidebar skips hidden labels —
	// those are kept solely so a thread row can resolve its chip.
	var wg sync.WaitGroup
	sem := make(chan struct{}, metadataConcurrency)
	for i := range labels {
		if labels[i].Hidden {
			continue
		}
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int) {
			defer wg.Done()
			defer func() { <-sem }()
			detail, err := svc.Users.Labels.Get("me", labels[idx].ID).Do()
			if err != nil {
				logging.Debug("gmail label detail failed", "label", labels[idx].ID, "error", err)
				return
			}
			labels[idx].Unread = detail.MessagesUnread
			labels[idx].Total = detail.MessagesTotal
		}(i)
	}
	wg.Wait()
	return labels, nil
}

func ListThreads(svc *gmailapi.Service, labelID, query, pageToken string) (*ThreadPage, error) {
	call := svc.Users.Threads.List("me").MaxResults(threadPageSize)
	if labelID != "" {
		call = call.LabelIds(labelID)
	}
	if query != "" {
		call = call.Q(query)
	}
	if pageToken != "" {
		call = call.PageToken(pageToken)
	}
	resp, err := call.Do()
	if err != nil {
		return nil, err
	}

	page := &ThreadPage{
		Threads:        make([]ThreadSummary, len(resp.Threads)),
		NextPageToken:  resp.NextPageToken,
		ResultEstimate: resp.ResultSizeEstimate,
	}

	var wg sync.WaitGroup
	sem := make(chan struct{}, metadataConcurrency)
	for i, t := range resp.Threads {
		wg.Add(1)
		sem <- struct{}{}
		go func(idx int, threadID, snippet string) {
			defer wg.Done()
			defer func() { <-sem }()
			summary := ThreadSummary{ID: threadID, Snippet: snippet}
			detail, err := svc.Users.Threads.Get("me", threadID).
				Format("metadata").MetadataHeaders("From", "Subject", "Date").Do()
			if err != nil {
				logging.Debug("gmail thread metadata failed", "thread", threadID, "error", err)
				page.Threads[idx] = summary
				return
			}
			summary.MsgCount = len(detail.Messages)
			labelSet := map[string]bool{}
			for _, msg := range detail.Messages {
				for _, l := range msg.LabelIds {
					labelSet[l] = true
				}
			}
			summary.Unread = labelSet["UNREAD"]
			summary.Starred = labelSet["STARRED"]
			for l := range labelSet {
				summary.LabelIDs = append(summary.LabelIDs, l)
			}
			if len(detail.Messages) > 0 {
				last := detail.Messages[len(detail.Messages)-1]
				summary.DateUnix = last.InternalDate / 1000
				summary.DateText = shortDate(summary.DateUnix)
				// Sender of the newest message; subject from the first
				from := headerValue(last.Payload, "From")
				summary.From, summary.FromEmail = parseAddress(from)
				summary.Subject = headerValue(detail.Messages[0].Payload, "Subject")
				if summary.Subject == "" {
					summary.Subject = "(no subject)"
				}
			}
			page.Threads[idx] = summary
		}(i, t.Id, t.Snippet)
	}
	wg.Wait()
	return page, nil
}

func GetThread(svc *gmailapi.Service, threadID string) (*ThreadDetail, error) {
	resp, err := svc.Users.Threads.Get("me", threadID).Format("full").Do()
	if err != nil {
		return nil, err
	}
	detail := &ThreadDetail{ID: threadID}
	for _, msg := range resp.Messages {
		md := MessageDetail{
			ID:       msg.Id,
			From:     headerValue(msg.Payload, "From"),
			To:       headerValue(msg.Payload, "To"),
			Cc:       headerValue(msg.Payload, "Cc"),
			Subject:  headerValue(msg.Payload, "Subject"),
			DateText: fullDate(msg.InternalDate / 1000),
		}
		for _, l := range msg.LabelIds {
			if l == "UNREAD" {
				md.Unread = true
			}
		}
		var html, text strings.Builder
		inline := map[string]AttachmentMeta{}
		walkParts(msg.Payload, msg.Id, &html, &text, &md.Attachments, inline)
		md.BodyHTML = html.String()
		md.BodyText = text.String()
		if md.BodyHTML != "" && len(inline) > 0 {
			md.BodyHTML = embedInlineImages(svc, md.BodyHTML, inline)
		}
		detail.Messages = append(detail.Messages, md)
	}
	return detail, nil
}

func walkParts(part *gmailapi.MessagePart, messageID string, html, text *strings.Builder, attachments *[]AttachmentMeta, inline map[string]AttachmentMeta) {
	if part == nil {
		return
	}
	mime := part.MimeType
	filename := part.Filename

	if filename != "" && part.Body != nil && part.Body.AttachmentId != "" {
		meta := AttachmentMeta{
			MessageID:    messageID,
			AttachmentID: part.Body.AttachmentId,
			Filename:     filename,
			MimeType:     mime,
			Size:         part.Body.Size,
		}
		if cid := strings.Trim(headerValue(part, "Content-ID"), "<>"); cid != "" && strings.HasPrefix(mime, "image/") {
			inline[cid] = meta
		} else {
			*attachments = append(*attachments, meta)
		}
		return
	}

	if part.Body != nil && part.Body.Data != "" {
		data, err := decodeBase64URL(part.Body.Data)
		if err == nil {
			switch mime {
			case "text/html":
				html.Write(data)
			case "text/plain":
				text.Write(data)
			}
		}
	}
	for _, child := range part.Parts {
		walkParts(child, messageID, html, text, attachments, inline)
	}
}

func embedInlineImages(svc *gmailapi.Service, html string, inline map[string]AttachmentMeta) string {
	for cid, meta := range inline {
		if meta.Size > inlineImageCap {
			continue
		}
		if !strings.Contains(html, "cid:"+cid) {
			continue
		}
		data, err := FetchAttachment(svc, meta.MessageID, meta.AttachmentID)
		if err != nil {
			logging.Debug("gmail inline image fetch failed", "cid", cid, "error", err)
			continue
		}
		uri := fmt.Sprintf("data:%s;base64,%s", meta.MimeType, base64.StdEncoding.EncodeToString(data))
		html = strings.ReplaceAll(html, "cid:"+cid, uri)
	}
	return html
}

func FetchAttachment(svc *gmailapi.Service, messageID, attachmentID string) ([]byte, error) {
	att, err := svc.Users.Messages.Attachments.Get("me", messageID, attachmentID).Do()
	if err != nil {
		return nil, err
	}
	return decodeBase64URL(att.Data)
}

func ModifyThread(svc *gmailapi.Service, threadID string, addLabels, removeLabels []string) error {
	_, err := svc.Users.Threads.Modify("me", threadID, &gmailapi.ModifyThreadRequest{
		AddLabelIds:    addLabels,
		RemoveLabelIds: removeLabels,
	}).Do()
	return err
}

func TrashThread(svc *gmailapi.Service, threadID string) error {
	_, err := svc.Users.Threads.Trash("me", threadID).Do()
	return err
}

func UntrashThread(svc *gmailapi.Service, threadID string) error {
	_, err := svc.Users.Threads.Untrash("me", threadID).Do()
	return err
}

// GetInboxUnread returns the INBOX unread conversation count
func GetInboxUnread(svc *gmailapi.Service) (int64, error) {
	label, err := svc.Users.Labels.Get("me", "INBOX").Do()
	if err != nil {
		return 0, err
	}
	return label.ThreadsUnread, nil
}

// DraftInfo is a Gmail draft belonging to a thread, editable in the app
type DraftInfo struct {
	DraftID   string `json:"draftId"`
	MessageID string `json:"messageId"`
	ThreadID  string `json:"threadId"`
	To        string `json:"to"`
	Subject   string `json:"subject"`
	BodyText  string `json:"bodyText"`
	BodyHTML  string `json:"bodyHtml"`
}

// ListThreadDrafts returns drafts attached to a specific thread
func ListThreadDrafts(svc *gmailapi.Service, threadID string) ([]DraftInfo, error) {
	list, err := svc.Users.Drafts.List("me").MaxResults(25).Do()
	if err != nil {
		return nil, err
	}
	drafts := []DraftInfo{}
	for _, d := range list.Drafts {
		full, err := svc.Users.Drafts.Get("me", d.Id).Format("full").Do()
		if err != nil {
			logging.Debug("gmail draft fetch failed", "draft", d.Id, "error", err)
			continue
		}
		if full.Message == nil || full.Message.ThreadId != threadID {
			continue
		}
		info := DraftInfo{
			DraftID:   d.Id,
			MessageID: full.Message.Id,
			ThreadID:  full.Message.ThreadId,
			To:        headerValue(full.Message.Payload, "To"),
			Subject:   headerValue(full.Message.Payload, "Subject"),
		}
		var html, text strings.Builder
		var atts []AttachmentMeta
		walkParts(full.Message.Payload, full.Message.Id, &html, &text, &atts, map[string]AttachmentMeta{})
		info.BodyHTML = html.String()
		info.BodyText = text.String()
		drafts = append(drafts, info)
	}
	return drafts, nil
}

func textToHTML(text string) string {
	escaped := strings.ReplaceAll(text, "&", "&amp;")
	escaped = strings.ReplaceAll(escaped, "<", "&lt;")
	escaped = strings.ReplaceAll(escaped, ">", "&gt;")
	return strings.ReplaceAll(escaped, "\n", "<br>\n")
}

// buildRawMessage builds a base64url RFC822 message: HTML body (+ optional Gmail
// signature) and optional file attachments as multipart/mixed
func buildRawMessage(to, subject, bodyText, signatureHTML, inReplyTo, references string, attachments []string) (string, error) {
	return buildRawMessageCc(to, "", subject, bodyText, signatureHTML, inReplyTo, references, attachments)
}

func buildRawMessageCc(to, cc, subject, bodyText, signatureHTML, inReplyTo, references string, attachments []string) (string, error) {
	htmlBody := "<div dir=\"ltr\">" + textToHTML(bodyText) + "</div>"
	if signatureHTML != "" {
		htmlBody += "<br><div class=\"gmail_signature\">" + signatureHTML + "</div>"
	}

	var sb strings.Builder
	sb.WriteString("To: " + to + "\r\n")
	if cc != "" {
		sb.WriteString("Cc: " + cc + "\r\n")
	}
	sb.WriteString("Subject: " + mime.QEncoding.Encode("utf-8", subject) + "\r\n")
	if inReplyTo != "" {
		sb.WriteString("In-Reply-To: " + inReplyTo + "\r\n")
	}
	if references != "" {
		sb.WriteString("References: " + references + "\r\n")
	}
	sb.WriteString("MIME-Version: 1.0\r\n")

	if len(attachments) == 0 {
		sb.WriteString("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
		sb.WriteString(htmlBody)
		return base64.RawURLEncoding.EncodeToString([]byte(sb.String())), nil
	}

	boundaryBytes := make([]byte, 16)
	if _, err := rand.Read(boundaryBytes); err != nil {
		return "", err
	}
	boundary := "cyberlife_" + hex.EncodeToString(boundaryBytes)

	sb.WriteString("Content-Type: multipart/mixed; boundary=\"" + boundary + "\"\r\n\r\n")
	sb.WriteString("--" + boundary + "\r\n")
	sb.WriteString("Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n")
	sb.WriteString(htmlBody + "\r\n")

	for _, path := range attachments {
		data, err := os.ReadFile(path)
		if err != nil {
			return "", fmt.Errorf("cannot read attachment %s: %w", filepath.Base(path), err)
		}
		if len(data) > 24*1024*1024 {
			return "", fmt.Errorf("attachment too large (max 24 MB): %s", filepath.Base(path))
		}
		name := filepath.Base(path)
		mimeType := mime.TypeByExtension(filepath.Ext(path))
		if mimeType == "" {
			mimeType = "application/octet-stream"
		}
		encodedName := mime.QEncoding.Encode("utf-8", name)
		sb.WriteString("--" + boundary + "\r\n")
		sb.WriteString("Content-Type: " + mimeType + "; name=\"" + encodedName + "\"\r\n")
		sb.WriteString("Content-Disposition: attachment; filename=\"" + encodedName + "\"\r\n")
		sb.WriteString("Content-Transfer-Encoding: base64\r\n\r\n")
		encoded := base64.StdEncoding.EncodeToString(data)
		for i := 0; i < len(encoded); i += 76 {
			end := i + 76
			if end > len(encoded) {
				end = len(encoded)
			}
			sb.WriteString(encoded[i:end] + "\r\n")
		}
	}
	sb.WriteString("--" + boundary + "--\r\n")

	return base64.RawURLEncoding.EncodeToString([]byte(sb.String())), nil
}

// GetSignature returns the default send-as signature (HTML) for the account
func GetSignature(svc *gmailapi.Service) (string, error) {
	resp, err := svc.Users.Settings.SendAs.List("me").Do()
	if err != nil {
		return "", err
	}
	fallback := ""
	for _, sa := range resp.SendAs {
		if sa.IsDefault {
			return sa.Signature, nil
		}
		if fallback == "" {
			fallback = sa.Signature
		}
	}
	return fallback, nil
}

// Contact is a harvested email correspondent for compose autocomplete
type Contact struct {
	Name  string `json:"name"`
	Email string `json:"email"`
	Count int    `json:"count"`
}

// ListContacts harvests frequent correspondents from sent mail (To/Cc) and inbox (From)
func ListContacts(svc *gmailapi.Service) ([]Contact, error) {
	counts := map[string]*Contact{}
	var mu sync.Mutex

	harvest := func(msgID string, headers []string) {
		msg, err := svc.Users.Messages.Get("me", msgID).Format("metadata").
			MetadataHeaders(headers...).Do()
		if err != nil {
			return
		}
		for _, h := range headers {
			raw := headerValue(msg.Payload, h)
			if raw == "" {
				continue
			}
			addrs, err := mail.ParseAddressList(raw)
			if err != nil {
				continue
			}
			mu.Lock()
			for _, a := range addrs {
				lower := strings.ToLower(a.Address)
				if c, ok := counts[lower]; ok {
					c.Count++
					if c.Name == "" && a.Name != "" {
						c.Name = a.Name
					}
				} else {
					counts[lower] = &Contact{Name: a.Name, Email: a.Address, Count: 1}
				}
			}
			mu.Unlock()
		}
	}

	collect := func(query, labelID string, headers []string) {
		call := svc.Users.Messages.List("me").MaxResults(100)
		if query != "" {
			call = call.Q(query)
		}
		if labelID != "" {
			call = call.LabelIds(labelID)
		}
		resp, err := call.Do()
		if err != nil {
			logging.Debug("gmail contacts list failed", "error", err)
			return
		}
		var wg sync.WaitGroup
		sem := make(chan struct{}, metadataConcurrency)
		for _, m := range resp.Messages {
			wg.Add(1)
			sem <- struct{}{}
			go func(id string) {
				defer wg.Done()
				defer func() { <-sem }()
				harvest(id, headers)
			}(m.Id)
		}
		wg.Wait()
	}

	// Sent recipients matter most (people you actually write to), inbox senders second
	collect("in:sent", "", []string{"To", "Cc"})
	collect("", "INBOX", []string{"From"})

	contacts := make([]Contact, 0, len(counts))
	for _, c := range counts {
		contacts = append(contacts, *c)
	}
	sortContactsByCount(contacts)
	if len(contacts) > 300 {
		contacts = contacts[:300]
	}
	return contacts, nil
}

func sortContactsByCount(contacts []Contact) {
	for i := 1; i < len(contacts); i++ {
		for j := i; j > 0 && contacts[j].Count > contacts[j-1].Count; j-- {
			contacts[j], contacts[j-1] = contacts[j-1], contacts[j]
		}
	}
}

// UpdateDraft replaces a draft's content, preserving threading headers
func UpdateDraft(svc *gmailapi.Service, draftID, to, subject, body, signatureHTML string, attachments []string) error {
	current, err := svc.Users.Drafts.Get("me", draftID).Format("full").Do()
	if err != nil {
		return err
	}
	threadID := ""
	inReplyTo := ""
	references := ""
	if current.Message != nil {
		threadID = current.Message.ThreadId
		inReplyTo = headerValue(current.Message.Payload, "In-Reply-To")
		references = headerValue(current.Message.Payload, "References")
	}

	raw, err := buildRawMessage(to, subject, body, signatureHTML, inReplyTo, references, attachments)
	if err != nil {
		return err
	}
	_, err = svc.Users.Drafts.Update("me", draftID, &gmailapi.Draft{
		Message: &gmailapi.Message{
			Raw:      raw,
			ThreadId: threadID,
		},
	}).Do()
	return err
}

// CreateDraft creates a standalone draft and returns its id
func CreateDraft(svc *gmailapi.Service, to, subject, body, signatureHTML string, attachments []string) (string, error) {
	raw, err := buildRawMessage(to, subject, body, signatureHTML, "", "", attachments)
	if err != nil {
		return "", err
	}
	draft, err := svc.Users.Drafts.Create("me", &gmailapi.Draft{
		Message: &gmailapi.Message{Raw: raw},
	}).Do()
	if err != nil {
		return "", err
	}
	return draft.Id, nil
}

// SendMessageCc sends a new message immediately with optional Cc
// recipients (comma-separated)
func SendMessageCc(svc *gmailapi.Service, to, cc, subject, body, signatureHTML string, attachments []string) error {
	raw, err := buildRawMessageCc(to, cc, subject, body, signatureHTML, "", "", attachments)
	if err != nil {
		return err
	}
	_, err = svc.Users.Messages.Send("me", &gmailapi.Message{Raw: raw}).Do()
	return err
}

// SendMessage sends a new message immediately
func SendMessage(svc *gmailapi.Service, to, subject, body, signatureHTML string, attachments []string) error {
	raw, err := buildRawMessage(to, subject, body, signatureHTML, "", "", attachments)
	if err != nil {
		return err
	}
	_, err = svc.Users.Messages.Send("me", &gmailapi.Message{Raw: raw}).Do()
	return err
}

// SendDraft sends a draft as-is
func SendDraft(svc *gmailapi.Service, draftID string) error {
	_, err := svc.Users.Drafts.Send("me", &gmailapi.Draft{Id: draftID}).Do()
	return err
}

// DeleteDraft discards a draft
func DeleteDraft(svc *gmailapi.Service, draftID string) error {
	return svc.Users.Drafts.Delete("me", draftID).Do()
}

func decodeBase64URL(s string) ([]byte, error) {
	if data, err := base64.RawURLEncoding.DecodeString(s); err == nil {
		return data, nil
	}
	return base64.URLEncoding.DecodeString(s)
}

func headerValue(part *gmailapi.MessagePart, name string) string {
	if part == nil {
		return ""
	}
	for _, h := range part.Headers {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

func parseAddress(raw string) (name, email string) {
	addr, err := mail.ParseAddress(raw)
	if err != nil {
		return raw, raw
	}
	if addr.Name != "" {
		return addr.Name, addr.Address
	}
	return addr.Address, addr.Address
}

func shortDate(unix int64) string {
	t := time.Unix(unix, 0)
	now := time.Now()
	if t.Year() == now.Year() && t.YearDay() == now.YearDay() {
		return t.Format("15:04")
	}
	if t.Year() == now.Year() {
		return t.Format("2 Jan")
	}
	return t.Format("2 Jan 06")
}

func fullDate(unix int64) string {
	return time.Unix(unix, 0).Format("Mon, 2 Jan 2006 15:04")
}
