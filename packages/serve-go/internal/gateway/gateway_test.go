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

package gateway

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type stubBackend struct {
	opens  atomic.Int32
	closes atomic.Int32
	client *engine.Client
}

func (b *stubBackend) Snapshot() engine.Snapshot {
	return engine.Snapshot{State: "stopped", Ready: true}
}
func (b *stubBackend) Open(ctx context.Context, credential, ip string) (*engine.Session, error) {
	b.opens.Add(1)
	if credential != "valid" {
		return nil, &protocol.Error{Code: "unauthorized", Message: "Invalid token"}
	}
	return b.client.Open(ctx, credential, ip)
}
func (b *stubBackend) Close(ctx context.Context, s *engine.Session) error {
	b.closes.Add(1)
	return s.Close(ctx)
}
func (b *stubBackend) Dispatch(ctx context.Context, s *engine.Session, request []byte) error {
	return s.Dispatch(ctx, request)
}
func gatewayConfig() Config {
	return Config{Host: "127.0.0.1", AuthTimeout: time.Second, ControlTimeout: time.Second, WriteTimeout: time.Second}
}
func testCtx(t *testing.T) context.Context {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	return ctx
}

func TestHealthMissingCredentialAndOriginDoNotWakeEngine(t *testing.T) {
	b := &stubBackend{}
	g := New(gatewayConfig(), b)
	for _, path := range []string{"/health", "/ready"} {
		r := httptest.NewRequest("GET", path, nil)
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	for _, origin := range []string{"", "https://evil.example"} {
		r := httptest.NewRequest("GET", "http://localhost/", nil)
		r.Header.Set("Upgrade", "websocket")
		if origin != "" {
			r.Header.Set("Origin", origin)
			r.Header.Set("Authorization", "Bearer valid")
		}
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 401 && w.Code != 403 {
			t.Fatal(w.Code)
		}
	}
	if b.opens.Load() != 0 {
		t.Fatal("cheap checks or health started authentication")
	}
}
func TestCredentialFailureIsRejectedBeforeUpgrade(t *testing.T) {
	b := &stubBackend{}
	g := New(gatewayConfig(), b)
	r := httptest.NewRequest("GET", "http://localhost/", nil)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Authorization", "Bearer wrong")
	r.Header.Set("Sec-WebSocket-Key", "MDEyMzQ1Njc4OWFiY2RlZg==")
	r.Header.Set("Sec-WebSocket-Version", "13")
	r.Header.Set("Connection", "Upgrade")
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 401 || b.opens.Load() != 1 {
		t.Fatalf("auth rejection: %d", w.Code)
	}
	if strings.Contains(w.Body.String(), "wrong") {
		t.Fatal("credential leaked")
	}
}
func TestTokenHeaderPrecedesSubprotocolAndQueryIsExcluded(t *testing.T) {
	r := httptest.NewRequest("GET", "http://localhost/?token=query-secret", nil)
	if token, _ := Token(r); token != "" {
		t.Fatal("URL credential accepted")
	}
	r.Header.Set("Sec-WebSocket-Protocol", "unused, bearer.sub.secret")
	if token, sub := Token(r); token != "sub.secret" || sub != "bearer.sub.secret" {
		t.Fatal(token, sub)
	}
	r.Header.Set("Authorization", "bEaReR header.secret")
	if token, sub := Token(r); token != "header.secret" || sub != "" {
		t.Fatal(token, sub)
	}
}
func TestOriginAndHostPolicy(t *testing.T) {
	for _, tc := range []struct {
		host, origin string
		want         bool
	}{
		{"serve.example", "https://serve.example", true},
		{"attacker.example", "https://serve.example", false},
		{"serve.example", "https://serve.example.attacker.example", false},
		{"serve.example", "null", false},
		{"serve.example", "https://user@serve.example", false},
	} {
		r := httptest.NewRequest("GET", "https://"+tc.host+"/", nil)
		r.Header.Set("Origin", tc.origin)
		if got := allowed(r, Config{Host: "0.0.0.0", TLS: true, TrustedHosts: []string{"serve.example"}}); got != tc.want {
			t.Fatalf("%+v: %v", tc, got)
		}
	}
}
func TestRateLimitIsBoundedAndExpiresDeterministically(t *testing.T) {
	g := New(gatewayConfig(), &stubBackend{})
	now := time.Unix(123, 0)
	for i := 0; i < 60; i++ {
		if !g.rateAllowed("ip", now) {
			t.Fatal("premature rate limit")
		}
	}
	if g.rateAllowed("ip", now) {
		t.Fatal("unbounded rate")
	}
	if !g.rateAllowed("ip", now.Add(time.Minute)) {
		t.Fatal("expired rate retained")
	}
}

func TestRateLimitEvictsOldestEntryInsteadOfLockingOutNewAddresses(t *testing.T) {
	g := New(gatewayConfig(), &stubBackend{})
	now := time.Unix(123, 0)
	for i := 0; i < 4096; i++ {
		if !g.rateAllowed(fmt.Sprint(i), now.Add(time.Duration(i)*time.Nanosecond)) {
			t.Fatal("new address rejected before capacity")
		}
	}
	if !g.rateAllowed("new", now.Add(time.Second)) || len(g.rates) != 4096 {
		t.Fatal("full table locked out a new address or grew unbounded")
	}
	if _, exists := g.rates["0"]; exists {
		t.Fatal("oldest entry was retained")
	}
}

func TestOversizedCredentialIs401WithoutStartingAuthentication(t *testing.T) {
	for _, header := range []string{"Authorization", "Sec-WebSocket-Protocol"} {
		b := &stubBackend{}
		g := New(gatewayConfig(), b)
		r := httptest.NewRequest("GET", "http://localhost/", nil)
		r.Header.Set("Upgrade", "websocket")
		prefix := "Bearer "
		if header == "Sec-WebSocket-Protocol" {
			prefix = "bearer."
		}
		r.Header.Set(header, prefix+strings.Repeat("a", 513))
		w := httptest.NewRecorder()
		g.ServeHTTP(w, r)
		if w.Code != 401 || b.opens.Load() != 0 {
			t.Fatalf("oversized %s credential reached engine: status %d", header, w.Code)
		}
	}
}

func TestOversizedMutationGetsSizeErrorAndConnectionRemainsUsable(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	request := []byte(`{"type":"workflow.run","id":"large","payload":"` + strings.Repeat("a", protocol.MaxFrameBytes-2048) + `"}`)
	if err := conn.Write(ctx, websocket.MessageText, request); err != nil {
		t.Fatal(err)
	}
	_, response, err := conn.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var refused struct {
		Error *protocol.Error `json:"error"`
	}
	if json.Unmarshal(response, &refused) != nil || refused.Error == nil || refused.Error.Code != "request_too_large" {
		t.Fatalf("oversized mutation reported an ambiguous result: %s", response)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"data.query","id":"large","payload":{}}`)); err != nil {
		t.Fatal(err)
	}
	_, response, err = conn.Read(ctx)
	if err != nil || !strings.Contains(string(response), `"session":"session-one"`) {
		t.Fatalf("size refusal lost the session or active ID: %s %v", response, err)
	}
}

type pipeProcess struct {
	inR  *io.PipeReader
	inW  *io.PipeWriter
	outR *io.PipeReader
	outW *io.PipeWriter
	done chan struct{}
	once sync.Once
}

func (p *pipeProcess) Input() io.WriteCloser { return p.inW }
func (p *pipeProcess) Output() io.ReadCloser { return p.outR }
func (p *pipeProcess) Wait() error           { <-p.done; return nil }
func (p *pipeProcess) Kill() error {
	p.once.Do(func() { p.inR.Close(); p.inW.Close(); p.outW.Close(); close(p.done) })
	return nil
}
func (p *pipeProcess) send(e protocol.Envelope) {
	frame, _ := protocol.Encode(e)
	_ = protocol.Write(p.outW, frame)
}
func gatewayBackend(t *testing.T) (*stubBackend, *pipeProcess) {
	inR, inW := io.Pipe()
	outR, outW := io.Pipe()
	p := &pipeProcess{inR: inR, inW: inW, outR: outR, outW: outW, done: make(chan struct{})}
	go func() {
		defer p.Kill()
		next := 0
		sessionLabels := make(map[string]string)
		detachedID := ""
		for {
			e, err := protocol.Read(inR)
			if err != nil {
				return
			}
			result := json.RawMessage(`{}`)
			switch e.Method {
			case "session.open":
				next++
				var params struct {
					SessionID string `json:"sessionId"`
				}
				_ = json.Unmarshal(e.Params, &params)
				sessionLabels[params.SessionID] = nextString(next)
				result, _ = json.Marshal(map[string]interface{}{"sessionId": params.SessionID})
			case "request.dispatch":
				var params struct {
					SessionID string `json:"sessionId"`
					Request   struct {
						ID   string `json:"id"`
						Type string `json:"type"`
					} `json:"request"`
				}
				_ = json.Unmarshal(e.Params, &params)
				if params.Request.Type == "cancel" {
					if params.Request.ID == "refused" {
						p.send(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Error: &protocol.Error{Code: "permission_denied", Message: "Cancellation refused"}})
						continue
					}
					// The legacy public-ID cancellation detaches without a terminal.
					detachedID = params.Request.ID
				} else if params.Request.Type == "workflow.run" && params.Request.ID == "refused" {
					message := json.RawMessage(`{"type":"event","id":"refused","event":{"kind":"started","runId":"known-run"}}`)
					p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: message})
				} else if params.Request.Type == "watch" {
					message, _ := json.Marshal(map[string]interface{}{"type": "event", "id": params.Request.ID, "event": map[string]string{"kind": "progress"}})
					p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: message})
				} else if params.Request.Type == "revoke" {
					p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Closed: &protocol.Closed{Code: 4003, Reason: "Session revoked"}})
				} else {
					if params.Request.Type == "barrier" && detachedID != "" {
						message, _ := json.Marshal(map[string]interface{}{"type": "event", "id": detachedID, "event": map[string]string{"kind": "started", "runId": "old-run"}})
						p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: message})
						detachedID = ""
					}
					message, _ := json.Marshal(map[string]interface{}{"type": "data.query", "id": params.Request.ID, "payload": map[string]string{"session": sessionLabels[params.SessionID]}})
					p.send(protocol.Envelope{Version: 1, Generation: e.Generation, SessionID: params.SessionID, Message: message})
				}
			}
			p.send(protocol.Envelope{Version: 1, Generation: e.Generation, ID: e.ID, Result: result})
		}
	}()
	c := engine.NewClient("generation", p)
	t.Cleanup(func() { c.Stop(); c.Wait() })
	return &stubBackend{client: c}, p
}
func nextString(n int) string {
	if n == 1 {
		return "session-one"
	}
	return "session-two"
}

func TestRefusedCancelPreservesOriginalMutationBookkeeping(t *testing.T) {
	b, process := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer conn.CloseNow()
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"workflow.run","id":"refused"}`)); err != nil {
		t.Fatal(err)
	}
	if _, _, err := conn.Read(ctx); err != nil {
		t.Fatal(err)
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"cancel","id":"refused"}`)); err != nil {
		t.Fatal(err)
	}
	_, refusal, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(refusal), "permission_denied") {
		t.Fatalf("missing cancellation refusal: %s %v", refusal, err)
	}
	_ = process.Kill()
	_, interrupted, err := conn.Read(ctx)
	if err != nil || !strings.Contains(string(interrupted), "operation_indeterminate") || !strings.Contains(string(interrupted), "known-run") {
		t.Fatalf("refused cancellation forgot original mutation: %s %v", interrupted, err)
	}
}
func TestWebSocketRoutesIdenticalIDsAndEchoesBearerProtocol(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	u := "ws" + strings.TrimPrefix(server.URL, "http")
	a, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { a.CloseNow() })
	bConn, _, err := websocket.Dial(ctx, u, &websocket.DialOptions{Subprotocols: []string{"bearer.valid"}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { bConn.CloseNow() })
	if bConn.Subprotocol() != "bearer.valid" {
		t.Fatal("subprotocol not echoed")
	}
	for i, c := range []*websocket.Conn{a, bConn} {
		if err := c.Write(ctx, websocket.MessageText, []byte(`{"type":"data.query","id":"same","payload":{}}`)); err != nil {
			t.Fatal(err)
		}
		_, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var reply struct {
			ID      string `json:"id"`
			Payload struct {
				Session string `json:"session"`
			} `json:"payload"`
		}
		if err = json.Unmarshal(raw, &reply); err != nil {
			t.Fatal(err)
		}
		if reply.ID != "same" || reply.Payload.Session != nextString(i+1) {
			t.Fatalf("cross-session reply %s", raw)
		}
	}
}

type handshakeDeadlineWriter struct {
	http.ResponseWriter
	refreshed chan time.Time
}

func (w handshakeDeadlineWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }
func (w handshakeDeadlineWriter) SetWriteDeadline(deadline time.Time) error {
	w.refreshed <- deadline
	return http.NewResponseController(w.ResponseWriter).SetWriteDeadline(deadline)
}

func TestAuthenticatedUpgradeRefreshesExpiredHTTPWriteDeadline(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	refreshed := make(chan time.Time, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Simulate the ordinary HTTP write window expiring during bounded cold
		// authentication. A successful upgrade needs a new finite write window.
		if err := http.NewResponseController(w).SetWriteDeadline(time.Unix(1, 0)); err != nil {
			t.Error(err)
			return
		}
		g.ServeHTTP(handshakeDeadlineWriter{w, refreshed}, r)
	}))
	server.Config.WriteTimeout = 10 * time.Second
	server.Start()
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	conn, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatalf("expired pre-auth HTTP deadline broke successful upgrade: %v", err)
	}
	t.Cleanup(func() { _ = conn.CloseNow() })
	select {
	case deadline := <-refreshed:
		if deadline.IsZero() {
			t.Fatal("handshake deadline was disabled instead of refreshed")
		}
	case <-ctx.Done():
		t.Fatal("authenticated upgrade did not refresh its HTTP write deadline")
	}
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"type":"data.query","id":"after-auth","payload":{}}`)); err != nil {
		t.Fatal(err)
	}
	if _, reply, err := conn.Read(ctx); err != nil || !strings.Contains(string(reply), `"id":"after-auth"`) {
		t.Fatalf("upgraded session did not remain usable: %s %v", reply, err)
	}
}

