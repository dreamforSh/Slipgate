package config

import "testing"

func TestInternalOriginPointsTheBFFAtTheInternalListener(t *testing.T) {
	t.Parallel()
	for addr, want := range map[string]string{
		"127.0.0.1:19083": "http://127.0.0.1:19083",
		":19083":          "http://127.0.0.1:19083",
		"0.0.0.0:19083":   "http://127.0.0.1:19083",
		"[::]:19083":      "http://127.0.0.1:19083",
		"10.0.0.5:19083":  "http://10.0.0.5:19083",
		"[fd00::5]:7000":  "http://[fd00::5]:7000",
		"bogus":           "http://127.0.0.1:19083",
	} {
		if got := InternalOrigin(addr); got != want {
			t.Fatalf("InternalOrigin(%q) = %q, want %q", addr, got, want)
		}
	}
}

func TestInternalListenerDefaultsToLoopback(t *testing.T) {
	t.Setenv("SLIPGATE_INTERNAL_LISTEN_ADDR", "")
	if got := LoadFromEnv().InternalListenAddr; got != "127.0.0.1:19083" {
		t.Fatalf("the internal listener must default to loopback, got %q", got)
	}
}
