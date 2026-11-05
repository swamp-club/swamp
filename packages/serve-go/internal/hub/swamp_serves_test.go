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
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/serves"
)

type stubServe struct {
	pid  int
	once sync.Once
	exit chan int
}

func (p *stubServe) Pid() int           { return p.pid }
func (p *stubServe) Terminate() error   { p.once.Do(func() { p.exit <- 0 }); return nil }
func (p *stubServe) Kill() error        { p.once.Do(func() { p.exit <- 137 }); return nil }
func (p *stubServe) Wait() (int, error) { return <-p.exit, nil }

type stubStarts struct {
	mu   sync.Mutex
	argv [][]string
}

func (s *stubStarts) start(argv []string, _ string, stdout, _ io.Writer) (serves.Process, error) {
	s.mu.Lock()
	s.argv = append(s.argv, argv)
	pid := 5000 + len(s.argv)
	s.mu.Unlock()
	_, _ = stdout.Write([]byte("serve log line\n"))
	return &stubServe{pid: pid, exit: make(chan int, 1)}, nil
}

func (s *stubStarts) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.argv)
}

type serveRow struct {
	Name   string
	Serves []struct {
		ID, Owner, State, AuthMode string
		PID, Port                  int
	}
}

func (p *pageHarness) serveRows(t *testing.T, token string) map[string]serveRow {
	t.Helper()
	w := p.serve(p.request("GET", "/api/local/hub", token, nil))
	var reply struct{ Workspaces []serveRow }
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &reply) != nil {
		t.Fatalf("overview: %d %s", w.Code, w.Body.String())
	}
	rows := map[string]serveRow{}
	for _, row := range reply.Workspaces {
		rows[row.Name] = row
	}
	return rows
}

func (p *pageHarness) post(path, token, body string) (int, string) {
	r := p.request("POST", path, token, strings.NewReader(body))
	r.Header.Set("Origin", fmt.Sprintf("http://127.0.0.1:%d", p.port))
	w := p.serve(r)
	return w.Code, w.Body.String()
}

func TestHubStartsStopsAndListsSwampServes(t *testing.T) {
	control := siteFiles()
	control.list = []Workspace{{Name: "a", Path: "/repos/a", Trusted: true}, {Name: "u", Path: "/repos/u"}, {Name: "busy", Path: "/repos/busy", Trusted: true}}
	control.ports = map[string]int{"a": 9190}
	control.recorded = map[string][]ServeRecord{"/repos/busy": {{PID: 77, Port: 9300, URL: "http://127.0.0.1:9300", AuthMode: "token", Dashboard: true}}}
	p := newSiteHarness(t, control)
	starts := &stubStarts{}
	p.site.Serves = serves.NewManagerWith("/opt/swamp", t.TempDir(), starts.start)
	_, manage := p.manageToken(t)

	if code, _ := p.post("/api/local/hub/serves/start", p.token, `{"name":"a"}`); code != 403 {
		t.Fatalf("start without manage: %d", code)
	}
	for body, want := range map[string]string{`{"name":"nope"}`: "unknown_workspace", `{"name":"u"}`: "workspace_untrusted", `{"name":"busy"}`: "serve_running", `{}`: "invalid_request"} {
		if _, reply := p.post("/api/local/hub/serves/start", manage, body); !strings.Contains(reply, want) {
			t.Fatalf("start %s: %s", body, reply)
		}
	}
	if starts.count() != 0 {
		t.Fatal("a refused start launched swamp serve")
	}
	if code, reply := p.post("/api/local/hub/serves/start", manage, `{"name":"a"}`); code != 202 {
		t.Fatalf("start: %d %s", code, reply)
	}
	if got := strings.Join(starts.argv[0], " "); got != "/opt/swamp serve --repo-dir /repos/a --port 9190 --dashboard --json" {
		t.Fatalf("argv: %s", got)
	}
	if _, reply := p.post("/api/local/hub/serves/start", manage, `{"name":"a"}`); !strings.Contains(reply, "serve_running") {
		t.Fatalf("second start: %s", reply)
	}

	rows := p.serveRows(t, manage)
	if len(rows["a"].Serves) != 1 || rows["a"].Serves[0].Owner != "hub" || rows["a"].Serves[0].State != serves.StateStarting || rows["a"].Serves[0].ID == "" {
		t.Fatalf("a: %+v", rows["a"])
	}
	if len(rows["busy"].Serves) != 1 || rows["busy"].Serves[0].Owner != "other" || rows["busy"].Serves[0].ID != "" || rows["busy"].Serves[0].AuthMode != "token" {
		t.Fatalf("busy: %+v", rows["busy"])
	}
	if len(rows["u"].Serves) != 0 {
		t.Fatalf("u: %+v", rows["u"])
	}
	id := rows["a"].Serves[0].ID

	// Once the hub's serve writes its record, the row shows it once, as the hub's.
	control.recorded["/repos/a"] = []ServeRecord{{PID: 5001, Port: 9190, URL: "http://127.0.0.1:9190", AuthMode: "none", Dashboard: true}}
	if row := p.serveRows(t, manage)["a"]; len(row.Serves) != 1 || row.Serves[0].Owner != "hub" || row.Serves[0].AuthMode != "none" || row.Serves[0].ID != id {
		t.Fatalf("a with its record: %+v", row)
	}

	log := p.serve(p.request("GET", "/api/local/hub/serves/"+id+"/log", manage, nil))
	if log.Code != 200 || !strings.Contains(log.Body.String(), "serve log line") {
		t.Fatalf("log: %d %s", log.Code, log.Body.String())
	}
	if w := p.serve(p.request("GET", "/api/local/hub/serves/nope/log", manage, nil)); w.Code != 404 {
		t.Fatalf("unknown log: %d", w.Code)
	}
	if code, _ := p.post("/api/local/hub/serves/nope/stop", manage, ""); code != 404 {
		t.Fatalf("stop unknown: %d", code)
	}
	if code, _ := p.post("/api/local/hub/serves/"+id+"/stop", manage, ""); code != 202 {
		t.Fatalf("stop: %d", code)
	}
	deadline := time.Now().Add(5 * time.Second)
	for p.site.Serves.Count() != 0 {
		if time.Now().After(deadline) {
			t.Fatal("the serve never stopped")
		}
		time.Sleep(5 * time.Millisecond)
	}
}
