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
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/coder/websocket"
)

// StartTokenHeader carries a lease token on a start-page liveness probe.
const StartTokenHeader = "X-Swamp-Start-Token"

// serveLocal answers the routes a dashboard tab loads outside any workspace:
// the bundle, the workspace switcher, and the invoking process's start page.
// It reports false for any other path.
func (g *Gateway) serveLocal(w http.ResponseWriter, r *http.Request) bool {
	path := r.URL.Path
	switch {
	case path == "/":
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			return false
		}
		if g.guardLocal(w, r) {
			http.Redirect(w, r, "/dashboard/start", http.StatusFound)
		}
	case path == "/dashboard" || strings.HasPrefix(path, "/dashboard/"):
		g.serveAsset(w, r)
	case path == "/api/local/workspaces":
		g.serveWorkspaces(w, r)
	case path == "/start/ping":
		g.proxyStartPing(w, r)
	case path == "/start/ws":
		if g.guardLocal(w, r) {
			writeText(w, 426, "Upgrade required")
		}
	default:
		return false
	}
	return true
}

// serveAsset needs no lease: the bundle is public and the page carries its
// token in the URL fragment, which the browser never sends.
func (g *Gateway) serveAsset(w http.ResponseWriter, r *http.Request) {
	if !g.guardLocal(w, r) {
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		writeText(w, 405, "Method not allowed")
		return
	}
	subPath := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, "/dashboard"), "/")
	ctx, cancel := context.WithTimeout(r.Context(), g.config.AuthTimeout)
	defer cancel()
	asset, err := g.config.Site.Asset(ctx, subPath)
	switch {
	case errors.Is(err, ErrAssetForbidden):
		writeText(w, 403, "Forbidden")
		return
	case errors.Is(err, ErrAssetsUnavailable):
		writeText(w, 404, "Dashboard assets not available in this build")
		return
	case err != nil:
		writeRouteFailure(w, err)
		return
	}
	w.Header().Set("Content-Type", asset.ContentType)
	w.Header().Set("Cache-Control", asset.CacheControl)
	w.WriteHeader(200)
	if r.Method == http.MethodGet {
		_, _ = w.Write(asset.Body)
	}
}

func (g *Gateway) serveWorkspaces(w http.ResponseWriter, r *http.Request) {
	token, _, _ := classifyPage(r)
	lease, ok := g.guardLease(w, r, token)
	if !ok {
		return
	}
	if r.Method != http.MethodGet {
		writeText(w, 404, "Not found")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), g.config.AuthTimeout)
	defer cancel()
	workspaces, switchable, err := g.config.Site.Workspaces(ctx, lease)
	if err != nil {
		writeRouteFailure(w, err)
		return
	}
	writeJSON(w, 200, map[string]interface{}{"workspaces": workspaces, "switchable": switchable})
}

func (g *Gateway) proxyStartPing(w http.ResponseWriter, r *http.Request) {
	lease, ok := g.guardLease(w, r, r.Header.Get(StartTokenHeader))
	if !ok {
		return
	}
	backend := lease.Backend()
	if backend == "" {
		writeText(w, 401, "Unauthorized")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), g.config.ControlTimeout)
	defer cancel()
	ping, err := http.NewRequestWithContext(ctx, r.Method, backend+"/start/ping", nil)
	if err != nil {
		writeText(w, 502, "Bad gateway")
		return
	}
	ping.Header.Set(StartTokenHeader, r.Header.Get(StartTokenHeader))
	response, err := http.DefaultClient.Do(ping)
	if err != nil {
		writeText(w, 502, "Bad gateway")
		return
	}
	_ = response.Body.Close()
	w.WriteHeader(response.StatusCode)
}

// proxyStartSocket bridges the start page's socket to the process that
// registered the lease: the start flows stay in that process, unchanged.
func (g *Gateway) proxyStartSocket(w http.ResponseWriter, r *http.Request) {
	_, subprotocol, _ := classifyPage(r)
	token := strings.TrimPrefix(subprotocol, "bearer.")
	lease, ok := g.guardLease(w, r, token)
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
	backend := lease.Backend()
	if backend == "" {
		writeText(w, 404, "Not found")
		return
	}
	release, admitted := g.admit(w)
	if !admitted {
		return
	}
	defer release()
	dialCtx, cancelDial := context.WithTimeout(r.Context(), g.config.ControlTimeout)
	upstream, response, err := websocket.Dial(dialCtx, "ws"+strings.TrimPrefix(backend, "http")+"/start/ws", &websocket.DialOptions{
		Subprotocols:    []string{subprotocol},
		CompressionMode: websocket.CompressionDisabled,
	})
	cancelDial()
	if err != nil {
		status := 502
		if response != nil && response.StatusCode >= 400 {
			status = response.StatusCode
		}
		writeText(w, status, http.StatusText(status))
		return
	}
	defer upstream.CloseNow()
	upstream.SetReadLimit(-1)
	opts := &websocket.AcceptOptions{InsecureSkipVerify: true, CompressionMode: websocket.CompressionDisabled}
	if chosen := upstream.Subprotocol(); chosen != "" {
		opts.Subprotocols = []string{chosen}
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
	conn.SetReadLimit(-1)
	unhold, held := lease.HoldBackend(func() {
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
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{}, 2)
	pipe := func(from, to *websocket.Conn) {
		defer func() { done <- struct{}{} }()
		for {
			kind, data, err := from.Read(ctx)
			if err != nil {
				status := websocket.CloseStatus(err)
				if status == -1 {
					status = websocket.StatusGoingAway
				}
				_ = to.Close(status, "")
				return
			}
			if err := to.Write(ctx, kind, data); err != nil {
				return
			}
		}
	}
	go pipe(conn, upstream)
	go pipe(upstream, conn)
	<-done
	cancel()
	<-done
}
