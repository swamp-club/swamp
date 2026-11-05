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
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type fakeSiteControl struct {
	files   map[string]AssetChunk
	calls   sync.Map // path -> *atomic.Int32
	list    []Workspace
	trusted []string
	chunk   int
}

func (c *fakeSiteControl) List(context.Context) ([]Workspace, error) { return c.list, nil }

func (c *fakeSiteControl) Trust(_ context.Context, name string) (Workspace, error) {
	c.trusted = append(c.trusted, name)
	for _, w := range c.list {
		if w.Name == name {
			w.Trusted = true
			return w, nil
		}
	}
	return Workspace{}, ErrUnknownWorkspace
}

func (c *fakeSiteControl) AssetChunk(_ context.Context, path string, offset int64) (AssetChunk, error) {
	counter, _ := c.calls.LoadOrStore(path, &atomic.Int32{})
	counter.(*atomic.Int32).Add(1)
	if path == "../secret" {
		return AssetChunk{}, &protocol.Error{Code: "unknown_asset"}
	}
	if path == "missing-bundle" {
		return AssetChunk{}, &protocol.Error{Code: "assets_unavailable"}
	}
	file, ok := c.files[path]
	if !ok {
		file = c.files["index.html"]
	}
	end := min(int64(len(file.Data)), offset+int64(c.chunk))
	return AssetChunk{ContentType: file.ContentType, CacheControl: file.CacheControl, Size: int64(len(file.Data)), Offset: offset, Data: file.Data[offset:end], Done: end == int64(len(file.Data))}, nil
}

func (c *fakeSiteControl) callCount(path string) int32 {
	counter, ok := c.calls.Load(path)
	if !ok {
		return 0
	}
	return counter.(*atomic.Int32).Load()
}

// newSiteHarness is a page harness whose gateway also serves the site routes.
func newSiteHarness(t *testing.T, control *fakeSiteControl, workspaces ...Workspace) *pageHarness {
	t.Helper()
	p := &pageHarness{harness: newHarness(t, 0, workspaces...), leases: NewLeaseStore(0)}
	p.admin = NewAdmin("admin-secret", p.leases)
	site := &Site{Control: control, Hub: p.hub, Leases: p.leases}
	p.site = site
	p.gateway = gateway.New(gateway.Config{Host: "127.0.0.1", AuthTimeout: 10 * time.Second, ControlTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, Profile: "hub", Leases: p.leases, Admin: p.admin, Site: site}, p.hub)
	p.server = httptest.NewServer(p.gateway)
	t.Cleanup(p.server.Close)
	addr := p.server.Listener.Addr().(*net.TCPAddr)
	p.gateway.Listening(addr)
	p.port = addr.Port
	_, token, err := p.leases.Issue(LeaseScope{All: true})
	if err != nil {
		t.Fatal(err)
	}
	p.token = token
	return p
}

func siteFiles() *fakeSiteControl {
	return &fakeSiteControl{chunk: 4, files: map[string]AssetChunk{
		"index.html":    {ContentType: "text/html; charset=utf-8", CacheControl: "no-cache", Data: []byte("<html>dashboard</html>")},
		"assets/app.js": {ContentType: "application/javascript", CacheControl: "public, max-age=31536000, immutable", Data: []byte("console.log('dashboard');")},
	}}
}

