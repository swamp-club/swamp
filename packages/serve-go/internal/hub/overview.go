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
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
)

const (
	logTailBytes = 64 << 10
	logTailLines = 200
)

// OverviewConfig is what the hub overview reports about the hub process itself.
type OverviewConfig struct {
	StartedAt    time.Time
	ExitWhenIdle time.Duration
	LogFile      string
	Info         func() interface{}
	// Stop ends the hub; it returns gateway.ErrHubIsService when a service manager owns it.
	Stop func() error
}

type overviewEngine struct {
	ID         string     `json:"id"`
	State      string     `json:"state"`
	Ready      bool       `json:"ready"`
	Running    bool       `json:"running"`
	PID        int        `json:"pid,omitempty"`
	StartedAt  *time.Time `json:"startedAt,omitempty"`
	LastUsed   *time.Time `json:"lastUsed,omitempty"`
	Sessions   int        `json:"sessions"`
	Pages      int        `json:"pages"`
	Generation string     `json:"generation,omitempty"`
	Starts     uint64     `json:"starts"`
}

type overviewWorkspace struct {
	Name      string          `json:"name"`
	Path      string          `json:"path"`
	Trusted   bool            `json:"trusted"`
	Temporary bool            `json:"temporary"`
	Missing   bool            `json:"missing"`
	Engine    *overviewEngine `json:"engine"`
}

type overviewLease struct {
	LeaseInfo
	Self bool `json:"self"`
}

type overviewLog struct {
	Path  string   `json:"path"`
	Lines []string `json:"lines"`
}

type overviewHub struct {
	Info         interface{} `json:"info"`
	StartedAt    time.Time   `json:"startedAt"`
	ExitWhenIdle string      `json:"exitWhenIdle,omitempty"`
	LeaseTTL     string      `json:"leaseTtl,omitempty"`
}

// Overview is everything the hub manages, for a manage lease's dashboard.
func (s *Site) Overview(ctx context.Context, lease gateway.Lease) (interface{}, error) {
	hubInfo := overviewHub{StartedAt: s.Overviews.StartedAt}
	if s.Overviews.Info != nil {
		hubInfo.Info = s.Overviews.Info()
	}
	if s.Overviews.ExitWhenIdle > 0 {
		hubInfo.ExitWhenIdle = s.Overviews.ExitWhenIdle.String()
	}
	var leases []LeaseInfo
	if s.Leases != nil {
		leases = s.Leases.List()
		if ttl := s.Leases.TTL(); ttl > 0 {
			hubInfo.LeaseTTL = ttl.String()
		}
	}
	listed, listErr := s.Control.List(ctx)
	result := map[string]interface{}{
		"hub":        hubInfo,
		"workspaces": mergeWorkspaces(listed, s.Hub.Engines(), leases),
		"leases":     markSelf(leases, lease.LeaseID()),
		"log":        tailLog(s.Overviews.LogFile),
	}
	if listErr != nil {
		result["registryError"] = "The workspace list could not be read: " + listErr.Error()
	}
	return result, nil
}

func engineView(info EngineInfo) *overviewEngine {
	view := &overviewEngine{ID: info.ID, State: info.Snapshot.State, Ready: info.Snapshot.Ready, Running: info.Running, PID: info.Details.PID, Sessions: info.Details.Sessions, Pages: info.Details.Pages, Generation: info.Snapshot.Generation, Starts: info.Snapshot.Starts}
	if !info.Details.StartedAt.IsZero() {
		started := info.Details.StartedAt
		view.StartedAt = &started
	}
	if !info.LastUsed.IsZero() {
		used := info.LastUsed
		view.LastUsed = &used
	}
	return view
}

