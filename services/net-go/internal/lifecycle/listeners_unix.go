//go:build !windows

package lifecycle

import (
	"os"
	"syscall"
)

// HandoffSupported reports whether listening sockets can survive syscall.Exec here.
func HandoffSupported() bool { return true }

// inheritableFD clears FD_CLOEXEC on f's descriptor without touching its blocking mode (f.Fd()
// would switch the shared open file description to blocking under the running listener).
func inheritableFD(f *os.File) (uintptr, error) {
	rc, err := f.SyscallConn()
	if err != nil {
		return 0, err
	}
	var (
		fd    uintptr
		opErr error
	)
	ctrlErr := rc.Control(func(raw uintptr) {
		fd = raw
		if _, _, errno := syscall.Syscall(syscall.SYS_FCNTL, raw, syscall.F_SETFD, 0); errno != 0 {
			opErr = errno
		}
	})
	if ctrlErr != nil {
		return 0, ctrlErr
	}
	return fd, opErr
}
