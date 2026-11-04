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

// Package gateway only transports opaque, engine-authorized public messages.
package gateway

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

type Backend interface {
	Snapshot() engine.Snapshot
	Open(context.Context, string, string) (*engine.Session, error)
	Close(context.Context, *engine.Session) error
	Dispatch(context.Context, *engine.Session, []byte) error
}

// Router selects the backend for an upgrade path and answers readiness probes
// without starting an engine.
type Router interface {
	Route(ctx context.Context, path string) (Backend, error)
	Readiness(path string) (status int, body interface{}, ok bool)
}

// RouteError is a routing refusal the gateway reports before authentication.
type RouteError struct {
	Status int
	Code   string
}

func (e *RouteError) Error() string { return e.Code }

type singleRouter struct{ backend Backend }

// Single routes every upgrade path to one backend: the single-repository profile.
func Single(backend Backend) Router { return singleRouter{backend} }

func (r singleRouter) Route(context.Context, string) (Backend, error) { return r.backend, nil }
func (r singleRouter) Readiness(path string) (int, interface{}, bool) {
	if path != "/ready" && path != "/readyz" {
		return 0, nil, false
	}
	state := r.backend.Snapshot()
	if state.Ready {
		return 200, state, true
	}
	return 503, state, true
}

type Config struct {
	Host           string
	TLS            bool
	TrustedHosts   []string
	AuthTimeout    time.Duration
	ControlTimeout time.Duration
	WriteTimeout   time.Duration
	// Profile names the public profile in health and refusals; local-v1 by default.
	Profile string
}

func (c Config) profile() string {
	if c.Profile == "" {
		return "local-v1"
	}
	return c.Profile
}

type rateEntry struct {
	start time.Time
	count int
}
type Gateway struct {
	config      Config
	router      Router
	mu          sync.Mutex
	connections map[*websocket.Conn]struct{}
	rates       map[string]rateEntry
	admissions  chan struct{}
	stopping    bool
}

func New(config Config, router Router) *Gateway {
	return &Gateway{config: config, router: router, connections: make(map[*websocket.Conn]struct{}), rates: make(map[string]rateEntry), admissions: make(chan struct{}, engine.MaxSessions+engine.MaxColdWaiters)}
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.EqualFold(r.Header.Get("Upgrade"), "websocket") {
		g.upgrade(w, r)
		return
	}
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "method_not_allowed"})
		return
	}
	if r.URL.Path == "/health" || r.URL.Path == "/healthz" {
		writeJSON(w, 200, map[string]interface{}{"status": "alive", "implementation": "go", "profile": g.config.profile(), "protocolVersion": protocol.Version})
		return
	}
	if status, body, ok := g.router.Readiness(r.URL.Path); ok {
		writeJSON(w, status, body)
		return
	}
	writeJSON(w, 404, map[string]string{"error": "unsupported_endpoint", "profile": g.config.profile()})
}
func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func Token(r *http.Request) (string, string) {
	auth := r.Header.Get("Authorization")
	if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
		return auth[7:], ""
	}
	for _, part := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "bearer.") && len(part) > 7 {
			return part[7:], part
		}
	}
	return "", ""
}

func allowed(r *http.Request, config Config) bool {
	trusted := func(host string) bool {
		host = strings.ToLower(strings.Trim(host, "[]"))
		if host == "localhost" || host == "127.0.0.1" || host == "::1" {
			return true
		}
		if config.TLS && host == strings.ToLower(config.Host) {
			return true
		}
		for _, h := range config.TrustedHosts {
			if strings.EqualFold(h, host) {
				return true
			}
		}
		return false
	}
	if origin := r.Header.Get("Origin"); origin != "" {
		u, err := url.Parse(origin)
		if err != nil || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") || (u.Scheme != "http" && u.Scheme != "https") || !trusted(u.Hostname()) {
			return false
		}
	}
	bindIP := net.ParseIP(config.Host)
	if config.Host != "localhost" && (bindIP == nil || !bindIP.IsLoopback()) {
		u, err := url.Parse("http://" + r.Host)
		if err != nil || u.User != nil || u.Path != "" || u.RawQuery != "" || u.Fragment != "" {
			return false
		}
		if !trusted(u.Hostname()) && !strings.EqualFold(u.Hostname(), config.Host) {
			return false
		}
	}
	return true
}
func (g *Gateway) rateAllowed(ip string, now time.Time) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	for key, value := range g.rates {
		if now.Sub(value.start) >= time.Minute {
			delete(g.rates, key)
		}
	}
	e, ok := g.rates[ip]
	if !ok {
		if len(g.rates) >= 4096 {
			var oldest string
			var at time.Time
			for key, entry := range g.rates {
				if at.IsZero() || entry.start.Before(at) {
					oldest, at = key, entry.start
				}
			}
			delete(g.rates, oldest)
		}
		e.start = now
	}
	e.count++
	g.rates[ip] = e
	return e.count <= 60
}

