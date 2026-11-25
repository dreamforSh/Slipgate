//go:build windows

package supervisor

import (
	"os"
	"os/exec"
	"syscall"
)

var procGenerateConsoleCtrlEvent = syscall.NewLazyDLL("kernel32.dll").NewProc("GenerateConsoleCtrlEvent")

// prepareChildCmd starts each child in its own process group: CTRL_BREAK can then be sent to that
// child alone, and a Ctrl+C in the console reaches only the edge, which drains public traffic
// before it stops the children itself.
func prepareChildCmd(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP}
}

// interruptChild asks a child to shut down gracefully with CTRL_BREAK_EVENT (os.Interrupt cannot
// be sent on Windows): Bun sees SIGBREAK, Go programs os.Interrupt. It fails when the edge has no
// console to share with the child, and the caller then kills it.
func interruptChild(proc *os.Process) error {
	if r, _, err := procGenerateConsoleCtrlEvent.Call(uintptr(syscall.CTRL_BREAK_EVENT), uintptr(proc.Pid)); r == 0 {
		return err
	}
	return nil
}
