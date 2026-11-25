package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashcore"
	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dpbridge"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
	"github.com/dreamforSh/slipgate/services/net-go/internal/ingress"
	"github.com/dreamforSh/slipgate/services/net-go/internal/lifecycle"
	"github.com/dreamforSh/slipgate/services/net-go/internal/netguard"
	"github.com/dreamforSh/slipgate/services/net-go/internal/stealth"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
	"github.com/dreamforSh/slipgate/services/net-go/internal/syslogfwd"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

var (
	version = "0.1.0"
	commit  = "dev"
)

func main() {
	showVersion := flag.Bool("version", false, "print slipgate version and exit")
	standalone := flag.Bool("standalone", false, "run slipgate-net without spawning child processes")
	allowDegraded := flag.Bool("allow-degraded", false, "continue running even if core or bff binaries are unavailable")
	devMode := flag.Bool("dev", false, "enable dev mode with repo-synced hot updates")
	showCapabilities := flag.Bool("capabilities", false, "print graceful-restart capabilities and exit")
	flag.Parse()

	if *showVersion {
		fmt.Printf("slipgate %s (%s)\n", version, commit)
		return
	}
	if *showCapabilities {
		// A restarting edge asks its successor this before passing listening sockets to it.
		fmt.Println(lifecycle.HandoffCapability)
		return
	}

	// Every line still goes to stdout; warnings/errors (and core's, via the supervisor hook) are also
	// forwarded to the BFF's persisted system logs. SLIPGATE_SYSTEM_LOG_FORWARD=false turns that off.
	logFwd := syslogfwd.New(syslogfwd.Options{
		Out:      os.Stdout,
		Disabled: strings.EqualFold(strings.TrimSpace(os.Getenv("SLIPGATE_SYSTEM_LOG_FORWARD")), "false"),
	})
	logger := log.New(logFwd, "", log.LstdFlags|log.Lmsgprefix)
	cfg := config.LoadFromEnv()
	if *standalone {
		cfg.Supervise = false
	}
	if *allowDegraded {
		cfg.AllowDegraded = true
	}
	if *devMode {
		cfg.Mode = "dev"
	}

	if problems := cfg.SecretProblems(); len(problems) > 0 {
		summary := strings.Join(problems, "; ")
		if !cfg.AllowInsecureSecrets {
			logger.Fatalf("[security] refusing to start: %s. Generate each secret with `openssl rand -hex 32` "+
				"(keep SLIPGATE_VAULT_SECRET stable once accounts exist: it decrypts stored credentials), "+
				"or set SLIPGATE_ALLOW_INSECURE_SECRETS=true for local development only", summary)
		}
		logger.Printf("[security] WARNING: running with weak secrets because SLIPGATE_ALLOW_INSECURE_SECRETS=true: %s. "+
			"Never expose this instance.", summary)
	}

	// An install upgraded outside the update center (new image, reinstall, rebuild) makes the
	// hot-update overlay stale: drop it (and its restart marker and baseline) before anything
	// reads it. The release's own edge, started through the handoff below, is never "upgraded".
	hotupdate.ReconcileExternalUpgrade(cfg.HotUpdateDir, version, commit, hotupdate.ResolvedCurrentExecutable(), logger)

	// Boot guard: a cold boot (crash restart by Docker/systemd, not an exec handoff) while a
	// restart is still unconfirmed counts against the new release; after repeated failures
	// active.json is restored to the previous release before the handoff below reads it.
	hotupdate.PrepareBoot(cfg.HotUpdateDir, os.Getenv("SLIPGATE_REEXEC_GUARD") == "", logger)

	// What health endpoints and the console report: the active release when one is in effect,
	// even if this edge binary is older (a release that only replaced core / bff / web UI).
	build := buildInfo{version: version, commit: commit}
	if active, ok := hotupdate.LoadActiveRelease(cfg.HotUpdateDir); ok {
		if active.EdgeBin != "" {
			if info, stErr := os.Stat(active.EdgeBin); stErr == nil && !info.IsDir() {
				curExe := hotupdate.ResolvedCurrentExecutable()
				if !hotupdate.SameExecutablePath(curExe, active.EdgeBin) && os.Getenv("SLIPGATE_REEXEC_GUARD") != active.EdgeBin {
					logger.Printf("[hotupdate] handing off startup to active release edge binary %s", active.EdgeBin)
					if execErr := execSelf(active.EdgeBin); execErr != nil {
						logger.Printf("[hotupdate] startup handoff to %s failed (continuing with current binary): %v", active.EdgeBin, execErr)
					} else {
						return
					}
				}
			}
		}
		if active.CoreBin != "" {
			if info, stErr := os.Stat(active.CoreBin); stErr == nil && !info.IsDir() {
				cfg.CoreBin = active.CoreBin
			}
		}
		if active.BFFBin != "" {
			if info, stErr := os.Stat(active.BFFBin); stErr == nil && !info.IsDir() {
				cfg.BFFBin = active.BFFBin
			}
		}
		if active.GuestdBin != "" {
			if info, stErr := os.Stat(active.GuestdBin); stErr == nil && !info.IsDir() {
				cfg.GuestdBin = active.GuestdBin
			}
		}
		if active.WebUIDir != "" {
			if info, stErr := os.Stat(filepath.Join(active.WebUIDir, "index.html")); stErr == nil && !info.IsDir() {
				cfg.WebUIDir = active.WebUIDir
			}
		}
		if strings.TrimSpace(active.Version) != "" {
			build.version = strings.TrimSpace(active.Version)
		}
		if strings.TrimSpace(active.Commit) != "" {
			build.commit = strings.TrimSpace(active.Commit)
		}
	}
	_ = os.Unsetenv("SLIPGATE_REEXEC_GUARD")
	// Listening sockets passed by the previous process (taken after the handoff above, which
	// forwards them untouched to the active release's edge).
	inherited := lifecycle.TakeInherited()

	res, err := run(cfg, build, logFwd, logger, inherited)
	if err != nil {
		logger.Fatalf("%v", err)
	}
	if res.target != "" {
		var extraEnv []string
		if env := res.handoff.Env(); env != "" {
			extraEnv = append(extraEnv, env)
		}
		logger.Printf("[hotupdate] executing edge restart -> %s (listener handoff: %v)", res.target, len(extraEnv) > 0)
		if execErr := execSelf(res.target, extraEnv...); execErr != nil {
			res.handoff.Close()
			logger.Fatalf("[hotupdate] edge restart failed (%s): %v", res.target, execErr)
		}
	}
}

