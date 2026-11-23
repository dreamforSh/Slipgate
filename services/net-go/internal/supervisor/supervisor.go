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
	"slices"
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
	spec          ChildSpec
	cmd           *exec.Cmd
	status        ChildStatus
	pid           int
	lastError     string
	done          chan struct{}
	crashRestarts int
	lastStartAt   time.Time
}

// Supervisor launches, hot-restarts, and cleanly terminates slipgate-core (Zig) and slipgate-bff (Bun).
type Supervisor struct {
	logger      *log.Logger
	lifecycleMu sync.Mutex
	mu          sync.RWMutex
	rootCtx     context.Context
	stopping    bool
	children    []*managedChild
	order       []int
	// lineHook also receives every child output line (system-log forwarding); nil when unset.
	lineHook func(child, line string)
	// restartHook runs asynchronously whenever a child restarts after an unexpected crash; nil when unset.
	restartHook func(child string)
}

// SetRestartHook registers a callback invoked asynchronously after a supervised child recovers from a crash.
func (s *Supervisor) SetRestartHook(hook func(child string)) {
	s.mu.Lock()
	s.restartHook = hook
	s.mu.Unlock()
}

// SetLineHook registers a function that receives each output line of every child started from
// now on (after it is echoed to the logger). The hook must not block.
func (s *Supervisor) SetLineHook(hook func(child, line string)) {
	s.mu.Lock()
	s.lineHook = hook
	s.mu.Unlock()
}

// New initializes a supervisor with a target logger.
func New(logger *log.Logger) *Supervisor {
	if logger == nil {
		logger = log.Default()
	}
	return &Supervisor{
		logger:  logger,
		rootCtx: context.Background(),
	}
}

// StartAll starts each ChildSpec in order. If a required child fails to start and AllowDegraded is false,
// previously started children are stopped and the error is returned.
func (s *Supervisor) StartAll(ctx context.Context, specs []ChildSpec) error {
	if ctx == nil {
		ctx = context.Background()
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()

	s.mu.Lock()
	s.rootCtx = ctx
	s.stopping = false
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
		if err := s.startChildLocked(ctx, i); err != nil {
			if spec.AllowDegraded {
				s.logger.Printf("[supervisor] child %s degraded (continuing): %v", spec.Name, err)
				s.mu.Lock()
				s.children[i].status = StatusDegraded
				s.children[i].lastError = err.Error()
				s.mu.Unlock()
				continue
			}
			_ = s.stopAllLocked(5 * time.Second)
			return fmt.Errorf("supervisor: start %s: %w", spec.Name, err)
		}
	}
	return nil
}

// UpdateChildBinary atomically updates the binary path used on the next start/restart of the named child.
func (s *Supervisor) UpdateChildBinary(name, binaryPath string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	for _, c := range s.children {
		if c != nil && c.spec.Name == name {
			c.spec.Binary = binaryPath
			return nil
		}
	}
	return fmt.Errorf("supervisor: unknown child %q", name)
}

// RestartChild gracefully stops a single supervised child and launches it again without affecting other children.
func (s *Supervisor) RestartChild(ctx context.Context, name string, graceTimeout time.Duration) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()

	s.mu.RLock()
	idx := -1
	var child *managedChild
	spawnCtx := s.rootCtx
	for i, c := range s.children {
		if c != nil && c.spec.Name == name {
			idx = i
			child = c
			break
		}
	}
	s.mu.RUnlock()

	if idx < 0 || child == nil {
		return fmt.Errorf("supervisor: unknown child %q", name)
	}
	if spawnCtx == nil {
		spawnCtx = context.Background()
	}

	if err := s.stopChild(child, graceTimeout); err != nil {
		s.logger.Printf("[supervisor] stop warning during restart of %s: %v", name, err)
	}

	if err := s.startChildLocked(spawnCtx, idx); err != nil {
		if child.spec.AllowDegraded {
			s.logger.Printf("[supervisor] child %s degraded after restart (continuing): %v", name, err)
			s.mu.Lock()
			child.status = StatusDegraded
			child.lastError = err.Error()
			s.mu.Unlock()
			return nil
		}
		return fmt.Errorf("supervisor: restart %s: %w", name, err)
	}
	return nil
}

// RestartAll gracefully stops all supervised children in reverse order and starts them again in dependency order.
func (s *Supervisor) RestartAll(ctx context.Context, graceTimeout time.Duration) error {
	if ctx != nil && ctx.Err() != nil {
		return ctx.Err()
	}

	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()

	if err := s.stopAllLocked(graceTimeout); err != nil {
		s.logger.Printf("[supervisor] stop warning during RestartAll: %v", err)
	}

	s.mu.RLock()
	count := len(s.children)
	spawnCtx := s.rootCtx
	s.mu.RUnlock()
	if spawnCtx == nil {
		spawnCtx = context.Background()
	}

	for i := 0; i < count; i++ {
		if ctx != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		s.mu.RLock()
		spec := s.children[i].spec
		s.mu.RUnlock()

		if err := s.startChildLocked(spawnCtx, i); err != nil {
			if spec.AllowDegraded {
				s.logger.Printf("[supervisor] child %s degraded after restart (continuing): %v", spec.Name, err)
				s.mu.Lock()
				s.children[i].status = StatusDegraded
				s.children[i].lastError = err.Error()
				s.mu.Unlock()
				continue
			}
			return fmt.Errorf("supervisor: restart %s: %w", spec.Name, err)
		}
	}
	return nil
}

