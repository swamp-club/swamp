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

package providers

import (
	"context"
	"fmt"
	"net/http"
	"os"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
)

// Provider answers one classification request. It never returns a tool
// outside the request's set: any such answer comes back as Response.Err.
type Provider interface {
	ID() string
	Classify(ctx context.Context, req eval.Request) eval.Response
}

func New(m models.Model, route models.Route, getenv func(string) string) (Provider, error) {
	if route == models.RouteCLI {
		switch m.CLI.Kind {
		case models.ClaudeCLI:
			return &ClaudeCLI{Model: m.CLI.Model, Effort: m.CLI.Effort, Run: ExecRunner}, nil
		case models.CodexCLI:
			return &CodexCLI{Model: m.CLI.Model, Effort: m.CLI.Effort, Run: ExecRunner, TempDir: os.TempDir()}, nil
		}
		return nil, fmt.Errorf("model %q: unsupported CLI %q", m.Alias, m.CLI.Kind)
	}
	key := getenv(m.API.KeyEnv)
	if key == "" {
		return nil, fmt.Errorf("model %q on the api route needs %s", m.Alias, m.API.KeyEnv)
	}
	client := &http.Client{}
	switch m.API.Kind {
	case models.Anthropic:
		return &AnthropicAPI{Config: *m.API, Key: key, BaseURL: anthropicBaseURL, Client: client}, nil
	case models.OpenAI:
		return &OpenAIAPI{Config: *m.API, Key: key, BaseURL: openAIBaseURL, Client: client}, nil
	case models.Google:
		return &GoogleAPI{Config: *m.API, Key: key, BaseURL: googleBaseURL, Client: client}, nil
	}
	return nil, fmt.Errorf("model %q: unsupported API %q", m.Alias, m.API.Kind)
}

// PreflightRequest is a tiny forced choice sent through the real adapter
// before any case runs, so a broken key or login fails once, up front.
func PreflightRequest() eval.Request {
	return eval.Request{
		SystemPrompt: "Select the ready tool.",
		Input:        "Are you ready? Call the ready tool.",
		Tools: []eval.Tool{
			{Name: "ready", Description: "Call this to confirm you are ready.", Param: "query", ParamDescription: "The user's request"},
			{Name: "not_ready", Description: "Never call this.", Param: "query", ParamDescription: "The user's request"},
		},
	}
}

// jsonSchemaParams is the parameter schema shared by every adapter that
// accepts JSON Schema; field order matches the previous harness's output.
type jsonSchemaParams struct {
	Type       string                    `json:"type"`
	Properties map[string]jsonSchemaProp `json:"properties"`
	Required   []string                  `json:"required"`
}

type jsonSchemaProp struct {
	Type        string `json:"type"`
	Description string `json:"description"`
}

func paramsOf(t eval.Tool) jsonSchemaParams {
	return jsonSchemaParams{
		Type:       "object",
		Properties: map[string]jsonSchemaProp{t.Param: {Type: "string", Description: t.ParamDescription}},
		Required:   []string{t.Param},
	}
}
