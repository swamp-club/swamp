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

package models

import "testing"

func TestResolveRoute(t *testing.T) {
	cases := []struct {
		alias, requested string
		ci               bool
		want             Route
		wantErr          bool
	}{
		{"opus", "", false, RouteCLI, false},
		{"opus", "", true, RouteAPI, false},
		{"sonnet", "", false, RouteCLI, false},
		{"sonnet", "", true, RouteAPI, false},
		{"fable", "", false, RouteAPI, false},
		{"gpt-5.4", "", false, RouteAPI, false},
		{"gemini-3.1-pro", "", true, RouteAPI, false},
		{"gpt-6-astra", "", false, RouteCLI, false},
		{"gpt-6-astra", "", true, RouteCLI, false},
		{"opus", "api", false, RouteAPI, false},
		{"opus", "cli", true, RouteCLI, false},
		{"gpt-6-astra", "api", false, "", true},
		{"fable", "cli", false, "", true},
		{"opus", "carrier-pigeon", false, "", true},
	}
	for _, tc := range cases {
		m, err := Lookup(tc.alias)
		if err != nil {
			t.Fatal(err)
		}
		got, err := m.ResolveRoute(tc.requested, tc.ci)
		if tc.wantErr {
			if err == nil {
				t.Errorf("%s route %q ci=%v: want error, got %s", tc.alias, tc.requested, tc.ci, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("%s route %q ci=%v = %s, %v; want %s", tc.alias, tc.requested, tc.ci, got, err, tc.want)
		}
	}
}

func TestLookupRejectsUnknownAndRawModelIDs(t *testing.T) {
	for _, alias := range []string{"", "claude-opus-5-5", "gpt-4"} {
		if _, err := Lookup(alias); err == nil {
			t.Errorf("Lookup(%q): want error", alias)
		}
	}
}

func TestRegistryIsConsistent(t *testing.T) {
	seen := map[string]bool{}
	for _, m := range Registry {
		if seen[m.Alias] {
			t.Errorf("duplicate alias %s", m.Alias)
		}
		seen[m.Alias] = true
		if m.API == nil && m.CLI == nil {
			t.Errorf("%s has no route", m.Alias)
		}
		if m.API != nil {
			if m.API.ModelID == "" || m.API.KeyEnv == "" || m.API.Concurrency < 1 || m.API.Pricing == nil {
				t.Errorf("%s: incomplete API config %+v", m.Alias, *m.API)
			}
			if m.API.AdaptiveThinking && m.API.Kind != Anthropic {
				t.Errorf("%s: adaptive thinking is an Anthropic setting", m.Alias)
			}
		}
	}
	want := []string{"opus", "sonnet", "fable", "gpt-5.4", "gemini-2.5-pro", "gemini-3.1-pro"}
	got := APIAliases()
	if len(got) != len(want) {
		t.Fatalf("API matrix = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("API matrix = %v, want %v", got, want)
		}
	}
	gpt, _ := Lookup("gpt-5.4")
	if gpt.DefaultConcurrency(RouteAPI) != 1 {
		t.Error("gpt-5.4 must keep its concurrency of 1")
	}
	opus, _ := Lookup("opus")
	if opus.DefaultConcurrency(RouteCLI) != DefaultCLIConcurrency {
		t.Error("CLI concurrency default changed")
	}
}

func TestPricingCost(t *testing.T) {
	got := Pricing{InputPerMillion: 3, OutputPerMillion: 15}.Cost(1_000_000, 200_000)
	if got != 6 {
		t.Errorf("cost = %v, want 6", got)
	}
}
