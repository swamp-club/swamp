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
	"strings"
	"sync"

	"github.com/swamp-club/swamp/packages/serve-go/internal/gateway"
	"github.com/swamp-club/swamp/packages/serve-go/internal/protocol"
)

// SiteControl is what the dashboard site needs from the control engine.
type SiteControl interface {
	List(ctx context.Context) ([]Workspace, error)
	AssetChunk(ctx context.Context, path string, offset int64) (AssetChunk, error)
}

const (
	maxAssetBytes      = 32 << 20
	maxAssetCacheBytes = 64 << 20
)

// Site serves the dashboard bundle and the workspace switcher's list. The
// bundle lives inside the swamp binary, so every byte comes from the control
// engine; immutable files are kept after the first fetch.
type Site struct {
	Control SiteControl
	Hub     *Hub
	mu      sync.Mutex
	cache   map[string]gateway.Asset
	cached  int
}

func (s *Site) Asset(ctx context.Context, path string) (gateway.Asset, error) {
	s.mu.Lock()
	asset, ok := s.cache[path]
	s.mu.Unlock()
	if ok {
		return asset, nil
	}
	var body bytes.Buffer
	var offset int64
	for {
		chunk, err := s.Control.AssetChunk(ctx, path, offset)
		var failure *protocol.Error
		if errors.As(err, &failure) {
			switch failure.Code {
			case "assets_unavailable":
				return gateway.Asset{}, gateway.ErrAssetsUnavailable
			case "unknown_asset":
				return gateway.Asset{}, gateway.ErrAssetForbidden
			}
		}
		if err != nil {
			return gateway.Asset{}, err
		}
		if chunk.Offset != offset || chunk.Size > maxAssetBytes || int64(body.Len()+len(chunk.Data)) > chunk.Size {
			return gateway.Asset{}, protocol.ErrFrame
		}
		if offset == 0 {
			asset = gateway.Asset{ContentType: chunk.ContentType, CacheControl: chunk.CacheControl}
		}
		body.Write(chunk.Data)
		offset += int64(len(chunk.Data))
		if chunk.Done {
			break
		}
		if len(chunk.Data) == 0 {
			return gateway.Asset{}, protocol.ErrFrame
		}
	}
	asset.Body = body.Bytes()
	if strings.Contains(asset.CacheControl, "immutable") {
		s.mu.Lock()
		if s.cache == nil {
			s.cache = map[string]gateway.Asset{}
		}
		if _, ok := s.cache[path]; !ok && s.cached+len(asset.Body) <= maxAssetCacheBytes {
			s.cache[path] = asset
			s.cached += len(asset.Body)
		}
		s.mu.Unlock()
	}
	return asset, nil
}

// Workspaces is what the switcher lists: every registered workspace for a
// lease over all of them, else only the lease's own, which can't switch.
func (s *Site) Workspaces(ctx context.Context, lease gateway.Lease) ([]gateway.LocalWorkspace, bool, error) {
	all, name := lease.ScopeOf()
	if all {
		listed, err := s.Control.List(ctx)
		if err != nil {
			return nil, false, err
		}
		workspaces := make([]gateway.LocalWorkspace, 0, len(listed))
		for _, w := range listed {
			workspaces = append(workspaces, gateway.LocalWorkspace{Name: w.Name, Path: w.Path})
		}
		return workspaces, true, nil
	}
	if path, ok := lease.Bound(name); ok {
		return []gateway.LocalWorkspace{{Name: name, Path: path}}, false, nil
	}
	workspace, err := s.Hub.resolve(ctx, name)
	if errors.Is(err, ErrUnknownWorkspace) {
		return []gateway.LocalWorkspace{}, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	return []gateway.LocalWorkspace{{Name: workspace.Name, Path: workspace.Path}}, false, nil
}
