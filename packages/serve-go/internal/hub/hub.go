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

// Package hub fronts every workspace of one user, each through its own
// on-demand engine. Workspace facts come only from the control engine.
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

// Workspace is a registered repository as the control engine resolved it.
type Workspace struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	Trusted bool   `json:"trusted"`
	// bound came from a page lease, not the registry.
	bound bool
}

// key names a workspace's engine: a lease-bound folder shares one engine with
// every lease bound to it, whatever name each lease gives it.
func (w Workspace) key() string {
	if w.bound {
		return "path:" + w.Path
	}
	return w.Name
}

type Resolver interface {
	Resolve(ctx context.Context, name string) (Workspace, error)
}

var ErrUnknownWorkspace = errors.New("unknown workspace")

type Config struct {
	Engine engine.Config
	// MaxEngines bounds concurrently running engines; zero is unbounded.
	MaxEngines int
	// ResolveTTL reuses a resolution for new connections; zero always resolves.
	ResolveTTL time.Duration
	Starter    func(Workspace) engine.Starter
}

// Mirrors parseWorkspaceName, so a malformed name never reaches the control engine.
var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,62}$`)

// ParseRoute splits /w/<workspace>[/rest]; the prefix is the only routing key
// because server tokens carry no repository identity.
func ParseRoute(path string) (name, rest string, ok bool) {
	trimmed, found := strings.CutPrefix(path, "/w/")
	if !found {
		return "", "", false
	}
	name, rest, _ = strings.Cut(trimmed, "/")
	if !namePattern.MatchString(name) {
		return "", "", false
	}
	return name, "/" + rest, true
}

type workspaceEngine struct {
	*engine.Supervisor
	// id names this engine for the hub overview; a replacement gets a new one.
	id        string
	key       string
	workspace Workspace
	lastUsed  atomic.Int64
}

func (e *workspaceEngine) touch() { e.lastUsed.Store(time.Now().UnixNano()) }

// Open admits a cli caller only to an engine that serves cli: a read-only
// engine is refused before the credential is ever sent.
func (e *workspaceEngine) Open(ctx context.Context, credential, ip string) (*engine.Session, error) {
	e.touch()
	info, err := e.Supervisor.Info(ctx)
	if err != nil {
		return nil, err
	}
	if !info.Serves(engine.ClassCLI) {
		return nil, &gateway.RouteError{Status: 403, Code: "unsupported_profile"}
	}
	return e.Supervisor.Open(ctx, credential, ip)
}

func (e *workspaceEngine) OpenPage(ctx context.Context, ip string, oneShot bool) (*engine.Session, error) {
	e.touch()
	return e.Supervisor.OpenAs(ctx, engine.OpenRequest{Class: engine.ClassPage, SourceIP: ip, OneShot: oneShot})
}

func (e *workspaceEngine) DispatchHTTP(ctx context.Context, session *engine.Session, request []byte) error {
	e.touch()
	return session.DispatchHTTP(ctx, request)
}

func (e *workspaceEngine) Health(ctx context.Context) (json.RawMessage, error) {
	e.touch()
	var snapshot json.RawMessage
	if err := e.Supervisor.Call(ctx, "health.snapshot", struct{}{}, &snapshot); err != nil {
		return nil, err
	}
	return snapshot, nil
}

func (e *workspaceEngine) Dispatch(ctx context.Context, session *engine.Session, request []byte) error {
	e.touch()
	return e.Supervisor.Dispatch(ctx, session, request)
}

type resolution struct {
	workspace Workspace
	at        time.Time
}

type Hub struct {
	config   Config
	resolver Resolver
	mu       sync.Mutex
	engines  map[string]*workspaceEngine
	resolved map[string]resolution
	// Cold starts admitted but not yet visible as running, so concurrent
	// admissions cannot both claim the last engine slot.
	pending  map[string]time.Time
	admitMu  sync.Mutex
	runCtx   context.Context
	loops    sync.WaitGroup
	retiring sync.WaitGroup
	retired  []error
	stopping bool
	serial   uint64
}

func New(config Config, resolver Resolver) *Hub {
	return &Hub{config: config, resolver: resolver, engines: make(map[string]*workspaceEngine), resolved: make(map[string]resolution), pending: make(map[string]time.Time)}
}

func (h *Hub) Route(ctx context.Context, path string) (gateway.Backend, error) {
	name, _, ok := ParseRoute(path)
	if !ok {
		return nil, &gateway.RouteError{Status: 404, Code: "workspace_required"}
	}
	workspace, err := h.resolve(ctx, name)
	if errors.Is(err, ErrUnknownWorkspace) {
		return nil, &gateway.RouteError{Status: 404, Code: "unknown_workspace"}
	}
	if err != nil {
		return nil, err
	}
	// Opening a session can load extension code; that needs the user's trust.
	if !workspace.Trusted {
		return nil, &gateway.RouteError{Status: 403, Code: "workspace_untrusted"}
	}
	return h.admitted(ctx, workspace)
}

func (h *Hub) admitted(ctx context.Context, workspace Workspace) (*workspaceEngine, error) {
	e, err := h.engineFor(workspace)
	if err != nil {
		return nil, err
	}
	if err := h.admit(ctx, e); err != nil {
		return nil, err
	}
	return e, nil
}

func (h *Hub) PageWorkspace(path string) (string, string, bool) { return ParseRoute(path) }

// RoutePage serves a dashboard tab. An untrusted workspace gets an engine that
// loads no extension code, so its built-in reads still work. A lease bound to
// a folder is served from it; the user ran swamp there, so it is trusted.
func (h *Hub) RoutePage(ctx context.Context, lease gateway.Lease, name string) (gateway.PageBackend, error) {
	if path, ok := lease.Bound(name); ok {
		return h.admitted(ctx, Workspace{Name: name, Path: path, Trusted: true, bound: true})
	}
	workspace, err := h.resolve(ctx, name)
	if errors.Is(err, ErrUnknownWorkspace) {
		return nil, &gateway.RouteError{Status: 404, Code: "unknown_workspace"}
	}
	if err != nil {
		return nil, err
	}
	return h.admitted(ctx, workspace)
}

func (h *Hub) resolve(ctx context.Context, name string) (Workspace, error) {
	h.mu.Lock()
	cached, ok := h.resolved[name]
	h.mu.Unlock()
	if ok && h.config.ResolveTTL > 0 && time.Since(cached.at) < h.config.ResolveTTL {
		return cached.workspace, nil
	}
	workspace, err := h.resolver.Resolve(ctx, name)
	if err != nil {
		if errors.Is(err, ErrUnknownWorkspace) {
			h.mu.Lock()
			delete(h.resolved, name)
			h.mu.Unlock()
		}
		return Workspace{}, err
	}
	if workspace.Name != name || workspace.Path == "" {
		return Workspace{}, protocol.ErrFrame
	}
	h.mu.Lock()
	h.resolved[name] = resolution{workspace: workspace, at: time.Now()}
	h.mu.Unlock()
	return workspace, nil
}

func (h *Hub) engineFor(workspace Workspace) (*workspaceEngine, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.stopping {
		return nil, &gateway.RouteError{Status: 503, Code: "draining"}
	}
	key := workspace.key()
	existing := h.engines[key]
	// Trust decides whether extension code may load, so a change needs a new generation.
	if existing != nil && existing.workspace.Path == workspace.Path && existing.workspace.Trusted == workspace.Trusted {
		existing.workspace = workspace
		return existing, nil
	}
	if existing != nil {
		// A workspace re-pointed at another repository: never mix the two
		// behind one name while the old one still serves connections.
		if existing.Activity().Sessions != 0 {
			code := "workspace_moved"
			if existing.workspace.Path == workspace.Path {
				code = "workspace_trust_changed"
			}
			return nil, &gateway.RouteError{Status: 409, Code: code}
		}
		h.retire(existing)
	}
	h.serial++
	e := &workspaceEngine{
		Supervisor: engine.NewSupervisorWith(h.config.Engine, h.config.Starter(workspace), engine.HubHandshake(workspace.Path, workspace.Trusted)),
		id:         "e" + strconv.FormatUint(h.serial, 10),
		key:        key,
		workspace:  workspace,
	}
	e.touch()
	h.engines[key] = e
	if h.runCtx != nil {
		h.startLoop(e)
	}
	return e, nil
}

// retire is called with mu held.
func (h *Hub) retire(e *workspaceEngine) {
	h.retiring.Add(1)
	go func() {
		defer h.retiring.Done()
		ctx, cancel := context.WithTimeout(context.Background(), h.config.Engine.DrainTimeout)
		defer cancel()
		if err := e.Shutdown(ctx); err != nil {
			h.mu.Lock()
			h.retired = append(h.retired, err)
			h.mu.Unlock()
		}
	}()
}

// startLoop is called with mu held.
func (h *Hub) startLoop(e *workspaceEngine) {
	h.loops.Add(1)
	go func() { defer h.loops.Done(); e.Run(h.runCtx) }()
}

// admit keeps running engines within MaxEngines by quiescing the least
// recently used idle engine; an engine with work is never evicted.
func (h *Hub) admit(ctx context.Context, target *workspaceEngine) error {
	if h.config.MaxEngines <= 0 || target.Activity().Running {
		return nil
	}
	h.admitMu.Lock()
	defer h.admitMu.Unlock()
	refused := map[*workspaceEngine]bool{}
	for {
		running, victim := h.capacity(target, refused)
		if running < h.config.MaxEngines {
			h.mu.Lock()
			h.pending[target.key] = time.Now()
			h.mu.Unlock()
			return nil
		}
		if victim == nil {
			return &gateway.RouteError{Status: 503, Code: "hub_engine_limit"}
		}
		if err := victim.QuiesceIdle(ctx); err != nil && ctx.Err() != nil {
			return ctx.Err()
		}
		if victim.Activity().Running {
			refused[victim] = true
		}
	}
}

func (h *Hub) capacity(target *workspaceEngine, refused map[*workspaceEngine]bool) (int, *workspaceEngine) {
	h.mu.Lock()
	defer h.mu.Unlock()
	running := 0
	var victim *workspaceEngine
	for name, e := range h.engines {
		if e == target {
			continue
		}
		activity := e.Activity()
		if started, ok := h.pending[name]; ok {
			if activity.Running || time.Since(started) > h.config.Engine.StartupTimeout {
				delete(h.pending, name)
			} else {
				running++
				continue
			}
		}
		if !activity.Running {
			continue
		}
		running++
		if activity.Sessions == 0 && !refused[e] && (victim == nil || e.lastUsed.Load() < victim.lastUsed.Load()) {
			victim = e
		}
	}
	return running, victim
}

func (h *Hub) Readiness(path string) (int, interface{}, bool) {
	if path == "/ready" || path == "/readyz" {
		h.mu.Lock()
		defer h.mu.Unlock()
		// Workspace names are not disclosed to unauthenticated probes.
		summary := map[string]interface{}{"implementation": "go", "profile": "hub", "protocolVersion": protocol.Version, "ready": !h.stopping}
		counts := map[string]int{}
		for _, e := range h.engines {
			counts[e.Snapshot().State]++
		}
		summary["engines"] = counts
		if h.stopping {
			return 503, summary, true
		}
		return 200, summary, true
	}
	name, rest, ok := ParseRoute(path)
	if !ok || (rest != "/ready" && rest != "/readyz") {
		return 0, nil, false
	}
	h.mu.Lock()
	e := h.engines[name]
	h.mu.Unlock()
	if e == nil {
		return 503, map[string]interface{}{"state": "unloaded", "ready": false}, true
	}
	state := e.Snapshot()
	if state.Ready {
		return 200, state, true
	}
	return 503, state, true
}

// Reset acknowledges one workspace's unconfirmed command cleanup.
func (h *Hub) Reset(name string) error {
	h.mu.Lock()
	e := h.engines[name]
	h.mu.Unlock()
	if e == nil {
		return ErrUnknownWorkspace
	}
	return e.Reset()
}

// EngineInfo is one workspace engine as the hub overview shows it.
type EngineInfo struct {
	ID        string
	Workspace Workspace
	Temporary bool
	Snapshot  engine.Snapshot
	Details   engine.Details
	Running   bool
	LastUsed  time.Time
}

func (h *Hub) Engines() []EngineInfo {
	h.mu.Lock()
	engines := make([]*workspaceEngine, 0, len(h.engines))
	for _, e := range h.engines {
		engines = append(engines, e)
	}
	h.mu.Unlock()
	out := make([]EngineInfo, 0, len(engines))
	for _, e := range engines {
		info := EngineInfo{ID: e.id, Workspace: e.workspace, Temporary: e.workspace.bound, Snapshot: e.Snapshot(), Details: e.Details(), Running: e.Activity().Running}
		if used := e.lastUsed.Load(); used != 0 {
			info.LastUsed = time.Unix(0, used)
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Workspace.Name < out[j].Workspace.Name })
	return out
}

// StartWorkspace starts a workspace's engine without opening a page; it then
// stays up for the page idle grace.
func (h *Hub) StartWorkspace(ctx context.Context, workspace Workspace) error {
	e, err := h.admitted(ctx, workspace)
	if err != nil {
		return err
	}
	if err := e.Validate(ctx); err != nil {
		return err
	}
	e.Linger()
	return nil
}

// Retrusted forgets a workspace's cached lookup and retires its untrusted
// engine, so its tabs reconnect to one that loads extensions.
func (h *Hub) Retrusted(name string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.resolved, name)
	if e := h.engines[name]; e != nil && !e.workspace.Trusted {
		delete(h.engines, name)
		delete(h.pending, name)
		h.retire(e)
	}
}

// StopEngine retires one engine now, closing its sessions; the next request
// for its workspace starts a new generation.
func (h *Hub) StopEngine(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	for key, e := range h.engines {
		if e.id != id {
			continue
		}
		delete(h.engines, key)
		delete(h.pending, key)
		h.retire(e)
		return true
	}
	return false
}

// Idle reports no engine running or starting, so nothing would be lost if
// the hub stopped.
func (h *Hub) Idle() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.pending) != 0 {
		for key, started := range h.pending {
			e := h.engines[key]
			if e != nil && !e.Activity().Running && time.Since(started) <= h.config.Engine.StartupTimeout {
				return false
			}
		}
	}
	for _, e := range h.engines {
		if activity := e.Activity(); activity.Running || activity.Sessions != 0 {
			return false
		}
	}
	return true
}

// Run drives every engine's idle clock until ctx ends.
func (h *Hub) Run(ctx context.Context) {
	h.mu.Lock()
	h.runCtx = ctx
	for _, e := range h.engines {
		h.startLoop(e)
	}
	h.mu.Unlock()
	<-ctx.Done()
	h.loops.Wait()
}

func (h *Hub) Shutdown(ctx context.Context) error {
	h.mu.Lock()
	h.stopping = true
	engines := make([]*workspaceEngine, 0, len(h.engines))
	for _, e := range h.engines {
		engines = append(engines, e)
	}
	h.mu.Unlock()
	errs := make(chan error, len(engines))
	for _, e := range engines {
		go func() { errs <- e.Shutdown(ctx) }()
	}
	var result error
	for range engines {
		result = errors.Join(result, <-errs)
	}
	h.retiring.Wait()
	h.mu.Lock()
	result = errors.Join(append([]error{result}, h.retired...)...)
	h.mu.Unlock()
	return result
}
