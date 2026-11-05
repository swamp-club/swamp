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

// HubControl returns the profile and controls of the hub's repository-less control engine.
func HubControl() (string, []string) {
	var contract struct {
		HubControl struct {
			Profile  string   `json:"profile"`
			Controls []string `json:"controls"`
		} `json:"hubControl"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil || contract.HubControl.Profile == "" {
		panic("invalid embedded hub control contract")
	}
	return contract.HubControl.Profile, contract.HubControl.Controls
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

// PageContract is what a dashboard tab may send through the hub.
type PageContract struct {
	Operations             []string `json:"operations"`
	Reads                  []string `json:"reads"`
	Actions                []string `json:"actions"`
	HTTPOperations         []string `json:"httpOperations"`
	RefusalMessage         string   `json:"refusalMessage"`
	HTTPRefusalMessage     string   `json:"httpRefusalMessage"`
	HTTPUnsupportedMessage string   `json:"httpUnsupportedMessage"`
}

func Page() PageContract {
	var contract struct {
		CallerClasses struct {
			Page PageContract `json:"page"`
		} `json:"callerClasses"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil || len(contract.CallerClasses.Page.Operations) == 0 ||
		contract.CallerClasses.Page.RefusalMessage == "" {
		panic("invalid embedded page caller contract")
	}
	return contract.CallerClasses.Page
}

// PageLimits are the TypeScript dashboard servers' bounds, which the hub keeps.
type PageLimits struct {
	CompressionThresholdBytes int `json:"compressionThresholdBytes"`
	HTTPRequestBodyBytes      int `json:"httpRequestBodyBytes"`
	HTTPRequestsInFlight      int `json:"httpRequestsInFlight"`
}

func PageLimitsOf() PageLimits {
	var contract struct {
		Limits PageLimits `json:"limits"`
	}
	if err := json.Unmarshal(manifest, &contract); err != nil || contract.Limits.CompressionThresholdBytes <= 0 ||
		contract.Limits.HTTPRequestBodyBytes <= 0 || contract.Limits.HTTPRequestsInFlight <= 0 {
		panic("invalid embedded page limits")
	}
	return contract.Limits
}