// buildInfo is the release version/commit reported to clients (see main).
type buildInfo struct {
	version string
	commit  string
}

// restartResult is what run hands back to main when the edge should re-exec.
type restartResult struct {
	target  string
	handoff *lifecycle.Handoff
}

// drainExempt lists public requests still served while draining: the liveness probe and the
// admin status poll that renders restart progress.
func drainExempt(r *http.Request) bool {
	if r.Method != http.MethodGet {
		return false
	}
	switch r.URL.Path {
	case "/healthz", "/api/v1/admin/system/update":
		return true
	}
	return false
}

// edgeSupportsHandoff asks a restart target whether it understands inherited listeners; older
// releases would fail to bind ports the inherited sockets still hold.
func edgeSupportsHandoff(target string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, target, "-capabilities").Output()
	return err == nil && strings.Contains(string(out), lifecycle.HandoffCapability)
}

// waitPlanesReady polls until slipgate-core answers, slipgate-bff is healthy and the DataPlane
// holds a ControlPlane snapshot, or ctx ends.
func waitPlanesReady(ctx context.Context, cfg config.Config, dp *dataplane.Coordinator) bool {
	if !cfg.Supervise {
		return true
	}
	bffOrigin := strings.TrimSpace(cfg.BFFAddr)
	if !strings.HasPrefix(bffOrigin, "http://") && !strings.HasPrefix(bffOrigin, "https://") {
		bffOrigin = "http://" + bffOrigin
	}
	client := &http.Client{Timeout: 2 * time.Second}
	probe := func() bool {
		pingCtx, cancel := context.WithTimeout(ctx, time.Second)
		coreOK := dpbridge.PingAuth(pingCtx, cfg.CoreIPC, cfg.InternalToken) == nil
		cancel()
		if !coreOK {
			return false
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, bffOrigin+"/api/v1/health", nil)
		if err != nil {
			return false
		}
		resp, err := client.Do(req)
		if err != nil {
			return false
		}
		_ = resp.Body.Close()
		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			return false
		}
		return dp == nil || dp.SnapshotApplied()
	}
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		if probe() {
			return true
		}
		select {
		case <-ctx.Done():
			return false
		case <-ticker.C:
		}
	}
}

