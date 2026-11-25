package lifecycle

import (
	"net"
	"os"
	"testing"
)

func TestTakeInheritedParsesAndClearsEnv(t *testing.T) {
	t.Setenv(InheritEnv, "public:7, internal:8,bogus,neg:-1,low:2")
	in := TakeInherited()
	if _, still := os.LookupEnv(InheritEnv); still {
		t.Fatalf("%s must be removed from the environment", InheritEnv)
	}
	if !HandoffSupported() {
		if len(in) != 0 {
			t.Fatalf("handoff unsupported here, expected no inherited fds, got %v", in)
		}
		return
	}
	if in["public"] != 7 || in["internal"] != 8 || len(in) != 2 {
		t.Fatalf("unexpected inherited map %v", in)
	}
}

func TestListenFallsBackToFreshSocket(t *testing.T) {
	t.Parallel()

	ln, inherited, err := Inherited{}.Listen("public", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	defer ln.Close()
	if inherited {
		t.Fatalf("expected a fresh listener")
	}
	if _, ok := ln.Addr().(*net.TCPAddr); !ok {
		t.Fatalf("expected TCP listener, got %T", ln.Addr())
	}
}

func TestHandoffEnvFormatting(t *testing.T) {
	t.Parallel()

	var nilHandoff *Handoff
	if nilHandoff.Env() != "" {
		t.Fatalf("nil handoff must produce no env")
	}
	h := &Handoff{fds: map[string]uintptr{"public": 9, "internal": 10}}
	if got, want := h.Env(), InheritEnv+"=internal:10,public:9"; got != want {
		t.Fatalf("Env() = %q, want %q", got, want)
	}
}

func TestSameListenAddrRequiresMatchingHost(t *testing.T) {
	t.Parallel()

	v4Any := &net.TCPAddr{IP: net.IPv4zero, Port: 8080}
	v6Any := &net.TCPAddr{IP: net.IPv6unspecified, Port: 8080}
	loop := &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 8080}
	cases := []struct {
		name string
		got  net.Addr
		want string
		ok   bool
	}{
		{"wildcard on dual-stack", v6Any, ":8080", true},
		{"wildcard on v4 any", v4Any, ":8080", true},
		{"explicit v4 any", v4Any, "0.0.0.0:8080", true},
		{"v4 any vs v6 any", v6Any, "0.0.0.0:8080", false},
		{"loopback exact", loop, "127.0.0.1:8080", true},
		{"narrowed to loopback", v6Any, "127.0.0.1:8080", false},
		{"widened from loopback", loop, ":8080", false},
		{"other port", loop, "127.0.0.1:9090", false},
		{"host name never matches", loop, "localhost:8080", false},
		{"malformed", loop, "8080", false},
	}
	for _, tc := range cases {
		if got := sameListenAddr(tc.got, tc.want); got != tc.ok {
			t.Errorf("%s: sameListenAddr(%v, %q) = %v, want %v", tc.name, tc.got, tc.want, got, tc.ok)
		}
	}
}