func TestUpgradeDeadlineFailureReleasesAuthenticatedSession(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	r := httptest.NewRequest("GET", "http://localhost/", nil)
	r.Header.Set("Upgrade", "websocket")
	r.Header.Set("Connection", "Upgrade")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("Sec-WebSocket-Key", "MDEyMzQ1Njc4OWFiY2RlZg==")
	r.Header.Set("Sec-WebSocket-Version", "13")
	// A recorder has no response deadline support, so the upgrade must fail
	// while the already-authenticated session is still cleaned up exactly once.
	w := httptest.NewRecorder()
	g.ServeHTTP(w, r)
	if w.Code != 503 || b.opens.Load() != 1 || b.closes.Load() != 1 {
		t.Fatalf("unsupported deadline leaked authentication: status=%d opens=%d closes=%d", w.Code, b.opens.Load(), b.closes.Load())
	}
}
func TestEngineRevalidationCloseCodeReachesWebSocket(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	if err = c.Write(ctx, websocket.MessageText, []byte(`{"type":"revoke","id":"r"}`)); err != nil {
		t.Fatal(err)
	}
	_, _, err = c.Read(ctx)
	if websocket.CloseStatus(err) != 4003 {
		t.Fatalf("revalidation close lost: %v", err)
	}
}

func TestPublicIDDetachReleasesTransportBookkeeping(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	for _, raw := range []string{`{"type":"watch","id":"reused"}`, `{"type":"cancel","id":"reused"}`, `{"type":"data.query","id":"reused"}`} {
		if err = c.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
			t.Fatal(err)
		}
		if strings.Contains(raw, "watch") {
			if _, _, err = c.Read(ctx); err != nil {
				t.Fatal(err)
			}
		}
	}
	_, raw, err := c.Read(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Type string `json:"type"`
		ID   string `json:"id"`
	}
	if err = json.Unmarshal(raw, &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Type != "data.query" || reply.ID != "reused" {
		t.Fatalf("cancelled subscription retained active ID: %s", raw)
	}
}