func withEnv(base []string, key, val string) []string {
	prefix := key + "="
	out := make([]string, 0, len(base)+1)
	for _, entry := range base {
		if !strings.HasPrefix(entry, prefix) {
			out = append(out, entry)
		}
	}
	return append(out, prefix+val)
}

func run(cfg config.Config, build buildInfo, logFwd *syslogfwd.Forwarder, logger *log.Logger, inherited lifecycle.Inherited) (restartResult, error) {
	rootCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	// Bind (or adopt) both listeners first: after a graceful restart the kernel has been queueing
	// connections on the inherited sockets, and they are served once the planes are ready.
	publicLn, publicInherited, err := inherited.Listen("public", cfg.ListenAddr)
	if err != nil {
		inherited.CloseUnused()
		return restartResult{}, fmt.Errorf("listen on %s: %w", cfg.ListenAddr, err)
	}
	internalLn, _, err := inherited.Listen("internal", cfg.InternalListenAddr)
	if err != nil {
		_ = publicLn.Close()
		inherited.CloseUnused()
		return restartResult{}, fmt.Errorf("internal listen on %s: %w", cfg.InternalListenAddr, err)
	}
	inherited.CloseUnused()
	var publicServing, internalServing bool
	defer func() {
		// Listeners never handed to Serve are not closed by Shutdown.
		if !publicServing {
			_ = publicLn.Close()
		}
		if !internalServing {
			_ = internalLn.Close()
		}
	}()
	if publicInherited {
		logger.Printf("[lifecycle] adopted listening sockets from the previous process; queued connections are served once the planes are ready")
	}

	pool := clashpool.NewManager(cfg.ClashPortMin, cfg.ClashPortMax, cfg.MaxAccountsPerExit)

	var clashRT clashcore.Runtime = clashcore.DisabledRuntime{}
	if cfg.ClashMode != "disabled" {
		engine, openErr := clashcore.Open(clashcore.Options{
			HomeDir: cfg.ClashDataDir,
			Log: func(level, msg string) {
				logger.Printf("[mihomo:%s] %s", level, msg)
			},
		})
		if openErr != nil {
			if !cfg.AllowDegraded {
				return restartResult{}, fmt.Errorf("failed to start embedded mihomo core: %w", openErr)
			}
			logger.Printf("[clash] embedded mihomo degraded (continuing): %v", openErr)
		} else {
			clashRT = engine
			defer func() {
				if err := engine.Close(); err != nil {
					logger.Printf("[clash] mihomo close warning: %v", err)
				}
			}()
		}
	}

	var netStore clashpool.NetStore
	if cfg.DatabaseURL != "" {
		pgStore, pgErr := clashpool.NewPostgresNetStore(cfg.DatabaseURL, cfg.VaultSecret)
		if pgErr != nil {
			return restartResult{}, fmt.Errorf("failed to initialize net postgres store: %w", pgErr)
		}
		netStore = pgStore
	} else {
		netStore = clashpool.NewMemoryNetStore()
	}
	defer func() { _ = netStore.Close() }()

	stealthDialer := stealth.NewAccountDialer(pool)
	clashCoord := clashpool.NewCoordinator(clashpool.CoordinatorOptions{
		Manager:              pool,
		Runtime:              clashRT,
		Store:                netStore,
		Stealth:              stealth.NewCoordinatorAdapter(stealthDialer),
		Logger:               logger,
		ProbeURL:             cfg.ClashProbeURL,
		IPEchoURL:            cfg.ClashIPEchoURL,
		ProbeIntervalSec:     cfg.ClashProbeIntervalSec,
		AllowLoopbackServers: cfg.AllowPrivateUpstreams,
	})
	if err := clashCoord.Bootstrap(rootCtx); err != nil {
		if !cfg.AllowDegraded {
			return restartResult{}, fmt.Errorf("failed to bootstrap Clash/uTLS pool: %w", err)
		}
		logger.Printf("[clash] bootstrap degraded (continuing): %v", err)
	}
	clashCoord.StartBackgroundTasks(rootCtx)

	vmSlots := vmslot.NewManager(pool)
	var vmStore vmslot.VmStore
	if cfg.DatabaseURL != "" {
		pgVmStore, pgErr := vmslot.NewPostgresVmStore(cfg.DatabaseURL, cfg.VaultSecret)
		if pgErr != nil {
			return restartResult{}, fmt.Errorf("failed to initialize vm postgres store: %w", pgErr)
		}
		vmStore = pgVmStore
	} else {
		vmStore = vmslot.NewMemoryVmStore()
	}
	defer func() { _ = vmStore.Close() }()

	vmCoord := vmslot.NewCoordinator(vmslot.CoordinatorOptions{
		Manager:   vmSlots,
		ClashPool: pool,
		Store:     vmStore,
		VMDataDir: cfg.VMDataDir,
		GuestdBin: cfg.GuestdBin,
		Logger:    logger,
	})
	if err := vmCoord.Bootstrap(rootCtx); err != nil {
		if !cfg.AllowDegraded {
			return restartResult{}, fmt.Errorf("failed to bootstrap VM fleet coordinator: %w", err)
		}
		logger.Printf("[vmslot] bootstrap degraded (continuing): %v", err)
	}
	defer vmCoord.Shutdown()

	sup := supervisor.New(logger)
	sup.SetLineHook(logFwd.ChildLineHook("core", "bff"))
	logFwd.SetTarget(cfg.BFFAddr, cfg.InternalToken)
	// Forwarding outlives the stop signal so the drain and shutdown lines reach the BFF too; it
	// is stopped (with a final flush) just before the BFF itself.
	logCtx, stopLogs := context.WithCancel(context.Background())
	logDone := make(chan struct{})
	go func() {
		defer close(logDone)
		logFwd.Run(logCtx)
	}()
	defer stopLogs()
	internalURL := config.InternalOrigin(cfg.InternalListenAddr)

	if cfg.Supervise {
		specs := []supervisor.ChildSpec{
			{
				Name:   "core",
				Binary: cfg.CoreBin,
				Env: []string{
					"SLIPGATE_CORE_ADDR=" + cfg.CoreIPC,
					"SLIPGATE_INTERNAL_TOKEN=" + cfg.InternalToken,
				},
				AllowDegraded: cfg.AllowDegraded,
			},
			{
				Name:   "bff",
				Binary: cfg.BFFBin,
				Env: []string{
					"SLIPGATE_BFF_ADDR=" + cfg.BFFAddr,
					"SLIPGATE_MODE=" + cfg.Mode,
					"SLIPGATE_DEV_SYNC_MODE=" + cfg.DevSyncMode,
					fmt.Sprintf("SLIPGATE_DEV_SYNC_INTERVAL_SEC=%d", cfg.DevSyncIntervalSec),
					"SLIPGATE_BUILD_VERSION=" + build.version,
					"SLIPGATE_BUILD_COMMIT=" + build.commit,
					"SLIPGATE_UPDATE_REPO=" + cfg.UpdateRepo,
					"SLIPGATE_UPDATE_BRANCH=" + cfg.UpdateBranch,
					"SLIPGATE_INTERNAL_TOKEN=" + cfg.InternalToken,
					"SLIPGATE_NET_INTERNAL_URL=" + internalURL,
					"SLIPGATE_VAULT_SECRET=" + cfg.VaultSecret,
				},
				AllowDegraded: cfg.AllowDegraded,
			},
		}
		// The children must outlive the shutdown signal: the edge first drains in-flight turns (which
		// still settle against core) and flushes pending settlements to a live BFF; the deferred
		// sup.Stop below then interrupts them gracefully. Spawning them on rootCtx would SIGKILL both
		// the moment the signal arrives.
		childCtx, cancelChildren := context.WithCancel(context.Background())
		defer cancelChildren()
		if err := sup.StartAll(childCtx, specs); err != nil {
			return restartResult{}, fmt.Errorf("failed to start supervised planes: %w", err)
		}
		defer func() {
			if err := sup.Stop(10 * time.Second); err != nil {
				logger.Printf("supervisor shutdown warning: %v", err)
			}
		}()
	}

	dpCoord := dataplane.NewCoordinator(dataplane.CoordinatorOptions{
		CoreIPC:               cfg.CoreIPC,
		BFFOrigin:             cfg.BFFAddr,
		InternalToken:         cfg.InternalToken,
		VaultSecret:           cfg.VaultSecret,
		ClashPool:             pool,
		StealthDialer:         stealthDialer,
		VMSlots:               vmSlots,
		Logger:                logger,
		AllowPrivateUpstreams: cfg.AllowPrivateUpstreams,
		TrustedProxies:        netguard.ParseTrustedProxies(cfg.TrustedProxies),
		// "[http.access]" per /v1 turn while the BFF persists access logs (runtime config, ~30 s).
		AccessLogEnabled: logFwd.AccessLogsEnabled,
		// On the persistent volume by default, so undelivered settlements survive a restart or redeploy.
		SettlementSpoolDir: dataplane.ResolveSettlementSpoolDir(filepath.Join(cfg.HotUpdateDir, "settlement-spool")),
		UpstreamTimeouts:   dataplane.UpstreamTimeouts{Header: cfg.UpstreamHeaderTimeout, Idle: cfg.UpstreamIdleTimeout},
		GuestToken:         strings.TrimSpace(os.Getenv("SLIPGATE_GUEST_TOKEN")),
	})
	sup.SetRestartHook(func(child string) {
		if child != "core" {
			return
		}
		if err := dpCoord.ResyncCore(rootCtx); err != nil && !errors.Is(err, context.Canceled) {
			logger.Printf("[dataplane] warning: core restart snapshot resync failed: %v", err)
		}
	})
	dpCoord.StartBackgroundSync(rootCtx)

	edge, err := ingress.NewServer(cfg, build.version, pool, sup)
	if err != nil {
		return restartResult{}, fmt.Errorf("failed to initialize edge ingress: %w", err)
	}
	edge.WithCommit(build.commit)
	edge.WithClashCoordinator(clashCoord)
	edge.WithVmSlotManager(vmSlots)
	edge.WithVmCoordinator(vmCoord)
	edge.WithDataPlaneCoordinator(dpCoord)

	var (
		restartMu     sync.Mutex
		restartTarget string
	)
	updater := hotupdate.NewManager(hotupdate.Options{
		Config:        cfg,
		Version:       version,
		InitialCommit: commit,
		Supervisor:    sup,
		Logger:        logger,
		OnWebUIDir:    edge.SetWebUIOverrideDir,
		GetWebUIDir:   edge.WebUIOverrideDir,
		OnGuestdBin:   vmCoord.SetGuestdBin,
		OnBuildInfo:   edge.SetBuildInfo,
		OnPlanesRestarted: func(ctx context.Context) {
			if err := dpCoord.ResyncCore(ctx); err != nil && !errors.Is(err, context.Canceled) {
				logger.Printf("[dataplane] warning: post-hotupdate core snapshot resync failed: %v", err)
			}
		},
		OnEdgeRestart: func(targetBinary string) {
			restartMu.Lock()
			restartTarget = targetBinary
			restartMu.Unlock()
			logger.Printf("[hotupdate] draining gateway to restart with %s", targetBinary)
			stopSignals()
		},
	})
	edge.WithHotUpdater(updater)
	updater.StartAutoSync(rootCtx)

	drainer := lifecycle.NewDrainer(drainExempt)
	edge.WithDrainer(drainer)
	httpSrv := ingress.NewHTTPServer(cfg.ListenAddr, drainer.Middleware(edge.PublicHandler()))
	internalSrv := ingress.NewHTTPServer(cfg.InternalListenAddr, edge.Handler())
	errCh := make(chan error, 2)

	// The internal listener serves at once: slipgate-bff pushes its first snapshot through it,
	// which is part of what the readiness gate below waits for.
	internalServing = true
	go func() {
		logger.Printf("[net] internal listener (slipgate-bff callbacks) on %s", cfg.InternalListenAddr)
		if serveErr := internalSrv.Serve(internalLn); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- fmt.Errorf("internal listener: %w", serveErr)
		}
	}()

	// After a graceful restart, hold the queued public connections until the planes are ready
	// (bounded), so clients see a short delay instead of 502/503 while core and BFF boot.
	bootStarted := time.Now()
	pendingBoot := updater.HasPendingBoot()
	planesReady := !cfg.Supervise
	if (pendingBoot || publicInherited) && cfg.Supervise && cfg.StartupReadyTimeoutSec > 0 {
		readyCtx, cancelReady := context.WithTimeout(rootCtx, time.Duration(cfg.StartupReadyTimeoutSec)*time.Second)
		planesReady = waitPlanesReady(readyCtx, cfg, dpCoord)
		cancelReady()
		if planesReady {
			logger.Printf("[lifecycle] planes ready after %s; serving public traffic", time.Since(bootStarted).Round(time.Millisecond))
		} else if rootCtx.Err() == nil {
			logger.Printf("[lifecycle] planes not ready after %ds; serving public traffic degraded", cfg.StartupReadyTimeoutSec)
		}
	}

	// A restart whose planes are already ready is confirmed before public traffic flows, so the
	// first status a reconnecting console sees already carries the restart outcome.
	if pendingBoot && planesReady && rootCtx.Err() == nil {
		updater.CompleteBoot(rootCtx, true)
		pendingBoot = false
	}

	publicServing = true
	go func() {
		logger.Printf(
			"[net] Slipgate unified edge listening on %s (mode=%s version=%s commit=%s core=%s bff=%s)",
			cfg.ListenAddr,
			cfg.Mode,
			build.version,
			build.commit,
			cfg.CoreIPC,
			cfg.BFFAddr,
		)
		if serveErr := httpSrv.Serve(publicLn); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
			return
		}
		errCh <- nil
	}()

	// Settle the restart that led to this boot: a release that never becomes healthy within
	// RestartHealthTimeoutSec is rolled back by the update manager.
	if pendingBoot {
		go func() {
			remaining := time.Duration(cfg.RestartHealthTimeoutSec)*time.Second - time.Since(bootStarted)
			healthCtx, cancelHealth := context.WithTimeout(rootCtx, max(remaining, time.Second))
			ready := waitPlanesReady(healthCtx, cfg, dpCoord)
			cancelHealth()
			if rootCtx.Err() != nil {
				return // shutting down: leave the marker for the next boot to settle
			}
			updater.CompleteBoot(rootCtx, ready)
		}()
	}

	select {
	case <-rootCtx.Done():
	case serveErr := <-errCh:
		if serveErr != nil {
			return restartResult{}, fmt.Errorf("[net] http server stopped unexpectedly: %w", serveErr)
		}
	}

	restartMu.Lock()
	target := restartTarget
	restartMu.Unlock()

	// Drain: new public requests get 503 + Retry-After while in-flight ones (streams included)
	// finish, bounded by the drain timeout. A second stop signal cuts the wait short.
	drainTimeout := updater.DrainTimeout()
	if target != "" {
		logger.Printf("[lifecycle] graceful restart: draining public traffic (up to %s, %d in flight)", drainTimeout, drainer.Inflight())
	} else {
		logger.Printf("[net] shutdown signal received, draining in-flight requests (up to %s)...", drainTimeout)
	}
	drainDeadline := time.Now().Add(drainTimeout)
	drainer.BeginDrain(drainTimeout)
	drainCtx, cancelDrain := context.WithDeadline(context.Background(), drainDeadline)
	stopCh := make(chan os.Signal, 1)
	signal.Notify(stopCh, os.Interrupt, syscall.SIGTERM)
	var stopRequested atomic.Bool
	go func() {
		select {
		case <-stopCh:
			stopRequested.Store(true)
			logger.Printf("[lifecycle] stop signal received while draining; cutting the drain short")
			cancelDrain()
		case <-drainCtx.Done():
		}
	}()
	remaining := drainer.Wait(drainCtx, func(inflight int) {
		if target != "" {
			updater.SetRestartProgress(hotupdate.RestartPhaseDraining, inflight, drainDeadline)
		}
	})
	cancelDrain()
	signal.Stop(stopCh)
	if remaining > 0 {
		logger.Printf("[lifecycle] drain ended with %d request(s) still in flight; closing them", remaining)
	}
	if target != "" && stopRequested.Load() {
		logger.Printf("[lifecycle] restart to %s aborted by a stop signal; exiting instead", target)
		target = ""
		updater.MarkRestartInterrupted()
	}

	// Keep the listening sockets alive across exec so the successor adopts them; connections
	// arriving in between wait in the kernel backlog instead of being refused.
	var handoff *lifecycle.Handoff
	if target != "" && lifecycle.HandoffSupported() {
		if edgeSupportsHandoff(target) {
			h, handoffErr := lifecycle.PrepareHandoff(map[string]net.Listener{"public": publicLn, "internal": internalLn})
			if handoffErr != nil {
				logger.Printf("[lifecycle] listener handoff unavailable (%v); restarting with fresh sockets", handoffErr)
			} else {
				handoff = h
			}
		} else {
			logger.Printf("[lifecycle] %s predates listener handoff; restarting with fresh sockets", target)
		}
	}
	if target != "" {
		updater.SetRestartProgress(hotupdate.RestartPhaseStopping, remaining, time.Time{})
	}

	shutdownGrace := 5 * time.Second
	if remaining > 0 {
		shutdownGrace = 2 * time.Second
	}
	shutdownCtx, cancelShutdown := context.WithTimeout(context.Background(), shutdownGrace)
	if err := httpSrv.Shutdown(shutdownCtx); err != nil {
		logger.Printf("[net] http shutdown: %v; closing remaining connections", err)
		_ = httpSrv.Close()
	}
	if err := internalSrv.Shutdown(shutdownCtx); err != nil {
		logger.Printf("[net] internal listener shutdown: %v; closing remaining connections", err)
		_ = internalSrv.Close()
	}
	cancelShutdown()

	// No more turns: hand the last settlements to the BFF before the deferred sup.Stop stops it.
	// Anything still undelivered is in the settlement spool for the next start.
	flushCtx, cancelFlush := context.WithTimeout(context.Background(), 10*time.Second)
	dpCoord.FlushSettlements(flushCtx)
	dpCoord.FlushRequestErrors(flushCtx)
	cancelFlush()

	// Last system-log flush while the BFF is still up (its own final post is bounded at 2s).
	stopLogs()
	select {
	case <-logDone:
	case <-time.After(3 * time.Second):
	}

	return restartResult{target: target, handoff: handoff}, nil
}
