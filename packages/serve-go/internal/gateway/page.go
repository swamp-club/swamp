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

package gateway

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/coder/websocket"
	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

// LocalTokenHeader carries a page lease on a dashboard tab's HTTP requests.
const LocalTokenHeader = "X-Swamp-Local-Token"

// Lease is a dashboard tab's credential. The hub checks it; engines never see it.
type Lease interface {
	Allows(workspace string) bool
	// ScopeOf is every workspace, or the one workspace the lease names.
	ScopeOf() (all bool, workspace string)
	// Bound is the folder the lease serves its workspace from, if it names one.
	Bound(workspace string) (path string, ok bool)
	// Backend is the invoking process's loopback start server, or "".
	Backend() string
	// Hold registers a live dashboard socket or stream that revoking the lease stops.
	Hold(stop func()) (release func(), ok bool)
	// HoldBackend registers a proxied start socket, which is not a dashboard page.
	HoldBackend(stop func()) (release func(), ok bool)
	// CanManage lets the lease read the hub overview and act on the hub.
	CanManage() bool
	LeaseID() string
	// Touch renews a lease its page keeps alive itself; others ignore it.
	Touch()
}

type Leases interface {
	Lookup(token string) (Lease, bool)
}

// PageBackend serves one workspace's dashboard tabs.
type PageBackend interface {
	OpenPage(ctx context.Context, ip string, oneShot bool) (*engine.Session, error)
	Close(context.Context, *engine.Session) error
	Dispatch(context.Context, *engine.Session, []byte) error
	DispatchHTTP(context.Context, *engine.Session, []byte) error
	Health(context.Context) (json.RawMessage, error)
}

// PageRouter is a Router that also serves dashboard tabs.
type PageRouter interface {
	// PageWorkspace names the workspace a path addresses, resolving nothing.
	PageWorkspace(path string) (workspace, rest string, ok bool)
	RoutePage(ctx context.Context, lease Lease, workspace string) (PageBackend, error)
}

// Asset is one dashboard bundle file.
type Asset struct {
	ContentType  string
	CacheControl string
	Body         []byte
}

// LocalWorkspace is one entry of the workspace switcher.
type LocalWorkspace struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

var (
	ErrAssetsUnavailable = errors.New("dashboard assets unavailable")
	ErrAssetForbidden    = errors.New("dashboard asset outside the bundle")
)

// HubSite is the hub overview a manage lease reads and acts through.
type HubSite interface {
	Overview(ctx context.Context, lease Lease) (interface{}, error)
	StopEngine(id string) bool
	RevokeLease(id string) bool
	StopHub() error
}

// ErrHubIsService refuses to stop a hub a service manager would restart.
var ErrHubIsService = errors.New("hub runs as a user service")

// Site serves what a dashboard tab loads outside any workspace.
type Site interface {
	Asset(ctx context.Context, path string) (Asset, error)
	Workspaces(ctx context.Context, lease Lease) ([]LocalWorkspace, bool, error)
}

var page = servecontract.Page()
var pageLimits = servecontract.PageLimitsOf()

func setOf(values []string) map[string]bool {
	set := make(map[string]bool, len(values))
	for _, value := range values {
		set[value] = true
	}
	return set
}

var (
	pageOperations = setOf(page.Operations)
	pageReads      = setOf(page.Reads)
)

// classifyPage reports a page credential, decided by carrier and shape alone:
// the local-token header, or a bearer subprotocol whose token has no dot. A
// serve token always has one, and Authorization is only ever cli.
func classifyPage(r *http.Request) (token, subprotocol string, ok bool) {
	if header := r.Header.Get(LocalTokenHeader); header != "" {
		return header, "", true
	}
	auth := r.Header.Get("Authorization")
	if len(auth) > 7 && strings.EqualFold(auth[:7], "Bearer ") {
		return "", "", false
	}
	for _, part := range strings.Split(r.Header.Get("Sec-WebSocket-Protocol"), ",") {
		part = strings.TrimSpace(part)
		if strings.HasPrefix(part, "bearer.") && len(part) > 7 {
			if strings.Contains(part[7:], ".") {
				return "", "", false
			}
			return part[7:], part, true
		}
	}
	return "", "", false
}

func (g *Gateway) pages() (PageRouter, bool) {
	if g.config.Leases == nil {
		return nil, false
	}
	router, ok := g.router.(PageRouter)
	return router, ok
}

