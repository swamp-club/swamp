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
	"os"
	"os/signal"
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
	if config.StartupTimeout <= 0 || config.ControlTimeout <= 0 || config.DrainTimeout <= 0 || config.Cooldown <= 0 || config.IdleTimeout < 0 || options.controlIdle < 0 || options.resolveTTL < 0 {
		return errors.New("timeouts must be positive; only idle timeouts and --resolve-ttl accept zero")
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
	var handler slog.Handler = slog.NewTextHandler(stdout, nil)
	if options.jsonMode {
		handler = slog.NewJSONHandler(stdout, nil)
	}
	logger := slog.New(handler)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	controlConfig := config
	controlConfig.IdleTimeout = options.controlIdle
	control := engine.NewSupervisorWith(controlConfig, engine.ControlStarter(executable, config.DrainTimeout), hub.ControlHandshake)
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
	workspaces := hub.New(hub.Config{
		Engine:     config,
		MaxEngines: options.maxEngines,
		ResolveTTL: options.resolveTTL,
		Starter: func(workspace hub.Workspace) engine.Starter {
			return engine.ExecStarter(executable, workspace.Path, config.DrainTimeout)
		},
	}, hub.ControlResolver{Control: control})
	gatewayConfig := gateway.Config{Host: host, TLS: tlsConfig != nil, TrustedHosts: parseHosts(options.trusted), AuthTimeout: 2*config.StartupTimeout + config.ControlTimeout, ControlTimeout: config.ControlTimeout, WriteTimeout: 10 * time.Second, Profile: "hub"}
	runEngines := func(ctx context.Context) {
		done := make(chan struct{})
		go func() { control.Run(ctx); close(done) }()
		workspaces.Run(ctx)
		<-done
	}
	shutdownEngines := func(ctx context.Context) error {
		controlDone := make(chan error, 1)
		go func() { controlDone <- control.Shutdown(ctx) }()
		return errors.Join(workspaces.Shutdown(ctx), <-controlDone)
	}
	return serveUntilStopped(ctx, stop, options.bind, gateway.New(gatewayConfig, workspaces), tlsConfig, logger, "hub", config.DrainTimeout, runEngines, shutdownEngines)
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
