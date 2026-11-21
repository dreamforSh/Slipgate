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
	"syscall"
	"time"

	"github.com/dreamforSh/slipgate/services/net-go/internal/clashpool"
	"github.com/dreamforSh/slipgate/services/net-go/internal/config"
	"github.com/dreamforSh/slipgate/services/net-go/internal/ingress"
	"github.com/dreamforSh/slipgate/services/net-go/internal/supervisor"
	"github.com/dreamforSh/slipgate/services/net-go/internal/vmslot"
)

const version = "0.1.0"

func main() {
	showVersion := flag.Bool("version", false, "print slipgate version and exit")
	standalone := flag.Bool("standalone", false, "run slipgate-net without spawning child processes")
	allowDegraded := flag.Bool("allow-degraded", false, "continue running even if core or bff binaries are unavailable")
	flag.Parse()

	if *showVersion {
		fmt.Printf("slipgate %s\n", version)
		return
	}

	logger := log.New(os.Stdout, "", log.LstdFlags|log.Lmsgprefix)
	cfg := config.LoadFromEnv()
	if *standalone {
		cfg.Supervise = false
	}
	if *allowDegraded {
		cfg.AllowDegraded = true
	}

	rootCtx, stopSignals := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stopSignals()

	pool := clashpool.NewManager(cfg.ClashPortMin, cfg.ClashPortMax, cfg.MaxAccountsPerExit)
	vmSlots := vmslot.NewManager(pool)
	sup := supervisor.New(logger)

	if cfg.Supervise {
		specs := []supervisor.ChildSpec{
			{
				Name:          "core",
				Binary:        cfg.CoreBin,
				Env:           []string{"SLIPGATE_CORE_ADDR=" + cfg.CoreIPC},
				AllowDegraded: cfg.AllowDegraded,
			},
			{
				Name:          "bff",
				Binary:        cfg.BFFBin,
				Env:           []string{"SLIPGATE_BFF_ADDR=" + cfg.BFFAddr},
				AllowDegraded: cfg.AllowDegraded,
			},
		}
		if err := sup.StartAll(rootCtx, specs); err != nil {
			logger.Fatalf("failed to start supervised planes: %v", err)
		}
		defer func() {
			if err := sup.Stop(10 * time.Second); err != nil {
				logger.Printf("supervisor shutdown warning: %v", err)
			}
		}()
	}

	edge, err := ingress.NewServer(cfg, version, pool, sup)
	if err != nil {
		logger.Fatalf("failed to initialize edge ingress: %v", err)
	}
	edge.WithVmSlotManager(vmSlots)

	httpSrv := ingress.NewHTTPServer(cfg.ListenAddr, edge.Handler())
	errCh := make(chan error, 1)
	go func() {
		logger.Printf("[net] Slipgate unified edge listening on %s (core=%s bff=%s)", cfg.ListenAddr, cfg.CoreIPC, cfg.BFFAddr)
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
	case serveErr := <-errCh:
		if serveErr != nil {
			logger.Fatalf("[net] http server stopped unexpectedly: %v", serveErr)
		}
	}
}
