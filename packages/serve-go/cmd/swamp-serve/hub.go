// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
//
// This file is part of Swamp.
//
// Swamp is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation, with the Swamp
// Extension and Definition Exception (found in the "COPYING-EXCEPTION"
// file).
//
// Swamp is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with Swamp.  If not, see <https://www.gnu.org/licenses/>.

package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/hub"
)

const hubUsage = "swamp-serve hub --engine <executable> [options]"

type hubOptions struct {
	executable  string
	bind        string
	certPath    string
	keyPath     string
	trusted     string
	jsonMode    bool
	engine      engine.Config
	controlIdle time.Duration
	maxEngines  int
	resolveTTL  time.Duration
	record      string
	exitIdle    time.Duration
	leaseTTL    time.Duration
	logFile     string
}

func hubFlags(options *hubOptions) *flag.FlagSet {
	flags := flag.NewFlagSet("swamp-serve hub", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	options.engine = engine.DefaultConfig()
	flags.StringVar(&options.executable, "engine", "", "Explicit installed swamp executable path (required)")
	flags.StringVar(&options.bind, "bind", "127.0.0.1:9870", "HTTP listen address; non-loopback requires TLS")
	flags.StringVar(&options.certPath, "tls-cert", "", "PEM certificate path, relative to launch directory")
	flags.StringVar(&options.keyPath, "tls-key", "", "PEM private key path, relative to launch directory")
	flags.StringVar(&options.trusted, "trusted-hosts", "", "Comma-separated external hostnames")
	flags.BoolVar(&options.jsonMode, "json", false, "JSON operational output")
	flags.DurationVar(&options.engine.StartupTimeout, "startup-timeout", options.engine.StartupTimeout, "Engine startup deadline")
	flags.DurationVar(&options.engine.IdleTimeout, "idle-timeout", options.engine.IdleTimeout, "Workspace engine idle grace; zero keeps engines running")
	flags.DurationVar(&options.engine.DrainTimeout, "drain-timeout", options.engine.DrainTimeout, "Shutdown deadline")
	flags.DurationVar(&options.engine.ControlTimeout, "control-timeout", options.engine.ControlTimeout, "Private control request deadline")
	flags.DurationVar(&options.engine.Cooldown, "startup-cooldown", options.engine.Cooldown, "Delay before restarting a failed generation")
	flags.DurationVar(&options.controlIdle, "control-idle-timeout", 10*time.Minute, "Control engine idle grace; zero keeps it running")
	flags.IntVar(&options.maxEngines, "max-engines", 8, "Workspace engines running at once; the least recently used idle one stops first; zero is unbounded")
	flags.DurationVar(&options.resolveTTL, "resolve-ttl", 5*time.Second, "How long a workspace lookup is reused for new connections")
	flags.StringVar(&options.record, "record", "", "Write the hub record (port and a fresh admin token, mode 0600) here and serve dashboard pages; the admin API issues page leases")
	flags.DurationVar(&options.exitIdle, "exit-when-idle", 0, "Stop once no lease and no engine has been left this long; zero keeps running")
	flags.DurationVar(&options.leaseTTL, "lease-ttl", time.Minute, "Revoke a page lease its owner has not renewed this long; zero never expires")
	flags.StringVar(&options.logFile, "log-file", "", "Append operational output here instead of standard output")
	flags.DurationVar(&options.engine.PageIdleGrace, "page-idle-grace", 10*time.Minute, "Keep a workspace engine up this long after its last dashboard page closes")
	return flags
}

// runHub fronts every workspace in the user's registry at /w/<workspace>/.
func runHub(args []string, stdout, stderr io.Writer) (result error) {
	var options hubOptions
	flags := hubFlags(&options)
	requestedJSON := jsonRequested(flags, args)
	defer func() {
		if result != nil {
			writeError(stderr, result, requestedJSON)
		}
	}()
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return writeHubHelp(stdout, flags, requestedJSON)
		}
		return err
	}
	requestedJSON = options.jsonMode
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional argument %q; use swamp-serve hub --help for options", flags.Arg(0))
	}
	if options.executable == "" {
		return errors.New("--engine is required; use swamp-serve hub --help for options")
	}
	config := options.engine
	if config.StartupTimeout <= 0 || config.ControlTimeout <= 0 || config.DrainTimeout <= 0 || config.Cooldown <= 0 || config.IdleTimeout < 0 || options.controlIdle < 0 || options.resolveTTL < 0 || config.PageIdleGrace < 0 || options.exitIdle < 0 || options.leaseTTL < 0 {
		return errors.New("timeouts must be positive; only idle timeouts, --page-idle-grace, --resolve-ttl, --exit-when-idle and --lease-ttl accept zero")
	}
	if options.exitIdle > 0 && options.record == "" {
		return errors.New("--exit-when-idle needs --record: a hub without one serves no leases to wait for")
	}
	if options.maxEngines < 0 {
		return errors.New("--max-engines must not be negative")
	}
	maxDrainMs := servecontract.MaxShutdownDeadlineMilliseconds()
	if config.DrainTimeout > time.Duration(maxDrainMs)*time.Millisecond {
		return fmt.Errorf("--drain-timeout must not exceed %dms (the engine's safe timer range, about 24.8 days)", maxDrainMs)
	}
	if (options.certPath == "") != (options.keyPath == "") {
		return errors.New("--tls-cert and --tls-key must be provided together")
	}
	host, err := validateBind(options.bind, options.certPath != "")
	if err != nil {
		return err
	}
	executable, err := resolvePath(options.executable)
	if err != nil {
		return fmt.Errorf("invalid engine path: %w", err)
	}
	tlsConfig, err := loadTLS(options.certPath, options.keyPath)
	if err != nil {
		return err
	}
	var recordPath, adminToken string
	if options.record != "" {
		// The record is new each start: resolve its directory, never the file.
		dir, err := resolvePath(filepath.Dir(options.record))
		if err != nil {
			return fmt.Errorf("invalid record path: %w", err)
		}
		recordPath = filepath.Join(dir, filepath.Base(options.record))
		if adminToken, err = hub.NewToken(); err != nil {
			return err
		}
	}
	if options.logFile != "" {
		logOutput, err := os.OpenFile(options.logFile, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
		if err != nil {
			return fmt.Errorf("invalid log file: %w", err)
		}
		defer logOutput.Close()
		stdout = logOutput
	}
	var handler slog.Handler = slog.NewTextHandler(stdout, nil)
	if options.jsonMode {
		handler = slog.NewJSONHandler(stdout, nil)
	}
	logger := slog.New(handler)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	controlConfig := config
	controlConfig.IdleTimeout = options.controlIdle
	identity := &hub.ControlIdentity{}
	control := engine.NewSupervisorWith(controlConfig, engine.ControlStarter(executable, config.DrainTimeout), identity.Handshake)
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), config.DrainTimeout)
		defer cancel()
		_ = control.Shutdown(ctx)
	}()
	// A broken repository must not stop the hub, but an incompatible engine
	// pair would fail every workspace: prove the pair before listening.
	startup, cancelStartup := context.WithTimeout(ctx, config.StartupTimeout)
	err = control.Validate(startup)
	cancelStartup()
	if err != nil {
		return startupError(err)
	}
	resolver := hub.ControlResolver{Control: control}
	workspaces := hub.New(hub.Config{
		Engine:     config,
		MaxEngines: options.maxEngines,
		ResolveTTL: options.resolveTTL,
		Starter: func(workspace hub.Workspace) engine.Starter {
			if !workspace.Trusted {
				return engine.UntrustedStarter(executable, workspace.Path, config.DrainTimeout)
			}
			return engine.ExecStarter(executable, workspace.Path, config.DrainTimeout)
		},
	}, resolver)
	gatewayConfig := gateway.Config{Host: host, TLS: tlsConfig != nil, TrustedHosts: parseHosts(options.trusted), AuthTimeout: 2*config.StartupTimeout + config.ControlTimeout, ControlTimeout: config.ControlTimeout, WriteTimeout: 10 * time.Second, Profile: "hub"}
	leases := hub.NewLeaseStore(options.leaseTTL)
	var record hubRecord
	var onListening func(*net.TCPAddr) error
	if recordPath != "" {
		engineVersion, engineGitSHA := identity.Get()
		record = hubRecord{PID: os.Getpid(), AdminToken: adminToken, Version: version, GitSHA: gitSHA, Engine: executable, EngineVersion: engineVersion, EngineGitSHA: engineGitSHA, AutoExit: options.exitIdle > 0}
		admin := hub.NewAdmin(adminToken, leases)
		admin.Timeout = gatewayConfig.AuthTimeout
		admin.Inspect = resolver.Inspect
		admin.Info = func() interface{} { info := record; info.AdminToken = ""; return info }
		admin.Shutdown = func() error {
			if !record.AutoExit || leases.Count() != 0 {
				return hub.ErrShutdownRefused
			}
			stop()
			return nil
		}
		gatewayConfig.Leases = leases
		gatewayConfig.Admin = admin
		gatewayConfig.Site = &hub.Site{Control: resolver, Hub: workspaces}
		onListening = func(addr *net.TCPAddr) error {
			record.Port = addr.Port
			return writeHubRecord(recordPath, record)
		}
		defer removeHubRecord(recordPath, record.PID)
	}
	runEngines := func(ctx context.Context) {
		done := make(chan struct{})
		go func() { control.Run(ctx); close(done) }()
		ticker := time.NewTicker(time.Second)
		go func() {
			defer ticker.Stop()
			watchLeases(ctx, ticker.C, leases, workspaces.Idle, options.exitIdle, stop)
		}()
		workspaces.Run(ctx)
		<-done
	}
	shutdownEngines := func(ctx context.Context) error {
		controlDone := make(chan error, 1)
		go func() { controlDone <- control.Shutdown(ctx) }()
		return errors.Join(workspaces.Shutdown(ctx), <-controlDone)
	}
	return serveUntilStopped(ctx, stop, options.bind, gateway.New(gatewayConfig, workspaces), tlsConfig, logger, "hub", config.DrainTimeout, runEngines, shutdownEngines, onListening)
}

