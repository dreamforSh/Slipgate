package clashcore

import (
	"context"
	"errors"
	"fmt"
	"os"
	"runtime/debug"
	"sync"
	"sync/atomic"
	"time"

	"github.com/metacubex/mihomo/common/observable"
	C "github.com/metacubex/mihomo/constant"
	"github.com/metacubex/mihomo/hub/executor"
	mlog "github.com/metacubex/mihomo/log"
	"github.com/metacubex/mihomo/tunnel"
	"github.com/metacubex/mihomo/tunnel/statistic"
)

const mihomoModulePath = "github.com/metacubex/mihomo"

var (
	ErrEngineOpen         = errors.New("clashcore: an embedded mihomo engine is already open in this process")
	ErrEngineClosed       = errors.New("clashcore: embedded mihomo engine is closed")
	ErrProxyNotFound      = errors.New("clashcore: proxy not found in active runtime")
	ErrRuntimeUnavailable = errors.New("clashcore: runtime disabled or unavailable")
	errApplyPanicked      = errors.New("clashcore: config apply panicked")
	engineOpen            atomic.Bool
	emptyConfigYAML       = []byte("mode: rule\nlog-level: silent\nallow-lan: false\nprofile:\n  store-selected: false\n  store-fake-ip: false\nrules:\n  - MATCH,REJECT\n")
	logBurstPerSecond     = 20
)

// LogFunc receives rate-limited mihomo warning and error log lines.
type LogFunc func(level, message string)

// ConfigError indicates mihomo rejected a rendered YAML configuration without replacing the active one.
type ConfigError struct {
	Err error
}

func (e *ConfigError) Error() string { return e.Err.Error() }
func (e *ConfigError) Unwrap() error { return e.Err }

// ConnectionStats reports a single active proxied connection observed inside the runtime.
type ConnectionStats struct {
	ID       string
	Inbound  string
	InUser   string
	Upload   int64
	Download int64
	Start    time.Time
}

// Runtime abstracts an active mihomo execution kernel (embedded in-process or disabled stub).
type Runtime interface {
	Mode() string
	Ready() bool
	Version() string
	Apply(ctx context.Context, payload []byte) error
	HasProxy(name string) bool
	DelayTest(ctx context.Context, proxyName, testURL string) (time.Duration, error)
	Connections() []ConnectionStats
	CloseInboundConnections(inboundNames []string) int
	Close() error
}

// Options configures Open for the embedded mihomo engine.
type Options struct {
	HomeDir string
	Log     LogFunc
}

// Engine wraps the in-process metacubex/mihomo core.
// mihomo holds process-wide singleton state (tunnel, listeners, resolver), so at most one Engine may be open at a time.
type Engine struct {
	mu      sync.Mutex
	closed  bool
	opts    Options
	sub     observable.Subscription[mlog.Event]
	logDone chan struct{}
	version string
}

// Open initializes the process-wide embedded mihomo engine with a fail-closed empty config.
func Open(opts Options) (*Engine, error) {
	if !engineOpen.CompareAndSwap(false, true) {
		return nil, ErrEngineOpen
	}
	if opts.HomeDir != "" {
		if err := os.MkdirAll(opts.HomeDir, 0o700); err != nil {
			engineOpen.Store(false)
			return nil, fmt.Errorf("clashcore: create home dir: %w", err)
		}
		C.SetHomeDir(opts.HomeDir)
	}
	mlog.SetLevel(mlog.SILENT)

	e := &Engine{
		opts:    opts,
		sub:     mlog.Subscribe(),
		logDone: make(chan struct{}),
		version: detectMihomoVersion(),
	}
	go e.pumpLogs()

	if err := e.Apply(context.Background(), emptyConfigYAML); err != nil {
		_ = e.Close()
		return nil, err
	}
	return e, nil
}

func (e *Engine) Mode() string    { return "embedded" }
func (e *Engine) Ready() bool     { return !e.isClosed() }
func (e *Engine) Version() string { return e.version }

// Validate parses a YAML config using mihomo without applying it.
func (e *Engine) Validate(payload []byte) error {
	if _, err := executor.ParseWithBytes(payload); err != nil {
		return &ConfigError{Err: err}
	}
	return nil
}

// Apply parses and hot-reloads mihomo listeners/proxies in place.
func (e *Engine) Apply(_ context.Context, payload []byte) (err error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return ErrEngineClosed
	}

	cfg, parseErr := executor.ParseWithBytes(payload)
	if parseErr != nil {
		return &ConfigError{Err: parseErr}
	}
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%w: %v", errApplyPanicked, r)
		}
	}()
	executor.ApplyConfig(cfg, true)
	mlog.SetLevel(mlog.SILENT)
	return nil
}