func loopbackPeer(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func peerIP(r *http.Request) string {
	ip, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return ip
}

func writeText(w http.ResponseWriter, status int, text string) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, text)
}

type pageRequest struct {
	lease     Lease
	workspace string
	rest      string
}

// guardLocal admits only this machine's browser addressing the hub by its own
// authority, which defeats DNS rebinding.
func (g *Gateway) guardLocal(w http.ResponseWriter, r *http.Request) bool {
	if !loopbackPeer(r) {
		writeJSON(w, 404, map[string]string{"error": "unsupported_endpoint", "profile": g.config.profile()})
		return false
	}
	port := g.port.Load()
	if port == 0 || (r.Host != fmt.Sprintf("127.0.0.1:%d", port) && r.Host != fmt.Sprintf("localhost:%d", port)) {
		writeText(w, 421, "Misdirected request")
		return false
	}
	return true
}

func (g *Gateway) guardLease(w http.ResponseWriter, r *http.Request, token string) (Lease, bool) {
	if !g.guardLocal(w, r) {
		return nil, false
	}
	var lease Lease
	if token != "" && len(token) <= 512 {
		lease, _ = g.config.Leases.Lookup(token)
	}
	if lease == nil {
		writeText(w, 401, "Unauthorized")
		return nil, false
	}
	lease.Touch()
	return lease, true
}

// guardPage refuses in a fixed order before anything resolves, so a probe
// without a lease never wakes the control engine or a workspace engine.
func (g *Gateway) guardPage(w http.ResponseWriter, r *http.Request, router PageRouter, token string) (pageRequest, bool) {
	lease, ok := g.guardLease(w, r, token)
	if !ok {
		return pageRequest{}, false
	}
	workspace, rest, ok := router.PageWorkspace(r.URL.Path)
	if !ok {
		writeJSON(w, 404, map[string]string{"error": "workspace_required"})
		return pageRequest{}, false
	}
	// Worded as the dashboard child's hub did: a lease never learns whether
	// a workspace outside its scope exists.
	if !lease.Allows(workspace) {
		writeText(w, 404, "No workspace named "+workspace)
		return pageRequest{}, false
	}
	return pageRequest{lease: lease, workspace: workspace, rest: rest}, true
}

func (g *Gateway) routePage(w http.ResponseWriter, ctx context.Context, router PageRouter, request pageRequest) (PageBackend, bool) {
	backend, err := router.RoutePage(ctx, request.lease, request.workspace)
	var refusal *RouteError
	if errors.As(err, &refusal) && refusal.Code == "unknown_workspace" {
		writeText(w, 404, "No workspace named "+request.workspace)
		return nil, false
	}
	if err != nil {
		writeRouteFailure(w, err)
		return nil, false
	}
	return backend, true
}

func writeRouteFailure(w http.ResponseWriter, err error) {
	var refusal *RouteError
	if errors.As(err, &refusal) {
		writeJSON(w, refusal.Status, map[string]string{"error": refusal.Code})
		return
	}
	// An untrusted workspace whose datastore is extension code cannot open.
	var startup *protocol.Error
	if errors.As(err, &startup) && startup.Code == "workspace_untrusted" {
		writeJSON(w, 403, map[string]string{"error": startup.Code})
		return
	}
	writeJSON(w, 503, map[string]string{"error": "engine_unavailable"})
}

