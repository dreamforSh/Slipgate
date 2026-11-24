//go:build windows

package main

import (
	"os"
	"os/exec"
)

func execSelf(targetBinary string) error {
	var args []string
	if len(os.Args) > 1 {
		args = os.Args[1:]
	}
	cmd := exec.Command(targetBinary, args...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = withEnv(os.Environ(), "SLIPGATE_REEXEC_GUARD", targetBinary)
	return cmd.Start()
}
