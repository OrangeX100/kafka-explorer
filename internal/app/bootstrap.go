// Package app is the composition root: every dependency is constructed here
// by hand and injected downward. Nothing outside this file builds services.
package app

import (
	"context"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"sync"

	"go.uber.org/zap"
	"go.uber.org/zap/exp/zapslog"

	"github.com/wailsapp/wails/v3/pkg/application"

	appsvc "kafkaexplorer/internal/application"
	"kafkaexplorer/internal/buildinfo"
	"kafkaexplorer/internal/infrastructure/kafka"
	"kafkaexplorer/internal/infrastructure/keyring"
	"kafkaexplorer/internal/infrastructure/store"
	"kafkaexplorer/internal/presentation/wails"
)

// Bootstrap wires every service and creates the wails application.
// assets is the embedded frontend dist.
func Bootstrap(assets embed.FS) (*application.App, func(), error) {
	// A gen-2 app (installed by the in-app update's waiter) inherits the
	// waiter's KE_UPDATE_* variables; stale values would shadow the next
	// update's fresh ones (Windows reads the FIRST duplicate) and that
	// update would die after this app quit (045 Windows round). Drop them
	// at the root; launchDetached's mergeEnv is the second layer.
	for _, k := range []string{"KE_UPDATE_PID", "KE_UPDATE_SETUP", "KE_UPDATE_APP", "KE_UPDATE_RELAUNCH"} {
		_ = os.Unsetenv(k)
	}
	log, err := newLogger()
	if err != nil {
		return nil, nil, fmt.Errorf("init logger: %w", err)
	}

	dbPath, err := DatabasePath()
	if err != nil {
		return nil, nil, fmt.Errorf("resolve database path: %w", err)
	}
	db, err := store.Open(dbPath)
	if err != nil {
		return nil, nil, fmt.Errorf("open settings database: %w", err)
	}

	connRepo := store.NewConnectionRepo(db)
	secrets := keyring.NewStore("KafkaExplorer")
	pool := kafka.NewPool(connRepo, secrets)
	dbw := store.NewWrapper(db)

	connSvc := appsvc.NewConnectionService(connRepo, secrets, pool)
	topicSvc := appsvc.NewTopicService(pool)
	msgSvc := appsvc.NewMessageService(pool)
	groupSvc := appsvc.NewConsumerGroupService(pool)
	adminSvc := appsvc.NewAdminService(pool)
	registrySvc := appsvc.NewSchemaRegistryService(dbw, secrets)
	genSvc := appsvc.NewGenerateService(pool)
	ioSvc := appsvc.NewMessageIOService(pool)
	settingsSvc := appsvc.NewSettingsService(dbw)
	connectSvc := appsvc.NewConnectService(dbw, secrets)
	updateSvc := appsvc.NewUpdateService(buildinfo.Version, log)

	// re-point the ARP 卸载 button at the styled wrapper (Inno re-writes
	// the key on every install/upgrade and no setup hook runs after that)
	fixUninstallRegistry()
	winOptions := application.WindowsOptions{}
	// CDP debug port for UI automation (Playwright): requires BOTH the
	// build-stamp DebugFeatures="cdp" (only task dev:cdp sets it) AND the
	// runtime env var KE_DEBUG_CDP=1. A release binary has the stamp empty,
	// so the port is unreachable regardless of the environment — see
	// internal/buildinfo.DebugFeatures.
	if os.Getenv("KE_DEBUG_CDP") == "1" && buildinfo.DebugFeatures == "cdp" {
		winOptions.AdditionalBrowserArgs = []string{"--remote-debugging-port=9223"}
	}

	// Single instance: the tray lives in-process, so a second launch would
	// show a SECOND tray icon for the same app. The wails runtime takes a
	// named-mutex lock; a duplicate process notifies the first instance and
	// exits itself before creating any window or tray. We respond by
	// surfacing the existing window (fade restore from tray) so the user
	// understands why nothing new appeared. trayRef/appRef are filled right
	// after construction — the callback only fires once the app is running.
	var trayRef *Tray
	var appRef *application.App
	app := application.New(application.Options{
		Name:        AppName,
		Description: "Kafka cluster explorer: topics, messages and consumer groups",
		Windows:     winOptions,
		SingleInstance: &application.SingleInstanceOptions{
			UniqueID: "com.kafkaexplorer.app",
			OnSecondInstanceLaunch: func(data application.SecondInstanceData) {
				log.Info("second instance launch redirected to the running window")
				if trayRef != nil {
					trayRef.restore()
					return
				}
				if appRef != nil {
					if w, ok := appRef.Window.GetByName("main"); ok {
						w.Show()
						w.Focus()
					}
				}
			},
		},

		// wails wants an slog.Logger; zapslog bridges our zap logger so all
		// output (app + framework) lands in one file, level follows the core.
		Logger:   slog.New(zapslog.NewHandler(log.Core())),
		LogLevel: slog.LevelInfo,
		ErrorHandler: func(err error) {
			log.Error("wails runtime error", zap.Error(err))
		},
		Assets: application.AssetOptions{
			Handler: application.AssetFileServerFS(assets),
		},
		ShouldQuit: func() bool { return true },
		OnShutdown: func() {},
	})

	app.RegisterService(application.NewService(wails.NewTopicHandler(topicSvc, log)))
	app.RegisterService(application.NewService(wails.NewGroupHandler(groupSvc, log)))
	app.RegisterService(application.NewService(wails.NewAdminHandler(adminSvc, log)))
	app.RegisterService(application.NewService(wails.NewSchemaRegistryHandler(registrySvc, secrets, log)))
	genHandler := wails.NewGenerateHandler(genSvc, ioSvc, log)
	genHandler.SetEmitter(func(topic string, data ...any) { app.Event.Emit(topic, data...) })
	app.RegisterService(application.NewService(genHandler))
	systemHandler := wails.NewSystemHandler(updateSvc, log)
	systemHandler.SetEmitter(func(topic string, data ...any) { app.Event.Emit(topic, data...) })
	var tray *Tray // created below; the quit closure runs only after boot
	systemHandler.SetQuit(func() { tray.Quit() })
	app.RegisterService(application.NewService(systemHandler))

	// Pick-path authorization: native dialogs issue paths into ONE shared
	// broker; the import/export/read bindings verify membership, so a
	// compromised webview cannot name arbitrary files (045 security round).
	// Mechanism contract: pathbroker_test.go; wiring is verified visually
	// here (every consumer's SetPathBroker sits within this function —
	// a new consumer must be wired or it fail-closes all file verbs).
	pathBroker := systemHandler.PathBroker()
	connHandler := wails.NewConnectionHandler(connSvc, log)
	connHandler.SetPathBroker(pathBroker)
	app.RegisterService(application.NewService(connHandler))

	// ksqlDB module: servers, statement exec and streaming queries.
	ksqlSvc := appsvc.NewKsqlDbService(dbw, secrets)
	ksqlHandler := wails.NewKsqlDbHandler(ksqlSvc, secrets, log)
	ksqlHandler.SetEmitter(func(topic string, data ...any) { app.Event.Emit(topic, data...) })
	app.RegisterService(application.NewService(ksqlHandler))
	connectHandler := wails.NewConnectHandler(connectSvc, secrets, log)
	app.RegisterService(application.NewService(connectHandler))

	// one-file backup across every persisted module (settings page); built
	// after ksqlSvc so the service set is complete
	backupSvc := appsvc.NewBackupService(connSvc, registrySvc, connectSvc, ksqlSvc, settingsSvc)
	genHandler.SetPathBroker(pathBroker)
	settingsHandler := wails.NewSettingsHandler(settingsSvc, backupSvc, log)
	settingsHandler.SetPathBroker(pathBroker)
	app.RegisterService(application.NewService(settingsHandler))

	// Value decoding: message browsing resolves Confluent schema ids through
	// the registry bound to the browsed CONNECTION (binding picked in
	// pickRegistryFor); unbound registries stay the global fallback so the
	// common one-registry setup keeps working unchanged.
	msgHandler := wails.NewMessageHandler(msgSvc, log)
	// Schema cache: decode=auto resolves a schema id PER RECORD and every
	// miss is an HTTP round trip to the registry — a 60-row page was 60
	// calls. Distinct schemas are few; cache forever (Confluent ids are
	// immutable: an id IS the schema, never invalidated). Keyed by
	// registry/id: the same numeric id means DIFFERENT schemas across
	// registries once connections bind their own. ONE fetcher instance is
	// shared by message browsing AND schema-aware exports (same binding,
	// same cache).
	var schemaMu sync.Mutex
	// Cap the cache: Confluent ids are immutable but a hostile cluster can
	// mint unlimited distinct ids — unbounded growth was a DoS vector
	// (045 round-5). 4096 entries is far beyond any legitimate workload.
	const schemaCacheCap = 4096
	schemaCache := map[string]struct {
		schema, typ string
	}{}
	decodeFetcher := func(ctx context.Context, connectionID string, id int) (string, string, error) {
		registries, err := registrySvc.List(ctx)
		if err != nil || len(registries) == 0 {
			return "", "", fmt.Errorf("no schema registry configured")
		}
		reg := pickRegistryFor(registries, connectionID)
		if reg == nil {
			return "", "", fmt.Errorf("当前连接未绑定 Schema Registry，且没有未绑定的全局 Registry 可用（请在「Schema Registry」页为该集群绑定一个）")
		}
		cacheKey := fmt.Sprintf("%s/%d", reg.ID, id)
		schemaMu.Lock()
		if hit, ok := schemaCache[cacheKey]; ok {
			schemaMu.Unlock()
			return hit.schema, hit.typ, nil
		}
		schemaMu.Unlock()
		schema, typ, err := registrySvc.SchemaByID(ctx, reg.ID, id)
		if err != nil {
			return "", "", err
		}
		schemaMu.Lock()
		if len(schemaCache) >= schemaCacheCap {
			// FIFO 逐出最早写入的 entry（不做 LRU——读多写少场景 FIFO 足够）
			for k := range schemaCache {
				delete(schemaCache, k)
				break
			}
		}
		schemaCache[cacheKey] = struct{ schema, typ string }{schema, typ}
		schemaMu.Unlock()
		return schema, typ, nil
	}
	msgHandler.SetDecodeFetcher(decodeFetcher)
	ioSvc.SetSchemaFetcher(decodeFetcher)
	app.RegisterService(application.NewService(msgHandler))

	// application.New does NOT create a window: without this the process
	// runs headless and the user sees nothing (fixed after first smoke test).
	app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:      "main",
		Title:     AppName,
		URL:       "/",
		Width:     1280,
		Height:    800,
		MinWidth:  960,
		MinHeight: 600,
		// Custom titlebar: the native frame is removed; the frontend
		// TitleBar component owns dragging (--wails-draggable) and the
		// minimise/maximise/close buttons (runtime Window API).
		Frameless: true,
		// Match styles.css ink-950 so the window never flashes white.
		BackgroundColour: application.RGBA{Red: 0x12, Green: 0x13, Blue: 0x18, Alpha: 1},
		InitialPosition:  application.WindowCentered,
	})

	// The wails window class carries the generic IDI_APPLICATION icon, which
	// overrides the exe resource on the taskbar — set ours explicitly.
	setWindowIcon(AppName)

	// System tray: the ✕ hides to the tray (CloseToTray setting), quitting
	// lives only in the tray menu. cleanup runs after pool/db teardown.
	tray = NewTray(app, settingsSvc, func() {
		pool.CloseAll()
		_ = db.Close()
		_ = log.Sync()
	})
	trayRef = tray
	appRef = app
	systemHandler.SetCloseTray(tray.CloseRequested)

	cleanup := func() {
		tray.Quit()
	}
	return app, cleanup, nil
}

// newLogger writes to the data dir and stderr; simple but structured.
func newLogger() (*zap.Logger, error) {
	cfg := zap.NewProductionConfig()
	if dir, err := DataDir(); err == nil {
		cfg.OutputPaths = []string{
			"stderr",
			fmt.Sprintf("%s/kafka-explorer.log", dir),
		}
	}
	return cfg.Build()
}
