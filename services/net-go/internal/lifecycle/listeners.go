package lifecycle

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"sort"
	"strconv"
	"strings"
)

// InheritEnv carries listening sockets from a restarting edge to its successor:
// "public:5,internal:6" maps listener names to inherited file descriptors.
const InheritEnv = "SLIPGATE_INHERIT_FDS"

// HandoffCapability is printed by `slipgate -capabilities` when the binary understands InheritEnv.
const HandoffCapability = "listener-handoff"

// Inherited is the set of listening sockets passed in by the previous process.
type Inherited map[string]uintptr

// TakeInherited parses InheritEnv and removes it from the environment so supervised children
// never see it.
func TakeInherited() Inherited {
	raw := strings.TrimSpace(os.Getenv(InheritEnv))
	_ = os.Unsetenv(InheritEnv)
	out := Inherited{}
	if raw == "" || !HandoffSupported() {
		return out
	}
	for _, part := range strings.Split(raw, ",") {
		name, fdText, ok := strings.Cut(strings.TrimSpace(part), ":")
		if !ok || name == "" {
			continue
		}
		fd, err := strconv.ParseUint(fdText, 10, 32)
		if err != nil || fd < 3 {
			continue
		}
		out[name] = uintptr(fd)
	}
	return out
}

// Listen returns the inherited listener called name when it is bound to exactly addr (same port
// and same bind address), else a fresh TCP listener on addr. inherited reports which one it was.
func (in Inherited) Listen(name, addr string) (ln net.Listener, inherited bool, err error) {
	if fd, ok := in[name]; ok {
		delete(in, name)
		if f := os.NewFile(fd, "slipgate-inherited-"+name); f != nil {
			candidate, fileErr := net.FileListener(f)
			_ = f.Close()
			if fileErr == nil {
				if sameListenAddr(candidate.Addr(), addr) {
					return candidate, true, nil
				}
				_ = candidate.Close()
			}
		}
	}
	ln, err = net.Listen("tcp", addr)
	return ln, false, err
}

// CloseUnused closes inherited descriptors no Listen call claimed.
func (in Inherited) CloseUnused() {
	for name, fd := range in {
		if f := os.NewFile(fd, "slipgate-inherited-"+name); f != nil {
			_ = f.Close()
		}
		delete(in, name)
	}
}

// Handoff holds duplicated listening sockets kept open (and inheritable) across exec.
type Handoff struct {
	files map[string]*os.File
	fds   map[string]uintptr
}

// PrepareHandoff duplicates each listener's socket and makes the copy survive exec. Call it
// before shutting the HTTP servers down: closing the original then leaves the socket listening
// (the kernel keeps completing handshakes into the backlog) until the successor accepts.
func PrepareHandoff(listeners map[string]net.Listener) (*Handoff, error) {
	if !HandoffSupported() {
		return nil, errors.New("lifecycle: listener handoff is not supported on this platform")
	}
	h := &Handoff{files: map[string]*os.File{}, fds: map[string]uintptr{}}
	for name, ln := range listeners {
		tcp, ok := ln.(*net.TCPListener)
		if !ok {
			h.Close()
			return nil, fmt.Errorf("lifecycle: listener %q is %T, not *net.TCPListener", name, ln)
		}
		f, err := tcp.File()
		if err != nil {
			h.Close()
			return nil, fmt.Errorf("lifecycle: duplicate listener %q: %w", name, err)
		}
		fd, err := inheritableFD(f)
		if err != nil {
			_ = f.Close()
			h.Close()
			return nil, fmt.Errorf("lifecycle: make listener %q inheritable: %w", name, err)
		}
		h.files[name] = f
		h.fds[name] = fd
	}
	return h, nil
}

// Env returns the InheritEnv assignment for the successor ("" when there is nothing to pass).
func (h *Handoff) Env() string {
	if h == nil || len(h.fds) == 0 {
		return ""
	}
	names := make([]string, 0, len(h.fds))
	for name := range h.fds {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s:%d", name, h.fds[name]))
	}
	return InheritEnv + "=" + strings.Join(parts, ",")
}

// Close releases the duplicated sockets (when exec fails or is skipped).
func (h *Handoff) Close() {
	if h == nil {
		return
	}
	for name, f := range h.files {
		_ = f.Close()
		delete(h.files, name)
		delete(h.fds, name)
	}
}

// sameListenAddr reports whether an inherited socket bound to got may serve addr. The port must
// match and so must the bind address, so a successor configured for 127.0.0.1 never keeps serving
// on an all-interfaces socket: a wildcard host ("", "*", "0.0.0.0", "::") wants a wildcard socket
// (of the same family when the family is spelled out), a literal IP wants exactly that IP, and a
// host name is never trusted to match (it may resolve differently now) so a fresh socket is bound.
func sameListenAddr(got net.Addr, want string) bool {
	tcp, ok := got.(*net.TCPAddr)
	if !ok {
		return false
	}
	host, port, err := net.SplitHostPort(strings.TrimSpace(want))
	if err != nil || port != strconv.Itoa(tcp.Port) {
		return false
	}
	gotIP, ok := netip.AddrFromSlice(tcp.IP)
	if !ok {
		return false
	}
	gotIP = gotIP.Unmap()
	if host == "" || host == "*" {
		return gotIP.IsUnspecified()
	}
	wantIP, err := netip.ParseAddr(host)
	if err != nil {
		return false
	}
	wantIP = wantIP.Unmap()
	if wantIP.IsUnspecified() {
		return gotIP.IsUnspecified() && gotIP.Is4() == wantIP.Is4()
	}
	return gotIP == wantIP
}
