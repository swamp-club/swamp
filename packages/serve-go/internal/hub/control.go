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

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

// ControlHandshake admits the repository-less control engine of a pair.
func ControlHandshake(ctx context.Context, c *engine.Client) error {
	profile, required := servecontract.HubControl()
	var hello struct {
		Version  int      `json:"version"`
		Profile  string   `json:"profile"`
		Controls []string `json:"controls"`
	}
	if err := c.Call(ctx, "hello", map[string]string{"profile": profile}, &hello); err != nil {
		return err
	}
	offered := make(map[string]bool, len(hello.Controls))
	for _, control := range hello.Controls {
		offered[control] = true
	}
	if hello.Version != protocol.Version || hello.Profile != profile {
		return protocol.ErrVersion
	}
	for _, control := range required {
		if !offered[control] {
			return protocol.ErrVersion
		}
	}
	return nil
}

// ControlResolver asks the control engine, which owns the workspace registry.
type ControlResolver struct {
	Control *engine.Supervisor
}

func (r ControlResolver) Resolve(ctx context.Context, name string) (Workspace, error) {
	var workspace Workspace
	err := r.Control.Call(ctx, "workspace.resolve", map[string]string{"name": name}, &workspace)
	var failure *protocol.Error
	if errors.As(err, &failure) && failure.Code == "unknown_workspace" {
		return Workspace{}, ErrUnknownWorkspace
	}
	return workspace, err
}
