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
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// leaseClients are the swamp commands that take leases, as the overview names them.
var leaseClients = map[string]bool{"start": true, "dashboard": true, "hub": true}

// ErrShutdownRefused answers a shutdown request the hub won't honour.
var ErrShutdownRefused = errors.New("shutdown refused")

// Admin is the loopback API the swamp CLI drives: page leases, a ping that
// identifies the hub, and a shutdown for a hub it launched.
type Admin struct {
	Leases *LeaseStore
	// Inspect resolves a folder to a repository realpath, through the control engine.
	Inspect  func(ctx context.Context, path string) (string, error)
	Info     func() interface{}
	Shutdown func() error
	Timeout  time.Duration
	hash     [32]byte
}

func NewAdmin(adminToken string, leases *LeaseStore) *Admin {
	return &Admin{Leases: leases, hash: sha256.Sum256([]byte(adminToken)), Timeout: 10 * time.Second}
}

func (a *Admin) authorized(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if len(auth) <= 7 || !strings.EqualFold(auth[:7], "Bearer ") {
		return false
	}
	digest := sha256.Sum256([]byte(auth[7:]))
	return subtle.ConstantTimeCompare(digest[:], a.hash[:]) == 1
}

func readBody(r *http.Request, value interface{}) bool {
	raw, err := io.ReadAll(io.LimitReader(r.Body, 4096))
	return err == nil && json.Unmarshal(raw, value) == nil
}

// loopbackBackend accepts only http://127.0.0.1:<port>, the start server's
// own listener, so a lease can never proxy anywhere else.
func loopbackBackend(raw string) (string, bool) {
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "http" || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return "", false
	}
	host, port, err := net.SplitHostPort(parsed.Host)
	if err != nil || host != "127.0.0.1" {
		return "", false
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return "", false
	}
	return "http://" + parsed.Host, true
}

// ServeHTTP is mounted at /hub/; the gateway serves it to loopback peers only.
func (a *Admin) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !a.authorized(r) {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	path := r.URL.Path
	switch {
	case path == "/hub/ping" && r.Method == http.MethodGet:
		var info interface{} = map[string]string{}
		if a.Info != nil {
			info = a.Info()
		}
		writeJSON(w, 200, info)
	case path == "/hub/shutdown" && r.Method == http.MethodPost:
		if a.Shutdown == nil || a.Shutdown() != nil {
			writeJSON(w, 409, map[string]string{"error": "shutdown_refused"})
			return
		}
		w.WriteHeader(202)
	case path == "/hub/leases" && r.Method == http.MethodPost:
		a.issue(w, r)
	default:
		id, sub, _ := strings.Cut(strings.TrimPrefix(path, "/hub/leases/"), "/")
		if !strings.HasPrefix(path, "/hub/leases/") || id == "" {
			writeJSON(w, 404, map[string]string{"error": "unsupported_endpoint"})
			return
		}
		switch {
		case sub == "" && r.Method == http.MethodGet:
			status, ok := a.Leases.Renew(id)
			if !ok {
				writeJSON(w, 404, map[string]string{"error": "unknown_lease"})
				return
			}
			writeJSON(w, 200, status)
		case sub == "" && r.Method == http.MethodDelete:
			if !a.Leases.Revoke(id) {
				writeJSON(w, 404, map[string]string{"error": "unknown_lease"})
				return
			}
			w.WriteHeader(204)
		case sub == "backend" && r.Method == http.MethodPut:
			var body struct {
				URL string `json:"url"`
			}
			backend, ok := "", readBody(r, &body)
			if ok {
				backend, ok = loopbackBackend(body.URL)
			}
			if !ok {
				writeJSON(w, 400, map[string]string{"error": "invalid_backend"})
				return
			}
			if !a.Leases.SetBackend(id, backend) {
				writeJSON(w, 404, map[string]string{"error": "unknown_lease"})
				return
			}
			w.WriteHeader(204)
		default:
			writeJSON(w, 404, map[string]string{"error": "unsupported_endpoint"})
		}
	}
}

func (a *Admin) issue(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Scope     string `json:"scope"`
		Workspace string `json:"workspace"`
		Path      string `json:"path"`
		Manage    bool   `json:"manage"`
		Client    string `json:"client"`
		PID       int    `json:"pid"`
		// PageRenewed lets the page keep the lease alive after its command exits.
		PageRenewed bool `json:"pageRenewed"`
	}
	if !readBody(r, &body) || body.PID < 0 || (body.Client != "" && !leaseClients[body.Client]) {
		writeJSON(w, 400, map[string]string{"error": "invalid_request"})
		return
	}
	var scope LeaseScope
	switch body.Scope {
	case "all":
		scope.All = true
	case "workspace":
		if !namePattern.MatchString(body.Workspace) {
			writeJSON(w, 400, map[string]string{"error": "invalid_workspace"})
			return
		}
		scope.Workspace = body.Workspace
	default:
		writeJSON(w, 400, map[string]string{"error": "invalid_scope"})
		return
	}
	if body.Manage && !scope.All {
		writeJSON(w, 400, map[string]string{"error": "invalid_scope"})
		return
	}
	bound := ""
	if body.Path != "" {
		if scope.All || a.Inspect == nil {
			writeJSON(w, 400, map[string]string{"error": "invalid_scope"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), a.Timeout)
		path, err := a.Inspect(ctx, body.Path)
		cancel()
		if errors.Is(err, ErrNotARepo) {
			writeJSON(w, 400, map[string]string{"error": "not_a_repo"})
			return
		}
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "engine_unavailable"})
			return
		}
		bound = path
	}
	lease, token, err := a.Leases.IssueWith(LeaseOptions{Scope: scope, Path: bound, Manage: body.Manage, Client: body.Client, PID: body.PID, PageRenewed: body.PageRenewed})
	if err != nil {
		writeJSON(w, 503, map[string]string{"error": "lease_unavailable"})
		return
	}
	writeJSON(w, 201, map[string]string{"id": lease.ID, "token": token})
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
