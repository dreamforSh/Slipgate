package config

import (
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
	AllowDegraded      bool
	CoreBin            string
	BFFBin             string
	ClashPortMin       int
	ClashPortMax       int
	MaxAccountsPerExit int
	DevUIURL           string
}

// LoadFromEnv loads configuration from SLIPGATE_* environment variables with safe defaults.
func LoadFromEnv() Config {
	return Config{
		ListenAddr:         envString("SLIPGATE_LISTEN_ADDR", ":8080"),
		CoreIPC:            envString("SLIPGATE_CORE_IPC", "127.0.0.1:19081"),
		BFFAddr:            envString("SLIPGATE_BFF_ADDR", "127.0.0.1:19082"),
		Supervise:          envBool("SLIPGATE_SUPERVISE", true),
		AllowDegraded:      envBool("SLIPGATE_ALLOW_DEGRADED", false),
		CoreBin:            envString("SLIPGATE_CORE_BIN", ResolveSiblingBinary("slipgate-core")),
		BFFBin:             envString("SLIPGATE_BFF_BIN", ResolveSiblingBinary("slipgate-bff")),
		ClashPortMin:       envInt("SLIPGATE_CLASH_PORT_MIN", 20000),
		ClashPortMax:       envInt("SLIPGATE_CLASH_PORT_MAX", 24999),
		MaxAccountsPerExit: envInt("SLIPGATE_MAX_ACCOUNTS_PER_EXIT_IP", 1),
		DevUIURL:           strings.TrimSpace(os.Getenv("SLIPGATE_DEV_UI_URL")),
	}
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
