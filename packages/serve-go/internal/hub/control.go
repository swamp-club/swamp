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
	"sync"

	servecontract "github.com/swamp-club/swamp/packages/serve-go"
	"github.com/swamp-club/swamp/packages/serve-go/internal/engine"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

// ControlIdentity is what the control engine reported in its hello.
type ControlIdentity struct {
	mu            sync.Mutex
	engineVersion string
	gitSHA        string
}

func (i *ControlIdentity) Get() (engineVersion, gitSHA string) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.engineVersion, i.gitSHA
}

// ControlHandshake admits the repository-less control engine of a pair.
func ControlHandshake(ctx context.Context, c *engine.Client) error {
	return (&ControlIdentity{}).Handshake(ctx, c)
}

// Handshake admits the control engine and records who it is.
func (i *ControlIdentity) Handshake(ctx context.Context, c *engine.Client) error {
	profile, required := servecontract.HubControl()
	var hello struct {
		Version       int      `json:"version"`
		Profile       string   `json:"profile"`
		Controls      []string `json:"controls"`
		EngineVersion string   `json:"engineVersion"`
		GitSHA        string   `json:"gitSha"`
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
	i.mu.Lock()
	i.engineVersion, i.gitSHA = hello.EngineVersion, hello.GitSHA
	i.mu.Unlock()
	return nil
}

// ErrNotARepo answers a lease that names a folder that is not a repository.
var ErrNotARepo = errors.New("not a repository")

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

// Trust records the user's trust in a registered workspace.
func (r ControlResolver) Trust(ctx context.Context, name string) (Workspace, error) {
	var workspace Workspace
	err := r.Control.Call(ctx, "workspace.trust", map[string]string{"name": name}, &workspace)
	var failure *protocol.Error
	if errors.As(err, &failure) && failure.Code == "unknown_workspace" {
		return Workspace{}, ErrUnknownWorkspace
	}
	return workspace, err
}

func (r ControlResolver) List(ctx context.Context) ([]Workspace, error) {
	var listed struct {
		Workspaces []Workspace `json:"workspaces"`
	}
	if err := r.Control.Call(ctx, "workspace.list", struct{}{}, &listed); err != nil {
		return nil, err
	}
	return listed.Workspaces, nil
}

func (r ControlResolver) Inspect(ctx context.Context, path string) (string, error) {
	var inspected struct {
		Path string `json:"path"`
	}
	err := r.Control.Call(ctx, "workspace.inspect", map[string]string{"path": path}, &inspected)
	var failure *protocol.Error
	if errors.As(err, &failure) && failure.Code == "not_a_repo" {
		return "", ErrNotARepo
	}
	if err == nil && inspected.Path == "" {
		return "", protocol.ErrFrame
	}
	return inspected.Path, err
}

// AssetChunk is one control reply of a dashboard file.
type AssetChunk struct {
	ContentType  string `json:"contentType"`
	CacheControl string `json:"cacheControl"`
	Size         int64  `json:"size"`
	Offset       int64  `json:"offset"`
	Data         []byte `json:"data"`
	Done         bool   `json:"done"`
}

func (r ControlResolver) AssetChunk(ctx context.Context, path string, offset int64) (AssetChunk, error) {
	var chunk AssetChunk
	err := r.Control.Call(ctx, "asset.get", map[string]interface{}{"path": path, "offset": offset}, &chunk)
	return chunk, err
}
