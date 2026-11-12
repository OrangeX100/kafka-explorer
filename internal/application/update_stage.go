package application

// Staging and installing an update: download the setup exe into the data
// directory, verify its size, then hand over to a hidden PowerShell that
// waits for this process to exit and runs the Inno Setup installer
// silently (the proven silent-install pattern: values travel through
// environment variables so no path needs quoting; the setup is the same
// one the user would have run by hand, so rollback is "old version still
// installed").

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"kafkaexplorer/internal/appdir"
	"kafkaexplorer/internal/domain"
)

// Progress is one download-tick payload, in bytes.
type Progress struct {
	Bytes int64 `json:"bytes"`
	Total int64 `json:"total"`
}

// updatesDir keeps staged installers together: staging writes
// <name>.part and renames on success, so a finished file is always whole.
func updatesDir() (string, error) {
	dir, err := appdir.DataDir()
	if err != nil {
		return "", err
	}
	p := filepath.Join(dir, "updates")
	if err := os.MkdirAll(p, 0o755); err != nil {
		return "", err
	}
	return p, nil
}

// StageUpdate downloads the setup asset into DataDir/updates with
// progress ticks. cancelled is polled between chunks — closing it is the
// stop button, and the .part file is removed so a later retry starts over.
func (s *UpdateService) StageUpdate(ctx context.Context, assetURL string, assetSize int64, progress func(Progress), cancelled <-chan struct{}) (string, error) {
	if runtime.GOOS != "windows" {
		return "", fmt.Errorf("%w: 自动更新当前仅支持 Windows", domain.ErrInvalid)
	}
	if assetURL == "" {
		return "", fmt.Errorf("%w: 该发布版本未附带安装包，请从发布页手动下载", domain.ErrInvalid)
	}
	dir, err := updatesDir()
	if err != nil {
		return "", err
	}
	name := assetNameFromURL(assetURL)
	dest := filepath.Join(dir, name)
	part := dest + ".part"

	// No overall client timeout: a 22MB download on a slow link must be
	// allowed to finish; cancellation is handled by ctx/cancelled.
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, assetURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "kafka-explorer-updater")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return "", nil // cancelled while connecting: the normal stop
		}
		return "", fmt.Errorf("%w: 无法连接更新源", domain.ErrUnavailable)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("更新源返回异常状态 %d", resp.StatusCode)
	}
	if assetSize <= 0 && resp.ContentLength > 0 {
		assetSize = resp.ContentLength
	}

	partFile, err := os.Create(part)
	if err != nil {
		return "", fmt.Errorf("创建临时文件失败: %w", err)
	}
	ticker := time.NewTicker(150 * time.Millisecond)
	defer ticker.Stop()
	done := make(chan error, 1)

	go func() {
		buf := make([]byte, 64*1024)
		var got int64
		for {
			select {
			case <-cancelled:
				done <- errCancelled
				return
			case <-ticker.C:
				progress(Progress{Bytes: got, Total: assetSize})
			default:
			}
			n, rerr := resp.Body.Read(buf)
			if n > 0 {
				if _, werr := partFile.Write(buf[:n]); werr != nil {
					done <- werr
					return
				}
				got += int64(n)
			}
			if rerr == io.EOF {
				done <- nil
				return
			}
			if rerr != nil {
				done <- rerr
				return
			}
		}
	}()

	werr := <-done
	partFile.Close()
	if werr != nil {
		os.Remove(part)
		if werr == errCancelled || ctx.Err() != nil {
			return "", nil // stop button: not an error
		}
		return "", fmt.Errorf("%w: 下载中断，请检查网络后重试", domain.ErrUnavailable)
	}
	// Size gate: the release metadata promised a byte count; a truncated
	// download must not become the installer.
	if assetSize > 0 {
		st, statErr := os.Stat(part)
		if statErr != nil || st.Size() != assetSize {
			os.Remove(part)
			got := int64(-1)
			if statErr == nil {
				got = st.Size()
			}
			return "", fmt.Errorf("下载不完整（%d/%d 字节），请重试", got, assetSize)
		}
	}
	// SHA-256 gate: releases publish <asset>.sha256 next to the installer;
	// when present the staged file must match it (catches truncated-but-
	// size-matching downloads and tampering). A missing checksum file keeps
	// the size gate as the only protection (legacy releases).
	if want, ok := fetchExpectedChecksum(ctx, assetURL+".sha256"); ok {
		got, err := fileSHA256(part)
		if err != nil {
			os.Remove(part)
			return "", fmt.Errorf("读取已下载文件失败: %w", err)
		}
		if got != want {
			os.Remove(part)
			return "", fmt.Errorf("安装包校验失败（SHA-256 不匹配），文件可能不完整或被篡改。请到发布页手动下载，或稍后重试")
		}
	}
	if err := os.Rename(part, dest); err != nil {
		os.Remove(part)
		return "", fmt.Errorf("暂存安装包失败: %w", err)
	}
	progress(Progress{Bytes: assetSize, Total: assetSize})
	return dest, nil
}

