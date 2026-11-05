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

package serves

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// fakeProcess stands in for a serve: it exits when terminated (unless it
// ignores that) or killed, or when the test makes it.
type fakeProcess struct {
	pid        int
	ignoreTerm bool
	terms      atomic.Int32
	kills      atomic.Int32
	once       sync.Once
	exit       chan int
}

func (p *fakeProcess) Pid() int { return p.pid }
func (p *fakeProcess) Terminate() error {
	p.terms.Add(1)
	if !p.ignoreTerm {
		p.finish(0)
	}
	return nil
}
func (p *fakeProcess) Kill() error {
	p.kills.Add(1)
	p.finish(137)
	return nil
}
func (p *fakeProcess) finish(code int)    { p.once.Do(func() { p.exit <- code }) }
func (p *fakeProcess) Wait() (int, error) { return <-p.exit, nil }

type fakeStarts struct {
	mu        sync.Mutex
	argv      [][]string
	processes []*fakeProcess
	// line is what the fake writes to stdout; empty writes nothing.
	line       string
	ignoreTerm bool
}

func (f *fakeStarts) start(argv []string, _ string, stdout, _ io.Writer) (Process, error) {
	f.mu.Lock()
	p := &fakeProcess{pid: 1000 + len(f.processes), ignoreTerm: f.ignoreTerm, exit: make(chan int, 1)}
	f.argv = append(f.argv, argv)
	f.processes = append(f.processes, p)
	line := f.line
	f.mu.Unlock()
	if line != "" {
		// Split across writes, as a pipe may deliver it.
		half := len(line) / 2
		_, _ = stdout.Write([]byte("starting up\n" + line[:half]))
		_, _ = stdout.Write([]byte(line[half:] + "\n"))
	}
	return p, nil
}

func (f *fakeStarts) last() *fakeProcess {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.processes[len(f.processes)-1]
}

func readyServer(t *testing.T, ready *atomic.Bool) int {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ready" && ready.Load() {
			w.WriteHeader(200)
			return
		}
		w.WriteHeader(503)
	}))
	t.Cleanup(server.Close)
	return server.Listener.Addr().(*net.TCPAddr).Port
}

func manager(t *testing.T, starts *fakeStarts) *Manager {
	t.Helper()
	m := NewManager("/opt/swamp", t.TempDir())
	m.start = starts.start
	m.StopTimeout = 200 * time.Millisecond
	m.ReadyTimeout = 2 * time.Second
	return m
}

func waitFor(t *testing.T, what string, check func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !check() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func stateOf(m *Manager, id string) string {
	info, _ := m.Get(id)
	return info.State
}

func TestServeStartsListensAndBecomesRunningOnlyOnceReady(t *testing.T) {
	var ready atomic.Bool
	port := readyServer(t, &ready)
	starts := &fakeStarts{line: fmt.Sprintf(`{"status":"listening","host":"127.0.0.1","port":%d,"url":"ws://127.0.0.1:%d"}`, port, port)}
	m := manager(t, starts)
	info, err := m.Start("demo", "/repos/demo", 0)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(starts.argv[0], " "); got != "/opt/swamp serve --repo-dir /repos/demo --port 0 --dashboard --json" {
		t.Fatalf("argv: %s", got)
	}
	if info.State != StateStarting || info.PID != 1000 || m.Count() != 1 {
		t.Fatalf("started: %+v", info)
	}
	waitFor(t, "the port", func() bool { i, _ := m.Get(info.ID); return i.Port == port })
	if stateOf(m, info.ID) != StateStarting {
		t.Fatal("running before /ready answered")
	}
	ready.Store(true)
	waitFor(t, "running", func() bool { return stateOf(m, info.ID) == StateRunning })
	if i, _ := m.Get(info.ID); i.URL != fmt.Sprintf("http://127.0.0.1:%d", port) {
		t.Fatalf("url: %s", i.URL)
	}
	if _, err := m.Start("demo", "/repos/demo", 9190); err != ErrRunning {
		t.Fatalf("second start: %v", err)
	}
	log, _ := os.ReadFile(info.LogPath)
	if !strings.Contains(string(log), `"status":"listening"`) {
		t.Fatalf("log: %q", log)
	}

	if err := m.Stop(info.ID); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "exited", func() bool { return stateOf(m, info.ID) == StateExited })
	if i, _ := m.Get(info.ID); i.ExitCode == nil || *i.ExitCode != 0 || starts.last().kills.Load() != 0 || m.Count() != 0 {
		t.Fatalf("stopped: %+v kills=%d", i, starts.last().kills.Load())
	}
	if err := m.Stop(info.ID); err != ErrUnknown {
		t.Fatalf("stop twice: %v", err)
	}
	next, err := m.Start("demo", "/repos/demo", 0)
	if err != nil || next.ID == info.ID || len(m.List()) != 1 {
		t.Fatalf("restart: %+v %v, %d listed", next, err, len(m.List()))
	}
}

