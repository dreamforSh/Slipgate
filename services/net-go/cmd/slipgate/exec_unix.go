//go:build !windows

package main

import (
	"os"
	"syscall"
)

func execSelf(targetBinary string) error {
	args := []string{targetBinary}
	if len(os.Args) > 1 {
		args = append(args, os.Args[1:]...)
	}
	return syscall.Exec(targetBinary, args, withEnv(os.Environ(), "SLIPGATE_REEXEC_GUARD", targetBinary))
}
