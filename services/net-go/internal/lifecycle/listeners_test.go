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
