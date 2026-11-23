// Package logx writes slipgate-net's structured log lines:
//
//	[component] level: message key=value key="value with spaces" ...
//
// The fields are logfmt. The system-log forwarder (internal/syslogfwd) reads such a line back
// into an entry: the tag is the component, the level word the level, request_id / user_id /
// api_key_id / account_id / platform / model fill the entry's correlation columns (so the admin
// System logs filters find it), and the other fields land in its context.
package logx

import (
	"log"
	"strings"
	"unicode/utf8"
)

// MaxValueBytes caps one field value (the forwarder reads at most this many characters).
const MaxValueBytes = 256

// Event prints one structured line through l; a nil l writes nothing. kv holds key/value pairs:
// pairs with an empty value or an invalid key are left out, and a trailing odd key is ignored.
func Event(l *log.Logger, component, level, msg string, kv ...string) {
	if l == nil {
		return
	}
	l.Print(Format(component, level, msg, kv...))
}

// Format builds the line Event prints (without the logger's timestamp).
func Format(component, level, msg string, kv ...string) string {
	var b strings.Builder
	b.Grow(len(component) + len(msg) + 16*len(kv) + 16)
	b.WriteByte('[')
	b.WriteString(component)
	b.WriteString("] ")
	b.WriteString(levelWord(level))
	b.WriteString(": ")
	b.WriteString(oneLine(msg))
	for i := 0; i+1 < len(kv); i += 2 {
		k, v := kv[i], kv[i+1]
		if !ValidKey(k) || strings.TrimSpace(v) == "" {
			continue
		}
		b.WriteByte(' ')
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(Quote(v))
	}
	return b.String()
}

func levelWord(level string) string {
	switch strings.ToLower(strings.TrimSpace(level)) {
	case "debug", "trace":
		return "debug"
	case "warn", "warning":
		return "warning"
	case "error", "err", "fatal":
		return "error"
	}
	return "info"
}

// ValidKey reports whether k is a logfmt key the forwarder reads: [a-z][a-z0-9_]{0,39}.
func ValidKey(k string) bool {
	if k == "" || len(k) > 40 || k[0] < 'a' || k[0] > 'z' {
		return false
	}
	for i := 1; i < len(k); i++ {
		c := k[i]
		if (c < 'a' || c > 'z') && (c < '0' || c > '9') && c != '_' {
			return false
		}
	}
	return true
}

// SafeBare reports whether v can be written without quotes: letters, digits and . _ : / @ + -.
func SafeBare(v string) bool {
	if v == "" {
		return false
	}
	for i := 0; i < len(v); i++ {
		c := v[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.', c == '_', c == ':', c == '/', c == '@', c == '+', c == '-':
		default:
			return false
		}
	}
	return true
}

// Quote returns v as a logfmt value: on one line, at most MaxValueBytes, and in double quotes
// (with any double quote inside turned into a single one) unless it is SafeBare.
func Quote(v string) string {
	v = strings.TrimSpace(oneLine(v))
	if len(v) > MaxValueBytes {
		cut := MaxValueBytes
		for cut > 0 && !utf8.RuneStart(v[cut]) {
			cut--
		}
		v = v[:cut]
	}
	if SafeBare(v) {
		return v
	}
	return `"` + strings.ReplaceAll(v, `"`, `'`) + `"`
}

func oneLine(s string) string {
	if !strings.ContainsAny(s, "\r\n\t") {
		return s
	}
	return strings.NewReplacer("\r\n", " ", "\n", " ", "\r", " ", "\t", " ").Replace(s)
}
