//go:build !windows

package supervisor

func canInterruptChildren() bool { return true }
