package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashcore"
	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/dataplane"
	"github.com/dreamforSh/slipgate/services/net-go/internal/hotupdate"
	"github.com/dreamforSh/slipgate/services/net-go/internal/ingress"
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
	flag.Parse()

	if *showVersion {
		fmt.Printf("slipgate %s (%s)\n", version, commit)
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

	if active, ok := hotupdate.LoadActiveRelease(cfg.HotUpdateDir); ok {
		baseMismatch := active.BaseCommit != "" &&
			!hotupdate.CommitsEqual(active.BaseCommit, commit) &&
			!hotupdate.CommitsEqual(active.Commit, commit)
		if baseMismatch {
			logger.Printf(
				"[hotupdate] detected external upgrade (binary commit=%s, active base=%s target=%s); clearing active release",
				commit,
				active.BaseCommit,
				active.Commit,
			)
			_ = hotupdate.ClearActiveRelease(cfg.HotUpdateDir)
		} else {
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
		}
	}
	_ = os.Unsetenv("SLIPGATE_REEXEC_GUARD")

	restartTarget, err := run(cfg, logFwd, logger)
	if err != nil {
		logger.Fatalf("%v", err)
	}
	if restartTarget != "" {
		logger.Printf("[hotupdate] executing edge restart -> %s", restartTarget)
		if execErr := execSelf(restartTarget); execErr != nil {
			logger.Fatalf("[hotupdate] edge restart failed (%s): %v", restartTarget, execErr)
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

func run(cfg config.Config, logFwd *syslogfwd.Forwarder, logger *log.Logger) (string, error) {
	rootCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

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
				return "", fmt.Errorf("failed to start embedded mihomo core: %w", openErr)
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
			return "", fmt.Errorf("failed to initialize net postgres store: %w", pgErr)
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
			return "", fmt.Errorf("failed to bootstrap Clash/uTLS pool: %w", err)
		}
		logger.Printf("[clash] bootstrap degraded (continuing): %v", err)
	}
	clashCoord.StartBackgroundTasks(rootCtx)

	vmSlots := vmslot.NewManager(pool)
	var vmStore vmslot.VmStore
	if cfg.DatabaseURL != "" {
		pgVmStore, pgErr := vmslot.NewPostgresVmStore(cfg.DatabaseURL, cfg.VaultSecret)
		if pgErr != nil {
			return "", fmt.Errorf("failed to initialize vm postgres store: %w", pgErr)
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
			return "", fmt.Errorf("failed to bootstrap VM fleet coordinator: %w", err)
		}
		logger.Printf("[vmslot] bootstrap degraded (continuing): %v", err)
	}
	defer vmCoord.Shutdown()

	sup := supervisor.New(logger)
	sup.SetLineHook(logFwd.ChildLineHook("core", "bff"))
	logFwd.SetTarget(cfg.BFFAddr, cfg.InternalToken)
	go logFwd.Run(rootCtx)
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
					"SLIPGATE_BUILD_VERSION=" + version,
					"SLIPGATE_BUILD_COMMIT=" + commit,
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
			return "", fmt.Errorf("failed to start supervised planes: %w", err)
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

	edge, err := ingress.NewServer(cfg, version, pool, sup)
	if err != nil {
		return "", fmt.Errorf("failed to initialize edge ingress: %w", err)
	}
	edge.WithCommit(commit)
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

	httpSrv := ingress.NewHTTPServer(cfg.ListenAddr, edge.PublicHandler())
	internalSrv := ingress.NewHTTPServer(cfg.InternalListenAddr, edge.Handler())
	errCh := make(chan error, 2)
	go func() {
		logger.Printf("[net] internal listener (slipgate-bff callbacks) on %s", cfg.InternalListenAddr)
		if serveErr := internalSrv.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- fmt.Errorf("internal listener: %w", serveErr)
		}
	}()
	go func() {
		logger.Printf(
			"[net] Slipgate unified edge listening on %s (mode=%s version=%s commit=%s core=%s bff=%s)",
			cfg.ListenAddr,
			cfg.Mode,
			version,
			commit,
			cfg.CoreIPC,
			cfg.BFFAddr,
		)
		if serveErr := httpSrv.ListenAndServe(); serveErr != nil && !errors.Is(serveErr, http.ErrServerClosed) {
			errCh <- serveErr
			return
		}
		errCh <- nil
	}()

	select {
	case <-rootCtx.Done():
		logger.Printf("[net] shutdown signal received, draining connections...")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := httpSrv.Shutdown(shutdownCtx); err != nil {
			logger.Printf("[net] http shutdown error: %v", err)
		}
		if err := internalSrv.Shutdown(shutdownCtx); err != nil {
			logger.Printf("[net] internal listener shutdown error: %v", err)
		}
	case serveErr := <-errCh:
		if serveErr != nil {
			return "", fmt.Errorf("[net] http server stopped unexpectedly: %w", serveErr)
		}
	}

	// No more turns: hand the last settlements to the BFF before the deferred sup.Stop stops it.
	// Anything still undelivered is in the settlement spool for the next start.
	flushCtx, cancelFlush := context.WithTimeout(context.Background(), 10*time.Second)
	dpCoord.FlushSettlements(flushCtx)
	dpCoord.FlushRequestErrors(flushCtx)
	cancelFlush()

	restartMu.Lock()
	target := restartTarget
	restartMu.Unlock()
	return target, nil
}
