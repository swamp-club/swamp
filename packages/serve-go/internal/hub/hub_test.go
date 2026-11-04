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

package hub

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type pipeEngine struct {
	inR  *io.PipeReader
	inW  *io.PipeWriter
	outR *io.PipeReader
	outW *io.PipeWriter
	done chan struct{}
	once sync.Once
}

func (p *pipeEngine) Input() io.WriteCloser { return p.inW }
func (p *pipeEngine) Output() io.ReadCloser { return p.outR }
func (p *pipeEngine) Wait() error           { <-p.done; return nil }
func (p *pipeEngine) Kill() error {
	p.once.Do(func() { p.inR.Close(); p.inW.Close(); p.outW.Close(); close(p.done) })
	return nil
}

// fakeEngine answers like a local-v1 engine bound to repo; busy reports a run.
func fakeEngine(repo string, busy *atomic.Bool) *pipeEngine {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &pipeEngine{inR: inR, inW: inW, outR: outR, outW: outW, done: make(chan struct{})}
	go func() {
		defer p.Kill()
		for {
			e, err := protocol.Read(inR)
			if err != nil {
				return
			}
			var result interface{} = struct{}{}
			finish := false
			switch e.Method {
			case "hello":
				result = map[string]interface{}{"version": 1, "profile": "local-v1", "callerSessionIds": true, "authenticationDeadlines": true, "operations": servecontract.Operations(), "repo": map[string]string{"path": repo}}
			case "session.open":
				var params struct {
					SessionID string `json:"sessionId"`
				}
				_ = json.Unmarshal(e.Params, &params)
				result = map[string]string{"sessionId": params.SessionID}
			case "engine.status":
				runs := 0
				if busy != nil && busy.Load() {
					runs = 1
				}
				result = engine.Status{State: "ready", Runs: runs}
			case "engine.quiesce":
				quiescent := busy == nil || !busy.Load()
				result = map[string]bool{"quiescent": quiescent}
				finish = quiescent
			case "engine.shutdown":
				finish = true
			}
			raw, _ := json.Marshal(result)
			frame, _ := protocol.Encode(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Result: raw})
			_ = protocol.Write(outW, frame)
			if finish {
				return
			}
		}
	}()
	return p
}

type mapResolver struct {
	mu         sync.Mutex
	workspaces map[string]Workspace
	calls      atomic.Int32
	err        error
}

func (r *mapResolver) Resolve(_ context.Context, name string) (Workspace, error) {
	r.calls.Add(1)
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.err != nil {
		return Workspace{}, r.err
	}
	w, ok := r.workspaces[name]
	if !ok {
		return Workspace{}, ErrUnknownWorkspace
	}
	return w, nil
}
func (r *mapResolver) set(w Workspace) {
	r.mu.Lock()
	r.workspaces[w.Name] = w
	r.mu.Unlock()
}

type harness struct {
	hub      *Hub
	resolver *mapResolver
	starts   sync.Map // path -> *atomic.Int32
	busy     sync.Map // path -> *atomic.Bool
	boundTo  func(Workspace) string
}

func newHarness(t *testing.T, maxEngines int, workspaces ...Workspace) *harness {
	t.Helper()
	h := &harness{resolver: &mapResolver{workspaces: map[string]Workspace{}}, boundTo: func(w Workspace) string { return w.Path }}
	for _, w := range workspaces {
		h.resolver.set(w)
	}
	config := engine.DefaultConfig()
	config.IdleTimeout = 0
	h.hub = New(Config{Engine: config, MaxEngines: maxEngines, Starter: func(w Workspace) engine.Starter {
		return func(context.Context) (engine.Process, error) {
			counter, _ := h.starts.LoadOrStore(w.Path, &atomic.Int32{})
			counter.(*atomic.Int32).Add(1)
			busy, _ := h.busy.LoadOrStore(w.Path, &atomic.Bool{})
			return fakeEngine(h.boundTo(w), busy.(*atomic.Bool)), nil
		}
	}}, h.resolver)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = h.hub.Shutdown(ctx)
	})
	return h
}
func (h *harness) startCount(path string) int32 {
	counter, ok := h.starts.Load(path)
	if !ok {
		return 0
	}
	return counter.(*atomic.Int32).Load()
}
func (h *harness) setBusy(path string, busy bool) {
	value, _ := h.busy.LoadOrStore(path, &atomic.Bool{})
	value.(*atomic.Bool).Store(busy)
}

