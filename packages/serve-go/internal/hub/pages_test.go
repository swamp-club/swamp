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

package hub

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type pageHarness struct {
	*harness
	leases  *LeaseStore
	admin   *Admin
	gateway *gateway.Gateway
	site    *Site
	server  *httptest.Server
	port    int
	token   string
	opens   []map[string]interface{}
	mu      sync.Mutex
}

func newPageHarness(t *testing.T, workspaces ...Workspace) *pageHarness {
	t.Helper()
	p := &pageHarness{harness: newHarness(t, 0, workspaces...), leases: NewLeaseStore(0)}
	p.admin = NewAdmin("admin-secret", p.leases)
	p.opened = func(params json.RawMessage) {
		var decoded map[string]interface{}
		_ = json.Unmarshal(params, &decoded)
		p.mu.Lock()
		p.opens = append(p.opens, decoded)
		p.mu.Unlock()
	}
	p.gateway = gateway.New(gateway.Config{Host: "127.0.0.1", AuthTimeout: 10 * time.Second, ControlTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, Profile: "hub", Leases: p.leases, Admin: p.admin}, p.hub)
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

func (p *pageHarness) request(method, path, token string, body io.Reader) *http.Request {
	r := httptest.NewRequest(method, path, body)
	r.Host = fmt.Sprintf("127.0.0.1:%d", p.port)
	r.RemoteAddr = "127.0.0.1:50000"
	if token != "" {
		r.Header.Set(gateway.LocalTokenHeader, token)
	}
	return r
}

func (p *pageHarness) serve(r *http.Request) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	p.gateway.ServeHTTP(w, r)
	return w
}

// sessionReply emits frames on the dispatched session, then closes it as a
// one-shot session does once its request settles.
func sessionReply(frames ...string) func(protocol.Envelope, func(protocol.Envelope)) *protocol.Error {
	return func(e protocol.Envelope, out func(protocol.Envelope)) *protocol.Error {
		var params struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(e.Params, &params)
		for _, frame := range frames {
			out(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: json.RawMessage(frame)})
		}
		out(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Closed: &protocol.Closed{Code: 1000, Reason: "Request complete"}})
		return nil
	}
}

func TestPageRoutesRefuseInOrderBeforeAnythingWakes(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	foreign := p.request("GET", "/w/a/auth/info", p.token, nil)
	foreign.RemoteAddr = "10.0.0.7:50000"
	if w := p.serve(foreign); w.Code != 404 {
		t.Fatalf("non-loopback peer got %d", w.Code)
	}
	rebound := p.request("GET", "/w/a/auth/info", p.token, nil)
	rebound.Host = "attacker.example:80"
	if w := p.serve(rebound); w.Code != 421 {
		t.Fatalf("foreign Host got %d", w.Code)
	}
	for _, token := range []string{"", "not-a-lease", strings.Repeat("x", 600)} {
		if w := p.serve(p.request("GET", "/w/a/api/v1/health", token, nil)); w.Code != 401 {
			t.Fatalf("token %q got %d", token, w.Code)
		}
	}
	// A cli token never reaches the lease store or an engine on a page route.
	cli := p.request("GET", "/w/a/api/v1/health", "", nil)
	cli.Header.Set("Authorization", "Bearer name.secret")
	if w := p.serve(cli); w.Code != 401 {
		t.Fatalf("cli credential on a page route got %d", w.Code)
	}
	if calls := p.resolver.calls.Load(); calls != 0 || p.startCount("/repo/a") != 0 {
		t.Fatalf("refused probes resolved %d workspaces and started %d engines", calls, p.startCount("/repo/a"))
	}
	_, scoped, _ := p.leases.Issue(LeaseScope{Workspace: "b"})
	if w := p.serve(p.request("GET", "/w/a/auth/info", scoped, nil)); w.Code != 404 || w.Body.String() != "No workspace named a" {
		t.Fatalf("lease scoped to another workspace got %d %q", w.Code, w.Body.String())
	}
	w := p.serve(p.request("GET", "/w/a/auth/info", p.token, nil))
	if w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"local":true,"mode":"none"}` {
		t.Fatalf("auth/info: %d %s", w.Code, w.Body.String())
	}
	if w := p.serve(p.request("POST", "/w/a/auth/dashboard/session", p.token, nil)); w.Code != 401 || w.Body.Len() != 0 {
		t.Fatalf("dashboard session: %d %q", w.Code, w.Body.String())
	}
	if p.startCount("/repo/a") != 0 {
		t.Fatal("static page routes woke an engine")
	}
}

func TestPageHealthAnswersFromTheEngine(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	w := p.serve(p.request("GET", "/w/a/api/v1/health", p.token, nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"activeRuns":[]`) {
		t.Fatalf("health: %d %s", w.Code, w.Body.String())
	}
	if w := p.serve(p.request("GET", "/w/unknown/api/v1/health", p.token, nil)); w.Code != 404 {
		t.Fatalf("unknown workspace got %d", w.Code)
	}
}

