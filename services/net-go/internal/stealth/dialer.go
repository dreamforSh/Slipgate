package stealth

import (
	"context"
	"fmt"
	"net"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

// ProfileSpec defines TLS/HTTP2 fingerprint traits attached to an upstream account.
type ProfileSpec struct {
	ID                string
	Name              string
	JA3Fingerprint    string
	JA4Fingerprint    string
	ALPNProtocols     []string
	UserAgentTemplate string
}

// AccountDialer establishes outbound connections strictly through the account's bound Clash exit.
// Direct connections are disallowed to prevent source IP leakage.
type AccountDialer struct {
	pool      *clashpool.Manager
	baseDial  net.Dialer
	profiles  map[string]ProfileSpec
}

// NewAccountDialer constructs an AccountDialer backed by a Clash exit pool.
func NewAccountDialer(pool *clashpool.Manager) *AccountDialer {
	return &AccountDialer{
		pool: pool,
		baseDial: net.Dialer{
			Timeout:   15 * time.Second,
			KeepAlive: 30 * time.Second,
		},
		profiles: make(map[string]ProfileSpec),
	}
}

// RegisterProfile stores a TLS fingerprint profile template.
func (d *AccountDialer) RegisterProfile(spec ProfileSpec) {
	d.profiles[spec.ID] = spec
}

// DialAccountExit resolves the account's Clash SOCKS5 listener (fail-closed) and connects to it.
func (d *AccountDialer) DialAccountExit(ctx context.Context, accountID, utlsProfileID string) (net.Conn, clashpool.DialTarget, error) {
	target, err := d.pool.ResolveDialTarget(accountID)
	if err != nil {
		return nil, clashpool.DialTarget{}, err
	}
	if utlsProfileID != "" {
		if _, ok := d.profiles[utlsProfileID]; !ok {
			return nil, clashpool.DialTarget{}, fmt.Errorf("stealth: unknown uTLS profile %q", utlsProfileID)
		}
	}
	conn, err := d.baseDial.DialContext(ctx, "tcp", target.SOCKSAddr)
	if err != nil {
		return nil, clashpool.DialTarget{}, fmt.Errorf("stealth: failed dialing Clash listener %s: %w", target.SOCKSAddr, err)
	}
	return conn, target, nil
}