func testContext(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func routeError(t *testing.T, err error) *gateway.RouteError {
	t.Helper()
	var refusal *gateway.RouteError
	if !errors.As(err, &refusal) {
		t.Fatalf("expected route refusal, got %v", err)
	}
	return refusal
}

func open(t *testing.T, h *Hub, path string) (gateway.Backend, *engine.Session) {
	t.Helper()
	ctx := testContext(t)
	backend, err := h.Route(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	session, err := backend.Open(ctx, "token", "127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	return backend, session
}

func TestParseRouteRequiresWellFormedWorkspacePrefix(t *testing.T) {
	cases := []struct {
		path, name, rest string
		ok               bool
	}{
		{"/w/alpha", "alpha", "/", true},
		{"/w/alpha/", "alpha", "/", true},
		{"/w/alpha/api/v1/request", "alpha", "/api/v1/request", true},
		{"/w/9-lives/x", "9-lives", "/x", true},
		{"/", "", "", false},
		{"/w/", "", "", false},
		{"/w/Alpha", "", "", false},
		{"/w/-alpha", "", "", false},
		{"/w/al_pha", "", "", false},
		{"/workspace/alpha", "", "", false},
		{"/w/" + string(make([]byte, 64)), "", "", false},
	}
	for _, c := range cases {
		name, rest, ok := ParseRoute(c.path)
		if ok != c.ok || name != c.name || rest != c.rest {
			t.Errorf("ParseRoute(%q) = %q %q %v; want %q %q %v", c.path, name, rest, ok, c.name, c.rest, c.ok)
		}
	}
}

func TestRouteRefusesBeforeStartingAnyEngine(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "untrusted", Path: "/repos/untrusted"})
	ctx := testContext(t)
	if refusal := routeError(t, routeErr(h.hub.Route(ctx, "/"))); refusal.Status != 404 || refusal.Code != "workspace_required" {
		t.Fatalf("missing prefix: %+v", refusal)
	}
	if refusal := routeError(t, routeErr(h.hub.Route(ctx, "/w/missing"))); refusal.Status != 404 || refusal.Code != "unknown_workspace" {
		t.Fatalf("unknown workspace: %+v", refusal)
	}
	if refusal := routeError(t, routeErr(h.hub.Route(ctx, "/w/untrusted"))); refusal.Status != 403 || refusal.Code != "workspace_untrusted" {
		t.Fatalf("untrusted workspace: %+v", refusal)
	}
	if h.startCount("/repos/untrusted") != 0 {
		t.Fatal("a refused route started an engine")
	}
	h.resolver.err = errors.New("control engine down")
	if _, err := h.hub.Route(ctx, "/w/untrusted"); err == nil || errors.As(err, new(*gateway.RouteError)) {
		t.Fatalf("resolver failure must stay an availability error, got %v", err)
	}
}

func routeErr(_ gateway.Backend, err error) error { return err }

func TestEachWorkspaceGetsItsOwnEngine(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true}, Workspace{Name: "beta", Path: "/repos/beta", Trusted: true})
	a1, s1 := open(t, h.hub, "/w/alpha")
	a2, s2 := open(t, h.hub, "/w/alpha/other")
	b, s3 := open(t, h.hub, "/w/beta")
	if a1 != a2 {
		t.Fatal("one workspace must reuse one engine")
	}
	if a1 == b {
		t.Fatal("workspaces must not share an engine")
	}
	if h.startCount("/repos/alpha") != 1 || h.startCount("/repos/beta") != 1 {
		t.Fatalf("starts: alpha=%d beta=%d", h.startCount("/repos/alpha"), h.startCount("/repos/beta"))
	}
	ctx := testContext(t)
	for _, pair := range []struct {
		backend gateway.Backend
		session *engine.Session
	}{{a1, s1}, {a2, s2}, {b, s3}} {
		if err := pair.backend.Close(ctx, pair.session); err != nil {
			t.Fatal(err)
		}
	}
}

