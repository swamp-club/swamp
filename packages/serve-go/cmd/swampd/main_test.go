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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/hub"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

func TestDrainTimeoutAcceptsLongSafeBudgetsAndRejectsOverflow(t *testing.T) {
	maximum := servecontract.MaxShutdownDeadlineMilliseconds()
	for _, test := range []struct {
		flag, value, want string
	}{
		{"--drain-timeout", "10m", "Off-loopback binding requires TLS"},
		{"--shutdown-drain-timeout", "600", "Off-loopback binding requires TLS"},
		{"--drain-timeout", fmt.Sprintf("%dms", maximum), "Off-loopback binding requires TLS"},
		{"--drain-timeout", fmt.Sprintf("%dms", maximum+1), "must not exceed"},
		{"--shutdown-drain-timeout", "2147484", "must not exceed"},
	} {
		t.Run(test.flag+"="+test.value, func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			// Binding validation follows timeout validation but precedes process startup.
			err := run([]string{"--repo", "/repo", "--engine", "/engine", test.flag, test.value, "--bind", "0.0.0.0:0", "--json"}, &stdout, &stderr)
			if err == nil || !strings.Contains(err.Error(), test.want) || stdout.Len() != 0 {
				t.Fatalf("unexpected drain validation: error=%v stdout=%s", err, &stdout)
			}
			var failure map[string]string
			if err := json.Unmarshal(stderr.Bytes(), &failure); err != nil || failure["error"] == "" {
				t.Fatalf("drain validation did not produce JSON: %s", &stderr)
			}
		})
	}
}

func TestArgumentErrorsHonorJSONRegardlessOfFlagOrder(t *testing.T) {
	for _, args := range [][]string{
		{"--json", "--idle-timeout", "invalid"},
		{"--idle-timeout", "invalid", "--json"},
		{"--idle-timeout=invalid", "--json=true"},
		{"--shutdown-drain-timeout", "invalid", "--json"},
		{"--json", "--unknown"},
		{"--unknown", "--json"},
		{"--json", "--repo"},
		{"--json", "--repo", "/repo", "--engine", "/engine", "--drain-timeout=0"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			err := run(args, &stdout, &stderr)
			if err == nil || stdout.Len() != 0 {
				t.Fatalf("invalid invocation succeeded or wrote stdout: %v %s", err, &stdout)
			}
			var failure map[string]string
			if decodeErr := json.Unmarshal(stderr.Bytes(), &failure); decodeErr != nil {
				t.Fatalf("argument error was not a single JSON value: %s", &stderr)
			}
			if failure["error"] != err.Error() || len(failure) != 1 {
				t.Fatalf("argument error did not use the flat CLI schema: %#v", failure)
			}
		})
	}
}

func TestOutputModeRespectsFalseValuesAndArgumentBoundaries(t *testing.T) {
	for _, args := range [][]string{
		{"--json=false", "--idle-timeout", "invalid"},
		{"--idle-timeout", "invalid", "--json=false"},
		{"--json", "--json=false", "--unknown"},
		{"--", "--json"},
		{"--idle-timeout", "invalid", "--", "--json"},
		{"--repo", "--json", "--unknown"},
		{"--repo-dir", "--json", "--unknown"},
		{"--cert-file", "--json", "--unknown"},
		{"--key-file", "--json", "--unknown"},
		{"--shutdown-drain-timeout", "--json", "--unknown"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			err := run(args, &stdout, &stderr)
			if err == nil || stdout.Len() != 0 || stderr.String() != err.Error()+"\n" {
				t.Fatalf("output mode crossed an argument boundary: err=%v stdout=%s stderr=%s", err, &stdout, &stderr)
			}
		})
	}
}

func TestUnexpectedPositionalsAreDiagnosedSeparately(t *testing.T) {
	for _, args := range [][]string{
		{"--repo", "/repo", "--engine", "/engine", "extra"},
		{"--json", "--repo", "/repo", "--engine", "/engine", "extra"},
		{"--json", "--", "extra"},
	} {
		t.Run(strings.Join(args, " "), func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			err := run(args, &stdout, &stderr)
			if err == nil || !strings.Contains(err.Error(), `unexpected positional argument "extra"`) || strings.Contains(err.Error(), "are required") {
				t.Fatalf("misleading positional diagnosis: %v", err)
			}
		})
	}
}

