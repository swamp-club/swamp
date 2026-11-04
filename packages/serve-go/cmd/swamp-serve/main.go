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
	"crypto/tls"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/commandguardian"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

var version = "dev"
var gitSHA = "unknown"

func main() {
	if len(os.Args) > 1 && os.Args[1] == commandguardian.Mode {
		os.Exit(commandguardian.Run(os.Args[2:], os.Stdin, os.Stdout, os.Stderr))
	}
	runner := run
	args := os.Args[1:]
	if len(args) > 0 && args[0] == "hub" {
		runner, args = runHub, args[1:]
	}
	if err := runner(args, os.Stdout, os.Stderr); err != nil {
		os.Exit(1)
	}
}
func run(args []string, stdout, stderr io.Writer) (result error) {
	flags := flag.NewFlagSet("swamp-serve", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	config := engine.DefaultConfig()
	repo := flags.String("repo", "", "Local swamp repository (required)")
	executable := flags.String("engine", "", "Explicit installed swamp executable path (required)")
	bind := flags.String("bind", "127.0.0.1:9876", "HTTP listen address; non-loopback requires TLS")
	certPath := flags.String("tls-cert", "", "PEM certificate path, relative to launch directory")
	keyPath := flags.String("tls-key", "", "PEM private key path, relative to launch directory")
	flags.StringVar(repo, "repo-dir", "", "Alias for --repo")
	flags.StringVar(certPath, "cert-file", "", "Alias for --tls-cert; relative to launch directory")
	flags.StringVar(keyPath, "key-file", "", "Alias for --tls-key; relative to launch directory")
	trusted := flags.String("trusted-hosts", "", "Comma-separated external hostnames")
	jsonMode := flags.Bool("json", false, "JSON operational output")
	showVersion := flags.Bool("version", false, "Print server version")
	flags.DurationVar(&config.StartupTimeout, "startup-timeout", config.StartupTimeout, "Engine startup deadline")
	flags.DurationVar(&config.IdleTimeout, "idle-timeout", config.IdleTimeout, "Engine idle grace (e.g. 60s); connected sessions keep it running; zero disables engine shutdown")
	flags.DurationVar(&config.DrainTimeout, "drain-timeout", config.DrainTimeout, "Shutdown deadline")
	flags.Var(legacyDrainDuration{&config.DrainTimeout}, "shutdown-drain-timeout", "Alias for --drain-timeout; positive seconds or Go duration (e.g. 30, 30s, 5m)")
	flags.DurationVar(&config.ControlTimeout, "control-timeout", config.ControlTimeout, "Private control request deadline")
	flags.DurationVar(&config.Cooldown, "startup-cooldown", config.Cooldown, "Delay before restarting a failed generation")
	requestedJSON := jsonRequested(flags, args)
	defer func() {
		if result != nil {
			writeError(stderr, result, requestedJSON)
		}
	}()
	if err := flags.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return writeHelp(stdout, flags, requestedJSON)
		}
		return err
	}
	requestedJSON = *jsonMode
	if flags.NArg() != 0 {
		return fmt.Errorf("unexpected positional argument %q; use --help for experimental local-v1 options", flags.Arg(0))
	}
	if *showVersion {
		if *jsonMode {
			return json.NewEncoder(stdout).Encode(map[string]string{"version": version, "gitSha": gitSHA, "profile": "local-v1"})
		}
		_, err := fmt.Fprintf(stdout, "swamp-serve %s (%s)\n", version, gitSHA)
		return err
	}
	if *repo == "" || *executable == "" {
		return errors.New("--repo and --engine are required; use --help for experimental local-v1 options")
	}
	if config.StartupTimeout <= 0 || config.ControlTimeout <= 0 || config.DrainTimeout <= 0 || config.Cooldown <= 0 || config.IdleTimeout < 0 {
		return errors.New("timeouts must be positive; only --idle-timeout accepts zero")
	}
	maxDrainMs := servecontract.MaxShutdownDeadlineMilliseconds()
	if config.DrainTimeout > time.Duration(maxDrainMs)*time.Millisecond {
		return fmt.Errorf("--drain-timeout and --shutdown-drain-timeout must not exceed %dms (the engine's safe timer range, about 24.8 days)", maxDrainMs)
	}
	if (*certPath == "") != (*keyPath == "") {
		return errors.New("--tls-cert and --tls-key must be provided together")
	}
	host, err := validateBind(*bind, *certPath != "")
	if err != nil {
		return err
	}
	*repo, err = resolvePath(*repo)
	if err != nil {
		return fmt.Errorf("invalid repository path: %w", err)
	}
	*executable, err = resolvePath(*executable)
	if err != nil {
		return fmt.Errorf("invalid engine path: %w", err)
	}
	if info, err := os.Stat(*repo); err != nil || !info.IsDir() {
		return errors.New("--repo must select an existing directory")
	}
	var handler slog.Handler = slog.NewTextHandler(stdout, nil)
	if *jsonMode {
		handler = slog.NewJSONHandler(stdout, nil)
	}
	logger := slog.New(handler)
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	supervisor := engine.NewSupervisor(config, engine.ExecStarter(*executable, *repo, config.DrainTimeout))
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), config.DrainTimeout)
		defer cancel()
		_ = supervisor.Shutdown(ctx)
	}()
	startup, cancelStartup := context.WithTimeout(ctx, config.StartupTimeout)
	err = supervisor.Validate(startup)
	cancelStartup()
	if err != nil {
		return startupError(err)
	}
	tlsConfig, err := loadTLS(*certPath, *keyPath)
	if err != nil {
		return err
	}
	gatewayConfig := gateway.Config{Host: host, TLS: tlsConfig != nil, TrustedHosts: parseHosts(*trusted), AuthTimeout: config.StartupTimeout + config.ControlTimeout, ControlTimeout: config.ControlTimeout, WriteTimeout: 10 * time.Second}
	return serveUntilStopped(ctx, stop, *bind, gateway.New(gatewayConfig, gateway.Single(supervisor)), tlsConfig, logger, "local-v1", config.DrainTimeout, supervisor.Run, supervisor.Shutdown)
}