func (g *Gateway) upgradePage(w http.ResponseWriter, r *http.Request, router PageRouter, token, subprotocol string) {
	request, ok := g.guardPage(w, r, router, token)
	if !ok {
		return
	}
	scheme := "http"
	if g.config.TLS {
		scheme = "https"
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != scheme+"://"+r.Host {
		writeText(w, 403, "Forbidden origin")
		return
	}
	key, keyErr := base64.StdEncoding.DecodeString(r.Header.Get("Sec-WebSocket-Key"))
	if keyErr != nil || len(key) != 16 || r.Header.Get("Sec-WebSocket-Version") != "13" || !headerContains(r.Header.Get("Connection"), "upgrade") {
		writeJSON(w, 400, map[string]string{"error": "invalid_upgrade"})
		return
	}
	release, admitted := g.admit(w)
	if !admitted {
		return
	}
	defer release()
	ctx, cancel := context.WithTimeout(context.Background(), g.config.AuthTimeout)
	backend, ok := g.routePage(w, ctx, router, request)
	if !ok {
		cancel()
		return
	}
	session, err := backend.OpenPage(ctx, peerIP(r), false)
	cancel()
	if err != nil {
		writeRouteFailure(w, err)
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), g.config.ControlTimeout)
		defer cancel()
		_ = backend.Close(ctx, session)
	}()
	opts := &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled}
	if subprotocol != "" {
		opts.Subprotocols = []string{subprotocol}
	}
	if err := http.NewResponseController(w).SetWriteDeadline(time.Now().Add(g.config.WriteTimeout)); err != nil {
		writeJSON(w, 503, map[string]string{"error": "upgrade_unavailable"})
		return
	}
	conn, err := websocket.Accept(w, r, opts)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(protocol.MaxFrameBytes - 1024)
	// Revoking returns at once; the close handshake finishes on its own.
	unhold, held := request.lease.Hold(func() {
		go func() { _ = conn.Close(websocket.StatusPolicyViolation, "Lease revoked") }()
	})
	if !held {
		_ = conn.Close(websocket.StatusPolicyViolation, "Lease revoked")
		return
	}
	defer unhold()
	if !g.track(conn) {
		return
	}
	defer g.untrack(conn)
	g.serve(conn, backend, session, &connection{page: true, gzip: r.URL.Query().Get("compress") == "gzip"})
}

// admit reserves an admission slot unless the gateway is stopping or full.
func (g *Gateway) admit(w http.ResponseWriter) (func(), bool) {
	g.mu.Lock()
	stopping := g.stopping
	g.mu.Unlock()
	if stopping {
		writeJSON(w, 503, map[string]string{"error": "draining"})
		return nil, false
	}
	select {
	case g.admissions <- struct{}{}:
		return func() { <-g.admissions }, true
	default:
		writeJSON(w, 503, map[string]string{"error": "connection_limit"})
		return nil, false
	}
}

func (g *Gateway) track(conn *websocket.Conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.stopping {
		return false
	}
	g.connections[conn] = struct{}{}
	return true
}

func (g *Gateway) untrack(conn *websocket.Conn) {
	g.mu.Lock()
	delete(g.connections, conn)
	g.mu.Unlock()
}

// servePageHTTP answers a dashboard tab's HTTP routes, as the dashboard child did.
func (g *Gateway) servePageHTTP(w http.ResponseWriter, r *http.Request, router PageRouter) {
	token, _, _ := classifyPage(r)
	request, ok := g.guardPage(w, r, router, token)
	if !ok {
		return
	}
	switch {
	case request.rest == "/auth/info" && r.Method == http.MethodGet:
		writeJSON(w, 200, map[string]interface{}{"mode": "none", "local": true})
	case request.rest == "/auth/dashboard/session":
		w.WriteHeader(401)
	case request.rest == "/api/v1/request" && strings.EqualFold(r.Method, http.MethodPost):
		g.pageRequestRoute(w, r, router, request)
	case request.rest == "/api/v1/health" && r.Method == http.MethodGet:
		g.pageHealth(w, r, router, request)
	case request.rest == "/api/v1/health/stream" && r.Method == http.MethodGet:
		g.pageHealthStream(w, r, router, request)
	default:
		writeText(w, 404, "Not found")
	}
}

