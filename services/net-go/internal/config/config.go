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
)

// Config holds runtime settings for slipgate-net and its built-in process supervisor.
type Config struct {
	ListenAddr         string
	CoreIPC            string
	BFFAddr            string
	Supervise          bool
	AllowDegraded         bool
	CoreBin               string
	BFFBin                string
	DatabaseURL           string
	VaultSecret           string
	ClashMode             string
	ClashDataDir          string
	ClashProbeURL         string
	ClashIPEchoURL        string
	ClashProbeIntervalSec int
	ClashPortMin          int
	ClashPortMax          int
	MaxAccountsPerExit    int
	DevUIURL           string
	Mode               string
	DevSyncMode        string
	DevSyncIntervalSec int
	UpdateRepo         string
	UpdateBranch       string
	GitRepoDir         string
	HotUpdateDir       string
	WebUIDir           string
	GitHubToken        string
	InternalToken      string
}

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
	clashMode := strings.ToLower(envString("SLIPGATE_CLASH_MODE", "embedded"))
	if clashMode != "disabled" {
		clashMode = "embedded"
	}
	probeInterval := envInt("SLIPGATE_CLASH_PROBE_INTERVAL_SEC", 300)
	if probeInterval < 0 {
		probeInterval = 0
	}

	return Config{
		ListenAddr:            envString("SLIPGATE_LISTEN_ADDR", ":8080"),
		CoreIPC:               envString("SLIPGATE_CORE_IPC", "127.0.0.1:19081"),
		BFFAddr:               envString("SLIPGATE_BFF_ADDR", "127.0.0.1:19082"),
		Supervise:             envBool("SLIPGATE_SUPERVISE", true),
		AllowDegraded:         envBool("SLIPGATE_ALLOW_DEGRADED", false),
		CoreBin:               envString("SLIPGATE_CORE_BIN", ResolveSiblingBinary("slipgate-core")),
		BFFBin:                envString("SLIPGATE_BFF_BIN", ResolveSiblingBinary("slipgate-bff")),
		DatabaseURL:           strings.TrimSpace(os.Getenv("DATABASE_URL")),
		VaultSecret:           envString("SLIPGATE_VAULT_SECRET", "slipgate-dev-vault-secret-change-in-prod"),
		ClashMode:             clashMode,
		ClashDataDir:          envString("SLIPGATE_CLASH_DATA_DIR", defaultClashDir),
		ClashProbeURL:         envString("SLIPGATE_CLASH_PROBE_URL", "https://www.gstatic.com/generate_204"),
		ClashIPEchoURL:        envString("SLIPGATE_CLASH_IP_ECHO_URL", "https://api.ipify.org?format=json"),
		ClashProbeIntervalSec: probeInterval,
		ClashPortMin:          envInt("SLIPGATE_CLASH_PORT_MIN", 20000),
		ClashPortMax:          envInt("SLIPGATE_CLASH_PORT_MAX", 24999),
		MaxAccountsPerExit:    envInt("SLIPGATE_MAX_ACCOUNTS_PER_EXIT_IP", 1),
		DevUIURL:           strings.TrimSpace(os.Getenv("SLIPGATE_DEV_UI_URL")),
		Mode:               mode,
		DevSyncMode:        syncMode,
		DevSyncIntervalSec: interval,
		UpdateRepo:         envString("SLIPGATE_UPDATE_REPO", "dreamforSh/Slipgate"),
		UpdateBranch:       envString("SLIPGATE_UPDATE_BRANCH", "main"),
		GitRepoDir:         strings.TrimSpace(os.Getenv("SLIPGATE_GIT_REPO_DIR")),
		HotUpdateDir:       envString("SLIPGATE_HOTUPDATE_DIR", defaultHotDir),
		WebUIDir:           strings.TrimSpace(os.Getenv("SLIPGATE_WEBUI_DIR")),
		GitHubToken:        ghToken,
		InternalToken:      internalToken,
	}
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