func TestDelayedStartedAfterDetachDoesNotResurrectRequest(t *testing.T) {
	b, _ := gatewayBackend(t)
	g := New(gatewayConfig(), b)
	server := httptest.NewServer(g)
	t.Cleanup(server.Close)
	t.Cleanup(g.Shutdown)
	ctx := testCtx(t)
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), &websocket.DialOptions{HTTPHeader: http.Header{"Authorization": []string{"Bearer valid"}}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.CloseNow()
	write := func(raw string) {
		t.Helper()
		if err := c.Write(ctx, websocket.MessageText, []byte(raw)); err != nil {
			t.Fatal(err)
		}
	}
	read := func() map[string]interface{} {
		t.Helper()
		_, raw, err := c.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var result map[string]interface{}
		if err = json.Unmarshal(raw, &result); err != nil {
			t.Fatal(err)
		}
		return result
	}
	write(`{"type":"watch","id":"reused"}`)
	read()
	write(`{"type":"cancel","id":"reused"}`)
	// Receiving this later request at the fake engine proves the gateway
	// consumed the cancel acknowledgement and removed its pending entry.
	write(`{"type":"barrier","id":"barrier"}`)
	if late := read(); late["type"] != "event" || late["id"] != "reused" {
		t.Fatal(late)
	}
	if barrier := read(); barrier["id"] != "barrier" {
		t.Fatal(barrier)
	}
	write(`{"type":"data.query","id":"reused"}`)
	if reply := read(); reply["type"] != "data.query" || reply["id"] != "reused" {
		t.Fatal(reply)
	}
}
