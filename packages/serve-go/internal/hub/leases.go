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
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"sort"
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
	// Manage lets the lease read the hub overview and stop engines, sessions or the hub.
	Manage bool
	// Client and PID name the swamp command that holds the lease, for the overview.
	Client string
	PID    int
	hash   [32]byte
	store  *LeaseStore
	// boundPath serves Scope.Workspace from this repository, registered or not.
	boundPath string
	backend   string
	renewed   time.Time
	holds     map[int]hold
	next      int
	revoked   bool
}

type hold struct {
	stop func()
	page bool
}

func (l *PageLease) Allows(workspace string) bool {
	return l.Scope.All || l.Scope.Workspace == workspace
}

func (l *PageLease) ScopeOf() (bool, string) { return l.Scope.All, l.Scope.Workspace }

func (l *PageLease) CanManage() bool { return l.Manage && l.Scope.All }

func (l *PageLease) LeaseID() string { return l.ID }

// Bound is the repository a lease serves its workspace from, when the
// invoking process named one instead of the registry.
func (l *PageLease) Bound(workspace string) (string, bool) {
	if l.boundPath == "" || l.Scope.All || l.Scope.Workspace != workspace {
		return "", false
	}
	return l.boundPath, true
}

// Backend is the invoking process's loopback start server, if it has one.
func (l *PageLease) Backend() string {
	l.store.mu.Lock()
	defer l.store.mu.Unlock()
	return l.backend
}

// Hold registers a dashboard socket or stream that revoking the lease stops.
func (l *PageLease) Hold(stop func()) (func(), bool) { return l.hold(stop, true) }

// HoldBackend registers a proxied start socket: revocation stops it, but it
// is not an open dashboard page.
func (l *PageLease) HoldBackend(stop func()) (func(), bool) { return l.hold(stop, false) }

func (l *PageLease) hold(stop func(), page bool) (func(), bool) {
	l.store.mu.Lock()
	defer l.store.mu.Unlock()
	if l.revoked {
		return nil, false
	}
	key := l.next
	l.next++
	l.holds[key] = hold{stop: stop, page: page}
	return func() {
		l.store.mu.Lock()
		delete(l.holds, key)
		l.store.mu.Unlock()
	}, true
}

// LeaseStore keys leases by token digest, so a lookup never compares tokens
// byte by byte; the digest match is still confirmed in constant time.
type LeaseStore struct {
	mu     sync.Mutex
	byHash map[[32]byte]*PageLease
	byID   map[string]*PageLease
	// ttl revokes a lease its invoker stopped renewing; zero never expires.
	ttl time.Duration
	now func() time.Time
}

func NewLeaseStore(ttl time.Duration) *LeaseStore {
	return &LeaseStore{byHash: map[[32]byte]*PageLease{}, byID: map[string]*PageLease{}, ttl: ttl, now: time.Now}
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
	return s.IssueWith(LeaseOptions{Scope: scope})
}

// IssueBound issues a lease whose workspace is served from path.
func (s *LeaseStore) IssueBound(scope LeaseScope, path string) (*PageLease, string, error) {
	return s.IssueWith(LeaseOptions{Scope: scope, Path: path})
}

// LeaseOptions describes a lease to issue; Path binds a workspace-scoped lease to a folder.
type LeaseOptions struct {
	Scope  LeaseScope
	Path   string
	Manage bool
	Client string
	PID    int
}

func (s *LeaseStore) IssueWith(options LeaseOptions) (*PageLease, string, error) {
	scope, path := options.Scope, options.Path
	token, err := NewToken()
	if err != nil {
		return nil, "", err
	}
	var id [16]byte
	if _, err := rand.Read(id[:]); err != nil {
		return nil, "", err
	}
	now := s.now()
	lease := &PageLease{ID: hex.EncodeToString(id[:]), Scope: scope, CreatedAt: now, Manage: options.Manage && scope.All, Client: options.Client, PID: options.PID, renewed: now, boundPath: path, hash: sha256.Sum256([]byte(token)), store: s, holds: map[int]hold{}}
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

// LeaseStatus is what the invoking process learns when it renews.
type LeaseStatus struct {
	ID    string `json:"id"`
	Pages int    `json:"pages"`
}

// Renew keeps a lease alive and reports its open dashboard pages.
func (s *LeaseStore) Renew(id string) (LeaseStatus, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	lease := s.byID[id]
	if lease == nil {
		return LeaseStatus{}, false
	}
	lease.renewed = s.now()
	return LeaseStatus{ID: id, Pages: lease.pagesLocked()}, true
}

// pagesLocked is called with store.mu held.
func (l *PageLease) pagesLocked() int {
	pages := 0
	for _, h := range l.holds {
		if h.page {
			pages++
		}
	}
	return pages
}

// LeaseInfo is one lease as the hub overview shows it; it never carries the token.
type LeaseInfo struct {
	ID        string    `json:"id"`
	Client    string    `json:"client,omitempty"`
	PID       int       `json:"pid,omitempty"`
	All       bool      `json:"-"`
	Scope     string    `json:"scope"`
	Workspace string    `json:"workspace,omitempty"`
	Path      string    `json:"path,omitempty"`
	Manage    bool      `json:"manage"`
	Pages     int       `json:"pages"`
	Backend   bool      `json:"backend"`
	CreatedAt time.Time `json:"createdAt"`
	RenewedAt time.Time `json:"renewedAt"`
	ExpiresAt time.Time `json:"expiresAt,omitempty"`
}

// List copies every lease without renewing any.
func (s *LeaseStore) List() []LeaseInfo {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]LeaseInfo, 0, len(s.byID))
	for _, lease := range s.byID {
		info := LeaseInfo{ID: lease.ID, Client: lease.Client, PID: lease.PID, All: lease.Scope.All, Scope: "workspace", Workspace: lease.Scope.Workspace, Path: lease.boundPath, Manage: lease.Manage, Pages: lease.pagesLocked(), Backend: lease.backend != "", CreatedAt: lease.CreatedAt, RenewedAt: lease.renewed}
		if lease.Scope.All {
			info.Scope = "all"
		}
		if s.ttl > 0 {
			info.ExpiresAt = lease.renewed.Add(s.ttl)
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
	return out
}

func (s *LeaseStore) TTL() time.Duration { return s.ttl }

func (s *LeaseStore) SetBackend(id, backend string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	lease := s.byID[id]
	if lease == nil {
		return false
	}
	lease.backend = backend
	lease.renewed = s.now()
	return true
}

func (s *LeaseStore) Count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.byID)
}

// Expire revokes every lease not renewed within the TTL, so an invoker that
// died without revoking never keeps the hub alive.
func (s *LeaseStore) Expire() {
	if s.ttl <= 0 {
		return
	}
	s.mu.Lock()
	cutoff := s.now().Add(-s.ttl)
	var stale []string
	for id, lease := range s.byID {
		if lease.renewed.Before(cutoff) {
			stale = append(stale, id)
		}
	}
	s.mu.Unlock()
	for _, id := range stale {
		s.Revoke(id)
	}
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
	for _, h := range lease.holds {
		stops = append(stops, h.stop)
	}
	lease.holds = map[int]hold{}
	s.mu.Unlock()
	for _, stop := range stops {
		stop()
	}
	return true
}