func httpFailure(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

// pageRequestRoute is the HTTP request route for big dashboard reads: one
// one-shot page session per request, its frames streamed as NDJSON.
func (g *Gateway) pageRequestRoute(w http.ResponseWriter, r *http.Request, router PageRouter, request pageRequest) {
	body, err := io.ReadAll(io.LimitReader(r.Body, int64(pageLimits.HTTPRequestBodyBytes)+1))
	if err != nil || len(body) > pageLimits.HTTPRequestBodyBytes {
		if err == nil {
			httpFailure(w, 413, "payload_too_large", fmt.Sprintf("Request body exceeds %d bytes", pageLimits.HTTPRequestBodyBytes))
		} else {
			httpFailure(w, 400, "invalid_request", "Invalid request")
		}
		return
	}
	var frame struct {
		Type *string `json:"type"`
		ID   *string `json:"id"`
	}
	if json.Unmarshal(body, &frame) != nil || frame.Type == nil || frame.ID == nil {
		httpFailure(w, 400, "invalid_request", "Invalid request")
		return
	}
	if !pageReads[*frame.Type] {
		httpFailure(w, 404, "use_websocket", strings.ReplaceAll(page.HTTPRefusalMessage, "${type}", *frame.Type))
		return
	}
	if !g.httpSlot(request.workspace, true) {
		httpFailure(w, 429, "use_websocket", fmt.Sprintf("Over %d requests in flight on HTTP; send it over the WebSocket", pageLimits.HTTPRequestsInFlight))
		return
	}
	defer g.httpSlot(request.workspace, false)
	ctx, cancel := context.WithTimeout(r.Context(), g.config.AuthTimeout)
	backend, ok := g.routePage(w, ctx, router, request)
	if !ok {
		cancel()
		return
	}
	session, err := backend.OpenPage(ctx, peerIP(r), true)
	if err != nil {
		cancel()
		writeRouteFailure(w, err)
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), g.config.ControlTimeout)
		defer cancel()
		_ = backend.Close(ctx, session)
	}()
	err = backend.DispatchHTTP(ctx, session, body)
	cancel()
	if err != nil {
		var refusal *protocol.Error
		if errors.As(err, &refusal) {
			switch refusal.Code {
			case "invalid_request":
				httpFailure(w, 400, refusal.Code, refusal.Message)
				return
			case "use_websocket":
				httpFailure(w, 404, refusal.Code, refusal.Message)
				return
			}
		}
		writeJSON(w, 503, map[string]string{"error": "engine_unavailable"})
		return
	}
	stream, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()
	unhold, held := request.lease.Hold(cancelStream)
	if !held {
		writeText(w, 401, "Unauthorized")
		return
	}
	defer unhold()
	w.Header().Set("Content-Type", "application/x-ndjson")
	var out io.Writer = w
	var compressed *gzip.Writer
	if acceptsGzip(r) {
		w.Header().Set("Content-Encoding", "gzip")
		compressed = gzip.NewWriter(w)
		out = compressed
	}
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	for {
		msg, err := session.Receive(stream)
		if err != nil {
			break
		}
		_ = controller.SetWriteDeadline(time.Now().Add(g.config.WriteTimeout))
		if _, err := out.Write(append(msg, '\n')); err != nil {
			return
		}
		if compressed != nil {
			_ = compressed.Flush()
		}
		_ = controller.Flush()
	}
	if compressed != nil {
		_ = compressed.Close()
	}
}

func acceptsGzip(r *http.Request) bool {
	for _, encoding := range strings.Split(r.Header.Get("Accept-Encoding"), ",") {
		name, _, _ := strings.Cut(strings.TrimSpace(encoding), ";")
		if name == "gzip" {
			return true
		}
	}
	return false
}

// httpSlot bounds unread HTTP replies per workspace, as the child's slot did.
func (g *Gateway) httpSlot(workspace string, take bool) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if !take {
		g.httpInFlight[workspace]--
		if g.httpInFlight[workspace] <= 0 {
			delete(g.httpInFlight, workspace)
		}
		return true
	}
	if g.httpInFlight[workspace] >= pageLimits.HTTPRequestsInFlight {
		return false
	}
	g.httpInFlight[workspace]++
	return true
}

