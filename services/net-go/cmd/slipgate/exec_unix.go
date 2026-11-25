//go:build !windows

package main

import (
	"os"
	"strings"
	"syscall"
)

// execSelf replaces the process image with targetBinary (same PID, so Docker and systemd see no
// exit). extraEnv entries ("KEY=value") are added on top of the current environment, e.g. the
// inherited listener descriptors.
func execSelf(targetBinary string, extraEnv ...string) error {
	args := []string{targetBinary}
	if len(os.Args) > 1 {
		args = append(args, os.Args[1:]...)
	}
	env := withEnv(os.Environ(), "SLIPGATE_REEXEC_GUARD", targetBinary)
	for _, kv := range extraEnv {
		if key, val, ok := strings.Cut(kv, "="); ok && key != "" {
			env = withEnv(env, key, val)
		}
	}
	return syscall.Exec(targetBinary, args, env)
}
