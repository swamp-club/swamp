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
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
)

type overviewReply struct {
	Workspaces []struct {
		Name      string
		Path      string
		Trusted   bool
		Temporary bool
		Missing   bool
		Engine    *struct {
			ID      string
			State   string
			Running bool
		}
	}
	Leases []struct {
		ID     string
		Client string
		PID    int
		Scope  string
		Manage bool
		Self   bool
	}
	Log *struct {
		Path  string
		Lines []string
	}
}

func (p *pageHarness) manageToken(t *testing.T) (string, string) {
	t.Helper()
	lease, token, err := p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{All: true}, Manage: true, Client: "hub", PID: 4242})
	if err != nil {
		t.Fatal(err)
	}
	return lease.ID, token
}

func (p *pageHarness) overview(t *testing.T, token string) overviewReply {
	t.Helper()
	w := p.serve(p.request("GET", "/api/local/hub", token, nil))
	var reply overviewReply
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatalf("overview: %d %s", w.Code, w.Body.String())
	}
	return reply
}

func (p *pageHarness) action(path, token string) int {
	r := p.request("POST", path, token, nil)
	r.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", p.port))
	return p.serve(r).Code
}

func TestHubOverviewNeedsAManageLease(t *testing.T) {
	p := newSiteHarness(t, siteFiles())
	_, scoped, _ := p.leases.Issue(LeaseScope{Workspace: "a"})
	unmanaged, _, _ := p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{Workspace: "a"}, Manage: true})
	if unmanaged.CanManage() {
		t.Fatal("a workspace lease can manage the hub")
	}
	if w := p.serve(p.request("GET", "/api/local/hub", "", nil)); w.Code != 401 {
		t.Fatalf("no lease: %d", w.Code)
	}
	for _, token := range []string{p.token, scoped} {
		if w := p.serve(p.request("GET", "/api/local/hub", token, nil)); w.Code != 403 || !strings.Contains(w.Body.String(), "manage_required") {
			t.Fatalf("unmanaged lease: %d %s", w.Code, w.Body.String())
		}
		if code := p.action("/api/local/hub/stop", token); code != 403 {
			t.Fatalf("unmanaged stop: %d", code)
		}
	}
	_, manage := p.manageToken(t)
	if w := p.serve(p.request("POST", "/api/local/hub", manage, nil)); w.Code != 405 {
		t.Fatalf("POST overview: %d", w.Code)
	}
	rebound := p.request("GET", "/api/local/hub", manage, nil)
	rebound.Host = "attacker.example"
	if w := p.serve(rebound); w.Code != 421 {
		t.Fatalf("foreign Host: %d", w.Code)
	}
}

func TestHubOverviewMergesRegisteredTemporaryAndMissingWorkspaces(t *testing.T) {
	control := siteFiles()
	control.list = []Workspace{{Name: "a", Path: "/repos/a", Trusted: true}, {Name: "b", Path: "/repos/b"}}
	p := newSiteHarness(t, control, Workspace{Name: "a", Path: "/repos/a", Trusted: true}, Workspace{Name: "gone", Path: "/repos/gone", Trusted: true})
	_, bound, _ := p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{Workspace: "loose"}, Path: "/tmp/loose", Client: "dashboard", PID: 7})
	p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{Workspace: "idle"}, Path: "/tmp/idle", Client: "dashboard"})
	for _, request := range []struct{ path, token string }{{"/w/a/api/v1/health", p.token}, {"/w/gone/api/v1/health", p.token}, {"/w/loose/api/v1/health", bound}} {
		if w := p.serve(p.request("GET", request.path, request.token, nil)); w.Code != 200 {
			t.Fatalf("%s: %d %s", request.path, w.Code, w.Body.String())
		}
	}
	selfID, manage := p.manageToken(t)
	reply := p.overview(t, manage)
	type row struct {
		name                        string
		trusted, temporary, missing bool
		engine                      bool
	}
	want := []row{{"a", true, false, false, true}, {"b", false, false, false, false}, {"loose", true, true, false, true}, {"idle", true, true, false, false}, {"gone", true, false, true, true}}
	if len(reply.Workspaces) != len(want) {
		t.Fatalf("workspaces: %+v", reply.Workspaces)
	}
	for i, w := range want {
		got := reply.Workspaces[i]
		if got.Name != w.name || got.Trusted != w.trusted || got.Temporary != w.temporary || got.Missing != w.missing || (got.Engine != nil) != w.engine {
			t.Fatalf("row %d: %+v, want %+v", i, got, w)
		}
		if got.Engine != nil && (got.Engine.ID == "" || !got.Engine.Running) {
			t.Fatalf("row %d engine: %+v", i, got.Engine)
		}
	}
	var self, dashboard int
	for _, lease := range reply.Leases {
		if lease.Self {
			self++
			if lease.ID != selfID || lease.Client != "hub" || lease.PID != 4242 || lease.Scope != "all" || !lease.Manage {
				t.Fatalf("own lease: %+v", lease)
			}
		}
		if lease.Client == "dashboard" && lease.PID == 7 && lease.Scope == "workspace" {
			dashboard++
		}
	}
	if len(reply.Leases) != 4 || self != 1 || dashboard != 1 {
		t.Fatalf("leases: %+v", reply.Leases)
	}
	if reply.Log != nil {
		t.Fatalf("log without a log file: %+v", reply.Log)
	}
}