func (s *Supervisor) startChildLocked(ctx context.Context, idx int) error {
	s.mu.RLock()
	child := s.children[idx]
	spec := child.spec
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
	startedAt := time.Now()
	s.mu.Lock()
	child.cmd = cmd
	child.pid = cmd.Process.Pid
	child.status = StatusRunning
	child.lastError = ""
	child.done = done
	child.lastStartAt = startedAt
	if !slices.Contains(s.order, idx) {
		s.order = append(s.order, idx)
	}
	hook := s.lineHook
	s.mu.Unlock()

	var ioWG sync.WaitGroup
	ioWG.Add(2)
	go s.streamLogs(spec.Name, stdout, &ioWG, hook)
	go s.streamLogs(spec.Name, stderr, &ioWG, hook)

	go func(childIdx int, c *managedChild, procCmd *exec.Cmd, doneCh chan struct{}) {
		ioWG.Wait()
		waitErr := procCmd.Wait()

		s.mu.Lock()
		// An exit nobody asked for (no Stop/Restart, children's context still live) triggers logged auto-recovery.
		unexpected := c.done == doneCh && c.status != StatusStopped && !s.stopping && !errors.Is(ctx.Err(), context.Canceled)
		var backoff time.Duration
		if c.done == doneCh {
			if unexpected {
				c.status = StatusDegraded
				if waitErr != nil {
					c.lastError = waitErr.Error()
				} else {
					c.lastError = "unexpected exit 0"
				}
				if time.Since(c.lastStartAt) > 30*time.Second {
					c.crashRestarts = 0
				}
				c.crashRestarts++
				shift := min(c.crashRestarts-1, 5)
				backoff = min(10*time.Second, time.Duration(250*(1<<shift))*time.Millisecond)
			} else {
				c.status = StatusStopped
			}
		}
		s.mu.Unlock()
		close(doneCh)

		if unexpected {
			if waitErr != nil {
				s.logger.Printf("[supervisor] error: child %s (pid=%d) exited unexpectedly: %v (restarting in %s)", spec.Name, procCmd.Process.Pid, waitErr, backoff)
			} else {
				s.logger.Printf("[supervisor] warning: child %s (pid=%d) exited unexpectedly with status 0 (restarting in %s)", spec.Name, procCmd.Process.Pid, backoff)
			}
			timer := time.NewTimer(backoff)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
			}
			s.lifecycleMu.Lock()
			s.mu.RLock()
			stillNeedsRestart := !s.stopping && ctx.Err() == nil && childIdx < len(s.children) && s.children[childIdx] == c && c.done == doneCh
			onRestart := s.restartHook
			s.mu.RUnlock()
			if stillNeedsRestart {
				if restartErr := s.startChildLocked(ctx, childIdx); restartErr != nil {
					s.logger.Printf("[supervisor] error: auto-restart of %s failed: %v", spec.Name, restartErr)
				} else if onRestart != nil {
					go onRestart(spec.Name)
				}
			}
			s.lifecycleMu.Unlock()
		}
	}(idx, child, cmd, done)

	s.logger.Printf("[supervisor] started %s (pid=%d)", spec.Name, cmd.Process.Pid)
	return nil
}

func (s *Supervisor) streamLogs(name string, r io.Reader, wg *sync.WaitGroup, hook func(child, line string)) {
	defer wg.Done()
	scanner := bufio.NewScanner(r)
	buf := make([]byte, 0, 64*1024)
	scanner.Buffer(buf, 1024*1024)
	for scanner.Scan() {
		line := scanner.Text()
		s.logger.Printf("[%s] %s", name, line)
		if hook != nil {
			hook(name, line)
		}
	}
}

// Stop terminates all running child processes in reverse startup order.
func (s *Supervisor) Stop(graceTimeout time.Duration) error {
	s.lifecycleMu.Lock()
	defer s.lifecycleMu.Unlock()
	s.mu.Lock()
	s.stopping = true
	s.mu.Unlock()
	return s.stopAllLocked(graceTimeout)
}

func (s *Supervisor) stopAllLocked(graceTimeout time.Duration) error {
	s.mu.RLock()
	order := append([]int(nil), s.order...)
	children := append([]*managedChild(nil), s.children...)
	s.mu.RUnlock()

	var firstErr error
	for i := len(order) - 1; i >= 0; i-- {
		if err := s.stopChild(children[order[i]], graceTimeout); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (s *Supervisor) stopChild(child *managedChild, graceTimeout time.Duration) error {
	if child == nil {
		return nil
	}

	s.mu.Lock()
	cmd := child.cmd
	done := child.done
	if cmd != nil && cmd.Process != nil {
		child.status = StatusStopped
	}
	s.mu.Unlock()

	if cmd == nil || cmd.Process == nil || done == nil {
		return nil
	}

	select {
	case <-done:
		return nil
	default:
	}

	// Try graceful interrupt first; force-kill if the child doesn't exit within graceTimeout.
	_ = cmd.Process.Signal(os.Interrupt)
	timer := time.NewTimer(graceTimeout)
	defer timer.Stop()

	select {
	case <-done:
		return nil
	case <-timer.C:
		var killErr error
		if err := cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
			killErr = err
		}
		<-done
		return killErr
	}
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
