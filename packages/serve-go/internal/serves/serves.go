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

// Package serves supervises the `swamp serve` processes the hub starts, one
// per workspace. They are plain children: no engine protocol, only a log, a
// listening line on stdout and serve's own /ready.
package serves

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	StateStarting = "starting"
	StateRunning  = "running"
	StateStopping = "stopping"
	StateExited   = "exited"
	StateFailed   = "failed"
)

var (
	ErrRunning  = errors.New("a swamp serve is already running for this workspace")
	ErrUnknown  = errors.New("no such swamp serve")
	ErrDraining = errors.New("the hub is stopping")
)

// Process is a started serve. Signals reach its whole process group until
// Wait has reaped it, and never after.
type Process interface {
	Pid() int
	Terminate() error
	Kill() error
	// Wait blocks until exit, stops what is left of the group, then reaps.
	Wait() (exitCode int, err error)
}

type Starter func(argv []string, dir string, stdout, stderr io.Writer) (Process, error)

// Info is one serve as the hub overview shows it.
type Info struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	Path      string    `json:"path"`
	PID       int       `json:"pid,omitempty"`
	Port      int       `json:"port,omitempty"`
	URL       string    `json:"url,omitempty"`
	State     string    `json:"state"`
	ExitCode  *int      `json:"exitCode,omitempty"`
	Reason    string    `json:"reason,omitempty"`
	StartedAt time.Time `json:"startedAt"`
	LogPath   string    `json:"logPath"`
}

type serve struct {
	info    Info
	process Process
	exited  chan struct{}
}

func (s *serve) live() bool {
	return s.info.State == StateStarting || s.info.State == StateRunning || s.info.State == StateStopping
}

// Manager starts, stops and lists the hub's serves.
type Manager struct {
	Executable string
	LogDir     string
	// StopTimeout covers serve's own drain and cleanup before the group is killed.
	StopTimeout  time.Duration
	ReadyTimeout time.Duration
	start        Starter
	client       *http.Client
	mu           sync.Mutex
	serves       map[string]*serve
	serial       uint64
	draining     bool
}

func NewManager(executable, logDir string) *Manager {
	return NewManagerWith(executable, logDir, startProcess)
}

// NewManagerWith starts serves through start, so tests need no processes.
func NewManagerWith(executable, logDir string, start Starter) *Manager {
	return &Manager{Executable: executable, LogDir: logDir, StopTimeout: 60 * time.Second, ReadyTimeout: 60 * time.Second, start: start, client: &http.Client{Timeout: 2 * time.Second}, serves: map[string]*serve{}}
}

// Start runs `swamp serve` for one workspace; port 0 lets the OS choose.
func (m *Manager) Start(name, path string, port int) (Info, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.draining {
		return Info{}, ErrDraining
	}
	for _, s := range m.serves {
		if s.info.Name == name && s.live() {
			return Info{}, ErrRunning
		}
	}
	if err := os.MkdirAll(m.LogDir, 0o700); err != nil {
		return Info{}, err
	}
	logPath := filepath.Join(m.LogDir, filepath.Base(name)+".log")
	logFile, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o600)
	if err != nil {
		return Info{}, err
	}
	watcher := &listenWatcher{out: logFile, listening: make(chan listening, 1)}
	argv := []string{m.Executable, "serve", "--repo-dir", path, "--port", strconv.Itoa(port), "--dashboard", "--json"}
	p, err := m.start(argv, path, watcher, logFile)
	if err != nil {
		logFile.Close()
		return Info{}, err
	}
	m.serial++
	s := &serve{process: p, exited: make(chan struct{}), info: Info{ID: "s" + strconv.FormatUint(m.serial, 10), Name: name, Path: path, PID: p.Pid(), State: StateStarting, StartedAt: time.Now(), LogPath: logPath}}
	// One serve per workspace is remembered: a new start replaces the last one's record.
	for id, old := range m.serves {
		if old.info.Name == name {
			delete(m.serves, id)
		}
	}
	m.serves[s.info.ID] = s
	go func() {
		code, _ := p.Wait()
		logFile.Close()
		m.mu.Lock()
		s.info.ExitCode = &code
		if s.info.State != StateFailed {
			s.info.State = StateExited
		}
		m.mu.Unlock()
		close(s.exited)
	}()
	go m.watchStart(s, watcher.listening)
	return s.info, nil
}

func (m *Manager) set(s *serve, update func(*Info)) {
	m.mu.Lock()
	defer m.mu.Unlock()
	update(&s.info)
}

