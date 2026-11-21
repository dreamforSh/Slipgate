package stealth

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
)

// CoordinatorAdapter bridges AccountDialer onto clashpool.StealthDialer cleanly without circular imports.
type CoordinatorAdapter struct {
	dialer *AccountDialer
}

var _ clashpool.StealthDialer = (*CoordinatorAdapter)(nil)

// NewCoordinatorAdapter wraps dialer as a clashpool.StealthDialer.
func NewCoordinatorAdapter(dialer *AccountDialer) *CoordinatorAdapter {
	return &CoordinatorAdapter{dialer: dialer}
}

func (a *CoordinatorAdapter) ListProfiles() []clashpool.TLSProfile {
	return a.dialer.ListProfiles()
}

func (a *CoordinatorAdapter) RegisterProfile(spec clashpool.TLSProfile) {
	a.dialer.RegisterProfile(spec)
}

func (a *CoordinatorAdapter) DeleteProfile(profileID string) error {
	return a.dialer.DeleteProfile(profileID)
}

func (a *CoordinatorAdapter) TestAccountHTTP(ctx context.Context, accountID, utlsProfileID, targetURL string) (clashpool.OutboundMeta, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, targetURL, nil)
	if err != nil {
		return clashpool.OutboundMeta{}, err
	}
	res, err := a.dialer.DoAccountRequest(ctx, accountID, utlsProfileID, req)
	if err != nil {
		return clashpool.OutboundMeta{}, err
	}
	defer res.Response.Body.Close()

	var snippetBuf [1024]byte
	n, _ := io.ReadFull(res.Response.Body, snippetBuf[:])
	return clashpool.OutboundMeta{
		StatusCode:     res.Response.StatusCode,
		BodySnippet:    string(snippetBuf[:n]),
		Target:         res.DialTarget,
		TLSVersion:     res.TLSVersion,
		NegotiatedALPN: res.NegotiatedALPN,
		LatencyMS:      res.LatencyMS,
	}, nil
}

func (a *CoordinatorAdapter) ProbeNodeExitIP(ctx context.Context, socksAddr, username, password, ipEchoURL string, timeout time.Duration) (string, uint32, error) {
	return ProbeExitIP(ctx, socksAddr, username, password, ipEchoURL, timeout)
}