func TestJSONErrorPreservesWrappedEngineCode(t *testing.T) {
	for _, test := range []struct {
		name string
		err  error
		code string
	}{
		{"engine refusal", fmt.Errorf("engine validation failed: %w", &protocol.Error{Code: "unsupported_profile", Message: "Remote datastore is unsupported"}), "unsupported_profile"},
		{"ordinary failure", errors.New("listener unavailable"), ""},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var output bytes.Buffer
			writeError(&output, test.err, true)
			var failure map[string]string
			if err := json.Unmarshal(output.Bytes(), &failure); err != nil {
				t.Fatal(err)
			}
			if failure["error"] != test.err.Error() || failure["code"] != test.code {
				t.Fatalf("lost error message or code: %#v", failure)
			}
			if test.code == "" && len(failure) != 1 || test.code != "" && len(failure) != 2 {
				t.Fatalf("unexpected CLI error schema: %#v", failure)
			}
		})
	}
}

func TestHelpAndVersionSupportHumanAndJSONOutput(t *testing.T) {
	for _, test := range []struct {
		name string
		args []string
		json bool
		help bool
	}{
		{"human help", []string{"--help"}, false, true},
		{"short human help", []string{"-h"}, false, true},
		{"JSON help", []string{"--json", "--help"}, true, true},
		{"JSON after help", []string{"--help", "--json"}, true, true},
		{"human version", []string{"--version"}, false, false},
		{"JSON version", []string{"--version", "--json"}, true, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			var stdout, stderr bytes.Buffer
			if err := run(test.args, &stdout, &stderr); err != nil || stderr.Len() != 0 {
				t.Fatalf("help/version failed: %v %s", err, &stderr)
			}
			if test.json {
				var value map[string]json.RawMessage
				if err := json.Unmarshal(stdout.Bytes(), &value); err != nil {
					t.Fatal(err)
				}
				if string(value["profile"]) != `"local-v1"` {
					t.Fatalf("profile missing: %s", &stdout)
				}
				if test.help {
					if !strings.Contains(string(value["options"]), `"name":"--repo"`) || !strings.Contains(string(value["options"]), `"name":"--engine"`) {
						t.Fatalf("required flags missing from help: %s", &stdout)
					}
				} else if string(value["version"]) != fmt.Sprintf("%q", version) || string(value["gitSha"]) != fmt.Sprintf("%q", gitSHA) {
					t.Fatalf("version fields changed: %s", &stdout)
				}
			} else if test.help {
				if !strings.Contains(stdout.String(), "Usage: swampd") || !strings.Contains(stdout.String(), "--repo") || !strings.Contains(stdout.String(), "--engine") {
					t.Fatalf("human help missing usage: %s", &stdout)
				}
			} else if stdout.String() != fmt.Sprintf("swampd %s (%s)\n", version, gitSHA) {
				t.Fatalf("human version changed: %s", &stdout)
			}
		})
	}
}

func TestBindRequiresTLSOutsideLegacyLoopbackAllowlist(t *testing.T) {
	for _, address := range []string{"127.0.0.1:9876", "localhost:9876", "[::1]:9876"} {
		if _, err := validateBind(address, false); err != nil {
			t.Fatalf("loopback rejected: %s: %v", address, err)
		}
	}
	for _, address := range []string{"0.0.0.0:9876", ":9876", "[::]:9876", "server.example:9876", "192.0.2.1:9876", "127.0.0.2:9876"} {
		if _, err := validateBind(address, false); err == nil || !strings.Contains(err.Error(), "Off-loopback binding requires TLS") {
			t.Fatalf("plaintext external listener accepted: %s: %v", address, err)
		}
		if _, err := validateBind(address, true); err != nil {
			t.Fatalf("TLS external listener rejected: %s: %v", address, err)
		}
	}
	if _, err := validateBind("127.0.0.1", false); err == nil || err.Error() != "--bind must be host:port" {
		t.Fatalf("malformed address accepted: %v", err)
	}
}

