package dpbridge

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"strings"
)

const (
	// HeaderSize is the fixed 10-byte DataPlane IPC header length.
	HeaderSize = 10
	// MaxPayloadSize caps individual multiplexed frames at 16 MiB.
	MaxPayloadSize = 16 * 1024 * 1024
)

// FrameType identifies a multiplexed DataPlane binary frame.
type FrameType uint8

const (
	FramePing              FrameType = 0x01
	FramePong              FrameType = 0x02
	FrameReqHeaders        FrameType = 0x10
	FrameReqBodyChunk      FrameType = 0x11
	FrameDispatchDirective FrameType = 0x12
	FrameUpstreamChunk     FrameType = 0x13
	FrameStreamEnd         FrameType = 0x14
	FrameExitHealth        FrameType = 0x20
)

const (
	FlagEndStream   uint8 = 1 << 0
	FlagPassthrough uint8 = 1 << 1
	FlagError       uint8 = 1 << 2
)

var (
	ErrPayloadTooLarge = errors.New("dpbridge: payload exceeds maximum frame size")
	ErrShortHeader     = errors.New("dpbridge: frame header shorter than 10 bytes")
)

// Frame represents one DataPlane multiplexed IPC frame shared between Go and Zig.
type Frame struct {
	StreamID uint32
	Type     FrameType
	Flags    uint8
	Payload  []byte
}

// EncodeHeader serializes a frame header into a 10-byte big-endian buffer.
func EncodeHeader(streamID uint32, frameType FrameType, flags uint8, payloadLen uint32) ([HeaderSize]byte, error) {
	var buf [HeaderSize]byte
	if payloadLen > MaxPayloadSize {
		return buf, fmt.Errorf("%w: %d", ErrPayloadTooLarge, payloadLen)
	}
	binary.BigEndian.PutUint32(buf[0:4], streamID)
	buf[4] = byte(frameType)
	buf[5] = flags
	binary.BigEndian.PutUint32(buf[6:10], payloadLen)
	return buf, nil
}

// DecodeHeader parses a 10-byte big-endian frame header.
func DecodeHeader(buf []byte) (streamID uint32, frameType FrameType, flags uint8, payloadLen uint32, err error) {
	if len(buf) < HeaderSize {
		return 0, 0, 0, 0, ErrShortHeader
	}
	streamID = binary.BigEndian.Uint32(buf[0:4])
	frameType = FrameType(buf[4])
	flags = buf[5]
	payloadLen = binary.BigEndian.Uint32(buf[6:10])
	if payloadLen > MaxPayloadSize {
		return 0, 0, 0, 0, fmt.Errorf("%w: %d", ErrPayloadTooLarge, payloadLen)
	}
	return streamID, frameType, flags, payloadLen, nil
}

// WriteFrame writes the encoded 10-byte header followed by the frame payload.
func WriteFrame(w io.Writer, frame Frame) error {
	if len(frame.Payload) > MaxPayloadSize {
		return fmt.Errorf("%w: %d", ErrPayloadTooLarge, len(frame.Payload))
	}
	hdr, err := EncodeHeader(frame.StreamID, frame.Type, frame.Flags, uint32(len(frame.Payload)))
	if err != nil {
		return err
	}
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if len(frame.Payload) > 0 {
		if _, err := w.Write(frame.Payload); err != nil {
			return err
		}
	}
	return nil
}

// ReadFrame reads a complete multiplexed frame from r.
func ReadFrame(r io.Reader) (Frame, error) {
	var hdr [HeaderSize]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		return Frame{}, err
	}
	streamID, frameType, flags, payloadLen, err := DecodeHeader(hdr[:])
	if err != nil {
		return Frame{}, err
	}
	var payload []byte
	if payloadLen > 0 {
		payload = make([]byte, payloadLen)
		if _, err := io.ReadFull(r, payload); err != nil {
			return Frame{}, err
		}
	}
	return Frame{
		StreamID: streamID,
		Type:     frameType,
		Flags:    flags,
		Payload:  payload,
	}, nil
}

// DialIPC dials either a Unix domain socket (`unix:///path`) or TCP (`tcp://host:port` / `host:port`).
func DialIPC(ctx context.Context, endpoint string) (net.Conn, error) {
	var dialer net.Dialer
	if strings.HasPrefix(endpoint, "unix://") {
		return dialer.DialContext(ctx, "unix", strings.TrimPrefix(endpoint, "unix://"))
	}
	target := strings.TrimPrefix(endpoint, "tcp://")
	return dialer.DialContext(ctx, "tcp", target)
}

// Ping verifies live connectivity to slipgate-core over the binary frame protocol.
func Ping(ctx context.Context, endpoint string) error {
	conn, err := DialIPC(ctx, endpoint)
	if err != nil {
		return err
	}
	defer conn.Close()

	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}

	req := Frame{
		StreamID: 0,
		Type:     FramePing,
		Flags:    FlagEndStream,
		Payload:  []byte("slipgate-ping"),
	}
	if err := WriteFrame(conn, req); err != nil {
		return err
	}
	resp, err := ReadFrame(conn)
	if err != nil {
		return err
	}
	if resp.Type != FramePong {
		return fmt.Errorf("dpbridge: unexpected ping response frame type 0x%02x", resp.Type)
	}
	return nil
}