func TestEngineBoundToAnotherRepositoryIsRefused(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true})
	h.boundTo = func(Workspace) string { return "/repos/elsewhere" }
	ctx := testContext(t)
	backend, err := h.hub.Route(ctx, "/w/alpha")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := backend.Open(ctx, "token", "127.0.0.1"); !errors.Is(err, engine.ErrRepositoryMismatch) {
		t.Fatalf("expected repository mismatch, got %v", err)
	}
}

func TestEngineLimitEvictsLeastRecentlyUsedIdleEngine(t *testing.T) {
	h := newHarness(t, 2,
		Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true},
		Workspace{Name: "beta", Path: "/repos/beta", Trusted: true},
		Workspace{Name: "gamma", Path: "/repos/gamma", Trusted: true})
	ctx := testContext(t)
	for _, name := range []string{"alpha", "beta"} {
		backend, session := open(t, h.hub, "/w/"+name)
		if err := backend.Close(ctx, session); err != nil {
			t.Fatal(err)
		}
		time.Sleep(time.Millisecond) // distinct last-use stamps
	}
	gamma, session := open(t, h.hub, "/w/gamma")
	defer gamma.Close(ctx, session)
	h.hub.mu.Lock()
	alpha, beta := h.hub.engines["alpha"].Activity(), h.hub.engines["beta"].Activity()
	h.hub.mu.Unlock()
	if alpha.Running || !beta.Running {
		t.Fatalf("expected the least recently used engine evicted: alpha=%+v beta=%+v", alpha, beta)
	}
}

func TestEngineLimitNeverEvictsConnectedOrBusyEngines(t *testing.T) {
	h := newHarness(t, 2,
		Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true},
		Workspace{Name: "beta", Path: "/repos/beta", Trusted: true},
		Workspace{Name: "gamma", Path: "/repos/gamma", Trusted: true})
	ctx := testContext(t)
	alpha, alphaSession := open(t, h.hub, "/w/alpha")
	defer alpha.Close(ctx, alphaSession)
	beta, betaSession := open(t, h.hub, "/w/beta")
	h.setBusy("/repos/beta", true)
	if err := beta.Close(ctx, betaSession); err != nil {
		t.Fatal(err)
	}
	refusal := routeError(t, routeErr(h.hub.Route(ctx, "/w/gamma")))
	if refusal.Status != 503 || refusal.Code != "hub_engine_limit" {
		t.Fatalf("expected engine limit, got %+v", refusal)
	}
	if h.startCount("/repos/gamma") != 0 {
		t.Fatal("refused admission started an engine")
	}
	h.setBusy("/repos/beta", false)
	gamma, gammaSession := open(t, h.hub, "/w/gamma")
	if err := gamma.Close(ctx, gammaSession); err != nil {
		t.Fatal(err)
	}
}

func TestMovedWorkspaceRetiresOldEngineOnlyWhenDisconnected(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/one", Trusted: true})
	ctx := testContext(t)
	first, session := open(t, h.hub, "/w/alpha")
	h.resolver.set(Workspace{Name: "alpha", Path: "/repos/two", Trusted: true})
	refusal := routeError(t, routeErr(h.hub.Route(ctx, "/w/alpha")))
	if refusal.Status != 409 || refusal.Code != "workspace_moved" {
		t.Fatalf("expected workspace_moved, got %+v", refusal)
	}
	if err := first.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	second, session := open(t, h.hub, "/w/alpha")
	defer second.Close(ctx, session)
	if first == second || h.startCount("/repos/two") != 1 {
		t.Fatal("expected a new engine for the new repository")
	}
}

func TestResolutionIsCachedWithinTTL(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true})
	h.hub.config.ResolveTTL = time.Minute
	ctx := testContext(t)
	for i := 0; i < 3; i++ {
		if _, err := h.hub.Route(ctx, "/w/alpha"); err != nil {
			t.Fatal(err)
		}
	}
	if calls := h.resolver.calls.Load(); calls != 1 {
		t.Fatalf("expected one resolution, got %d", calls)
	}
}

