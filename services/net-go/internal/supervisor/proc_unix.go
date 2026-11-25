//go:build !windows

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
)

// prepareChildCmd puts each child in its own process group, so a Ctrl+C in the operator's
// terminal (or any signal sent to the edge's group) reaches only the edge: it drains public
// traffic first and then stops the children itself.
func prepareChildCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// interruptChild asks a child to shut down gracefully.
func interruptChild(proc *os.Process) error {
	return proc.Signal(os.Interrupt)
}