func TestPageRequestRouteFiltersThenStreamsOneShotSession(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	big := bytes.Repeat([]byte("x"), 70*1024)
	if w := p.serve(p.request("POST", "/w/a/api/v1/request", p.token, bytes.NewReader(big))); w.Code != 413 {
		t.Fatalf("oversize body got %d", w.Code)
	}
	if w := p.serve(p.request("POST", "/w/a/api/v1/request", p.token, strings.NewReader(`{"type":1}`))); w.Code != 400 {
		t.Fatalf("invalid frame got %d", w.Code)
	}
	w := p.serve(p.request("post", "/w/a/api/v1/request", p.token, strings.NewReader(`{"type":"workflow.run","id":"1"}`)))
	if w.Code != 404 || !strings.Contains(w.Body.String(), `'workflow.run' is not answered over HTTP here; send it over the WebSocket`) {
		t.Fatalf("unforwarded read: %d %s", w.Code, w.Body.String())
	}
	if p.startCount("/repo/a") != 0 {
		t.Fatal("a filtered request woke the engine")
	}
	p.dispatched = func(e protocol.Envelope, out func(protocol.Envelope)) *protocol.Error {
		return &protocol.Error{Code: "use_websocket", Message: "'model.get' is not answered over HTTP; send it over the WebSocket"}
	}
	if w := p.serve(p.request("POST", "/w/a/api/v1/request", p.token, strings.NewReader(`{"type":"model.get","id":"1"}`))); w.Code != 404 {
		t.Fatalf("engine refusal got %d", w.Code)
	}
	p.dispatched = sessionReply(`{"type":"data.query","id":"q","payload":{"page":1}}`, `{"type":"done","id":"q"}`)
	request := p.request("POST", "/w/a/api/v1/request", p.token, strings.NewReader(`{"type":"data.query","id":"q","payload":{}}`))
	request.Header.Set("Accept-Encoding", "gzip")
	w = p.serve(request)
	if w.Code != 200 || w.Header().Get("Content-Type") != "application/x-ndjson" || w.Header().Get("Content-Encoding") != "gzip" {
		t.Fatalf("stream: %d %v", w.Code, w.Header())
	}
	reader, err := gzip.NewReader(w.Body)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(reader)
	if string(body) != "{\"type\":\"data.query\",\"id\":\"q\",\"payload\":{\"page\":1}}\n{\"type\":\"done\",\"id\":\"q\"}\n" {
		t.Fatalf("ndjson body %q", body)
	}
	p.mu.Lock()
	last := p.opens[len(p.opens)-1]
	p.mu.Unlock()
	if last["class"] != "page" || last["oneShot"] != true {
		t.Fatalf("request route opened %v", last)
	}
	if p.hub.engines["a"].Activity().Sessions != 0 {
		t.Fatal("one-shot session stayed open")
	}
}

func TestPageHealthStreamResumesEventIDsAndClampsInterval(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, _ := http.NewRequestWithContext(ctx, "GET", p.server.URL+"/w/a/api/v1/health/stream?interval=10", nil)
	request.Header.Set(gateway.LocalTokenHeader, p.token)
	request.Header.Set("Last-Event-ID", "41")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if response.Header.Get("Content-Type") != "text/event-stream" || response.Header.Get("X-Health-Interval") != "1000" {
		t.Fatalf("stream headers %v", response.Header)
	}
	reader := bufio.NewReader(response.Body)
	var event []string
	for len(event) < 3 {
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		event = append(event, strings.TrimSuffix(line, "\n"))
	}
	if event[0] != "id: 42" || event[1] != "event: health" || !strings.HasPrefix(event[2], `data: {"activeRuns":[]`) {
		t.Fatalf("event %q", event)
	}
	// The open stream is a page session, so the engine cannot idle out.
	if p.hub.engines["a"].Activity().Sessions != 1 {
		t.Fatal("health stream holds no session")
	}
}

