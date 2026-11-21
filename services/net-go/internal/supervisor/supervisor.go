package supervisor

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"sync"
	"time"
)

// ChildStatus tracks the lifecycle state of a supervised subprocess.
type ChildStatus string

const (
	StatusPending  ChildStatus = "pending"
	StatusRunning  ChildStatus = "running"
	StatusStopped  ChildStatus = "stopped"
	StatusDegraded ChildStatus = "degraded"
)

// ChildSpec describes a child binary managed by the single-service Slipgate supervisor.
type ChildSpec struct {
	Name          string
	Binary        string
	Args          []string
	Env           []string
	AllowDegraded bool
}

// ChildSnapshot exposes thread-safe status info for health/readiness endpoints.
type ChildSnapshot struct {
	Name      string      `json:"name"`
	Status    ChildStatus `json:"status"`
	PID       int         `json:"pid"`
	LastError string      `json:"last_error,omitempty"`
}

type managedChild struct {
	spec      ChildSpec
	cmd       *exec.Cmd
	status    ChildStatus
	pid       int
	lastError string
	done      chan struct{}
}

// Supervisor launches and cleanly terminates slipgate-core (Zig) and slipgate-bff (Bun).
type Supervisor struct {
	logger   *log.Logger
	mu       sync.RWMutex
	children []*managedChild
	order    []int
}

// New initializes a supervisor with a target logger.
func New(logger *log.Logger) *Supervisor {
	if logger == nil {
		logger = log.Default()
	}
	return &Supervisor{logger: logger}
}

// StartAll starts each ChildSpec in order. If a required child fails to start and AllowDegraded is false,
// previously started children are stopped and the error is returned.
func (s *Supervisor) StartAll(ctx context.Context, specs []ChildSpec) error {
	s.mu.Lock()
	s.children = make([]*managedChild, len(specs))
	s.order = make([]int, 0, len(specs))
	for i, spec := range specs {
		s.children[i] = &managedChild{
			spec:   spec,
			status: StatusPending,
		}
	}
	s.mu.Unlock()

	for i, spec := range specs {
		if err := s.startChild(ctx, i); err != nil {
			if spec.AllowDegraded {
				s.logger.Printf("[supervisor] child %s degraded (continuing): %v", spec.Name, err)
				s.mu.Lock()
				s.children[i].status = StatusDegraded
				s.children[i].lastError = err.Error()
				s.mu.Unlock()
				continue
			}
			_ = s.Stop(5 * time.Second)
			return fmt.Errorf("supervisor: start %s: %w", spec.Name, err)
		}
	}
	return nil
}

func (s *Supervisor) startChild(ctx context.Context, idx int) error {
	s.mu.RLock()
	spec := s.children[idx].spec
	s.mu.RUnlock()

	cmd := exec.CommandContext(ctx, spec.Binary, spec.Args...)
	if len(spec.Env) > 0 {
		cmd.Env = append(os.Environ(), spec.Env...)
	}

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}

	if err := cmd.Start(); err != nil {
		return err
	}

	done := make(chan struct{})
	s.mu.Lock()
	child := s.children[idx]
	child.cmd = cmd
	child.pid = cmd.Process.Pid
	child.status = StatusRunning
	child.done = done
	s.order = append(s.order, idx)
	s.mu.Unlock()

	var ioWG sync.WaitGroup
	ioWG.Add(2)
	go s.streamLogs(spec.Name, stdout, &ioWG)
	go s.streamLogs(spec.Name, stderr, &ioWG)

	go func() {
		ioWG.Wait()
		waitErr := cmd.Wait()

		s.mu.Lock()
		if waitErr != nil && !errors.Is(ctx.Err(), context.Canceled) {
			child.status = StatusDegraded
			child.lastError = waitErr.Error()
		} else {
			child.status = StatusStopped
		}
		s.mu.Unlock()
		close(done)
	}()

	s.logger.Printf("[supervisor] started %s (pid=%d)", spec.Name, cmd.Process.Pid)
	return nil
}

func (s *Supervisor) streamLogs(name string, r io.Reader, wg *sync.WaitGroup) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		s.logger.Printf("[%s] %s", name, scanner.Text())
	}
}

// Stop terminates all running child processes in reverse startup order.
func (s *Supervisor) Stop(graceTimeout time.Duration) error {
	s.mu.RLock()
	order := append([]int(nil), s.order...)
	children := append([]*managedChild(nil), s.children...)
	s.mu.RUnlock()

	var firstErr error
	for i := len(order) - 1; i >= 0; i-- {
		child := children[order[i]]
		if child == nil || child.cmd == nil || child.cmd.Process == nil {
			continue
		}
		select {
		case <-child.done:
			continue
		default:
		}

		// Try graceful interrupt first; force-kill if the child doesn't exit within graceTimeout.
		_ = child.cmd.Process.Signal(os.Interrupt)
		timer := time.NewTimer(graceTimeout)
		select {
		case <-child.done:
			timer.Stop()
		case <-timer.C:
			if killErr := child.cmd.Process.Kill(); killErr != nil && !errors.Is(killErr, os.ErrProcessDone) {
				if firstErr == nil {
					firstErr = killErr
				}
			}
			<-child.done
		}
	}
	return firstErr
}

// Snapshots returns a copy of current supervised child states.
func (s *Supervisor) Snapshots() []ChildSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()

	out := make([]ChildSnapshot, 0, len(s.children))
	for _, c := range s.children {
		out = append(out, ChildSnapshot{
			Name:      c.spec.Name,
			Status:    c.status,
			PID:       c.pid,
			LastError: c.lastError,
		})
	}
	return out
}
