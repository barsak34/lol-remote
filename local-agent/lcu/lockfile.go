package lcu

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// LockfileInfo stores the parsed credentials to connect to the LCU API
type LockfileInfo struct {
	ProcessName string
	PID         int
	Port        int
	Password    string
	Protocol    string
	Path        string
}

// DefaultLockfilePaths lists common locations for League of Legends lockfile on Windows
var DefaultLockfilePaths = []string{
	`C:\Riot Games\League of Legends\lockfile`,
	`E:\Riot Games\League of Legends\lockfile`,
	`D:\Riot Games\League of Legends\lockfile`,
}

// FindLockfile attempts to locate the lockfile from env or default locations
func FindLockfile() (string, error) {
	// 1. Check custom path from environment variable
	if customPath := os.Getenv("LOL_LOCKFILE_PATH"); customPath != "" {
		if _, err := os.Stat(customPath); err == nil {
			return customPath, nil
		}
	}
	if customDir := os.Getenv("LOL_PATH"); customDir != "" {
		candidate := filepath.Join(customDir, "lockfile")
		if _, err := os.Stat(candidate); err == nil {
			return candidate, nil
		}
	}

	// 2. Check default Windows installation paths
	for _, path := range DefaultLockfilePaths {
		if _, err := os.Stat(path); err == nil {
			return path, nil
		}
	}

	return "", errors.New("lockfile no encontrado. Asegúrate de que el cliente de League of Legends esté iniciado")
}

// ReadLockfile parses the lockfile located at the given path
func ReadLockfile(path string) (*LockfileInfo, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("error al leer el lockfile: %w", err)
	}

	content := strings.TrimSpace(string(data))
	parts := strings.Split(content, ":")
	if len(parts) < 5 {
		return nil, fmt.Errorf("formato de lockfile inválido, se esperaban 5 segmentos separados por ':', se obtuvieron %d", len(parts))
	}

	pid, err := strconv.Atoi(parts[1])
	if err != nil {
		return nil, fmt.Errorf("PID inválido en lockfile: %w", err)
	}

	port, err := strconv.Atoi(parts[2])
	if err != nil {
		return nil, fmt.Errorf("puerto inválido en lockfile: %w", err)
	}

	return &LockfileInfo{
		ProcessName: parts[0],
		PID:         pid,
		Port:        port,
		Password:    parts[3],
		Protocol:    parts[4],
		Path:        path,
	}, nil
}

// GetLockfile finds and parses the lockfile, optionally waiting if wait is true
func GetLockfile(timeout time.Duration) (*LockfileInfo, error) {
	start := time.Now()
	for {
		path, err := FindLockfile()
		if err == nil {
			info, readErr := ReadLockfile(path)
			if readErr == nil {
				return info, nil
			}
		}

		if timeout == 0 || time.Since(start) >= timeout {
			break
		}
		time.Sleep(1 * time.Second)
	}
	return nil, errors.New("tiempo de espera agotado: no se encontró el lockfile de League of Legends")
}
