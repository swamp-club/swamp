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

// Package servecontract exposes the shared private protocol manifest.
package servecontract

import (
	_ "embed"
	"encoding/json"
)

//go:embed protocol.json
var manifest []byte

// Operations returns the capabilities every local-v1 engine must implement.
func Operations() []string {
	var contract struct {
		Operations []string `json:"operations"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil {
		panic("invalid embedded serve protocol manifest")
	}
	return contract.Operations
}

// MaxShutdownDeadlineMilliseconds is the engine's safe timer range from the shared contract.
func MaxShutdownDeadlineMilliseconds() int64 {
	var contract struct {
		Limits struct {
			MaxShutdownDeadlineMs int64 `json:"maxShutdownDeadlineMs"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil || contract.Limits.MaxShutdownDeadlineMs <= 0 {
		panic("invalid embedded shutdown deadline limit")
	}
	return contract.Limits.MaxShutdownDeadlineMs
}

// MaxCommandGuardians bounds both registered commands and pending handshakes.
func MaxCommandGuardians() int {
	var contract struct {
		Limits struct {
			CommandGuardians int `json:"commandGuardians"`
		} `json:"limits"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil || contract.Limits.CommandGuardians <= 0 {
		panic("invalid embedded command guardian limit")
	}
	return contract.Limits.CommandGuardians
}