func TestHubOverviewTailsTheLogBounded(t *testing.T) {
	p := newSiteHarness(t, siteFiles())
	path := filepath.Join(t.TempDir(), "hub.log")
	var log strings.Builder
	for i := range 300 {
		fmt.Fprintf(&log, "line %d\n", i)
	}
	if err := os.WriteFile(path, []byte(log.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	p.site.Overviews.LogFile = path
	_, manage := p.manageToken(t)
	reply := p.overview(t, manage)
	if reply.Log == nil || reply.Log.Path != path || len(reply.Log.Lines) != logTailLines || reply.Log.Lines[logTailLines-1] != "line 299" || reply.Log.Lines[0] != "line 100" {
		t.Fatalf("log: %+v", reply.Log)
	}
	if lines := tailLog(filepath.Join(t.TempDir(), "absent.log")); lines == nil || len(lines.Lines) != 0 {
		t.Fatalf("absent log: %+v", lines)
	}
	big := filepath.Join(t.TempDir(), "big.log")
	if err := os.WriteFile(big, []byte(strings.Repeat("x", logTailBytes)+"\nlast\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if lines := tailLog(big); len(lines.Lines) != 1 || lines.Lines[0] != "last" {
		t.Fatalf("partial first line kept: %d lines", len(lines.Lines))
	}
}

func TestHubActionsNeedTheirOwnOriginAndStopEnginesSessionsAndTheHub(t *testing.T) {
	control := siteFiles()
	control.list = []Workspace{{Name: "a", Path: "/repos/a", Trusted: true}}
	p := newSiteHarness(t, control, Workspace{Name: "a", Path: "/repos/a", Trusted: true})
	selfID, manage := p.manageToken(t)
	if w := p.serve(p.request("GET", "/w/a/api/v1/health", p.token, nil)); w.Code != 200 {
		t.Fatalf("health: %d", w.Code)
	}
	id := p.overview(t, manage).Workspaces[0].Engine.ID

	bare := p.request("POST", "/api/local/hub/engines/"+id+"/stop", manage, nil)
	if w := p.serve(bare); w.Code != 403 || !strings.Contains(w.Body.String(), "origin_mismatch") {
		t.Fatalf("no Origin: %d %s", w.Code, w.Body.String())
	}
	foreign := p.request("POST", "/api/local/hub/engines/"+id+"/stop", manage, nil)
	foreign.Header.Set("Origin", "http://attacker.example")
	if w := p.serve(foreign); w.Code != 403 {
		t.Fatalf("foreign Origin: %d", w.Code)
	}

	if code := p.action("/api/local/hub/engines/"+id+"/stop", manage); code != 204 {
		t.Fatalf("stop engine: %d", code)
	}
	if code := p.action("/api/local/hub/engines/"+id+"/stop", manage); code != 404 {
		t.Fatalf("stop a stopped engine: %d", code)
	}
	if engine := p.overview(t, manage).Workspaces[0].Engine; engine != nil {
		t.Fatalf("stopped engine still listed: %+v", engine)
	}
	if w := p.serve(p.request("GET", "/w/a/api/v1/health", p.token, nil)); w.Code != 200 || p.startCount("/repos/a") != 2 {
		t.Fatalf("restart after stop: %d, %d starts", w.Code, p.startCount("/repos/a"))
	}
	if next := p.overview(t, manage).Workspaces[0].Engine; next == nil || next.ID == id {
		t.Fatalf("replacement engine: %+v", next)
	}

	other, otherToken, _ := p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{Workspace: "a"}, Client: "dashboard"})
	held, _ := p.leases.Lookup(otherToken)
	closed := false
	_, _ = held.Hold(func() { closed = true })
	if code := p.action("/api/local/hub/leases/"+selfID+"/revoke", manage); code != 409 {
		t.Fatalf("revoke own lease: %d", code)
	}
	if code := p.action("/api/local/hub/leases/"+other.ID+"/revoke", manage); code != 204 || !closed {
		t.Fatalf("revoke: %d closed=%v", code, closed)
	}
	if code := p.action("/api/local/hub/leases/"+other.ID+"/revoke", manage); code != 404 {
		t.Fatalf("revoke twice: %d", code)
	}
	if code := p.action("/api/local/hub/nothing", manage); code != 404 {
		t.Fatalf("unknown action: %d", code)
	}

	if code := p.action("/api/local/hub/stop", manage); code != 409 {
		t.Fatalf("stop without a hook: %d", code)
	}
	p.site.Overviews.Stop = func() error { return gateway.ErrHubIsService }
	r := p.request("POST", "/api/local/hub/stop", manage, nil)
	r.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", p.port))
	if w := p.serve(r); w.Code != 409 || !strings.Contains(w.Body.String(), "hub_is_service") {
		t.Fatalf("stop a service hub: %d %s", w.Code, w.Body.String())
	}
	stopped := false
	p.site.Overviews.Stop = func() error { stopped = true; return nil }
	if code := p.action("/api/local/hub/stop", manage); code != 202 || !stopped {
		t.Fatalf("stop hub: %d", code)
	}
}

func TestAdminIssuesManageLeasesOnlyOverEveryWorkspaceAndNamesTheirClient(t *testing.T) {
	p := newSiteHarness(t, siteFiles())
	for _, body := range []string{`{"scope":"workspace","workspace":"a","manage":true}`, `{"scope":"all","client":"browser"}`, `{"scope":"all","pid":-1}`} {
		if w := p.adminRequest("POST", "/hub/leases", body); w.Code != 400 {
			t.Fatalf("%s: %d", body, w.Code)
		}
	}
	w := p.adminRequest("POST", "/hub/leases", `{"scope":"all","manage":true,"client":"hub","pid":99,"pageRenewed":true}`)
	var issued struct{ ID, Token string }
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	lease, _ := p.leases.Lookup(issued.Token)
	if !lease.CanManage() || lease.LeaseID() != issued.ID {
		t.Fatal("manage lease cannot manage")
	}
	found := false
	for _, info := range p.leases.List() {
		if info.ID == issued.ID {
			found = info.Client == "hub" && info.PID == 99 && info.Manage && info.PageRenewed && info.Scope == "all"
		}
	}
	if !found {
		t.Fatalf("listed: %+v", p.leases.List())
	}
	reply := p.serve(p.request("GET", "/api/local/workspaces", issued.Token, nil))
	if !strings.Contains(reply.Body.String(), `"home":"hub"`) {
		t.Fatalf("manage home: %s", reply.Body.String())
	}
	backed, backedToken, _ := p.leases.Issue(LeaseScope{All: true})
	p.leases.SetBackend(backed.ID, "http://127.0.0.1:4000")
	reply = p.serve(p.request("GET", "/api/local/workspaces", backedToken, nil))
	if !strings.Contains(reply.Body.String(), `"home":"start"`) {
		t.Fatalf("start home: %s", reply.Body.String())
	}
}

func TestLeaseListingNeverRenews(t *testing.T) {
	store := NewLeaseStore(0)
	lease, _, _ := store.Issue(LeaseScope{All: true})
	renewed := lease.renewed
	store.List()
	if lease.renewed != renewed {
		t.Fatal("List renewed a lease")
	}
}

func TestPageRenewedLeasesLiveWhileTheirPageIsInUse(t *testing.T) {
	p := newSiteHarness(t, siteFiles())
	now := time.Unix(1000, 0)
	p.leases.ttl = time.Minute
	p.leases.now = func() time.Time { return now }
	renewed, token, _ := p.leases.IssueWith(LeaseOptions{Scope: LeaseScope{All: true}, Manage: true, Client: "hub", PageRenewed: true})
	plain, plainToken, _ := p.leases.Issue(LeaseScope{All: true})

	now = now.Add(45 * time.Second)
	for _, tok := range []string{token, plainToken} {
		if w := p.serve(p.request("GET", "/api/local/workspaces", tok, nil)); w.Code != 200 {
			t.Fatalf("workspaces: %d", w.Code)
		}
	}
	now = now.Add(30 * time.Second)
	p.leases.Expire()
	if _, ok := p.leases.Lookup(plainToken); ok {
		t.Fatal("a page request renewed a lease its invoker holds")
	}
	if _, ok := p.leases.Lookup(token); !ok {
		t.Fatal("a page-renewed lease expired while its page polled")
	}

	held, _ := p.leases.Lookup(token)
	release, _ := held.Hold(func() {})
	now = now.Add(5 * time.Minute)
	p.leases.Expire()
	if _, ok := p.leases.Lookup(token); !ok {
		t.Fatal("a page-renewed lease expired under an open tab")
	}
	release()
	now = now.Add(61 * time.Second)
	p.leases.Expire()
	if _, ok := p.leases.Lookup(token); ok {
		t.Fatal("a page-renewed lease outlived its last tab")
	}
	if renewed.ID == plain.ID {
		t.Fatal("lease ids collided")
	}
}
