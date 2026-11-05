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
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
)

// LeaseScope is every workspace, or exactly one.
type LeaseScope struct {
	All       bool
	Workspace string
}

// PageLease is one dashboard tab's credential, held only in this process.
type PageLease struct {
	ID        string
	Scope     LeaseScope
	CreatedAt time.Time
	hash      [32]byte
	store     *LeaseStore
	holds     map[int]func()
	next      int
	revoked   bool
}

func (l *PageLease) Allows(workspace string) bool {
	return l.Scope.All || l.Scope.Workspace == workspace
}

// Hold registers a socket or stream that revoking the lease stops.
func (l *PageLease) Hold(stop func()) (func(), bool) {
	l.store.mu.Lock()
	defer l.store.mu.Unlock()
	if l.revoked {
		return nil, false
	}
	key := l.next
	l.next++
	l.holds[key] = stop
	return func() {
		l.store.mu.Lock()
		delete(l.holds, key)
		l.store.mu.Unlock()
	}, true
}

// LeaseStore keys leases by token digest, so a lookup never compares tokens
// byte by byte; the digest match is still confirmed in constant time.
type LeaseStore struct {
	mu        sync.Mutex
	byHash    map[[32]byte]*PageLease
	byID      map[string]*PageLease
	adminHash [32]byte
	now       func() time.Time
}

func NewLeaseStore(adminToken string) *LeaseStore {
	return &LeaseStore{byHash: map[[32]byte]*PageLease{}, byID: map[string]*PageLease{}, adminHash: sha256.Sum256([]byte(adminToken)), now: time.Now}
}

// NewToken is 32 random bytes in base64url, the page token format the
// dashboard already carries in its URL fragment.
func NewToken() (string, error) {
	var raw [32]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw[:]), nil
}

func (s *LeaseStore) Issue(scope LeaseScope) (*PageLease, string, error) {
	token, err := NewToken()
	if err != nil {
		return nil, "", err
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, "", err
	}
	lease := &PageLease{ID: hex.EncodeToString(id[:]), Scope: scope, CreatedAt: s.now(), hash: sha256.Sum256([]byte(token)), store: s, holds: map[int]func(){}}
	s.mu.Lock()
	s.byHash[lease.hash] = lease
	s.byID[lease.ID] = lease
	s.mu.Unlock()
	return lease, token, nil
}

func (s *LeaseStore) Lookup(token string) (gateway.Lease, bool) {
	digest := sha256.Sum256([]byte(token))
	s.mu.Lock()
	lease := s.byHash[digest]
	s.mu.Unlock()
	if lease == nil || subtle.ConstantTimeCompare(lease.hash[:], digest[:]) != 1 {
		return nil, false
	}
	return lease, true
}

// Revoke forgets the lease and stops every socket and stream it holds.
func (s *LeaseStore) Revoke(id string) bool {
	s.mu.Lock()
	lease := s.byID[id]
	if lease == nil {
		s.mu.Unlock()
		return false
	}
	delete(s.byID, id)
	delete(s.byHash, lease.hash)
	lease.revoked = true
	stops := make([]func(), 0, len(lease.holds))
	for _, stop := range lease.holds {
		stops = append(stops, stop)
	}
	lease.holds = map[int]func(){}
	s.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
	return true
}

func (s *LeaseStore) admin(r *http.Request) bool {
	auth := r.Header.Get("Authorization")
	if len(auth) <= 7 || !strings.EqualFold(auth[:7], "Bearer ") {
		return false
	}
	digest := sha256.Sum256([]byte(auth[7:]))
	return subtle.ConstantTimeCompare(digest[:], s.adminHash[:]) == 1
}

// ServeHTTP is the admin API: POST /hub/leases issues, DELETE
// /hub/leases/<id> revokes. The gateway serves it to loopback peers only.
func (s *LeaseStore) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !s.admin(r) {
		writeJSON(w, 401, map[string]string{"error": "unauthorized"})
		return
	}
	if r.URL.Path == "/hub/leases" && r.Method == http.MethodPost {
		var body struct {
			Scope     string `json:"scope"`
			Workspace string `json:"workspace"`
		}
		raw, err := io.ReadAll(io.LimitReader(r.Body, 4096))
		if err != nil || json.Unmarshal(raw, &body) != nil {
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
		lease, token, err := s.Issue(scope)
		if err != nil {
			writeJSON(w, 503, map[string]string{"error": "lease_unavailable"})
			return
		}
		writeJSON(w, 201, map[string]string{"id": lease.ID, "token": token})
		return
	}
	if id, ok := strings.CutPrefix(r.URL.Path, "/hub/leases/"); ok && r.Method == http.MethodDelete {
		if !s.Revoke(id) {
			writeJSON(w, 404, map[string]string{"error": "unknown_lease"})
			return
		}
		w.WriteHeader(204)
		return
	}
	writeJSON(w, 404, map[string]string{"error": "unsupported_endpoint"})
}

func writeJSON(w http.ResponseWriter, status int, value interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
