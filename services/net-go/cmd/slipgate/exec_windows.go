//go:build windows

package main

import (
	"os"
	"os/exec"
	"strings"
)

// execSelf starts targetBinary as a new process (Windows has no exec) and returns; the caller
// then exits. Listening sockets cannot be passed this way, so extraEnv never carries any.
func execSelf(targetBinary string, extraEnv ...string) error {
	var args []string
	if len(os.Args) > 1 {
		args = os.Args[1:]
	}
	cmd := exec.Command(targetBinary, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	env := withEnv(os.Environ(), "SLIPGATE_REEXEC_GUARD", targetBinary)
	for _, kv := range extraEnv {
		if key, val, ok := strings.Cut(kv, "="); ok && key != "" {
			env = withEnv(env, key, val)
		}
	}
	cmd.Env = env
	return cmd.Start()
}