// mergeWorkspaces lists registered repositories, then lease-bound folders,
// then engines whose registered folder is gone.
func mergeWorkspaces(listed []Workspace, engines []EngineInfo, leases []LeaseInfo) []overviewWorkspace {
	registered := map[string]*EngineInfo{}
	temporary := map[string]*EngineInfo{}
	for i := range engines {
		if engines[i].Temporary {
			temporary[engines[i].Workspace.Path] = &engines[i]
		} else {
			registered[engines[i].Workspace.Name] = &engines[i]
		}
	}
	rows := make([]overviewWorkspace, 0, len(listed)+len(engines))
	for _, w := range listed {
		row := overviewWorkspace{Name: w.Name, Path: w.Path, Trusted: w.Trusted}
		if e := registered[w.Name]; e != nil {
			row.Engine = engineView(*e)
			delete(registered, w.Name)
		}
		rows = append(rows, row)
	}
	seen := map[string]bool{}
	for _, l := range leases {
		if l.Path == "" || seen[l.Path] {
			continue
		}
		seen[l.Path] = true
		row := overviewWorkspace{Name: l.Workspace, Path: l.Path, Trusted: true, Temporary: true}
		if e := temporary[l.Path]; e != nil {
			row.Engine = engineView(*e)
			delete(temporary, l.Path)
		}
		rows = append(rows, row)
	}
	var rest []overviewWorkspace
	for _, e := range temporary {
		rest = append(rest, overviewWorkspace{Name: e.Workspace.Name, Path: e.Workspace.Path, Trusted: true, Temporary: true, Engine: engineView(*e)})
	}
	for _, e := range registered {
		rest = append(rest, overviewWorkspace{Name: e.Workspace.Name, Path: e.Workspace.Path, Trusted: e.Workspace.Trusted, Missing: true, Engine: engineView(*e)})
	}
	sort.Slice(rest, func(i, j int) bool { return rest[i].Name < rest[j].Name })
	return append(rows, rest...)
}

func markSelf(leases []LeaseInfo, self string) []overviewLease {
	out := make([]overviewLease, 0, len(leases))
	for _, l := range leases {
		out = append(out, overviewLease{LeaseInfo: l, Self: l.ID == self})
	}
	return out
}

// tailLog reads at most the last 64 KiB, so a long-running hub's log never
// costs more than that per refresh.
func tailLog(path string) *overviewLog {
	if path == "" {
		return nil
	}
	view := &overviewLog{Path: path, Lines: []string{}}
	file, err := os.Open(path)
	if err != nil {
		return view
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return view
	}
	offset := info.Size() - logTailBytes
	if offset < 0 {
		offset = 0
	}
	raw, err := io.ReadAll(io.NewSectionReader(file, offset, info.Size()-offset))
	if err != nil {
		return view
	}
	if offset > 0 {
		if cut := bytes.IndexByte(raw, '\n'); cut >= 0 {
			raw = raw[cut+1:]
		}
	}
	lines := strings.Split(strings.TrimRight(string(raw), "\n"), "\n")
	if len(lines) == 1 && lines[0] == "" {
		return view
	}
	if len(lines) > logTailLines {
		lines = lines[len(lines)-logTailLines:]
	}
	view.Lines = lines
	return view
}

// StartServe starts a registered workspace's engine, or a lease-bound
// folder's when path names one a live lease is bound to.
func (s *Site) StartServe(ctx context.Context, name, path string) error {
	unknown := &gateway.RouteError{Status: 404, Code: "unknown_workspace"}
	if path == "" {
		workspace, err := s.Hub.resolve(ctx, name)
		if errors.Is(err, ErrUnknownWorkspace) {
			return unknown
		}
		if err != nil {
			return err
		}
		return s.Hub.StartWorkspace(ctx, workspace)
	}
	if s.Leases == nil {
		return unknown
	}
	for _, lease := range s.Leases.List() {
		if lease.Path == path && lease.Workspace == name {
			return s.Hub.StartWorkspace(ctx, Workspace{Name: name, Path: path, Trusted: true, bound: true})
		}
	}
	return unknown
}

// TrustWorkspace records trust in a registered workspace, as the start page's
// confirmation does, and replaces its untrusted engine.
func (s *Site) TrustWorkspace(ctx context.Context, name string) error {
	_, err := s.Control.Trust(ctx, name)
	if errors.Is(err, ErrUnknownWorkspace) {
		return &gateway.RouteError{Status: 404, Code: "unknown_workspace"}
	}
	if err != nil {
		return err
	}
	s.Hub.Retrusted(name)
	return nil
}

func (s *Site) StopEngine(id string) bool { return s.Hub.StopEngine(id) }

func (s *Site) RevokeLease(id string) bool { return s.Leases != nil && s.Leases.Revoke(id) }

func (s *Site) StopHub() error {
	if s.Overviews.Stop == nil {
		return gateway.ErrHubIsService
	}
	return s.Overviews.Stop()
}