func assetNameFromURL(url string) string {
	for i := len(url) - 1; i >= 0; i-- {
		if url[i] == '/' {
			return url[i+1:]
		}
	}
	return url
}

// WriteWaiter spawns the hidden PowerShell that waits for this process to
// exit, then runs the staged setup silently and (optionally) relaunches the
// app. All values travel through environment variables — no path quoting.
func (s *UpdateService) WriteWaiter(setupPath string, relaunch bool) error {
	appPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("定位应用失败: %w", err)
	}
	dir, err := appdir.DataDir()
	if err != nil {
		return err
	}
	script := filepath.Join(dir, "update_waiter.ps1")
	body := "$ErrorActionPreference = 'SilentlyContinue'\n" +
		"$waitFor = [int]$env:KE_UPDATE_PID\n" +
		"while (Get-Process -Id $waitFor) { Start-Sleep -Milliseconds 100 }\n" +
		"Start-Process -FilePath $env:KE_UPDATE_SETUP -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CLOSEAPPLICATIONS','/SP-' -Wait\n" +
		"if ($env:KE_UPDATE_RELAUNCH -eq '1') { Start-Process -FilePath $env:KE_UPDATE_APP }\n"
	if err := os.WriteFile(script, []byte(body), 0o600); err != nil {
		return fmt.Errorf("写入等待脚本失败: %w", err)
	}
	relaunchFlag := "0"
	if relaunch {
		relaunchFlag = "1"
	}
	return launchDetached(
		filepath.Join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
		`-NoProfile -ExecutionPolicy Bypass -File "`+script+`"`,
		map[string]string{
			"KE_UPDATE_PID":      fmt.Sprint(os.Getpid()),
			"KE_UPDATE_SETUP":    setupPath,
			"KE_UPDATE_APP":      appPath,
			"KE_UPDATE_RELAUNCH": relaunchFlag,
		},
	)
}

func systemRoot() string {
	if root := os.Getenv("SystemRoot"); root != "" {
		return root
	}
	return `C:\Windows`
}

// fetchExpectedChecksum downloads <asset>.sha256 and returns the hex
// digest it carries. ok=false when the sidecar is missing (legacy
// releases) or unreachable — the size gate still protects the install.
func fetchExpectedChecksum(ctx context.Context, url string) (string, bool) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return "", false
	}
	req.Header.Set("User-Agent", "kafka-explorer-updater")
	resp, err := (&http.Client{Timeout: 15 * time.Second}).Do(req)
	if err != nil {
		return "", false
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", false
	}
	body := make([]byte, 256)
	n, _ := io.ReadFull(io.LimitReader(resp.Body, 256), body)
	line := strings.TrimSpace(string(body[:n]))
	if line == "" {
		return "", false
	}
	// sha256sum format: "<hex>  <filename>" — the digest is the first field.
	if i := strings.IndexAny(line, " 	"); i > 0 {
		line = line[:i]
	}
	if len(line) != 64 {
		return "", false
	}
	return strings.ToLower(line), true
}

// fileSHA256 hex-digests a file on disk.
func fileSHA256(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