func (p *pageHarness) adminRequest(method, path, body string) *httptest.ResponseRecorder {
	r := p.request(method, path, "", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer admin-secret")
	return p.serve(r)
}

func TestSiteServesTheBundleWithoutALeaseAndKeepsOnlyImmutableFiles(t *testing.T) {
	control := siteFiles()
	p := newSiteHarness(t, control)
	for range 2 {
		w := p.serve(p.request("GET", "/dashboard/assets/app.js", "", nil))
		if w.Code != 200 || w.Body.String() != "console.log('dashboard');" || w.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || w.Header().Get("Content-Type") != "application/javascript" {
			t.Fatalf("asset: %d %q %v", w.Code, w.Body.String(), w.Header())
		}
	}
	// Seven chunks once, then from memory.
	if calls := control.callCount("assets/app.js"); calls != 7 {
		t.Fatalf("immutable asset fetched in %d control calls", calls)
	}
	for _, path := range []string{"/dashboard", "/dashboard/start", "/dashboard/w/a/models"} {
		w := p.serve(p.request("GET", path, "", nil))
		if w.Code != 200 || w.Body.String() != "<html>dashboard</html>" || w.Header().Get("Cache-Control") != "no-cache" {
			t.Fatalf("%s: %d %q", path, w.Code, w.Body.String())
		}
	}
	before := control.callCount("start")
	p.serve(p.request("GET", "/dashboard/start", "", nil))
	if control.callCount("start") == before {
		t.Fatal("the page itself was cached")
	}
	if w := p.serve(p.request("HEAD", "/dashboard/assets/app.js", "", nil)); w.Code != 200 || w.Body.Len() != 0 {
		t.Fatalf("HEAD: %d %d bytes", w.Code, w.Body.Len())
	}
	if w := p.serve(p.request("POST", "/dashboard/assets/app.js", "", nil)); w.Code != 405 {
		t.Fatalf("POST: %d", w.Code)
	}
	if w := p.serve(p.request("GET", "/dashboard/../secret", "", nil)); w.Code != 403 && w.Code != 301 {
		t.Fatalf("escape: %d", w.Code)
	}
	if w := p.serve(p.request("GET", "/dashboard/missing-bundle", "", nil)); w.Code != 404 || w.Body.String() != "Dashboard assets not available in this build" {
		t.Fatalf("no bundle: %d %q", w.Code, w.Body.String())
	}
	if w := p.serve(p.request("GET", "/", "", nil)); w.Code != 302 || w.Header().Get("Location") != "/dashboard/hub" {
		t.Fatalf("root: %d %v", w.Code, w.Header())
	}
	rebound := p.request("GET", "/dashboard/assets/app.js", "", nil)
	rebound.Host = "attacker.example"
	if w := p.serve(rebound); w.Code != 421 {
		t.Fatalf("foreign Host: %d", w.Code)
	}
	foreign := p.request("GET", "/dashboard/assets/app.js", "", nil)
	foreign.RemoteAddr = "10.0.0.7:1"
	if w := p.serve(foreign); w.Code != 404 {
		t.Fatalf("remote peer: %d", w.Code)
	}
}

func TestSiteListsWorkspacesByLeaseScope(t *testing.T) {
	control := siteFiles()
	control.list = []Workspace{{Name: "a", Path: "/home/a"}, {Name: "b", Path: "/home/b"}}
	p := newSiteHarness(t, control, Workspace{Name: "a", Path: "/real/a", Trusted: true})
	if w := p.serve(p.request("GET", "/api/local/workspaces", "", nil)); w.Code != 401 {
		t.Fatalf("no lease: %d", w.Code)
	}
	w := p.serve(p.request("GET", "/api/local/workspaces", p.token, nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"home":null,"switchable":true,"workspaces":[{"name":"a","path":"/home/a"},{"name":"b","path":"/home/b"}]}` {
		t.Fatalf("all: %d %s", w.Code, w.Body.String())
	}
	_, registered, _ := p.leases.Issue(LeaseScope{Workspace: "a"})
	w = p.serve(p.request("GET", "/api/local/workspaces", registered, nil))
	if strings.TrimSpace(w.Body.String()) != `{"home":null,"switchable":false,"workspaces":[{"name":"a","path":"/real/a"}]}` {
		t.Fatalf("registered: %s", w.Body.String())
	}
	_, bound, _ := p.leases.IssueBound(LeaseScope{Workspace: "loose"}, "/tmp/loose")
	w = p.serve(p.request("GET", "/api/local/workspaces", bound, nil))
	if strings.TrimSpace(w.Body.String()) != `{"home":null,"switchable":false,"workspaces":[{"name":"loose","path":"/tmp/loose"}]}` {
		t.Fatalf("bound: %s", w.Body.String())
	}
}

func TestBoundLeasesServeTheirFolderTrustedAndShareOneEngine(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "loose", Path: "/registered/elsewhere", Trusted: false})
	_, first, _ := p.leases.IssueBound(LeaseScope{Workspace: "loose"}, "/tmp/loose")
	_, second, _ := p.leases.IssueBound(LeaseScope{Workspace: "loose"}, "/tmp/loose")
	for _, token := range []string{first, second} {
		if w := p.serve(p.request("GET", "/w/loose/api/v1/health", token, nil)); w.Code != 200 {
			t.Fatalf("bound health: %d %s", w.Code, w.Body.String())
		}
	}
	if p.startCount("/tmp/loose") != 1 || p.startCount("/registered/elsewhere") != 0 {
		t.Fatalf("starts: bound %d registered %d", p.startCount("/tmp/loose"), p.startCount("/registered/elsewhere"))
	}
	if p.resolver.calls.Load() != 0 {
		t.Fatal("a bound lease consulted the registry")
	}
	// The registered workspace of the same name is a different engine.
	if w := p.serve(p.request("GET", "/w/loose/api/v1/health", p.token, nil)); w.Code != 200 || p.startCount("/registered/elsewhere") != 1 {
		t.Fatalf("registered health: %d", w.Code)
	}
	if p.hub.Idle() {
		t.Fatal("hub idle with two engines running")
	}
}

func TestAdminSetsBackendsRenewsAndReportsOpenPages(t *testing.T) {
	p := newPageHarness(t)
	w := p.adminRequest("POST", "/hub/leases", `{"scope":"all"}`)
	var issued struct{ ID, Token string }
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	for _, url := range []string{"http://10.0.0.1:80", "https://127.0.0.1:80", "http://127.0.0.1:80/x", "http://localhost:80", "http://127.0.0.1", "http://user@127.0.0.1:80"} {
		if w := p.adminRequest("PUT", "/hub/leases/"+issued.ID+"/backend", `{"url":"`+url+`"}`); w.Code != 400 {
			t.Fatalf("backend %s: %d", url, w.Code)
		}
	}
	if w := p.adminRequest("PUT", "/hub/leases/"+issued.ID+"/backend", `{"url":"http://127.0.0.1:4321"}`); w.Code != 204 {
		t.Fatalf("backend: %d", w.Code)
	}
	lease, _ := p.leases.Lookup(issued.Token)
	if lease.Backend() != "http://127.0.0.1:4321" {
		t.Fatalf("backend stored as %q", lease.Backend())
	}
	release, _ := lease.Hold(func() {})
	unproxy, _ := lease.HoldBackend(func() {})
	w = p.adminRequest("GET", "/hub/leases/"+issued.ID, "")
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"id":"`+issued.ID+`","pages":1}` {
		t.Fatalf("renew: %d %s", w.Code, w.Body.String())
	}
	release()
	unproxy()
	if w := p.adminRequest("GET", "/hub/leases/unknown", ""); w.Code != 404 {
		t.Fatalf("unknown lease: %d", w.Code)
	}
	if w := p.adminRequest("POST", "/hub/leases", `{"scope":"all","path":"/tmp/x"}`); w.Code != 400 {
		t.Fatalf("bound all-scope lease: %d", w.Code)
	}
	p.admin.Info = func() interface{} { return map[string]int{"port": 7} }
	if w := p.adminRequest("GET", "/hub/ping", ""); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"port":7}` {
		t.Fatalf("ping: %d %s", w.Code, w.Body.String())
	}
	if w := p.adminRequest("POST", "/hub/shutdown", ""); w.Code != 409 {
		t.Fatalf("shutdown without a handler: %d", w.Code)
	}
	stopped := false
	p.admin.Shutdown = func() error { stopped = true; return nil }
	if w := p.adminRequest("POST", "/hub/shutdown", ""); w.Code != 202 || !stopped {
		t.Fatalf("shutdown: %d", w.Code)
	}
}

func TestAdminBindsALeaseToAFolderOnlyThroughInspect(t *testing.T) {
	p := newPageHarness(t)
	p.admin.Inspect = func(_ context.Context, path string) (string, error) {
		if path == "/not/a/repo" {
			return "", ErrNotARepo
		}
		return "/real" + path, nil
	}
	if w := p.adminRequest("POST", "/hub/leases", `{"scope":"workspace","workspace":"loose","path":"/not/a/repo"}`); w.Code != 400 || !strings.Contains(w.Body.String(), "not_a_repo") {
		t.Fatalf("non-repo: %d %s", w.Code, w.Body.String())
	}
	w := p.adminRequest("POST", "/hub/leases", `{"scope":"workspace","workspace":"loose","path":"/tmp/loose"}`)
	var issued struct{ Token string }
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil {
		t.Fatalf("bound: %d %s", w.Code, w.Body.String())
	}
	lease, _ := p.leases.Lookup(issued.Token)
	if path, ok := lease.Bound("loose"); !ok || path != "/real/tmp/loose" {
		t.Fatalf("bound to %q %v", path, ok)
	}
	if _, ok := lease.Bound("other"); ok {
		t.Fatal("bound beyond its workspace")
	}
}

func TestLeasesTheirOwnerStoppedRenewingExpire(t *testing.T) {
	store := NewLeaseStore(time.Minute)
	now := time.Unix(1000, 0)
	store.now = func() time.Time { return now }
	kept, _, _ := store.Issue(LeaseScope{All: true})
	dropped, token, _ := store.Issue(LeaseScope{All: true})
	stopped := false
	lease, _ := store.Lookup(token)
	_, _ = lease.Hold(func() { stopped = true })
	now = now.Add(45 * time.Second)
	store.Renew(kept.ID)
	now = now.Add(30 * time.Second)
	store.Expire()
	if _, ok := store.Renew(dropped.ID); ok || !stopped {
		t.Fatal("an abandoned lease outlived its TTL")
	}
	if _, ok := store.Renew(kept.ID); !ok || store.Count() != 1 {
		t.Fatal("a renewed lease expired")
	}
}

// startBackend stands in for the start server of the process holding a lease.
func startBackend(t *testing.T, token string) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/start/ping":
			if r.Header.Get(gateway.StartTokenHeader) != token {
				w.WriteHeader(401)
				return
			}
			w.WriteHeader(204)
		case "/start/ws":
			conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"bearer." + token}})
			if err != nil {
				return
			}
			defer conn.CloseNow()
			if conn.Subprotocol() != "bearer."+token || r.Header.Get("Origin") != "" {
				_ = conn.Close(websocket.StatusPolicyViolation, "unexpected")
				return
			}
			for {
				kind, data, err := conn.Read(context.Background())
				if err != nil {
					return
				}
				_ = conn.Write(context.Background(), kind, append([]byte("echo:"), data...))
			}
		}
	}))
	t.Cleanup(server.Close)
	return server
}

func TestStartRoutesReachTheLeaseHoldersOwnServer(t *testing.T) {
	p := newSiteHarness(t, siteFiles())
	lease, _ := p.leases.Lookup(p.token)
	ping := func(token string) int {
		r := p.request("GET", "/start/ping", "", nil)
		r.Header.Set(gateway.StartTokenHeader, token)
		return p.serve(r).Code
	}
	if code := ping(p.token); code != 401 {
		t.Fatalf("ping without a backend: %d", code)
	}
	if _, response, err := dialPage(t, p, "/start/ws", nil); err == nil || response.StatusCode != 404 {
		t.Fatalf("socket without a backend: %v", err)
	}
	backend := startBackend(t, p.token)
	p.leases.SetBackend(lease.(*PageLease).ID, backend.URL)
	if code := ping(p.token); code != 204 {
		t.Fatalf("ping: %d", code)
	}
	if code := ping("not-a-lease"); code != 401 {
		t.Fatalf("ping with a stranger's token: %d", code)
	}
	if w := p.serve(p.request("GET", "/start/ws", "", nil)); w.Code != 426 {
		t.Fatalf("plain GET of the socket: %d", w.Code)
	}
	if _, response, err := dialPage(t, p, "/start/ws", http.Header{"Origin": {"http://evil.example"}}); err == nil || response.StatusCode != 403 {
		t.Fatalf("foreign origin: %v", err)
	}
	conn, _, err := dialPage(t, p, "/start/ws", http.Header{"Origin": {p.server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "bearer."+p.token {
		t.Fatalf("subprotocol %q", conn.Subprotocol())
	}
	if err := conn.Write(testContext(t), websocket.MessageText, []byte(`{"type":"start.status","id":"1"}`)); err != nil {
		t.Fatal(err)
	}
	if _, data := readFrame(t, conn); string(data) != `echo:{"type":"start.status","id":"1"}` {
		t.Fatalf("relayed %s", data)
	}
	if status, _ := p.leases.Renew(lease.(*PageLease).ID); status.Pages != 0 {
		t.Fatalf("a start socket counted as %d pages", status.Pages)
	}
	p.leases.Revoke(lease.(*PageLease).ID)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, _, err := conn.Read(ctx); websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("revoked start socket: %v", err)
	}
}