func TestReadinessNeverStartsEnginesOrDisclosesNames(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true})
	status, body, ok := h.hub.Readiness("/ready")
	raw, _ := json.Marshal(body)
	if !ok || status != 200 {
		t.Fatalf("aggregate readiness: %d %s", status, raw)
	}
	if strings.Contains(string(raw), "alpha") {
		t.Fatalf("aggregate readiness discloses workspace names: %s", raw)
	}
	status, body, ok = h.hub.Readiness("/w/alpha/ready")
	if !ok || status != 503 || body.(map[string]interface{})["state"] != "unloaded" {
		t.Fatalf("unloaded workspace readiness: %d %v", status, body)
	}
	if _, _, ok := h.hub.Readiness("/w/alpha/other"); ok {
		t.Fatal("only readiness paths are answered")
	}
	if h.startCount("/repos/alpha") != 0 || h.resolver.calls.Load() != 0 {
		t.Fatal("readiness woke the control or a workspace engine")
	}
}

func TestShutdownRefusesNewRoutes(t *testing.T) {
	h := newHarness(t, 0, Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true})
	ctx := testContext(t)
	backend, session := open(t, h.hub, "/w/alpha")
	if err := backend.Close(ctx, session); err != nil {
		t.Fatal(err)
	}
	if err := h.hub.Shutdown(ctx); err != nil {
		t.Fatal(err)
	}
	if refusal := routeError(t, routeErr(h.hub.Route(ctx, "/w/alpha"))); refusal.Code != "draining" {
		t.Fatalf("expected draining, got %+v", refusal)
	}
}

func controlProcess(profile string, controls []string, resolve func(name string) (interface{}, *protocol.Error)) *pipeEngine {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &pipeEngine{inR: inR, inW: inW, outR: outR, outW: outW, done: make(chan struct{})}
	go func() {
		defer p.Kill()
		for {
			e, err := protocol.Read(inR)
			if err != nil {
				return
			}
			envelope := protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID}
			switch e.Method {
			case "hello":
				envelope.Result, _ = json.Marshal(map[string]interface{}{"version": 1, "profile": profile, "controls": controls})
			case "workspace.resolve":
				var params struct {
					Name string `json:"name"`
				}
				_ = json.Unmarshal(e.Params, &params)
				result, failure := resolve(params.Name)
				if failure != nil {
					envelope.Error = failure
				} else {
					envelope.Result, _ = json.Marshal(result)
				}
			default:
				envelope.Result = json.RawMessage(`{}`)
			}
			frame, _ := protocol.Encode(envelope)
			_ = protocol.Write(outW, frame)
			if e.Method == "engine.shutdown" {
				return
			}
		}
	}()
	return p
}

func TestControlResolverUsesControlEngine(t *testing.T) {
	profile, controls := servecontract.HubControl()
	control := engine.NewSupervisorWith(engine.DefaultConfig(), func(context.Context) (engine.Process, error) {
		return controlProcess(profile, controls, func(name string) (interface{}, *protocol.Error) {
			if name == "alpha" {
				return Workspace{Name: "alpha", Path: "/repos/alpha", Trusted: true}, nil
			}
			return nil, &protocol.Error{Code: "unknown_workspace", Message: "Unknown workspace"}
		}), nil
	}, ControlHandshake)
	ctx := testContext(t)
	defer control.Shutdown(ctx)
	resolver := ControlResolver{Control: control}
	workspace, err := resolver.Resolve(ctx, "alpha")
	if err != nil || workspace.Path != "/repos/alpha" || !workspace.Trusted {
		t.Fatalf("resolve: %+v %v", workspace, err)
	}
	if _, err := resolver.Resolve(ctx, "missing"); !errors.Is(err, ErrUnknownWorkspace) {
		t.Fatalf("expected unknown workspace, got %v", err)
	}
}

func TestControlHandshakeRequiresProfileAndControls(t *testing.T) {
	profile, controls := servecontract.HubControl()
	for _, c := range []struct {
		name     string
		profile  string
		controls []string
	}{
		{"wrong profile", "local-v1", controls},
		{"missing control", profile, controls[:1]},
	} {
		t.Run(c.name, func(t *testing.T) {
			config := engine.DefaultConfig()
			control := engine.NewSupervisorWith(config, func(context.Context) (engine.Process, error) {
				return controlProcess(c.profile, c.controls, nil), nil
			}, ControlHandshake)
			ctx := testContext(t)
			defer control.Shutdown(ctx)
			if err := control.Validate(ctx); !errors.Is(err, protocol.ErrVersion) {
				t.Fatalf("expected incompatible control engine, got %v", err)
			}
		})
	}
}