func TestExternalPlaintextRefusalPrecedesRepositoryOrEngineAccess(t *testing.T) {
	for _, jsonMode := range []bool{false, true} {
		args := []string{"--repo", "unresolved-repository", "--engine", "unresolved-engine", "--bind", "0.0.0.0:0", "--trusted-hosts", "server.example"}
		if jsonMode {
			args = append(args, "--json")
		}
		var stdout, stderr bytes.Buffer
		err := run(args, &stdout, &stderr)
		if err == nil || !strings.Contains(err.Error(), "Off-loopback binding requires TLS") || stdout.Len() != 0 {
			t.Fatalf("external plaintext reached filesystem/startup: err=%v stdout=%s", err, &stdout)
		}
		if jsonMode {
			var failure map[string]string
			if json.Unmarshal(stderr.Bytes(), &failure) != nil || failure["error"] != err.Error() {
				t.Fatalf("TLS refusal did not honor JSON mode: %s", &stderr)
			}
		}
	}
}

func TestEstablishedServeAliasesUseExistingConfiguration(t *testing.T) {
	for _, test := range []struct {
		args []string
		want string
	}{
		{[]string{"--repo-dir", "repo", "--engine", "engine", "--bind", "0.0.0.0:0"}, "Off-loopback binding requires TLS"},
		{[]string{"--repo", "repo", "--engine", "engine", "--cert-file", "cert"}, "--tls-cert and --tls-key must be provided together"},
		{[]string{"--repo", "repo", "--engine", "engine", "--key-file", "key"}, "--tls-cert and --tls-key must be provided together"},
		{[]string{"--repo", "repo", "--engine", "engine", "--shutdown-drain-timeout", "0"}, "timeouts must be positive"},
		{[]string{"--repo", "repo", "--engine", "engine", "--drain-timeout", "0s", "--shutdown-drain-timeout", "30", "--bind", "0.0.0.0:0"}, "Off-loopback binding requires TLS"},
		{[]string{"--repo", "repo", "--engine", "engine", "--shutdown-drain-timeout", "30", "--drain-timeout", "0s"}, "timeouts must be positive"},
	} {
		t.Run(strings.Join(test.args, " "), func(t *testing.T) {
			var stdout, stderr bytes.Buffer
			err := run(test.args, &stdout, &stderr)
			if err == nil || !strings.Contains(err.Error(), test.want) {
				t.Fatalf("alias did not populate the existing setting: %v", err)
			}
		})
	}
	var stdout, stderr bytes.Buffer
	if err := run([]string{"--json", "--help"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	for _, alias := range []string{"repo-dir", "cert-file", "key-file", "shutdown-drain-timeout"} {
		if !strings.Contains(stdout.String(), `"name":"--`+alias+`"`) {
			t.Fatalf("alias missing from help: %s", alias)
		}
	}
}

func TestLegacyDrainAliasAcceptsBareSecondsAndDurationUnits(t *testing.T) {
	for _, test := range []struct {
		text string
		want time.Duration
	}{
		{"30", 30 * time.Second},
		{"30s", 30 * time.Second},
		{"5m", 5 * time.Minute},
		{"0", 0},
	} {
		var value time.Duration
		if err := (legacyDrainDuration{&value}).Set(test.text); err != nil || value != test.want {
			t.Fatalf("duration %q: value=%s error=%v", test.text, value, err)
		}
	}
}

func TestStartupHandshakeFailureHasCompatibleEngineGuidance(t *testing.T) {
	for _, cause := range []error{engine.ErrUnavailable, fmt.Errorf("wrapped: %w", engine.ErrUnavailable), protocol.ErrVersion, protocol.ErrFrame} {
		err := startupError(cause)
		if !strings.Contains(err.Error(), "before listening") || !strings.Contains(err.Error(), "compatible swamp executable with --engine") || strings.Contains(err.Error(), "interrupted") || strings.Contains(err.Error(), "admitted") {
			t.Fatalf("misleading startup diagnosis: %v", err)
		}
		var output bytes.Buffer
		writeError(&output, err, true)
		var failure map[string]string
		if json.Unmarshal(output.Bytes(), &failure) != nil || failure["error"] != err.Error() {
			t.Fatalf("handshake error lost JSON shape: %s", &output)
		}
	}
	refusal := &protocol.Error{Code: "unsupported_profile", Message: "Remote datastore is unsupported"}
	var failure *protocol.Error
	if !errors.As(startupError(refusal), &failure) || failure.Code != refusal.Code {
		t.Fatal("specific startup refusal code was lost")
	}
}

func TestListeningOutputIncludesConnectionURLAndExistingFields(t *testing.T) {
	for _, test := range []struct {
		address *net.TCPAddr
		tls     bool
		url     string
	}{
		{&net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 9876}, false, "ws://127.0.0.1:9876"},
		{&net.TCPAddr{IP: net.ParseIP("::1"), Port: 4567}, true, "wss://[::1]:4567"},
		{&net.TCPAddr{IP: net.ParseIP("fe80::1"), Zone: "eth0", Port: 4567}, true, "wss://[fe80::1%25eth0]:4567"},
	} {
		var output bytes.Buffer
		logListening(slog.New(slog.NewJSONHandler(&output, nil)), test.address, test.tls, "local-v1")
		var value struct {
			Status         string `json:"status"`
			Host           string `json:"host"`
			Port           int    `json:"port"`
			URL            string `json:"url"`
			Address        string `json:"address"`
			Implementation string `json:"implementation"`
			Profile        string `json:"profile"`
		}
		if err := json.Unmarshal(output.Bytes(), &value); err != nil {
			t.Fatal(err)
		}
		if value.Status != "listening" || value.Host == "" || value.Port != test.address.Port || value.URL != test.url || value.Address != test.address.String() || value.Implementation != "go" || value.Profile != "local-v1" {
			t.Fatalf("startup connection fields missing or invalid: %s", &output)
		}
		output.Reset()
		logListening(slog.New(slog.NewTextHandler(&output, nil)), test.address, test.tls, "local-v1")
		if !strings.Contains(output.String(), test.url) {
			t.Fatalf("human startup omitted connection URL: %s", &output)
		}
	}
}

func TestHubRecordIsPrivateReplacedRemovedOnlyByItsOwnerAndNeverFollowsASymlink(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "hub.json")
	if err := writeHubRecord(path, hubRecord{PID: 1, Port: 1000, AdminToken: "first"}); err != nil {
		t.Fatal(err)
	}
	if err := writeHubRecord(path, hubRecord{PID: 2, Port: 2000, AdminToken: "second", AutoExit: true}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(path)
	var record hubRecord
	if err != nil || json.Unmarshal(data, &record) != nil || record.AdminToken != "second" || record.Port != 2000 || !record.AutoExit {
		t.Fatalf("record %q %v", data, err)
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
	removeHubRecord(path, 1)
	if _, err := os.Stat(path); err != nil {
		t.Fatal("a previous hub removed its successor's record")
	}
	removeHubRecord(path, 2)
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("owner left its record: %v", err)
	}
	if runtime.GOOS != "windows" {
		if err := writeHubRecord(path, hubRecord{PID: 3}); err != nil {
			t.Fatal(err)
		}
		info, _ := os.Stat(path)
		if info.Mode().Perm() != 0o600 {
			t.Fatalf("record mode %v", info.Mode().Perm())
		}
		target := filepath.Join(dir, "target")
		link := filepath.Join(dir, "link")
		if err := os.WriteFile(target, []byte("keep"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if err := writeHubRecord(link, hubRecord{PID: 4, AdminToken: "secret"}); err == nil {
			t.Fatal("followed a symlinked record path")
		}
		if kept, _ := os.ReadFile(target); string(kept) != "keep" {
			t.Fatal("symlink target overwritten")
		}
	}
}

func TestAutoLaunchedHubStopsOnlyAfterNoLeaseAndNoEngineForTheGrace(t *testing.T) {
	leases := hub.NewLeaseStore(0)
	lease, _, _ := leases.Issue(hub.LeaseScope{All: true})
	var idle atomic.Bool
	idle.Store(true)
	tick := make(chan time.Time)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var stopped atomic.Bool
	done := make(chan struct{})
	go func() {
		watchLeases(ctx, tick, leases, idle.Load, time.Minute, func() { stopped.Store(true) })
		close(done)
	}()
	// Each tick is handled while the test moves on, so every gap after a
	// change stays under the grace whichever side of it the tick saw.
	start := time.Unix(1000, 0)
	tick <- start
	tick <- start.Add(30 * time.Second)
	leases.Revoke(lease.ID)
	tick <- start.Add(60 * time.Second)
	idle.Store(false)
	tick <- start.Add(80 * time.Second)
	tick <- start.Add(85 * time.Second)
	idle.Store(true)
	tick <- start.Add(100 * time.Second)
	tick <- start.Add(110 * time.Second)
	if stopped.Load() {
		t.Fatal("stopped before the grace passed")
	}
	tick <- start.Add(200 * time.Second)
	<-done
	if !stopped.Load() {
		t.Fatal("never stopped once idle for the grace")
	}
}