// hubRecord is how a swamp process finds this hub and proves it may drive it.
type hubRecord struct {
	PID           int    `json:"pid"`
	Port          int    `json:"port"`
	AdminToken    string `json:"adminToken,omitempty"`
	Version       string `json:"version"`
	GitSHA        string `json:"gitSha"`
	Engine        string `json:"engine"`
	EngineVersion string `json:"engineVersion"`
	EngineGitSHA  string `json:"engineGitSha"`
	AutoExit      bool   `json:"autoExit"`
}

// writeHubRecord replaces a previous run's record but never follows a
// symlink planted at the path, and the record is private from the start.
func writeHubRecord(path string, record hubRecord) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.Mode().IsRegular() {
			return fmt.Errorf("refusing hub record path %s: not a regular file", path)
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return err
	}
	temp := fmt.Sprintf("%s.%d.tmp", path, record.PID)
	_ = os.Remove(temp)
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(append(encoded, '\n'))
	if err := errors.Join(writeErr, file.Sync(), file.Close()); err != nil {
		_ = os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		_ = os.Remove(temp)
		return err
	}
	return nil
}

// removeHubRecord leaves a record a newer hub has written in place.
func removeHubRecord(path string, pid int) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return
	}
	var record hubRecord
	if json.Unmarshal(raw, &record) == nil && record.PID == pid {
		_ = os.Remove(path)
	}
}

