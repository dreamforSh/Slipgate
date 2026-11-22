package dataplane

import (
	"bytes"
	"encoding/json"
	"strings"
)

// Canonical content part types. Text-only messages keep Parts nil and use Content alone.
const (
	partText     = "text"
	partImage    = "image"
	partDocument = "document"
)

// mediaSource is Anthropic's image/document source: base64, url, or (documents only) plain text.
type mediaSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	URL       string `json:"url"`
}

// contentBlock is the union of the content-part shapes used by OpenAI Chat, OpenAI Responses and
// Anthropic Messages. Unknown block types are ignored.
type contentBlock struct {
	Type     string          `json:"type"`
	Text     string          `json:"text"`
	ImageURL json.RawMessage `json:"image_url"` // Chat: {"url": "..."}; Responses: "..."
	FileData string          `json:"file_data"` // Responses input_file
	File     *struct {
		FileData string `json:"file_data"`
	} `json:"file"` // Chat file part
	Source *mediaSource `json:"source"` // Anthropic image/document
}

// parseContentBlocks flattens a string-or-array content field into its joined text plus ordered
// parts. Parts is only returned when the content carries something other than text.
func parseContentBlocks(raw json.RawMessage) (string, []CanonicalPart) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || bytes.Equal(trimmed, []byte("null")) {
		return "", nil
	}
	var str string
	if err := json.Unmarshal(trimmed, &str); err == nil {
		return str, nil
	}
	var blocks []contentBlock
	if err := json.Unmarshal(trimmed, &blocks); err != nil {
		return "", nil
	}
	parts := make([]CanonicalPart, 0, len(blocks))
	for _, b := range blocks {
		if p, ok := canonicalPartFromBlock(b); ok {
			parts = append(parts, p)
		}
	}
	return joinPartText(parts), compactParts(parts)
}

func canonicalPartFromBlock(b contentBlock) (CanonicalPart, bool) {
	switch b.Type {
	case "text", "input_text", "output_text", "refusal":
		if b.Text == "" {
			return CanonicalPart{}, false
		}
		return CanonicalPart{Type: partText, Text: b.Text}, true
	case "image_url", "input_image":
		if u := imageURLValue(b.ImageURL); u != "" {
			return mediaPartFromURL(partImage, u), true
		}
	case "image", "document":
		if b.Source == nil {
			return CanonicalPart{}, false
		}
		switch b.Source.Type {
		case "base64":
			if b.Source.Data != "" {
				return CanonicalPart{Type: b.Type, MediaType: b.Source.MediaType, Data: b.Source.Data}, true
			}
		case "url":
			if b.Source.URL != "" {
				return CanonicalPart{Type: b.Type, URL: b.Source.URL}, true
			}
		case "text":
			if b.Source.Data != "" {
				return CanonicalPart{Type: partText, Text: b.Source.Data}, true
			}
		}
	case "file":
		if b.File != nil && b.File.FileData != "" {
			return mediaPartFromURL(partDocument, b.File.FileData), true
		}
	case "input_file":
		if b.FileData != "" {
			return mediaPartFromURL(partDocument, b.FileData), true
		}
	}
	return CanonicalPart{}, false
}

// imageURLValue reads OpenAI's image_url, which is an object in Chat and a bare string in Responses.
func imageURLValue(raw json.RawMessage) string {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(trimmed, &s) == nil {
		return strings.TrimSpace(s)
	}
	var obj struct {
		URL string `json:"url"`
	}
	if json.Unmarshal(trimmed, &obj) == nil {
		return strings.TrimSpace(obj.URL)
	}
	return ""
}

// mediaPartFromURL turns a data: URL into an inline part and anything else into a remote reference.
func mediaPartFromURL(kind, u string) CanonicalPart {
	if mediaType, data, ok := parseDataURL(u); ok {
		return CanonicalPart{Type: kind, MediaType: mediaType, Data: data}
	}
	if kind == partDocument && !strings.Contains(u, "://") {
		// Responses input_file.file_data may be bare base64; OpenAI only accepts PDFs there.
		return CanonicalPart{Type: kind, MediaType: "application/pdf", Data: u}
	}
	return CanonicalPart{Type: kind, URL: u}
}

