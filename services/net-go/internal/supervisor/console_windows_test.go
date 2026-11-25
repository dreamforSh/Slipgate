//go:build windows

package supervisor

import "syscall"

// canInterruptChildren reports whether this process has a console to send CTRL_BREAK through.
func canInterruptChildren() bool {
	r, _, _ := syscall.NewLazyDLL("kernel32.dll").NewProc("GetConsoleWindow").Call()
	return r != 0
}
