//go:build windows

// The setup service: reads the install facts (existing install dir from a
// previous ARP entry), extracts the embedded Inno engine and runs it
// silently for the real file copying. Keeping Inno underneath means file
// lists, shortcuts, the ARP entry and the uninstall log stay exactly as
// before — only the chrome is ours.
package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/text/encoding/simplifiedchinese"

	wailsapp "github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows/registry"

	"kafkaexplorer/internal/buildinfo"
)

// arpKey is the Add/Remove Programs entry a previous install wrote (AppId
// from build/installer/installer.iss — keep the two in sync).
const arpKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\{A314C01E-B626-4FFB-97AC-4260A28648CD}_is1`

// engineExeName is the file name the embedded engine is extracted under
// inside %TEMP%.
const engineExeName = "KafkaExplorer_Engine.exe"

// appDirName is appended when the user picks a drive root, so a stray
// click on C:\ doesn't splatter the app across the root.
const appDirName = "Kafka Explorer"

// runningMutexes is the single-instance lock the app holds (UniqueID
// from internal/app/bootstrap.go — keep the two in sync).
var runningMutexes = []string{
	`wails-app-com.kafkaexplorer.app-sim`,
}

// Info is the pre-flight snapshot the UI renders: where a previous install
// lives ("" = fresh install) and whether the app must be closed first.
type Info struct {
	PrevDir    string `json:"prevDir"`
	Version    string `json:"version"`
	AppRunning bool   `json:"appRunning"`
}

// setupService is the wails service bound to the setup window. engineExe
// is the Inno engine payload injected from main (go:embed).
type setupService struct {
	engineExe []byte
	emit      func(topic string, data ...any) // wails events, wired by main
	mu        sync.Mutex
	running   bool
}

func newSetupService(engineExe []byte) *setupService {
	return &setupService{engineExe: engineExe}
}

// arpVersion reads the DisplayVersion a previous install recorded ("" when
// none).
func (s *setupService) arpVersion() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.QUERY_VALUE)
	if err != nil {
		return ""
	}
	defer k.Close()
	v, _, _ := k.GetStringValue("DisplayVersion")
	return v
}

// SetEmitter wires the wails event emitter (bootstrap owns the app) so
// the service can stream real install progress to the UI.
func (s *setupService) SetEmitter(emit func(topic string, data ...any)) {
	s.emit = emit
}

// Info collects the pre-flight snapshot.
func (s *setupService) Info() Info {
	var info Info
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		info.PrevDir, _, _ = k.GetStringValue("Inno Setup: App Path")
		info.Version, _, _ = k.GetStringValue("DisplayVersion")
	}
	info.AppRunning = appRunning()
	return info
}

// DefaultDir returns the suggested install directory: the previous
// install's location when upgrading, otherwise %LOCALAPPDATA%\Kafka Explorer.
func (s *setupService) DefaultDir() string {
	k, err := registry.OpenKey(registry.CURRENT_USER, arpKey, registry.QUERY_VALUE)
	if err == nil {
		defer k.Close()
		if v, _, err := k.GetStringValue("Inno Setup: App Path"); err == nil && v != "" {
			return v
		}
	}
	local := os.Getenv("LOCALAPPDATA")
	if local == "" {
		local = filepath.Join(os.Getenv("USERPROFILE"), "AppData", "Local")
	}
	return filepath.Join(local, appDirName)
}

// PickDir opens a native folder-picker (creating new folders allowed).
// "" = cancelled — a no-op, never an error (wails maps the dialog's cancel
// to the "cancelled by user" error, normalized here like everywhere else).
func (s *setupService) PickDir(title string) (string, error) {
	dlg := wailsapp.Get().Dialog.OpenFile().
		SetTitle(title).
		CanChooseFiles(false).
		CanChooseDirectories(true).
		CanCreateDirectories(true)
	path, err := dlg.PromptForSingleSelection()
	if err != nil && strings.Contains(strings.ToLower(err.Error()), "cancel") {
		return "", nil
	}
	return path, err
}

// appRunning reports whether the main app holds its single-instance lock.
// CreateMutex returns a valid handle even when the mutex already exists —
// close it in EVERY branch or the leaked handle pins the mutex alive
// (same bug family as the uninstaller's polling fix).
func appRunning() bool {
	for _, name := range runningMutexes {
		h, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
		already := err == windows.ERROR_ALREADY_EXISTS
		if h != 0 {
			windows.CloseHandle(h)
		}
		if already {
			return true
		}
	}
	return false
}

// engineRunner runs the Inno engine silently against dir. Injected so
// tests can stub the heavy lifting.
type engineRunner func(dir string) error

// Install is the wails-bound entry point. It MUST keep the single-arg
// signature — wails only binds serializable parameters, so the testable
// seam lives in the unexported install below.
func (s *setupService) Install(dir string) error {
	return s.install(dir, runPrevUninstaller, s.runEngine)
}

// install pre-uninstalls an existing SAME-VERSION install in dir (Inno
// otherwise SILENTLY SKIPS same-version reinstalls — exit 0 without
// copying a single file) and hands off to run. Different-version
// upgrades/downgrades go straight to Inno, which handles them in place —
// no uninstall step, fewer failure modes.
func (s *setupService) install(dir string, preUninstall func(string) error, run engineRunner) error {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return fmt.Errorf("安装正在进行中，请稍候。")
	}
	s.running = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.running = false; s.mu.Unlock() }()

	dir = strings.TrimSpace(dir)
	if dir == "" {
		return fmt.Errorf("请选择安装目录。")
	}
	// "D:Kafka Explorer" (colon, no separator) is a DRIVE-RELATIVE path:
	// Windows resolves it to that drive's current directory, so Inno would
	// install somewhere arbitrary. Repair it to the obvious intent.
	if len(dir) > 2 && dir[1] == ':' && dir[2] != '\\' && dir[2] != '/' {
		dir = dir[:2] + `\` + dir[2:]
	}
	// A bare drive root ("D:" / "D:\") would splatter the app across the
	// root — always nest one level of appDirName.
	if isDriveRoot(dir) {
		dir = filepath.Join(dir, appDirName)
	}
	if appRunning() {
		return fmt.Errorf("Kafka Explorer 正在运行。请先完全退出应用（包括托盘图标），再执行安装。")
	}

	// Same-version reinstall only (see above); buildinfo.Version is empty
	// in dev builds — then always pre-uninstall, the safe default.
	if buildinfo.Version != "" && s.arpVersion() != buildinfo.Version {
		return run(dir)
	}
	if err := preUninstall(dir); err != nil {
		return err
	}
	return run(dir)
}

// runPrevUninstaller silently runs dir\unins000.exe when the target
// directory already holds an installation; a fresh install (no file)
// is a no-op. The first run of a freshly written unins000.exe is the
// classic AV real-time-scan target (it holds the file for seconds and
// the spawn fails) — wait out the scan and retry once.
func runPrevUninstaller(dir string) error {
	prevUnins := filepath.Join(dir, "unins000.exe")
	if _, err := os.Stat(prevUnins); err != nil {
		return nil
	}
	runOnce := func() error {
		un := exec.Command(prevUnins, "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART")
		un.Dir = dir
		un.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		return un.Run()
	}
	err := runOnce()
	if err != nil {
		time.Sleep(2500 * time.Millisecond)
		err = runOnce()
	}
	if err != nil {
		return fmt.Errorf("准备升级时卸载旧版本未完成：旧文件可能正被杀毒软件短暂占用。请稍候几秒重试；若反复失败，请暂时退出杀毒软件实时防护后再试。")
	}
	return nil
}

// runEngine extracts the embedded Inno engine and runs it silently into
// dir. The compiled Inno exe is fully self-contained (all files embedded
// at compile time), so the release layout needs only this one front-end
// binary.
func (s *setupService) runEngine(dir string) (installErr error) {
	// Extract the engine NEXT TO this front-end when possible: 360's
	// behavior engine blocks exe payloads freshly dropped into %TEMP% by
	// an unsigned exe — the engine either never starts or its file writes
	// get access-denied mid-install — while the very same engine sitting
	// beside the front-end (the old side-by-side release layout) installs
	// fine. The embedded bytes are identical to any engine already there,
	// so skip the rewrite; everything we dropped gets cleaned up on
	// success (the download dir stays one file). A read-only front-end
	// dir (rare) falls back to %TEMP% + friendly error guidance on top.
	engine := ""
	workDir := ""
	wroteEngine := false
	var artifacts []string // dropped files to clean up after success
	if self, err := os.Executable(); err == nil {
		candidate := filepath.Join(filepath.Dir(self), engineExeName)
		if st, err := os.Stat(candidate); err == nil && st.Size() == int64(len(s.engineExe)) {
			engine = candidate
			workDir = filepath.Dir(self)
		} else if err := os.WriteFile(candidate, s.engineExe, 0o755); err == nil {
			engine = candidate
			workDir = filepath.Dir(self)
			wroteEngine = true
		}
	}
	if engine == "" {
		tmp, err := os.MkdirTemp("", "ke-setup-")
		if err != nil {
			return fmt.Errorf("创建临时目录失败: %w", err)
		}
		// Keep the temp dir (and the Inno log inside it) when the run
		// fails — the friendly error points there; clean up on success.
		defer func() {
			if installErr == nil {
				os.RemoveAll(tmp)
			}
		}()
		engine = filepath.Join(tmp, engineExeName)
		if err := os.WriteFile(engine, s.engineExe, 0o755); err != nil {
			return fmt.Errorf("写入安装引擎失败: %w", err)
		}
		workDir = tmp
	}
	// One log per attempt: each engine run rewrites its log, so sharing a
	// path would bury what the earlier attempts actually did.
	logPath := filepath.Join(workDir, "KafkaExplorer_Setup.log")
	// Real progress: the Inno log is the ground truth of what got copied.
	// A watcher runs for the WHOLE attempt chain (all attempts append to
	// their own logs, but the direct attempt's log is the one the early
	// files land in; on fallback the bar restarts from the new log).
	if s.emit != nil {
		watcher := &installProgress{emit: s.emit, logPath: logPath, deadline: time.Now().Add(20 * time.Minute)}
		go watcher.run()
	}
	engineArgs := func(log string) []string {
		return []string{
			"/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART",
			"/DIR=" + dir,
			"/LOG=" + log,
		}
	}
	// Success cleanup: the release is ONE downloaded file, so anything we
	// dropped beside it (engine copy, logs, the handoff script) goes away
	// once the install landed. AV often holds a just-run exe for seconds,
	// hence the patient background retries — never block the UI for it.
	defer func() {
		if installErr != nil {
			return
		}
		doomed := append([]string{logPath}, artifacts...)
		if wroteEngine {
			doomed = append(doomed, engine)
		}
		go removeEventually(doomed)
	}()
	// Fast path: spawn the engine directly. Works on machines without a
	// paranoid behavior engine; gives an exact exit code.
	err := runEngineProcess(engine, engineArgs(logPath), workDir)
	if err != nil {
		// 360 (and friends) taint launches out of a downloaded unsigned
		// exe — the engine never starts, or its file writes get
		// access-denied mid-install (verified: the same engine run from a
		// shell parent installs fine seconds earlier/later; child spawns
		// through cmd, explorer and WMI were ALL blocked on the dev
		// machine). Escalate through progressively more user-like
		// launchers, judging each attempt from its own Inno log:
		//  1. a one-line .cmd opened via explorer.exe — explorer→cmd→engine
		//     is what a double-click produces (may itself be denied);
		//  2. the one-click script through ShellExecute's open verb;
		//  3. hand the script to the user and watch for its completion.
		explorerLog := filepath.Join(workDir, "KafkaExplorer_Setup_explorer.log")
		artifacts = append(artifacts, explorerLog)
		problems := []string{"直连: " + describeRunErr(err)}
		err = runEngineViaExplorerCmd(engine, engineArgs(explorerLog), workDir, explorerLog)
		if err != nil {
			problems = append(problems, "explorer: "+describeRunErr(err))
		}
		// One-click script: the engine with the exact silent args, GBK
		// encoded (cmd.exe reads batch files in the ANSI codepage). The
		// shell can launch it, and failing that the USER double-clicks it
		// — a user-driven launch is the one pattern every behavior engine
		// allows (verified: shell-launched runs install fine seconds
		// around blocked front-end attempts).
		scriptPath := filepath.Join(workDir, handoffScriptName)
		artifacts = append(artifacts, scriptPath, filepath.Join(workDir, "run-install.cmd"))
		if werr := writeHandoffScript(scriptPath, engine, engineArgs(logPath)); werr != nil {
			problems = append(problems, "写脚本: "+werr.Error())
		} else if serr := shellRunScript(scriptPath, logPath); serr == nil {
			return nil // the shell-launched script completed the whole install
		} else {
			problems = append(problems, "shellexec: "+describeRunErr(serr))
		}
		// Handoff wait: watch the shared log for a completed install by
		// the user's double-click. The log from the failed direct attempt
		// still ends with "Log closed.", so it must go before the poll.
		// Generous window — the user has to read the hint and react.
		os.Remove(logPath)
		err = waitForEngineLog(logPath, time.Now().Add(10*time.Minute), 15*time.Minute)
		if err != nil {
			if errors.Is(err, errTimeout) {
				return fmt.Errorf("自动安装被杀毒软件拦截。请打开 %s 并双击「%s」完成安装；装完后本窗口会自动显示完成。", workDir, handoffScriptName)
			}
			return fmt.Errorf("自动安装未能完成（%s）。请暂时退出杀毒软件实时防护后重试，或双击「%s」（位于 %s）手动完成安装。", strings.Join(problems, "；"), handoffScriptName, workDir)
		}
		return nil
	}
	return nil
}

// removeEventually deletes files in the background with growing retries —
// the AV commonly pins a just-exited exe for a few seconds.
func removeEventually(paths []string) {
	for _, p := range paths {
		for _, delay := range []time.Duration{0, 2 * time.Second, 5 * time.Second, 10 * time.Second} {
			time.Sleep(delay)
			if err := os.Remove(p); err == nil || os.IsNotExist(err) {
				break
			}
		}
	}
}

// handoffScriptName is the double-click fallback the user runs when every
// automatic engine launch got intercepted. ASCII-safe stem, memorable name.
const handoffScriptName = "install-kafka-explorer.cmd"

// installProgress watches an Inno /LOG file and turns it into a
// deterministic progress bar: the log writes one "-- File entry --"
// marker per [Files] entry, so total markers ≈ entries and installed
// markers = real progress (Inno installs files in order, finishing at
// "Installation process succeeded"). Progress events go to the UI via
// the wails event system; 0/100 are synthesized around the run.
type installProgress struct {
	emit     func(topic string, data ...any)
	logPath  string
	deadline time.Time
}

// run streams progress until the log says done/failed or the deadline
// passes. It is best-effort: if the log never appears (engine blocked),
// the UI keeps a slow synthetic crawl instead of a dead bar.
func (p *installProgress) run() {
	defer func() {
		if p.emit != nil {
			p.emit("setup:progress", map[string]any{"pct": 100, "done": true})
		}
	}()
	seen := -1 // -1 = log not started yet
	for time.Now().Before(p.deadline) {
		time.Sleep(400 * time.Millisecond)
		data, err := os.ReadFile(p.logPath)
		if err != nil {
			continue
		}
		total := strings.Count(string(data), "-- File entry --")
		if total == 0 {
			continue
		}
		done := strings.Contains(string(data), "Installation process succeeded")
		failed := strings.Contains(string(data), "Log closed.") && !done
		// Files before the first marker (unins000.exe) count too.
		pct := 5 + 90*strings.Count(string(data), "Successfully installed the file.")/(total+1)
		if done {
			pct = 100
		}
		if pct != seen {
			seen = pct
			if p.emit != nil {
				p.emit("setup:progress", map[string]any{"pct": pct, "done": done})
			}
		}
		if done || failed {
			return
		}
	}
}

// writeHandoffScript encodes the one-click installer script in GBK —
// cmd.exe parses batch files in the ANSI codepage, and install paths here
// routinely contain Chinese characters.
func writeHandoffScript(path, engine string, args []string) error {
	var b strings.Builder
	b.WriteString("@echo off\r\n")
	b.WriteString("title Kafka Explorer installer\r\n")
	b.WriteString("echo 正在安装 Kafka Explorer，请勿关闭此窗口...\r\n")
	b.WriteString(quoteIfSpaced(engine))
	for _, a := range args {
		b.WriteString(" " + quoteIfSpaced(a))
	}
	b.WriteString("\r\n")
	enc := simplifiedchinese.GBK.NewEncoder()
	gbk, err := enc.String(b.String())
	if err != nil {
		return err
	}
	return os.WriteFile(path, []byte(gbk), 0o644)
}

// shellRunScript launches the handoff script through the shell's open
// verb (in-process ShellExecute, the same path a double-click takes) and
// reports the outcome judged from the Inno log.
func shellRunScript(scriptPath, logPath string) error {
	if err := windows.ShellExecute(0, windows.StringToUTF16Ptr("open"),
		windows.StringToUTF16Ptr(scriptPath), nil, nil, windows.SW_SHOWNORMAL); err != nil {
		return fmt.Errorf("唤起脚本失败: %w", err)
	}
	return waitForEngineLog(logPath, time.Now().Add(3*time.Minute), 8*time.Minute)
}

// describeRunErr turns a run outcome into a short label for the combined
// failure message.
func describeRunErr(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, errStartBlocked):
		return "引擎未能启动（疑似被拦截）"
	case errors.Is(err, errInUse):
		return "安装目标文件被占用"
	case errors.Is(err, errTimeout):
		return "安装超时"
	default:
		return err.Error()
	}
}

// Sentinel errors classifying the engine run; translated into friendly
// messages at the runEngine boundary.
var (
	errStartBlocked = errors.New("engine start blocked")
	errInUse        = errors.New("target file in use")
	errTimeout      = errors.New("engine run timed out")
)

// runEngineProcess launches the Inno engine directly as our child and
// waits for it (GUI exes included).
func runEngineProcess(engine string, args []string, wd string) error {
	cmd := exec.Command(engine, args...)
	cmd.Dir = wd
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return cmd.Run()
}

// runEngineViaExplorerCmd writes a one-line launcher script and asks
// explorer.exe to open it — the engine then runs under an
// explorer→cmd→engine ancestry, i.e. exactly what a user double-clicking
// produces, which behavior engines allow while they block our children.
// The front-end waits on Inno's log (see waitForEngineLog).
func runEngineViaExplorerCmd(engine string, args []string, workDir string, logPath string) error {
	cmdPath := filepath.Join(workDir, "run-install.cmd")
	var b strings.Builder
	b.WriteString("@echo off\r\n")
	b.WriteString(`start "" ` + quoteIfSpaced(engine))
	for _, a := range args {
		b.WriteString(" " + quoteIfSpaced(a))
	}
	b.WriteString("\r\n")
	if err := os.WriteFile(cmdPath, []byte(b.String()), 0o644); err != nil {
		return fmt.Errorf("写启动脚本失败: %w", err)
	}
	defer os.Remove(cmdPath) // best effort
	// explorer returns immediately; the log poll does the waiting
	if err := exec.Command("explorer.exe", cmdPath).Run(); err != nil {
		return fmt.Errorf("唤起 explorer 失败: %w", err)
	}
	return waitForEngineLog(logPath, time.Now().Add(20*time.Second), 8*time.Minute)
}

// waitForEngineLog polls Inno's own log for completion: it always ends
// with "Log closed." regardless of install language, and success is the
// exact "Installation process succeeded" line. startedBy bounds how long
// the log may take to appear (longer = the engine never started).
func waitForEngineLog(logPath string, startedBy time.Time, budget time.Duration) error {
	deadline := time.Now().Add(budget)
	started := false
	for time.Now().Before(deadline) {
		time.Sleep(500 * time.Millisecond)
		if !started {
			if _, err := os.Stat(logPath); err == nil {
				started = true
			} else if time.Now().After(startedBy) {
				return errStartBlocked
			}
			continue
		}
		data, err := os.ReadFile(logPath)
		if err == nil && strings.Contains(string(data), "Log closed.") {
			switch {
			case strings.Contains(string(data), "Installation process succeeded"):
				return nil
			case strings.Contains(string(data), "appears to be in use"):
				return errInUse
			default:
				return fmt.Errorf("安装程序异常退出，详细日志：%s", logPath)
			}
		}
	}
	return errTimeout
}

// quoteIfSpaced wraps a token for a CreateProcess command line built as
// one string, so tokens containing spaces stay a single argument.
func quoteIfSpaced(s string) string {
	if strings.ContainsAny(s, " \t") {
		return `"` + s + `"`
	}
	return s
}

// isDriveRoot reports whether dir is a bare drive root ("D:", "D:\",
// "D:/") — the case where nesting one appDirName level is mandatory.
// Bare "D:" (no separator) is the trap: Windows resolves it to that
// drive's CURRENT DIRECTORY (whatever process last cd'd there), so Inno
// would install somewhere arbitrary — it must be nested too.
func isDriveRoot(dir string) bool {
	v := strings.TrimSuffix(filepath.Clean(strings.TrimSpace(dir)+`\`), `\`)
	return len(v) == 2 && v[1] == ':'
}

// LaunchApp starts the freshly installed app detached; the setup window
// closes right after. Exported method so wails binds it for the
// done-state button.
//
// NO HideWindow here: SysProcAttr.HideWindow sets STARTUPINFO wShowWindow
// to SW_HIDE, which the (Wails) app honors and starts with its main
// window hidden — only the tray shows. The app has its own
// single-instance + tray logic, so a plain spawn shows the window.
func (s *setupService) LaunchApp(dir string) error {
	exe := filepath.Join(dir, "kafka-explorer.exe")
	if _, err := os.Stat(exe); err != nil {
		return fmt.Errorf("未找到 kafka-explorer.exe，安装可能未完成。")
	}
	detached := exec.Command(exe)
	detached.Dir = dir
	return detached.Start()
}