func TestHealthStreamIntervalMatchesTypeScript(t *testing.T) {
	for _, c := range []struct {
		param   string
		present bool
		want    time.Duration
	}{{"", false, 5 * time.Second}, {"abc", true, 5 * time.Second}, {"10", true, time.Second}, {"2500ms", true, 2500 * time.Millisecond}, {"999999", true, time.Minute}, {" 3000", true, 3 * time.Second}} {
		if got := gateway.HealthStreamInterval(c.param, c.present); got != c.want {
			t.Fatalf("interval %q: %v, want %v", c.param, got, c.want)
		}
	}
}

func dialPage(t *testing.T, p *pageHarness, path string, header http.Header) (*websocket.Conn, *http.Response, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	if header == nil {
		header = http.Header{}
	}
	return websocket.Dial(ctx, "ws"+strings.TrimPrefix(p.server.URL, "http")+path, &websocket.DialOptions{Subprotocols: []string{"bearer." + p.token}, HTTPHeader: header})
}

func readFrame(t *testing.T, conn *websocket.Conn) (websocket.MessageType, []byte) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	return kind, data
}

func TestPageSocketEchoesLeaseRefusesOutsideThePageSetAndClosesOnRevoke(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	header := http.Header{"Origin": {"http://evil.example"}}
	if _, response, err := dialPage(t, p, "/w/a/", header); err == nil || response == nil || response.StatusCode != 403 {
		t.Fatalf("foreign origin: %v %v", err, response)
	}
	dispatched := make(chan string, 4)
	p.dispatched = func(e protocol.Envelope, out func(protocol.Envelope)) *protocol.Error {
		dispatched <- string(e.Params)
		return nil
	}
	conn, response, err := dialPage(t, p, "/w/a/", http.Header{"Origin": {p.server.URL}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != "bearer."+p.token || response.StatusCode != 101 {
		t.Fatalf("subprotocol %q", conn.Subprotocol())
	}
	ctx := testContext(t)
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"workflow.run","id":"w1","payload":{}}`)); err != nil {
		t.Fatal(err)
	}
	_, frame := readFrame(t, conn)
	if !strings.Contains(string(frame), `"code":"not_available_locally"`) || !strings.Contains(string(frame), "workflow.run is not available on the local dashboard. Run it with the swamp CLI, or through swamp serve.") {
		t.Fatalf("refusal %s", frame)
	}
	// A stray frame is dropped and a detach cancel never reaches the engine.
	_ = conn.Write(ctx, websocket.MessageText, []byte(`not json`))
	_ = conn.Write(ctx, websocket.MessageText, []byte(`{"type":"cancel","id":"never"}`))
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"model.get","id":"r1","payload":{}}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case params := <-dispatched:
		if !strings.Contains(params, `"id":"r1"`) {
			t.Fatalf("first dispatch was %s", params)
		}
	case <-ctx.Done():
		t.Fatal("read never dispatched")
	}
	lease, _ := p.leases.Lookup(p.token)
	p.leases.Revoke(lease.(*PageLease).ID)
	readCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, _, err = conn.Read(readCtx)
	if websocket.CloseStatus(err) != websocket.StatusPolicyViolation {
		t.Fatalf("revoked lease close: %v", err)
	}
	if _, response, err := dialPage(t, p, "/w/a/", nil); err == nil || response.StatusCode != 401 {
		t.Fatalf("revoked lease reconnected: %v", err)
	}
}

func TestPageSocketGzipsLargeFramesOnlyWhenAsked(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	large := `{"type":"model.get","id":"r1","payload":"` + strings.Repeat("y", 20*1024) + `"}`
	p.dispatched = func(e protocol.Envelope, out func(protocol.Envelope)) *protocol.Error {
		var params struct {
			SessionID string `json:"sessionId"`
		}
		_ = json.Unmarshal(e.Params, &params)
		out(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: json.RawMessage(large)})
		out(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: json.RawMessage(`{"type":"done","id":"r1"}`)})
		return nil
	}
	for _, compress := range []bool{true, false} {
		path := "/w/a/"
		if compress {
			path += "?compress=gzip"
		}
		conn, _, err := dialPage(t, p, path, nil)
		if err != nil {
			t.Fatal(err)
		}
		if err := conn.Write(testContext(t), websocket.MessageText, []byte(`{"type":"model.get","id":"r1","payload":{}}`)); err != nil {
			t.Fatal(err)
		}
		kind, data := readFrame(t, conn)
		if compress {
			if kind != websocket.MessageBinary {
				t.Fatal("large frame not compressed")
			}
			reader, err := gzip.NewReader(bytes.NewReader(data))
			if err != nil {
				t.Fatal(err)
			}
			data, _ = io.ReadAll(reader)
		} else if kind != websocket.MessageText {
			t.Fatal("frame compressed without asking")
		}
		if string(data) != large {
			t.Fatal("frame changed in transit")
		}
		kind, data = readFrame(t, conn)
		if kind != websocket.MessageText || string(data) != `{"type":"done","id":"r1"}` {
			t.Fatalf("small frame %v %s", kind, data)
		}
		conn.CloseNow()
	}
}

func TestUntrustedWorkspaceServesPagesThroughAnEngineWithoutExtensions(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: false})
	_, err := p.hub.Route(testContext(t), "/w/a/")
	if refusal := routeError(t, err); refusal.Status != 403 || refusal.Code != "workspace_untrusted" {
		t.Fatalf("cli on untrusted: %+v", refusal)
	}
	if w := p.serve(p.request("GET", "/w/a/api/v1/health", p.token, nil)); w.Code != 200 {
		t.Fatalf("page on untrusted: %d %s", w.Code, w.Body.String())
	}
	// Trust changes which code may load, so it takes a new generation.
	p.resolver.set(Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	if w := p.serve(p.request("GET", "/w/a/api/v1/health", p.token, nil)); w.Code != 200 {
		t.Fatalf("page after trust: %d", w.Code)
	}
	if p.startCount("/repo/a") != 2 {
		t.Fatalf("trust change reused the untrusted engine: %d starts", p.startCount("/repo/a"))
	}
}

func TestReadOnlyEngineRefusesCLIBeforeTheCredentialIsSent(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	p.mode = func(Workspace) string { return "read-only" }
	backend, err := p.hub.Route(testContext(t), "/w/a/")
	if err != nil {
		t.Fatal(err)
	}
	_, err = backend.Open(testContext(t), "name.secret", "127.0.0.1")
	if refusal := routeError(t, err); refusal.Status != 403 || refusal.Code != "unsupported_profile" {
		t.Fatalf("cli on read-only: %+v", refusal)
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(p.opens) != 0 {
		t.Fatalf("credential reached the engine: %v", p.opens)
	}
}

func TestAdminAPIIssuesAndRevokesLeasesForAuthenticatedLoopbackCallers(t *testing.T) {
	p := newPageHarness(t, Workspace{Name: "a", Path: "/repo/a", Trusted: true})
	issue := func(token, remote string) *httptest.ResponseRecorder {
		r := p.request("POST", "/hub/leases", "", strings.NewReader(`{"scope":"workspace","workspace":"a"}`))
		r.RemoteAddr = remote
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		return p.serve(r)
	}
	if w := issue("admin-secret", "10.0.0.7:1"); w.Code != 404 {
		t.Fatalf("remote admin got %d", w.Code)
	}
	if w := issue("wrong", "127.0.0.1:1"); w.Code != 401 {
		t.Fatalf("wrong admin token got %d", w.Code)
	}
	w := issue("admin-secret", "127.0.0.1:1")
	var issued struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &issued) != nil || len(issued.Token) != 43 || issued.ID == "" {
		t.Fatalf("issue: %d %s", w.Code, w.Body.String())
	}
	if w := p.serve(p.request("GET", "/w/a/auth/info", issued.Token, nil)); w.Code != 200 {
		t.Fatalf("issued lease refused: %d", w.Code)
	}
	revoke := p.request("DELETE", "/hub/leases/"+issued.ID, "", nil)
	revoke.Header.Set("Authorization", "Bearer admin-secret")
	if w := p.serve(revoke); w.Code != 204 {
		t.Fatalf("revoke got %d", w.Code)
	}
	if w := p.serve(p.request("GET", "/w/a/auth/info", issued.Token, nil)); w.Code != 401 {
		t.Fatalf("revoked lease accepted: %d", w.Code)
	}
	again := p.request("DELETE", "/hub/leases/"+issued.ID, "", nil)
	again.Header.Set("Authorization", "Bearer admin-secret")
	if w := p.serve(again); w.Code != 404 {
		t.Fatalf("second revoke got %d", w.Code)
	}
}

var _ engine.Process = (*pipeEngine)(nil)
