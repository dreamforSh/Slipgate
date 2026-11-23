package dpbridge

import (
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestAuthenticatedIPCExchangeAndRejection(t *testing.T) {
	t.Parallel()

	const secret = "ipc-shared-secret-token-0123456789abcdef"

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	go func() {
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				req, readErr := ReadFrame(c)
				if readErr != nil {
					return
				}
				inner, authErr := UnwrapAuthPayload(req.Flags, req.Payload, secret)
				if authErr != nil {
					_ = WriteFrame(c, Frame{
						StreamID: req.StreamID,
						Type:     FrameStreamEnd,
						Flags:    FlagEndStream | FlagError,
						Payload:  []byte(`{"error":"unauthorized_ipc"}`),
					})
					return
				}
				if req.Type == FramePing {
					_ = WriteFrame(c, Frame{
						StreamID: req.StreamID,
						Type:     FramePong,
						Flags:    FlagEndStream,
						Payload:  inner,
					})
				}
			}(conn)
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	// Unauthenticated Ping must fail with ErrUnauthorizedIPC.
	if err := Ping(ctx, ln.Addr().String()); !errors.Is(err, ErrUnauthorizedIPC) {
		t.Fatalf("expected unauthenticated Ping to fail with ErrUnauthorizedIPC, got %v", err)
	}

	// Wrong token must fail with ErrUnauthorizedIPC.
	if err := PingAuth(ctx, ln.Addr().String(), "wrong-token"); !errors.Is(err, ErrUnauthorizedIPC) {
		t.Fatalf("expected wrong-token PingAuth to fail with ErrUnauthorizedIPC, got %v", err)
	}

	// Matching token succeeds cleanly.
	if err := PingAuth(ctx, ln.Addr().String(), secret); err != nil {
		t.Fatalf("expected valid PingAuth to succeed, got %v", err)
	}
}