// watchLeases expires abandoned leases and, for a hub a swamp process
// launched, stops once no lease and no engine has been left for exitIdle.
func watchLeases(ctx context.Context, tick <-chan time.Time, leases *hub.LeaseStore, idle func() bool, exitIdle time.Duration, stop context.CancelFunc) {
	var idleSince time.Time
	for {
		select {
		case <-ctx.Done():
			return
		case now := <-tick:
			leases.Expire()
			if exitIdle <= 0 {
				continue
			}
			if leases.Count() != 0 || !idle() {
				idleSince = time.Time{}
				continue
			}
			if idleSince.IsZero() {
				idleSince = now
			}
			if now.Sub(idleSince) >= exitIdle {
				stop()
				return
			}
		}
	}
}

func writeHubHelp(output io.Writer, flags *flag.FlagSet, jsonMode bool) error {
	if jsonMode {
		type option struct {
			Name        string `json:"name"`
			Description string `json:"description"`
			Default     string `json:"default"`
		}
		options := []option{}
		flags.VisitAll(func(f *flag.Flag) {
			options = append(options, option{Name: "--" + f.Name, Description: f.Usage, Default: f.DefValue})
		})
		return json.NewEncoder(output).Encode(struct {
			Name    string   `json:"name"`
			Profile string   `json:"profile"`
			Usage   string   `json:"usage"`
			Options []option `json:"options"`
		}{"swamp-serve hub", "hub", hubUsage, options})
	}
	var help strings.Builder
	fmt.Fprintf(&help, "Usage: %s\n\nServes every workspace in your registry at /w/<workspace>/, each through its own on-demand engine.\n\nOptions:\n", hubUsage)
	flags.SetOutput(&help)
	flags.PrintDefaults()
	_, err := io.WriteString(output, help.String())
	return err
}