func loadTLS(certPath, keyPath string) (*tls.Config, error) {
	if certPath == "" {
		return nil, nil
	}
	certPath, err := resolvePath(certPath)
	if err != nil {
		return nil, err
	}
	keyPath, err = resolvePath(keyPath)
	if err != nil {
		return nil, err
	}
	certificate, err := tls.LoadX509KeyPair(certPath, keyPath)
	if err != nil {
		return nil, fmt.Errorf("invalid TLS certificate/key: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}, nil
}

func parseHosts(trusted string) []string {
	var hosts []string
	for _, h := range strings.Split(trusted, ",") {
		if h = strings.TrimSpace(h); h != "" {
			hosts = append(hosts, h)
		}
	}
	return hosts
}

// serveUntilStopped listens, runs the engine clocks, and on a signal or
// listener failure drains HTTP and engines under one shutdown deadline.
func serveUntilStopped(ctx context.Context, stop context.CancelFunc, bind string, publicGateway *gateway.Gateway, tlsConfig *tls.Config, logger *slog.Logger, profile string, drainTimeout time.Duration, runEngines func(context.Context), shutdownEngines func(context.Context) error) error {
	server := newHTTPServer(bind, publicGateway, tlsConfig, logger)
	listener, err := net.Listen("tcp", bind)
	if err != nil {
		return err
	}
	listener = gateway.LimitListener(listener, 256)
	if tlsConfig != nil {
		listener = tls.NewListener(listener, tlsConfig)
	}
	loopDone := make(chan struct{})
	go func() { runEngines(ctx); close(loopDone) }()
	serveDone := make(chan error, 1)
	go func() { serveDone <- server.Serve(listener) }()
	// net.Listen("tcp") supplies a TCPAddr, preserved by both listener wrappers.
	logListening(logger, listener.Addr().(*net.TCPAddr), tlsConfig != nil, profile)
	select {
	case <-ctx.Done():
	case err = <-serveDone:
		if !errors.Is(err, http.ErrServerClosed) {
			// Unexpected listener failures use the same bounded drain as signals.
			break
		}
		err = nil
	}
	stop()
	drain, cancelDrain := context.WithTimeout(context.Background(), drainTimeout)
	defer cancelDrain()
	publicGateway.Shutdown()
	// Drain HTTP and engine admission together. A slow authentication control
	// or status poll must not delay starting the process shutdown deadline.
	engineDone := make(chan error, 1)
	go func() { engineDone <- shutdownEngines(drain) }()
	httpErr := server.Shutdown(drain)
	engineErr := <-engineDone
	<-loopDone
	logger.Info("stopped")
	return errors.Join(err, httpErr, engineErr)
}

func newHTTPServer(address string, handler http.Handler, tlsConfig *tls.Config, logger *slog.Logger) *http.Server {
	return &http.Server{
		Addr: address, Handler: handler, TLSConfig: tlsConfig,
		ReadHeaderTimeout: 5 * time.Second,
		// Bound unread request bodies too: net/http drains them after handlers
		// return. Hijacking a WebSocket clears the HTTP connection deadlines.
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 10 * time.Second,
		IdleTimeout:  30 * time.Second, MaxHeaderBytes: 16 << 10,
		ErrorLog: slog.NewLogLogger(logger.Handler(), slog.LevelWarn),
	}
}

type legacyDrainDuration struct{ value *time.Duration }

func (d legacyDrainDuration) String() string {
	if d.value == nil {
		return "0s"
	}
	return d.value.String()
}

func (d legacyDrainDuration) Set(raw string) error {
	value := strings.TrimSpace(raw)
	if _, err := strconv.ParseInt(value, 10, 64); err == nil {
		value += "s"
	}
	duration, err := time.ParseDuration(value)
	if err != nil {
		return err
	}
	*d.value = duration
	return nil
}

func startupError(err error) error {
	if errors.Is(err, engine.ErrUnavailable) || errors.Is(err, protocol.ErrVersion) || errors.Is(err, protocol.ErrFrame) {
		return errors.New("engine handshake failed before listening; select a compatible swamp executable with --engine")
	}
	return fmt.Errorf("engine validation failed: %w", err)
}

func logListening(logger *slog.Logger, address *net.TCPAddr, tlsEnabled bool, profile string) {
	scheme := "ws"
	if tlsEnabled {
		scheme = "wss"
	}
	host := address.IP.String()
	if address.Zone != "" {
		host += "%" + address.Zone
	}
	connectionURL := (&url.URL{Scheme: scheme, Host: address.String()}).String()
	logger.Info("listening", "status", "listening", "host", host, "port", address.Port,
		"url", connectionURL, "address", address.String(),
		"implementation", "go", "profile", profile, "version", version)
}

func validateBind(address string, tlsEnabled bool) (string, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return "", errors.New("--bind must be host:port")
	}
	// Match existing serve's explicit loopback allowlist. Hostname resolution
	// and trusted Host headers cannot establish transport confidentiality.
	loopback := host == "127.0.0.1" || host == "localhost" || host == "::1"
	if !loopback && !tlsEnabled {
		return "", errors.New("Off-loopback binding requires TLS: provide --tls-cert and --tls-key, or bind to 127.0.0.1")
	}
	return host, nil
}

// Determine the requested output mode even if parsing stops at an earlier bad
// flag. Respect value-taking options and the end-of-options boundary.
func jsonRequested(flags *flag.FlagSet, args []string) bool {
	requested := false
	for index := 0; index < len(args); index++ {
		arg := args[index]
		if arg == "--" || arg == "-" || !strings.HasPrefix(arg, "-") {
			break
		}
		name, value, hasValue := strings.Cut(strings.TrimPrefix(strings.TrimPrefix(arg, "-"), "-"), "=")
		if name == "json" {
			if !hasValue {
				requested = true
			} else if parsed, err := strconv.ParseBool(value); err == nil {
				requested = parsed
			}
			continue
		}
		option := flags.Lookup(name)
		if option == nil || hasValue {
			continue
		}
		boolean, ok := option.Value.(interface{ IsBoolFlag() bool })
		if !ok || !boolean.IsBoolFlag() {
			index++
		}
	}
	return requested
}

func writeError(output io.Writer, err error, jsonMode bool) {
	if jsonMode {
		failure := map[string]string{"error": err.Error()}
		var engineError *protocol.Error
		if errors.As(err, &engineError) && engineError.Code != "" {
			failure["code"] = engineError.Code
		}
		_ = json.NewEncoder(output).Encode(failure)
		return
	}
	_, _ = fmt.Fprintln(output, err)
}

func writeHelp(output io.Writer, flags *flag.FlagSet, jsonMode bool) error {
	const usage = "swamp-serve --repo <directory> --engine <executable> [options]"
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
		}{"swamp-serve", "local-v1", usage, options})
	}
	var help strings.Builder
	fmt.Fprintf(&help, "Usage: %s\n\nExperimental local-v1 server options:\n", usage)
	flags.SetOutput(&help)
	flags.PrintDefaults()
	_, err := io.WriteString(output, help.String())
	return err
}

func resolvePath(path string) (string, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return filepath.EvalSymlinks(absolute)
}
