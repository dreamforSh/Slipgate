package dataplane

import "testing"

func TestClientIPAccessDenylistWinsOverAllowlist(t *testing.T) {
	c := &Coordinator{
		keyIPAllowlists: map[string][]string{
			"k_allow": {"10.0.0.0/8"},
			"k_both":  {"10.0.0.0/8"},
		},
		keyIPDenylists: map[string][]string{
			"k_deny": {"203.0.113.7", "198.51.100.0/24"},
			"k_both": {"10.1.2.0/24"},
		},
	}
	cases := []struct {
		key, ip string
		want    bool
	}{
		{"k_open", "203.0.113.7", true},
		{"k_allow", "10.9.9.9", true},
		{"k_allow", "192.0.2.1", false},
		{"k_deny", "203.0.113.7", false},
		{"k_deny", "198.51.100.42", false},
		{"k_deny", "192.0.2.1", true},
		{"k_both", "10.1.2.3", false},
		{"k_both", "10.3.2.1", true},
		{"k_both", "192.0.2.1", false},
	}
	for _, tc := range cases {
		if got := c.isClientIPAllowed(tc.key, tc.ip); got != tc.want {
			t.Errorf("isClientIPAllowed(%q, %q) = %v, want %v", tc.key, tc.ip, got, tc.want)
		}
	}
}
