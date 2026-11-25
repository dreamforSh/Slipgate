package config

import (
	"crypto/rand"
	"encoding/hex"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// Config holds runtime settings for slipgate-net and its built-in process supervisor.
type Config struct {
	ListenAddr string
	// InternalListenAddr serves the token-authenticated /internal/* routes slipgate-bff calls; the
	// public ListenAddr never does, so a reverse proxy in front of the edge cannot reach them.
	InternalListenAddr string
	CoreIPC            string
	BFFAddr            string
	Supervise          bool
	AllowDegraded      bool
	CoreBin            string
	BFFBin             string
	DatabaseURL        string
	VaultSecret        string
	// JWTSecret is only validated here; slipgate-bff reads SLIPGATE_JWT_SECRET itself.
	JWTSecret string
	// AllowInsecureSecrets (SLIPGATE_ALLOW_INSECURE_SECRETS) lets weak secrets through with a
	// warning. Local development only.
	AllowInsecureSecrets   bool
	ClashMode              string
	ClashDataDir           string
	ClashProbeURL          string
	ClashIPEchoURL         string
	ClashProbeIntervalSec  int
	ClashPortMin           int
	ClashPortMax           int
	MaxAccountsPerExit     int
	VMDataDir              string
	GuestdBin              string
	DevUIURL               string
	Mode                   string
	DevSyncMode            string
	DevSyncIntervalSec     int
	AutoRestartAfterUpdate bool
	// DrainTimeoutSec (SLIPGATE_DRAIN_TIMEOUT_SEC, default 30, 5..600) bounds how long a restart or
	// shutdown lets in-flight requests finish while new ones get 503 + Retry-After.
	DrainTimeoutSec int
	// StartupReadyTimeoutSec (SLIPGATE_STARTUP_READY_TIMEOUT_SEC, default 30, 0 = off) bounds how long
	// the edge holds queued public connections after a restart until core, BFF and the DataPlane
	// snapshot are ready.
	StartupReadyTimeoutSec int
	// RestartHealthTimeoutSec (SLIPGATE_RESTART_HEALTH_TIMEOUT_SEC, default 180, min 30) is how long
	// a restarted release gets to become ready before the boot guard rolls it back.
	RestartHealthTimeoutSec int
	UpdateRepo              string
	UpdateBranch            string
	GitRepoDir              string
	HotUpdateDir            string
	WebUIDir                string
	GitHubToken             string
	InternalToken           string
	TrustedProxies          string
	AllowPrivateUpstreams   bool
	// UpstreamHeaderTimeout / UpstreamIdleTimeout bound an AI upstream's wait for response headers
	// and each stall of its response stream (SLIPGATE_UPSTREAM_HEADER_TIMEOUT_SEC, default 600;
	// SLIPGATE_UPSTREAM_IDLE_TIMEOUT_SEC, default 300; 0 = unbounded).
	UpstreamHeaderTimeout time.Duration
	UpstreamIdleTimeout   time.Duration
}

// Drain timeout bounds shared by the env loader and the runtime update policy.
const (
	DefaultDrainTimeoutSec = 30
	MinDrainTimeoutSec     = 5
	MaxDrainTimeoutSec     = 600
)

// LoadFromEnv loads configuration from SLIPGATE_* environment variables with safe defaults.
func LoadFromEnv() Config {
	mode := strings.ToLower(envString("SLIPGATE_MODE", "release"))
	if mode != "dev" {
		mode = "release"
	}

	syncMode := strings.ToLower(envString("SLIPGATE_DEV_SYNC_MODE", "auto"))
	switch syncMode {
	case "git", "release", "auto":
	default:
		syncMode = "auto"
	}

	interval := envInt("SLIPGATE_DEV_SYNC_INTERVAL_SEC", 60)
	if interval < 0 {
		interval = 0
	}

	ghToken := strings.TrimSpace(os.Getenv("SLIPGATE_GITHUB_TOKEN"))
	if ghToken == "" {
		ghToken = strings.TrimSpace(os.Getenv("GITHUB_TOKEN"))
	}

	internalToken := strings.TrimSpace(os.Getenv("SLIPGATE_INTERNAL_TOKEN"))
	if internalToken == "" {
		internalToken = generateInternalToken()
	}

	defaultHotDir := filepath.Join(os.TempDir(), "slipgate-hotupdate")
	defaultClashDir := filepath.Join(os.TempDir(), "slipgate-clash")
	defaultVMDir := filepath.Join(os.TempDir(), "slipgate-vms")
	defaultGuestd := ResolveSiblingBinary("slipgate-guestd")
	if info, err := os.Stat(defaultGuestd); err != nil || info.IsDir() {
		defaultGuestd = "/usr/local/share/slipgate/guest/slipgate-guestd"
	}
	clashMode := strings.ToLower(envString("SLIPGATE_CLASH_MODE", "embedded"))
	if clashMode != "disabled" {
		clashMode = "embedded"
	}
	drainTimeout := envInt("SLIPGATE_DRAIN_TIMEOUT_SEC", DefaultDrainTimeoutSec)
	if drainTimeout < MinDrainTimeoutSec || drainTimeout > MaxDrainTimeoutSec {
		drainTimeout = DefaultDrainTimeoutSec
	}
	readyTimeout := envInt("SLIPGATE_STARTUP_READY_TIMEOUT_SEC", 30)
	if readyTimeout < 0 {
		readyTimeout = 0
	}
	healthTimeout := envInt("SLIPGATE_RESTART_HEALTH_TIMEOUT_SEC", 180)
	if healthTimeout < 30 {
		healthTimeout = 30
	}
	probeInterval := envInt("SLIPGATE_CLASH_PROBE_INTERVAL_SEC", 300)
	if probeInterval < 0 {
		probeInterval = 0
	}

	return Config{
		ListenAddr:              envString("SLIPGATE_LISTEN_ADDR", ":8080"),
		InternalListenAddr:      envString("SLIPGATE_INTERNAL_LISTEN_ADDR", "127.0.0.1:19083"),
		CoreIPC:                 envString("SLIPGATE_CORE_IPC", "127.0.0.1:19081"),
		BFFAddr:                 envString("SLIPGATE_BFF_ADDR", "127.0.0.1:19082"),
		Supervise:               envBool("SLIPGATE_SUPERVISE", true),
		AllowDegraded:           envBool("SLIPGATE_ALLOW_DEGRADED", false),
		CoreBin:                 envString("SLIPGATE_CORE_BIN", ResolveSiblingBinary("slipgate-core")),
		BFFBin:                  envString("SLIPGATE_BFF_BIN", ResolveSiblingBinary("slipgate-bff")),
		DatabaseURL:             strings.TrimSpace(os.Getenv("DATABASE_URL")),
		VaultSecret:             envString("SLIPGATE_VAULT_SECRET", DevVaultSecret),
		JWTSecret:               strings.TrimSpace(os.Getenv("SLIPGATE_JWT_SECRET")),
		AllowInsecureSecrets:    envBool("SLIPGATE_ALLOW_INSECURE_SECRETS", false),
		ClashMode:               clashMode,
		ClashDataDir:            envString("SLIPGATE_CLASH_DATA_DIR", defaultClashDir),
		ClashProbeURL:           envString("SLIPGATE_CLASH_PROBE_URL", "https://www.gstatic.com/generate_204"),
		ClashIPEchoURL:          envString("SLIPGATE_CLASH_IP_ECHO_URL", "https://api.ipify.org?format=json"),
		ClashProbeIntervalSec:   probeInterval,
		VMDataDir:               envString("SLIPGATE_VM_DATA_DIR", defaultVMDir),
		GuestdBin:               envString("SLIPGATE_GUESTD_BIN", defaultGuestd),
		ClashPortMin:            envInt("SLIPGATE_CLASH_PORT_MIN", 20000),
		ClashPortMax:            envInt("SLIPGATE_CLASH_PORT_MAX", 24999),
		MaxAccountsPerExit:      envInt("SLIPGATE_MAX_ACCOUNTS_PER_EXIT_IP", 1),
		DevUIURL:                strings.TrimSpace(os.Getenv("SLIPGATE_DEV_UI_URL")),
		Mode:                    mode,
		DevSyncMode:             syncMode,
		DevSyncIntervalSec:      interval,
		AutoRestartAfterUpdate:  envBool("SLIPGATE_AUTO_RESTART_AFTER_UPDATE", true),
		DrainTimeoutSec:         drainTimeout,
		StartupReadyTimeoutSec:  readyTimeout,
		RestartHealthTimeoutSec: healthTimeout,
		UpdateRepo:              envString("SLIPGATE_UPDATE_REPO", "dreamforSh/Slipgate"),
		UpdateBranch:            envString("SLIPGATE_UPDATE_BRANCH", "main"),
		GitRepoDir:              strings.TrimSpace(os.Getenv("SLIPGATE_GIT_REPO_DIR")),
		HotUpdateDir:            envString("SLIPGATE_HOTUPDATE_DIR", defaultHotDir),
		WebUIDir:                strings.TrimSpace(os.Getenv("SLIPGATE_WEBUI_DIR")),
		GitHubToken:             ghToken,
		InternalToken:           internalToken,
		TrustedProxies:          strings.TrimSpace(os.Getenv("SLIPGATE_TRUSTED_PROXIES")),
		AllowPrivateUpstreams:   envBool("SLIPGATE_ALLOW_PRIVATE_UPSTREAMS", false),
		UpstreamHeaderTimeout:   envSeconds("SLIPGATE_UPSTREAM_HEADER_TIMEOUT_SEC", 600),
		UpstreamIdleTimeout:     envSeconds("SLIPGATE_UPSTREAM_IDLE_TIMEOUT_SEC", 300),
	}
}

// envSeconds reads a non-negative number of seconds (0 = disabled); anything else is the fallback.
func envSeconds(key string, fallback int) time.Duration {
	sec := envInt(key, fallback)
	if sec < 0 {
		sec = fallback
	}
	return time.Duration(sec) * time.Second
}

// LoopbackOrigin derives an internal loopback HTTP URL for slipgate-bff to call back into slipgate-net.
func LoopbackOrigin(listenAddr string) string {
	trimmed := strings.TrimSpace(listenAddr)
	if trimmed == "" {
		return "http://127.0.0.1:8080"
	}
	_, port, err := net.SplitHostPort(trimmed)
	if err != nil || port == "" || port == "0" {
		return "http://127.0.0.1:8080"
	}
	return "http://127.0.0.1:" + port
}

// InternalOrigin is the URL slipgate-bff calls the internal listener at: its own host, or loopback
// when it listens on every interface.
func InternalOrigin(internalListenAddr string) string {
	host, port, err := net.SplitHostPort(strings.TrimSpace(internalListenAddr))
	if err != nil || port == "" || port == "0" {
		return "http://127.0.0.1:19083"
	}
	if ip := net.ParseIP(host); host == "" || (ip != nil && ip.IsUnspecified()) {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func generateInternalToken() string {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "slipgate-internal-fallback-token"
	}
	return hex.EncodeToString(buf)
}

// ResolveSiblingBinary searches next to the running executable before falling back to PATH.
func ResolveSiblingBinary(baseName string) string {
	fileName := baseName
	if runtime.GOOS == "windows" && !strings.HasSuffix(strings.ToLower(fileName), ".exe") {
		fileName += ".exe"
	}
	if exePath, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(exePath), fileName)
		if info, statErr := os.Stat(candidate); statErr == nil && !info.IsDir() {
			return candidate
		}
	}
	return fileName
}

func envString(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func envBool(key string, fallback bool) bool {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.ParseBool(v)
	if err != nil {
		return fallback
	}
	return parsed
}

func envInt(key string, fallback int) int {
	v := strings.TrimSpace(os.Getenv(key))
	if v == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return parsed
}
