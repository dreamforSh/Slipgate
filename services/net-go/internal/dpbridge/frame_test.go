package dpbridge

import (
	"bytes"
	"context"
	"errors"
	"net"
	"testing"
	"time"
)

func TestFrameRoundTrip(t *testing.T) {
	t.Parallel()

	in := Frame{
		StreamID: 42,
		Type:     FrameReqHeaders,
		Flags:    FlagEndStream | FlagPassthrough,
		Payload:  []byte(`{"model":"claude-sonnet-4-5"}`),
	}

	var buf bytes.Buffer
	if err := WriteFrame(&buf, in); err != nil {
		t.Fatalf("WriteFrame failed: %v", err)
	}
	if buf.Len() != HeaderSize+len(in.Payload) {
		t.Fatalf("unexpected encoded size: got %d want %d", buf.Len(), HeaderSize+len(in.Payload))
	}

	out, err := ReadFrame(&buf)
	if err != nil {
		t.Fatalf("ReadFrame failed: %v", err)
	}
	if out.StreamID != in.StreamID || out.Type != in.Type || out.Flags != in.Flags {
		t.Fatalf("header mismatch: got %+v want %+v", out, in)
	}
	if !bytes.Equal(out.Payload, in.Payload) {
		t.Fatalf("payload mismatch: got %q want %q", out.Payload, in.Payload)
	}
}

func TestOversizedFrameRejected(t *testing.T) {
	t.Parallel()

	_, err := EncodeHeader(1, FrameReqBodyChunk, 0, MaxPayloadSize+1)
	if !errors.Is(err, ErrPayloadTooLarge) {
		t.Fatalf("expected ErrPayloadTooLarge, got %v", err)
	}
}

func TestPingExchange(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	done := make(chan error, 1)
	go func() {
		conn, acceptErr := ln.Accept()
		if acceptErr != nil {
			done <- acceptErr
			return
		}
		defer conn.Close()

		req, readErr := ReadFrame(conn)
		if readErr != nil {
			done <- readErr
			return
		}
		done <- WriteFrame(conn, Frame{
			StreamID: req.StreamID,
			Type:     FramePong,
			Flags:    FlagEndStream,
			Payload:  req.Payload,
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	if err := Ping(ctx, ln.Addr().String()); err != nil {
		t.Fatalf("Ping failed: %v", err)
	}
	if err := <-done; err != nil {
		t.Fatalf("server handler failed: %v", err)
	}
}

func TestSyncAndSettleFrameExchange(t *testing.T) {
	t.Parallel()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen failed: %v", err)
	}
	defer ln.Close()

	go func() {
		for range 2 {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			req, readErr := ReadFrame(conn)
			if readErr == nil {
				replyType := FrameSyncAck
				if req.Type == FrameSettleReport {
					replyType = FrameSettleAck
				}
				_ = WriteFrame(conn, Frame{
					StreamID: req.StreamID,
					Type:     replyType,
					Flags:    FlagEndStream,
					Payload:  []byte(`{"ok":true}`),
				})
			}
			_ = conn.Close()
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	syncResp, err := Exchange(ctx, ln.Addr().String(), Frame{
		StreamID: 10,
		Type:     FrameSyncState,
		Flags:    FlagEndStream,
		Payload:  []byte(`{"groups":[]}`),
	})
	if err != nil || syncResp.Type != FrameSyncAck {
		t.Fatalf("expected FrameSyncAck, got %+v err=%v", syncResp, err)
	}

	settleResp, err := Exchange(ctx, ln.Addr().String(), Frame{
		StreamID: 11,
		Type:     FrameSettleReport,
		Flags:    FlagEndStream,
		Payload:  []byte(`{"holdId":1}`),
	})
	if err != nil || settleResp.Type != FrameSettleAck {
		t.Fatalf("expected FrameSettleAck, got %+v err=%v", settleResp, err)
	}
}