func TestServeThatIgnoresTerminationIsKilledAfterTheStopTimeout(t *testing.T) {
	var ready atomic.Bool
	ready.Store(true)
	port := readyServer(t, &ready)
	starts := &fakeStarts{ignoreTerm: true, line: fmt.Sprintf(`{"status":"listening","host":"0.0.0.0","port":%d,"url":"ws://0.0.0.0:%d"}`, port, port)}
	m := manager(t, starts)
	info, _ := m.Start("demo", "/repos/demo", 0)
	waitFor(t, "running", func() bool { return stateOf(m, info.ID) == StateRunning })
	_ = m.Stop(info.ID)
	waitFor(t, "killed", func() bool { return stateOf(m, info.ID) == StateExited })
	if p := starts.last(); p.terms.Load() != 1 || p.kills.Load() != 1 {
		t.Fatalf("terms=%d kills=%d", p.terms.Load(), p.kills.Load())
	}
}

func TestServeThatNeverListensOrExitsEarlyFails(t *testing.T) {
	starts := &fakeStarts{}
	m := manager(t, starts)
	m.ReadyTimeout = 100 * time.Millisecond
	silent, _ := m.Start("silent", "/repos/silent", 0)
	waitFor(t, "failed", func() bool { return stateOf(m, silent.ID) == StateFailed })
	if i, _ := m.Get(silent.ID); !strings.Contains(i.Reason, "listening") || starts.last().terms.Load() != 1 {
		t.Fatalf("silent: %+v", i)
	}

	m.ReadyTimeout = 5 * time.Second
	early, _ := m.Start("early", "/repos/early", 0)
	starts.last().finish(1)
	waitFor(t, "failed", func() bool { return stateOf(m, early.ID) == StateFailed })
	if i, _ := m.Get(early.ID); i.ExitCode == nil || *i.ExitCode != 1 || !strings.Contains(i.Reason, "exited before") {
		t.Fatalf("early: %+v", i)
	}
}

func TestShutdownStopsEveryServeAndRefusesNewOnes(t *testing.T) {
	var ready atomic.Bool
	ready.Store(true)
	port := readyServer(t, &ready)
	starts := &fakeStarts{line: fmt.Sprintf(`{"status":"listening","host":"127.0.0.1","port":%d,"url":"ws://127.0.0.1:%d"}`, port, port)}
	m := manager(t, starts)
	a, _ := m.Start("a", "/repos/a", 0)
	starts.ignoreTerm = true
	b, _ := m.Start("b", "/repos/b", 0)
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	if err := m.Shutdown(ctx); err == nil || !strings.Contains(err.Error(), "b was killed") {
		t.Fatalf("shutdown: %v", err)
	}
	if stateOf(m, a.ID) != StateExited || stateOf(m, b.ID) != StateExited || m.Count() != 0 {
		t.Fatalf("after shutdown: %+v", m.List())
	}
	if _, err := m.Start("c", "/repos/c", 0); err != ErrDraining {
		t.Fatalf("start while draining: %v", err)
	}
}

func TestParseListeningMapsWildcardHostsAndTLS(t *testing.T) {
	at, ok := parseListening([]byte(`{"status":"listening","host":"0.0.0.0","port":9443,"url":"wss://0.0.0.0:9443"}`))
	if !ok || !at.tls || at.probeHost != "127.0.0.1" || at.url != "https://127.0.0.1:9443" {
		t.Fatalf("tls wildcard: %+v %v", at, ok)
	}
	for _, line := range []string{`{"status":"stopping"}`, `not json`, `{"status":"listening","port":0}`} {
		if _, ok := parseListening([]byte(line)); ok {
			t.Fatalf("parsed %s", line)
		}
	}
}