func (g *Gateway) upgrade(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet || r.ContentLength != 0 || len(r.TransferEncoding) != 0 {
		writeJSON(w, 400, map[string]string{"error": "invalid_upgrade"})
		return
	}
	if !allowed(r, g.config) {
		writeJSON(w, 403, map[string]string{"error": "untrusted_origin_or_host"})
		return
	}
	credential, subprotocol := Token(r)
	if credential == "" || len(credential) > 512 {
		writeJSON(w, 401, map[string]string{"error": "credential_required"})
		return
	}
	key, keyErr := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if keyErr != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" || !headerContains(r.Header.Get("Connection"), "upgrade") {
		writeJSON(w, 400, map[string]string{"error": "invalid_upgrade"})
		return
	}
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		ip = r.RemoteAddr
	}
	if !g.rateAllowed(ip, time.Now()) {
		w.Header().Set("Retry-After", "60")
		writeJSON(w, 429, map[string]string{"error": "authentication_rate_limit"})
		return
	}
	g.mu.Lock()
	stopping := g.stopping
	g.mu.Unlock()
	if stopping {
		writeJSON(w, 503, map[string]string{"error": "draining"})
		return
	}
	select {
	case g.admissions <- struct{}{}:
		defer func() { <-g.admissions }()
	default:
		writeJSON(w, 503, map[string]string{"error": "connection_limit"})
		return
	}
	// Authentication may create an engine session. Finish the bounded control
	// exchange even if the HTTP peer leaves, then release that session below.
	ctx, cancel := context.WithTimeout(context.Background(), g.config.AuthTimeout)
	backend, err := g.router.Route(ctx, r.URL.Path)
	if err != nil {
		cancel()
		var refusal *RouteError
		if errors.As(err, &refusal) {
			writeJSON(w, refusal.Status, map[string]string{"error": refusal.Code})
		} else {
			writeJSON(w, 503, map[string]string{"error": "engine_unavailable"})
		}
		return
	}
	session, err := backend.Open(ctx, credential, ip)
	cancel()
	credential = ""
	r.Header.Del("Authorization")
	if err != nil {
		var failure *protocol.Error
		if errors.As(err, &failure) && failure.Code == "unauthorized" {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		} else {
			writeJSON(w, 503, map[string]string{"error": "engine_unavailable"})
		}
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), g.config.ControlTimeout)
		defer cancel()
		_ = backend.Close(ctx, session)
	}()
	opts := &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled}
	// Origin/Host were checked before waking the engine. The library's default
	// same-host check would reject the explicitly trusted reverse-proxy hosts.
	if subprotocol != "" {
		opts.Subprotocols = []string{subprotocol}
	}
	// Cold startup/authentication has its own bounded budget. Give the 101
	// response a fresh bounded write window before Hijack clears HTTP deadlines.
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(g.config.WriteTimeout)); err != nil {
		writeJSON(w, 503, map[string]string{"error": "upgrade_unavailable"})
		return
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		return
	}
	subprotocol = ""
	opts.Subprotocols = nil
	r.Header.Del("Sec-WebSocket-Protocol")
	defer conn.CloseNow()
	conn.SetReadLimit(protocol.MaxFrameBytes - 1024)
	g.mu.Lock()
	if g.stopping {
		g.mu.Unlock()
		return
	}
	g.connections[conn] = struct{}{}
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(g.connections, conn); g.mu.Unlock() }()
	g.serve(conn, backend, session)
}

func headerContains(value, token string) bool {
	for _, entry := range strings.Split(value, ",") {
		if strings.EqualFold(strings.TrimSpace(entry), token) {
			return true
		}
	}
	return false
}

type pendingRequest struct {
	mutation bool
	runID    string
}

