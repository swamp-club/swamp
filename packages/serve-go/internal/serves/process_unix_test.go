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

//go:build linux || darwin

package serves

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

// TestHelperProcess is the stand-in `swamp serve` the real-process test runs.
func TestHelperProcess(t *testing.T) {
	if os.Getenv("SERVES_HELPER") == "" {
		return
	}
	if os.Getenv("SERVES_HELPER") == "ignore" {
		signal.Ignore(syscall.SIGTERM)
	} else {
		terms := make(chan os.Signal, 1)
		signal.Notify(terms, syscall.SIGTERM)
		go func() { <-terms; os.Exit(0) }()
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		os.Exit(3)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	fmt.Printf("{\"status\":\"listening\",\"host\":\"127.0.0.1\",\"port\":%d,\"url\":\"ws://127.0.0.1:%d\"}\n", port, port)
	_ = http.Serve(listener, http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(200) }))
	os.Exit(4)
}

func helperExecutable(t *testing.T) string {
	t.Helper()
	script := filepath.Join(t.TempDir(), "swamp")
	body := fmt.Sprintf("#!/bin/sh\nexec %q -test.run='^TestHelperProcess$' -- \"$@\"\n", os.Args[0])
	if err := os.WriteFile(script, []byte(body), 0o700); err != nil {
		t.Fatal(err)
	}
	return script
}

func TestRealServeIsStoppedBySIGTERMOrKilledWhenItIgnoresIt(t *testing.T) {
	for _, mode := range []string{"term", "ignore"} {
		t.Run(mode, func(t *testing.T) {
			t.Setenv("SERVES_HELPER", mode)
			m := NewManager(helperExecutable(t), t.TempDir())
			// A race-instrumented helper can take a while to exit after SIGTERM.
			m.StopTimeout = 10 * time.Second
			if mode == "ignore" {
				m.StopTimeout = 300 * time.Millisecond
			}
			info, err := m.Start("demo", t.TempDir(), 0)
			if err != nil {
				t.Fatal(err)
			}
			waitFor(t, "running", func() bool { return stateOf(m, info.ID) == StateRunning })
			if err := m.Stop(info.ID); err != nil {
				t.Fatal(err)
			}
			waitFor(t, "exited", func() bool { return stateOf(m, info.ID) == StateExited })
			got, _ := m.Get(info.ID)
			want := 0
			if mode == "ignore" {
				want = -1
			}
			if got.ExitCode == nil || *got.ExitCode != want {
				if got.ExitCode != nil {
					t.Fatalf("exit code: %d, want %d", *got.ExitCode, want)
				}
				t.Fatalf("exit code: %v, want %d", got.ExitCode, want)
			}
			if syscall.Kill(info.PID, 0) == nil {
				t.Fatal("the serve process is still alive")
			}
		})
	}
}
