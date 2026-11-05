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
	"errors"

	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
	"github.com/swamp-club/swamp/packages/serve-go/internal/serves"
)

// ServeRecord is a running `swamp serve` as its instance record describes it.
type ServeRecord struct {
	PID       int    `json:"pid"`
	Host      string `json:"host"`
	Port      int    `json:"port"`
	URL       string `json:"url"`
	AuthMode  string `json:"authMode"`
	Dashboard bool   `json:"dashboard"`
	StartedAt string `json:"startedAt"`
	Version   string `json:"version"`
}

// WorkspaceServes is the recorded serves of one repository folder.
type WorkspaceServes struct {
	Path   string        `json:"path"`
	Serves []ServeRecord `json:"serves"`
}

// ServeConfig is what starting a workspace's `swamp serve` needs; Port is
// zero unless the repository's serve config sets one.
type ServeConfig struct {
	Workspace
	Port int `json:"port"`
}

func (r ControlResolver) Serves(ctx context.Context, paths []string) ([]WorkspaceServes, error) {
	var found struct {
		Workspaces []WorkspaceServes `json:"workspaces"`
	}
	if err := r.Control.Call(ctx, "workspace.serves", map[string][]string{"paths": paths}, &found); err != nil {
		return nil, err
	}
	return found.Workspaces, nil
}

func (r ControlResolver) ServeConfig(ctx context.Context, name string) (ServeConfig, error) {
	var config ServeConfig
	err := r.Control.Call(ctx, "workspace.serveConfig", map[string]string{"name": name}, &config)
	var failure *protocol.Error
	if errors.As(err, &failure) && failure.Code == "unknown_workspace" {
		return ServeConfig{}, ErrUnknownWorkspace
	}
	return config, err
}

type overviewServe struct {
	ID        string `json:"id,omitempty"`
	Owner     string `json:"owner"`
	State     string `json:"state"`
	PID       int    `json:"pid,omitempty"`
	Port      int    `json:"port,omitempty"`
	URL       string `json:"url,omitempty"`
	AuthMode  string `json:"authMode,omitempty"`
	Dashboard bool   `json:"dashboard"`
	StartedAt string `json:"startedAt,omitempty"`
	Version   string `json:"version,omitempty"`
	ExitCode  *int   `json:"exitCode,omitempty"`
	Reason    string `json:"reason,omitempty"`
}

// attachServes gives each row its running serves: recorded ones, marked as
// the hub's when the hub started that pid, then hub serves with no record
// yet or any more (starting, failed or exited).
func attachServes(rows []overviewWorkspace, recorded []WorkspaceServes, hubServes []serves.Info) {
	byPath := map[string][]ServeRecord{}
	for _, w := range recorded {
		byPath[w.Path] = append(byPath[w.Path], w.Serves...)
	}
	used := map[string]bool{}
	for i := range rows {
		row := &rows[i]
		row.Serves = []overviewServe{}
		var own []serves.Info
		if !row.Temporary {
			for _, h := range hubServes {
				if h.Name == row.Name {
					own = append(own, h)
				}
			}
		}
		for _, record := range byPath[row.Path] {
			entry := overviewServe{Owner: "other", State: serves.StateRunning, PID: record.PID, Port: record.Port, URL: record.URL, AuthMode: record.AuthMode, Dashboard: record.Dashboard, StartedAt: record.StartedAt, Version: record.Version}
			for _, h := range own {
				if h.PID == record.PID && !used[h.ID] {
					used[h.ID] = true
					entry.ID, entry.Owner, entry.State, entry.ExitCode, entry.Reason = h.ID, "hub", h.State, h.ExitCode, h.Reason
				}
			}
			row.Serves = append(row.Serves, entry)
		}
		for _, h := range own {
			if used[h.ID] {
				continue
			}
			used[h.ID] = true
			row.Serves = append(row.Serves, overviewServe{ID: h.ID, Owner: "hub", State: h.State, PID: h.PID, Port: h.Port, URL: h.URL, Dashboard: true, StartedAt: h.StartedAt.Format("2006-01-02T15:04:05.000Z07:00"), ExitCode: h.ExitCode, Reason: h.Reason})
		}
	}
}

// StartSwampServe starts `swamp serve` for a trusted registered workspace
// that has none running, on the port its serve config sets or a free one.
func (s *Site) StartSwampServe(ctx context.Context, name string) error {
	if s.Serves == nil {
		return &gateway.RouteError{Status: 404, Code: "serves_unavailable"}
	}
	config, err := s.Control.ServeConfig(ctx, name)
	if errors.Is(err, ErrUnknownWorkspace) {
		return &gateway.RouteError{Status: 404, Code: "unknown_workspace"}
	}
	if err != nil {
		return err
	}
	// swamp serve always loads the repository's extensions.
	if !config.Trusted {
		return &gateway.RouteError{Status: 403, Code: "workspace_untrusted"}
	}
	recorded, err := s.Control.Serves(ctx, []string{config.Path})
	if err != nil {
		return err
	}
	for _, w := range recorded {
		if len(w.Serves) > 0 {
			return &gateway.RouteError{Status: 409, Code: "serve_running"}
		}
	}
	_, err = s.Serves.Start(config.Name, config.Path, config.Port)
	switch {
	case errors.Is(err, serves.ErrRunning):
		return &gateway.RouteError{Status: 409, Code: "serve_running"}
	case errors.Is(err, serves.ErrDraining):
		return &gateway.RouteError{Status: 503, Code: "draining"}
	}
	return err
}

func (s *Site) StopSwampServe(id string) error {
	if s.Serves == nil || errors.Is(s.Serves.Stop(id), serves.ErrUnknown) {
		return &gateway.RouteError{Status: 404, Code: "unknown_serve"}
	}
	return nil
}

func (s *Site) ServeLog(id string) (interface{}, bool) {
	if s.Serves == nil {
		return nil, false
	}
	info, ok := s.Serves.Get(id)
	if !ok {
		return nil, false
	}
	return tailLog(info.LogPath), true
}
