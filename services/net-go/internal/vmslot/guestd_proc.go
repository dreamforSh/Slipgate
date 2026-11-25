package vmslot

import (
	"os/exec"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Graceful supervision of local slipgate-guestd processes.
//
// Every connection to a guest daemon comes from this edge (turn handoffs, exit-health probes,
// health pings), so the edge itself knows when a daemon is idle. A running daemon is replaced
// blue/green: the new one is spawned and health-checked on a fresh port, traffic is pointed at
// it, and only then is the old one retired: once its in-flight IPC exchanges have finished (or
// a backstop timeout passes) it gets SIGTERM, and SIGKILL if it does not exit in time.

// Supervision timings; the driver copies them into fields so tests can shorten them.
const (
	// defaultGuestdSettle lets a turn that read a daemon's endpoint just before a swap or stop
	// register its exchange before the drain looks at the in-flight count.
	defaultGuestdSettle = 300 * time.Millisecond
	// defaultGuestdDrain bounds the wait for in-flight exchanges (each is itself bounded at a
	// couple of seconds by its caller); this is only a backstop.
	defaultGuestdDrain = 10 * time.Second
	// defaultGuestdTerm is how long a daemon has to exit after SIGTERM before it is killed.
	defaultGuestdTerm = 3 * time.Second
)

// guestProc is one supervised slipgate-guestd process.
type guestProc struct {
	cmd      *exec.Cmd
	bin      string
	endpoint string
	// exited is closed once the process has exited and been reaped.
	exited chan struct{}
}

// startGuestProc starts cmd and reaps it as soon as it exits, so a daemon that dies on its own
// never lingers as a zombie until the slot is stopped.
func startGuestProc(cmd *exec.Cmd, bin, endpoint string) (*guestProc, error) {
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	p := &guestProc{cmd: cmd, bin: bin, endpoint: endpoint, exited: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(p.exited)
	}()
	return p, nil
}

func (p *guestProc) alive() bool {
	select {
	case <-p.exited:
		return false
	default:
		return true
	}
}

// kill stops p at once and waits for it: for a daemon that never served traffic.
func (p *guestProc) kill() {
	if p.cmd.Process != nil {
		_ = p.cmd.Process.Kill()
	}
	<-p.exited
}

// retire stops p gracefully. After `settle` it waits (up to `drain`) for the exchanges in flight
// on its endpoint to finish, then sends SIGTERM (Windows has no SIGTERM for other processes, so
// there it kills), and kills p if it is still running `term` later. It returns once p is reaped.
func (p *guestProc) retire(settle, drain, term time.Duration) {
	if settle > 0 {
		select {
		case <-p.exited:
			return
		case <-time.After(settle):
		}
	}
	deadline := time.Now().Add(drain)
	for p.alive() && guestCallsInFlight(p.endpoint) > 0 && time.Now().Before(deadline) {
		select {
		case <-p.exited:
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !p.alive() {
		return
	}
	if p.cmd.Process == nil {
		<-p.exited
		return
	}
	if err := p.cmd.Process.Signal(syscall.SIGTERM); err != nil {
		_ = p.cmd.Process.Kill()
	}
	select {
	case <-p.exited:
	case <-time.After(term):
		_ = p.cmd.Process.Kill()
		<-p.exited
	}
}

// guestCalls counts the IPC exchanges in flight per guestd endpoint.
var guestCalls = struct {
	mu sync.Mutex
	n  map[string]int
}{n: map[string]int{}}

// beginGuestCall registers one exchange with the daemon at endpoint; call the returned func when
// it is over.
func beginGuestCall(endpoint string) func() {
	ep := strings.TrimSpace(endpoint)
	guestCalls.mu.Lock()
	guestCalls.n[ep]++
	guestCalls.mu.Unlock()
	return func() {
		guestCalls.mu.Lock()
		if guestCalls.n[ep] <= 1 {
			delete(guestCalls.n, ep)
		} else {
			guestCalls.n[ep]--
		}
		guestCalls.mu.Unlock()
	}
}

func guestCallsInFlight(endpoint string) int {
	guestCalls.mu.Lock()
	defer guestCalls.mu.Unlock()
	return guestCalls.n[strings.TrimSpace(endpoint)]
}