// watchStart waits for serve's listening line, then for /ready, and fails a
// serve that does neither in time.
func (m *Manager) watchStart(s *serve, listen <-chan listening) {
	deadline := time.NewTimer(m.ReadyTimeout)
	defer deadline.Stop()
	var at listening
	select {
	case at = <-listen:
	case <-s.exited:
		m.set(s, func(i *Info) { i.State, i.Reason = StateFailed, "swamp serve exited before it listened; see its log" })
		return
	case <-deadline.C:
		m.fail(s, "swamp serve did not start listening in time")
		return
	}
	m.set(s, func(i *Info) { i.Port, i.URL = at.port, at.url })
	for {
		if m.ready(at) {
			m.set(s, func(i *Info) {
				if i.State == StateStarting {
					i.State = StateRunning
				}
			})
			return
		}
		select {
		case <-s.exited:
			m.set(s, func(i *Info) { i.State, i.Reason = StateFailed, "swamp serve exited before it was ready; see its log" })
			return
		case <-deadline.C:
			m.fail(s, "swamp serve was not ready in time")
			return
		case <-time.After(250 * time.Millisecond):
		}
	}
}

func (m *Manager) fail(s *serve, reason string) {
	m.set(s, func(i *Info) { i.State, i.Reason = StateFailed, reason })
	m.stopProcess(s)
}

// ready probes serve's /ready; a TLS serve counts once it accepts connections.
func (m *Manager) ready(at listening) bool {
	address := net.JoinHostPort(at.probeHost, strconv.Itoa(at.port))
	if at.tls {
		conn, err := net.DialTimeout("tcp", address, time.Second)
		if err != nil {
			return false
		}
		conn.Close()
		return true
	}
	response, err := m.client.Get("http://" + address + "/ready")
	if err != nil {
		return false
	}
	response.Body.Close()
	return response.StatusCode == http.StatusOK
}

// Stop asks a serve to shut down and kills its group if it has not exited
// within StopTimeout. It returns once the request is made.
func (m *Manager) Stop(id string) error {
	m.mu.Lock()
	s := m.serves[id]
	if s == nil || !s.live() {
		m.mu.Unlock()
		return ErrUnknown
	}
	s.info.State = StateStopping
	m.mu.Unlock()
	go m.stopProcess(s)
	return nil
}

func (m *Manager) stopProcess(s *serve) {
	_ = s.process.Terminate()
	select {
	case <-s.exited:
	case <-time.After(m.StopTimeout):
		_ = s.process.Kill()
	}
}

// Shutdown stops every serve, as the hub stops, killing what outlives ctx.
func (m *Manager) Shutdown(ctx context.Context) error {
	m.mu.Lock()
	m.draining = true
	var live []*serve
	for _, s := range m.serves {
		if s.live() {
			s.info.State = StateStopping
			live = append(live, s)
		}
	}
	m.mu.Unlock()
	for _, s := range live {
		_ = s.process.Terminate()
	}
	var err error
	for _, s := range live {
		select {
		case <-s.exited:
		case <-ctx.Done():
			_ = s.process.Kill()
			<-s.exited
			err = errors.Join(err, errors.New("swamp serve "+s.info.Name+" was killed at hub shutdown"))
		}
	}
	return err
}

func (m *Manager) List() []Info {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Info, 0, len(m.serves))
	for _, s := range m.serves {
		out = append(out, s.info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (m *Manager) Get(id string) (Info, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.serves[id]
	if s == nil {
		return Info{}, false
	}
	return s.info, true
}

// Count is the serves that keep an auto-launched hub from idling out.
func (m *Manager) Count() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	count := 0
	for _, s := range m.serves {
		if s.live() {
			count++
		}
	}
	return count
}

type listening struct {
	port      int
	url       string
	probeHost string
	tls       bool
}

// listenWatcher copies serve's stdout to its log and reports the first
// `{"status":"listening"}` line, the only place the bound port appears.
type listenWatcher struct {
	out       io.Writer
	listening chan listening
	partial   []byte
	found     bool
}

func (w *listenWatcher) Write(data []byte) (int, error) {
	if !w.found {
		w.partial = append(w.partial, data...)
		for {
			line, rest, ok := bytes.Cut(w.partial, []byte("\n"))
			if !ok {
				break
			}
			w.partial = rest
			if at, ok := parseListening(line); ok {
				w.found = true
				w.partial = nil
				w.listening <- at
				break
			}
		}
		if len(w.partial) > 64<<10 {
			w.partial = nil
		}
	}
	return w.out.Write(data)
}

func parseListening(line []byte) (listening, bool) {
	var event struct {
		Status string `json:"status"`
		Host   string `json:"host"`
		Port   int    `json:"port"`
		URL    string `json:"url"`
	}
	if json.Unmarshal(bytes.TrimSpace(line), &event) != nil || event.Status != "listening" || event.Port < 1 || event.Port > 65535 {
		return listening{}, false
	}
	tls := strings.HasPrefix(event.URL, "wss://")
	host := event.Host
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	scheme := "http"
	if tls {
		scheme = "https"
	}
	return listening{port: event.Port, url: scheme + "://" + net.JoinHostPort(host, strconv.Itoa(event.Port)), probeHost: host, tls: tls}, true
}