func (g *Gateway) pageHealth(w http.ResponseWriter, r *http.Request, router PageRouter, request pageRequest) {
	ctx, cancel := context.WithTimeout(r.Context(), g.config.AuthTimeout)
	defer cancel()
	backend, ok := g.routePage(w, ctx, router, request)
	if !ok {
		return
	}
	snapshot, err := backend.Health(ctx)
	if err != nil {
		writeRouteFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(200)
	_, _ = w.Write(snapshot)
}

// HealthStreamInterval clamps a requested interval as the TypeScript stream does.
func HealthStreamInterval(param string, present bool) time.Duration {
	const fallback = 5000
	if !present {
		return fallback * time.Millisecond
	}
	parsed, ok := parseLeadingInt(param)
	if !ok {
		return fallback * time.Millisecond
	}
	return time.Duration(min(60000, max(1000, parsed))) * time.Millisecond
}

// parseLeadingInt reads an integer prefix the way JavaScript's parseInt does.
func parseLeadingInt(value string) (int64, bool) {
	value = strings.TrimLeftFunc(value, unicode.IsSpace)
	end := 0
	if end < len(value) && (value[end] == '-' || value[end] == '+') {
		end++
	}
	digits := end
	for end < len(value) && value[end] >= '0' && value[end] <= '9' {
		end++
	}
	if end == digits {
		return 0, false
	}
	parsed, err := strconv.ParseInt(value[:end], 10, 64)
	if err != nil {
		if strings.HasPrefix(value, "-") {
			return -1 << 62, true
		}
		return 1 << 62, true
	}
	return parsed, true
}

// pageHealthStream polls the engine at the requested interval. It holds a page
// session while open, so the engine never idles out under a watching tab.
func (g *Gateway) pageHealthStream(w http.ResponseWriter, r *http.Request, router PageRouter, request pageRequest) {
	interval := HealthStreamInterval(r.URL.Query().Get("interval"), r.URL.Query().Has("interval"))
	var eventID int64
	if last := r.Header.Get("Last-Event-ID"); last != "" {
		if parsed, ok := parseLeadingInt(last); ok {
			eventID = parsed
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), g.config.AuthTimeout)
	backend, ok := g.routePage(w, ctx, router, request)
	if !ok {
		cancel()
		return
	}
	session, err := backend.OpenPage(ctx, peerIP(r), false)
	cancel()
	if err != nil {
		writeRouteFailure(w, err)
		return
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), g.config.ControlTimeout)
		defer cancel()
		_ = backend.Close(ctx, session)
	}()
	stream, cancelStream := context.WithCancel(r.Context())
	defer cancelStream()
	unhold, held := request.lease.Hold(cancelStream)
	if !held {
		writeText(w, 401, "Unauthorized")
		return
	}
	defer unhold()
	g.mu.Lock()
	if g.stopping {
		g.mu.Unlock()
		writeJSON(w, 503, map[string]string{"error": "draining"})
		return
	}
	g.streams[&cancelStream] = cancelStream
	g.mu.Unlock()
	defer func() { g.mu.Lock(); delete(g.streams, &cancelStream); g.mu.Unlock() }()
	header := w.Header()
	header.Set("Content-Type", "text/event-stream")
	header.Set("Cache-Control", "no-cache")
	header.Set("Connection", "keep-alive")
	header.Set("X-Accel-Buffering", "no")
	header.Set("X-Health-Interval", strconv.FormatInt(interval.Milliseconds(), 10))
	w.WriteHeader(200)
	controller := http.NewResponseController(w)
	_ = controller.Flush()
	timer := time.NewTimer(0)
	defer timer.Stop()
	for {
		select {
		case <-stream.Done():
			return
		case <-session.Done():
			return
		case <-timer.C:
		}
		collect, cancelCollect := context.WithTimeout(stream, g.config.ControlTimeout)
		snapshot, err := backend.Health(collect)
		cancelCollect()
		// A failed collection skips this tick, as the TypeScript stream does.
		if err == nil {
			var compact bytes.Buffer
			if json.Compact(&compact, snapshot) == nil {
				eventID++
				_ = controller.SetWriteDeadline(time.Now().Add(g.config.WriteTimeout))
				if _, err := fmt.Fprintf(w, "id: %d\nevent: health\ndata: %s\n\n", eventID, compact.Bytes()); err != nil {
					return
				}
				if controller.Flush() != nil {
					return
				}
			}
		}
		timer.Reset(interval)
	}
}

// gzipFrame compresses a frame that asked for it, at the TypeScript threshold.
func gzipFrame(msg []byte) ([]byte, bool) {
	if len(msg) < pageLimits.CompressionThresholdBytes {
		return msg, false
	}
	var buffer bytes.Buffer
	writer := gzip.NewWriter(&buffer)
	if _, err := writer.Write(msg); err != nil {
		return msg, false
	}
	if err := writer.Close(); err != nil {
		return msg, false
	}
	return buffer.Bytes(), true
}

// pageRefusal is the not_available_locally frame swamp-uat pins.
func pageRefusal(id, requestType string) []byte {
	payload, _ := json.Marshal(map[string]interface{}{"type": "error", "id": id, "error": map[string]string{
		"code":    "not_available_locally",
		"message": strings.ReplaceAll(page.RefusalMessage, "${type}", requestType),
	}})
	return payload
}

type connection struct {
	page bool
	gzip bool
	// forwarded holds this page socket's read ids: the only ids its cancel names.
	forwarded map[string]bool
	mu        sync.Mutex
}
