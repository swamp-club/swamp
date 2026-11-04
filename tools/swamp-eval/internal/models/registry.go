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

import (
	"fmt"
	"slices"
	"strings"
)

type Route string

const (
	RouteAPI Route = "api"
	RouteCLI Route = "cli"
)

type APIKind string

const (
	Anthropic APIKind = "anthropic"
	Google    APIKind = "google"
)

type CLIKind string

const (
	ClaudeCLI CLIKind = "claude"
	CodexCLI  CLIKind = "codex"
)

type API struct {
	Kind    APIKind
	ModelID string
	KeyEnv  string
	// AdaptiveThinking also drops the forced tool choice, which Anthropic
	// refuses alongside thinking.
	AdaptiveThinking bool
	// MaxTokens of zero leaves the provider's default in place.
	MaxTokens   int
	Temperature *float64
	Concurrency int
	Pricing     *Pricing
}

type Pricing struct {
	InputPerMillion       float64
	OutputPerMillion      float64
	CachedInputPerMillion float64
}

// Cost prices the cached share of input at the cache-read rate; cached is a
// subset of input.
func (p Pricing) Cost(input, cached, output int64) float64 {
	return float64(input-cached)/1e6*p.InputPerMillion +
		float64(cached)/1e6*p.CachedInputPerMillion +
		float64(output)/1e6*p.OutputPerMillion
}

type CLI struct {
	Kind   CLIKind
	Model  string
	Effort string
}

type Model struct {
	Alias string
	API   *API
	CLI   *CLI
}

const DefaultCLIConcurrency = 6

func zero() *float64 { v := 0.0; return &v }

// Registry is the reviewed set of models the evaluator may run. Changing a
// model ID or price here changes evaluation coverage.
var Registry = []Model{
	{
		Alias: "opus",
		API: &API{Kind: Anthropic, ModelID: "claude-opus-5-5", KeyEnv: "ANTHROPIC_API_KEY",
			AdaptiveThinking: true, MaxTokens: 2048, Concurrency: 20,
			Pricing: &Pricing{4.0, 20.0, 0.40}},
		CLI: &CLI{Kind: ClaudeCLI, Model: "opus", Effort: "medium"},
	},
	{
		Alias: "sonnet",
		API: &API{Kind: Anthropic, ModelID: "claude-sonnet-4-5", KeyEnv: "ANTHROPIC_API_KEY",
			MaxTokens: 200, Temperature: zero(), Concurrency: 20,
			Pricing: &Pricing{3.0, 15.0, 0.30}},
		CLI: &CLI{Kind: ClaudeCLI, Model: "sonnet", Effort: "low"},
	},
	{
		Alias: "fable",
		API: &API{Kind: Anthropic, ModelID: "claude-fable-5", KeyEnv: "ANTHROPIC_API_KEY",
			AdaptiveThinking: true, MaxTokens: 2048, Concurrency: 20,
			Pricing: &Pricing{10.0, 50.0, 1.00}},
	},
	{
		// Thinking models: an output cap would also cap thinking, so none is sent.
		Alias: "gemini-2.5-pro",
		API: &API{Kind: Google, ModelID: "gemini-2.5-pro", KeyEnv: "GOOGLE_API_KEY",
			Temperature: zero(), Concurrency: 20,
			Pricing: &Pricing{1.25, 10.0, 0.3125}},
	},
	{
		Alias: "gemini-3.1-pro",
		API: &API{Kind: Google, ModelID: "gemini-3.1-pro-preview", KeyEnv: "GOOGLE_API_KEY",
			Temperature: zero(), Concurrency: 20,
			Pricing: &Pricing{1.25, 10.0, 0.3125}},
	},
	{
		Alias: "gpt-6-astra",
		CLI:   &CLI{Kind: CodexCLI, Model: "gpt-6-astra", Effort: "medium"},
	},
}

func Lookup(alias string) (Model, error) {
	for _, m := range Registry {
		if m.Alias == alias {
			return m, nil
		}
	}
	return Model{}, fmt.Errorf("unknown model %q (valid: %s)", alias, strings.Join(Aliases(), ", "))
}

func Aliases() []string {
	out := make([]string, len(Registry))
	for i, m := range Registry {
		out[i] = m.Alias
	}
	return out
}

// APIAliases is the scheduled matrix: every model reachable over an API.
func APIAliases() []string {
	var out []string
	for _, m := range Registry {
		if m.API != nil {
			out = append(out, m.Alias)
		}
	}
	return out
}

func (m Model) Routes() []Route {
	var out []Route
	if m.API != nil {
		out = append(out, RouteAPI)
	}
	if m.CLI != nil {
		out = append(out, RouteCLI)
	}
	return out
}

// ResolveRoute picks the requested route, or the default: the CLI for a
// CLI-only model, the API in GitHub Actions where the secrets live, and the
// CLI elsewhere when the model has one.
func (m Model) ResolveRoute(requested string, inGitHubActions bool) (Route, error) {
	route := Route(requested)
	if requested == "" {
		switch {
		case m.API == nil:
			route = RouteCLI
		case m.CLI == nil || inGitHubActions:
			route = RouteAPI
		default:
			route = RouteCLI
		}
	}
	if route != RouteAPI && route != RouteCLI {
		return "", fmt.Errorf("unknown route %q (valid: api, cli)", requested)
	}
	if !slices.Contains(m.Routes(), route) {
		if route == RouteAPI {
			return "", fmt.Errorf("model %q is CLI-only; use --route cli", m.Alias)
		}
		return "", fmt.Errorf("model %q has no CLI route; use --route api or one of: %s", m.Alias, strings.Join(cliAliases(), ", "))
	}
	return route, nil
}

func cliAliases() []string {
	var out []string
	for _, m := range Registry {
		if m.CLI != nil {
			out = append(out, m.Alias)
		}
	}
	return out
}

func (m Model) DefaultConcurrency(route Route) int {
	if route == RouteAPI {
		return m.API.Concurrency
	}
	return DefaultCLIConcurrency
}

// ConfiguredID is the model the route asks for: the API model ID, or the alias
// the CLI resolves itself.
func (m Model) ConfiguredID(route Route) string {
	if route == RouteAPI {
		return m.API.ModelID
	}
	return m.CLI.Model
}
