//go:build windows

package lifecycle

import (
	"errors"
	"os"
)

// HandoffSupported is false on Windows: the edge restarts by spawning a new process, which
// cannot adopt the old process's sockets through the environment.
func HandoffSupported() bool { return false }

func inheritableFD(_ *os.File) (uintptr, error) {
	return 0, errors.New("lifecycle: listener handoff is not supported on windows")
}
