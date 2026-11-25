//go:build !windows

package lifecycle

import (
	"io"
	"net"
	"strconv"
	"syscall"
	"testing"
	"time"
)

// dupFD gives Inherited.Listen its own descriptor (it closes what it adopts) so the Handoff can
// still close its copy without double-closing a reused fd number.
func dupFD(t *testing.T, fd uintptr) uintptr {
	t.Helper()
	copyFD, err := syscall.Dup(int(fd))
	if err != nil {
		t.Fatalf("dup: %v", err)
	}
	return uintptr(copyFD)
}

// The duplicated socket keeps listening after the original listener closes, queues a client,
// and is adopted again through Inherited.Listen, as the successor process does after exec.
func TestHandoffKeepsSocketListeningAcrossClose(t *testing.T) {
	orig, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := orig.Addr().(*net.TCPAddr).Port

	h, err := PrepareHandoff(map[string]net.Listener{"public": orig})
	if err != nil {
		t.Fatalf("PrepareHandoff: %v", err)
	}
	defer h.Close()
	if err := orig.Close(); err != nil {
		t.Fatalf("close original: %v", err)
	}

	// A client connecting during the "restart gap" is queued by the kernel, not refused.
	conn, err := net.DialTimeout("tcp", "127.0.0.1:"+strconv.Itoa(port), time.Second)
	if err != nil {
		t.Fatalf("dial during handoff gap: %v", err)
	}
	defer conn.Close()

	adopted, inherited, err := Inherited{"public": dupFD(t, h.fds["public"])}.Listen("public", "127.0.0.1:"+strconv.Itoa(port))
	if err != nil || !inherited {
		t.Fatalf("expected inherited listener, inherited=%v err=%v", inherited, err)
	}
	defer adopted.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, acceptErr := adopted.Accept()
		if acceptErr == nil {
			accepted <- c
		}
	}()
	if _, err := conn.Write([]byte("ping")); err != nil {
		t.Fatalf("write: %v", err)
	}
	select {
	case c := <-accepted:
		defer c.Close()
		buf := make([]byte, 4)
		_ = c.SetReadDeadline(time.Now().Add(time.Second))
		if _, err := io.ReadFull(c, buf); err != nil || string(buf) != "ping" {
			t.Fatalf("queued connection not served: %q err=%v", string(buf), err)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("queued connection was never accepted by the adopted listener")
	}
}

func TestInheritedListenRejectsPortMismatch(t *testing.T) {
	orig, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer orig.Close()
	h, err := PrepareHandoff(map[string]net.Listener{"public": orig})
	if err != nil {
		t.Fatalf("PrepareHandoff: %v", err)
	}
	defer h.Close()

	ln, inherited, err := Inherited{"public": dupFD(t, h.fds["public"])}.Listen("public", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()
	if inherited {
		t.Fatalf("a socket bound to another port must not be adopted")
	}
}