func parseDataURL(u string) (mediaType, data string, ok bool) {
	if !strings.HasPrefix(u, "data:") {
		return "", "", false
	}
	meta, payload, found := strings.Cut(u[len("data:"):], ",")
	if !found || !strings.HasSuffix(meta, ";base64") {
		return "", "", false
	}
	return strings.TrimSuffix(meta, ";base64"), payload, true
}

func partDataURL(p CanonicalPart) string {
	if p.Data == "" {
		return p.URL
	}
	mediaType := p.MediaType
	if mediaType == "" {
		mediaType = "application/octet-stream"
	}
	return "data:" + mediaType + ";base64," + p.Data
}

func joinPartText(parts []CanonicalPart) string {
	var texts []string
	for _, p := range parts {
		if p.Type == partText && p.Text != "" {
			texts = append(texts, p.Text)
		}
	}
	return strings.Join(texts, "\n")
}

// compactParts drops the part list when it holds text only, so text-only messages stay simple.
func compactParts(parts []CanonicalPart) []CanonicalPart {
	if hasMediaParts(parts) {
		return parts
	}
	return nil
}

func hasMediaParts(parts []CanonicalPart) bool {
	for _, p := range parts {
		if p.Type != partText {
			return true
		}
	}
	return false
}

// messageParts returns the ordered parts of m, synthesising a single text part for text-only messages.
func messageParts(m CanonicalMessage) []CanonicalPart {
	if len(m.Parts) > 0 {
		return m.Parts
	}
	if m.Content == "" {
		return nil
	}
	return []CanonicalPart{{Type: partText, Text: m.Content}}
}

// openAIChatContent renders message content for OpenAI Chat: a plain string unless media is present.
func openAIChatContent(m CanonicalMessage) any {
	if !hasMediaParts(m.Parts) {
		return m.Content
	}
	out := make([]map[string]any, 0, len(m.Parts))
	for _, p := range m.Parts {
		switch p.Type {
		case partText:
			out = append(out, map[string]any{"type": "text", "text": p.Text})
		case partImage:
			out = append(out, map[string]any{"type": "image_url", "image_url": map[string]any{"url": partDataURL(p)}})
		case partDocument:
			if p.Data != "" {
				out = append(out, map[string]any{"type": "file", "file": map[string]any{"filename": "document.pdf", "file_data": partDataURL(p)}})
			} else {
				out = append(out, map[string]any{"type": "text", "text": "[document: " + p.URL + "]"})
			}
		}
	}
	return out
}

// anthropicContentBlocks renders parts as Anthropic content blocks, skipping empty text.
func anthropicContentBlocks(parts []CanonicalPart) []map[string]any {
	out := make([]map[string]any, 0, len(parts))
	for _, p := range parts {
		switch p.Type {
		case partText:
			if strings.TrimSpace(p.Text) != "" {
				out = append(out, map[string]any{"type": "text", "text": p.Text})
			}
		case partImage, partDocument:
			var source map[string]any
			if p.Data != "" {
				mediaType := p.MediaType
				if mediaType == "" && p.Type == partDocument {
					mediaType = "application/pdf"
				}
				source = map[string]any{"type": "base64", "media_type": mediaType, "data": p.Data}
			} else {
				source = map[string]any{"type": "url", "url": p.URL}
			}
			out = append(out, map[string]any{"type": p.Type, "source": source})
		}
	}
	return out
}

// geminiContentParts renders parts for Gemini. Remote http(s) media cannot be fetched by Gemini,
// so those become a textual reference instead of a request the API would reject.
func geminiContentParts(parts []CanonicalPart) []map[string]any {
	out := make([]map[string]any, 0, len(parts))
	for _, p := range parts {
		switch p.Type {
		case partText:
			out = append(out, map[string]any{"text": p.Text})
		case partImage, partDocument:
			switch {
			case p.Data != "":
				mediaType := p.MediaType
				if mediaType == "" {
					mediaType = "application/octet-stream"
				}
				out = append(out, map[string]any{"inlineData": map[string]any{"mimeType": mediaType, "data": p.Data}})
			case strings.HasPrefix(p.URL, "gs://") || strings.Contains(p.URL, "generativelanguage.googleapis.com/"):
				out = append(out, map[string]any{"fileData": map[string]any{"mimeType": firstNonEmpty(p.MediaType, "application/octet-stream"), "fileUri": p.URL}})
			default:
				out = append(out, map[string]any{"text": "[" + p.Type + ": " + p.URL + "]"})
			}
		}
	}
	return out
}