func (g *Gateway) serve(conn *websocket.Conn, backend Backend, session *engine.Session) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var pendingMu sync.Mutex
	pending := make(map[string]pendingRequest)
	// The pipe reader owns the bounded mailbox; only this writer drains it.
	writerDone := make(chan struct{})
	go func() {
		defer close(writerDone)
		defer cancel()
		defer conn.CloseNow()
		for {
			msg, err := session.Receive(ctx)
			if err != nil {
				if ctx.Err() != nil {
					return
				}
				closed := session.Closed()
				if closed.Code == 1011 {
					pendingMu.Lock()
					for id, p := range pending {
						code, message := "engine_unavailable", "Engine exited during the request"
						if p.mutation {
							code = "operation_indeterminate"
							message = "Engine exited after handoff; the operation may have taken effect. Inspect history before retrying"
						}
						detail := map[string]interface{}{"code": code, "message": message}
						if p.runID != "" {
							detail["details"] = map[string]string{"runId": p.runID}
						}
						payload, _ := json.Marshal(map[string]interface{}{"type": "error", "id": id, "error": detail})
						if g.write(ctx, conn, payload) != nil {
							break
						}
					}
					pendingMu.Unlock()
				}
				_ = conn.Close(websocket.StatusCode(closed.Code), closed.Reason)
				return
			}
			var public struct {
				Type  string `json:"type"`
				ID    string `json:"id"`
				Event struct {
					Kind  string `json:"kind"`
					RunID string `json:"runId"`
				} `json:"event"`
			}
			if json.Unmarshal(msg, &public) == nil {
				pendingMu.Lock()
				if public.Type == "event" && public.Event.Kind == "started" {
					if p, exists := pending[public.ID]; exists {
						p.runID = public.Event.RunID
						pending[public.ID] = p
					}
				}
				if public.Type != "event" && public.Type != "run.attached" {
					delete(pending, public.ID)
				}
				pendingMu.Unlock()
			}
			if g.write(ctx, conn, msg) != nil {
				return
			}
		}
	}()
	defer func() { cancel(); conn.CloseNow(); <-writerDone }()
	for {
		kind, raw, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if kind != websocket.MessageText || !utf8.Valid(raw) {
			_ = conn.Close(websocket.StatusUnsupportedData, "Expected UTF-8 JSON text")
			return
		}
		var public struct {
			Type string `json:"type"`
			ID   string `json:"id"`
		}
		if json.Unmarshal(raw, &public) != nil || public.ID == "" || len(public.ID) > 256 {
			_ = conn.Close(websocket.StatusPolicyViolation, "Invalid request envelope")
			return
		}
		pendingMu.Lock()
		if public.Type != "cancel" {
			if _, exists := pending[public.ID]; exists {
				pendingMu.Unlock()
				_ = conn.Close(websocket.StatusPolicyViolation, "Duplicate active request ID")
				return
			}
			if len(pending) >= 64 {
				pendingMu.Unlock()
				_ = conn.Close(websocket.StatusTryAgainLater, "Request admission limit")
				return
			}
			pending[public.ID] = pendingRequest{mutation: public.Type == "workflow.run" || public.Type == "model.method.run"}
		}
		pendingMu.Unlock()
		// A socket disconnect detaches an accepted run. It must not cancel the
		// private admission exchange and fence every session's engine generation.
		control, stop := context.WithTimeout(context.Background(), g.config.ControlTimeout)
		err = backend.Dispatch(control, session, raw)
		stop()
		if err == nil && public.Type == "cancel" {
			// Legacy cancel(public request ID) detaches its subscription without
			// emitting a terminal frame. Durable run IDs are not entries here.
			pendingMu.Lock()
			delete(pending, public.ID)
			pendingMu.Unlock()
		}
		if err != nil {
			var failure *protocol.Error
			if errors.As(err, &failure) || errors.Is(err, engine.ErrBusy) {
				if failure == nil {
					failure = &protocol.Error{Code: "admission_limit", Message: "Request admission limit reached"}
				}
				payload, _ := json.Marshal(map[string]interface{}{"type": "error", "id": public.ID, "error": failure})
				if g.write(ctx, conn, payload) != nil {
					return
				}
				pendingMu.Lock()
				// A refused cancel did not finish or detach the original request.
				if public.Type != "cancel" {
					delete(pending, public.ID)
				}
				pendingMu.Unlock()
			} else {
				select {
				case <-session.Done():
					<-writerDone
					return
				default:
				}
				pendingMu.Lock()
				p, exists := pending[public.ID]
				delete(pending, public.ID)
				pendingMu.Unlock()
				if exists {
					code, message := "engine_unavailable", "Engine cannot accept requests"
					if p.mutation {
						code = "operation_indeterminate"
						message = "Engine handoff failed; inspect history before retrying"
					}
					payload, _ := json.Marshal(map[string]interface{}{"type": "error", "id": public.ID, "error": map[string]string{"code": code, "message": message}})
					_ = g.write(ctx, conn, payload)
				}
				return
			}
		}
	}
}
func (g *Gateway) write(ctx context.Context, conn *websocket.Conn, msg []byte) error {
	deadline, cancel := context.WithTimeout(ctx, g.config.WriteTimeout)
	defer cancel()
	return conn.Write(deadline, websocket.MessageText, msg)
}
func (g *Gateway) Shutdown() {
	g.mu.Lock()
	g.stopping = true
	connections := make([]*websocket.Conn, 0, len(g.connections))
	for c := range g.connections {
		connections = append(connections, c)
	}
	g.mu.Unlock()
	for _, c := range connections {
		_ = c.CloseNow()
	}
}