// HasProxy reports whether proxyName exists in the active mihomo tunnel table.
func (e *Engine) HasProxy(name string) bool {
	if e.isClosed() {
		return false
	}
	_, ok := tunnel.Proxies()[name]
	return ok
}

// DelayTest probes testURL through proxyName inside mihomo.
func (e *Engine) DelayTest(ctx context.Context, proxyName, testURL string) (time.Duration, error) {
	if e.isClosed() {
		return 0, ErrEngineClosed
	}
	proxy, ok := tunnel.Proxies()[proxyName]
	if !ok {
		return 0, fmt.Errorf("%w: %s", ErrProxyNotFound, proxyName)
	}
	ms, err := proxy.URLTest(ctx, testURL, nil)
	if err != nil {
		return 0, err
	}
	return time.Duration(ms) * time.Millisecond, nil
}

// Connections snapshots active inbound-tagged connections tracked by mihomo.
func (e *Engine) Connections() []ConnectionStats {
	if e.isClosed() {
		return nil
	}
	var out []ConnectionStats
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		info := c.Info()
		if info == nil || info.Metadata == nil || info.Metadata.InName == "" {
			return true
		}
		out = append(out, ConnectionStats{
			ID:       info.UUID.String(),
			Inbound:  info.Metadata.InName,
			InUser:   info.Metadata.InUser,
			Upload:   info.UploadTotal.Load(),
			Download: info.DownloadTotal.Load(),
			Start:    info.Start,
		})
		return true
	})
	return out
}

// CloseInboundConnections closes active connections belonging to any of the named listeners.
func (e *Engine) CloseInboundConnections(inboundNames []string) int {
	if len(inboundNames) == 0 || e.isClosed() {
		return 0
	}
	targets := make(map[string]struct{}, len(inboundNames))
	for _, n := range inboundNames {
		targets[n] = struct{}{}
	}
	closed := 0
	statistic.DefaultManager.Range(func(c statistic.Tracker) bool {
		info := c.Info()
		if info == nil || info.Metadata == nil {
			return true
		}
		if _, ok := targets[info.Metadata.InName]; ok {
			_ = c.Close()
			closed++
		}
		return true
	})
	return closed
}

// Close resets mihomo to an empty REJECT config and releases the process-wide engine lock.
func (e *Engine) Close() error {
	e.mu.Lock()
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	if cfg, err := executor.ParseWithBytes(emptyConfigYAML); err == nil {
		func() {
			defer func() { _ = recover() }()
			executor.ApplyConfig(cfg, true)
		}()
	}
	e.closed = true
	e.mu.Unlock()

	mlog.UnSubscribe(e.sub)
	<-e.logDone
	engineOpen.Store(false)
	return nil
}

func (e *Engine) isClosed() bool {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.closed
}

func (e *Engine) pumpLogs() {
	defer close(e.logDone)
	var (
		windowStart time.Time
		emitted     int
		dropped     int
	)
	for ev := range e.sub {
		if e.opts.Log == nil {
			continue
		}
		level := ""
		switch ev.LogLevel {
		case mlog.WARNING:
			level = "warn"
		case mlog.ERROR:
			level = "error"
		default:
			continue
		}
		now := time.Now()
		if now.Sub(windowStart) >= time.Second {
			if dropped > 0 {
				e.opts.Log("warn", fmt.Sprintf("mihomo: %d log lines suppressed", dropped))
			}
			windowStart, emitted, dropped = now, 0, 0
		}
		if emitted >= logBurstPerSecond {
			dropped++
			continue
		}
		emitted++
		e.opts.Log(level, ev.Payload)
	}
}

func detectMihomoVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return "unknown"
	}
	for _, dep := range info.Deps {
		if dep.Path == mihomoModulePath {
			if dep.Replace != nil {
				return dep.Replace.Version
			}
			return dep.Version
		}
	}
	return "unknown"
}

// DisabledRuntime satisfies Runtime cleanly when SLIPGATE_CLASH_MODE=disabled.
type DisabledRuntime struct{}

func (DisabledRuntime) Mode() string                                       { return "disabled" }
func (DisabledRuntime) Ready() bool                                        { return false }
func (DisabledRuntime) Version() string                                    { return "" }
func (DisabledRuntime) Apply(context.Context, []byte) error                { return nil }
func (DisabledRuntime) HasProxy(string) bool                               { return false }
func (DisabledRuntime) DelayTest(context.Context, string, string) (time.Duration, error) {
	return 0, ErrRuntimeUnavailable
}
func (DisabledRuntime) Connections() []ConnectionStats           { return nil }
func (DisabledRuntime) CloseInboundConnections([]string) int     { return 0 }
func (DisabledRuntime) Close() error                             { return nil }
