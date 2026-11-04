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
	"net/http"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
)

const anthropicBaseURL = "https://api.anthropic.com"

type AnthropicAPI struct {
	Config  models.API
	Key     string
	BaseURL string
	Client  *http.Client
}

type anthropicTool struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	InputSchema jsonSchemaParams `json:"input_schema"`
}

type anthropicMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type anthropicRequest struct {
	Model       string             `json:"model"`
	MaxTokens   int                `json:"max_tokens"`
	System      string             `json:"system"`
	Messages    []anthropicMessage `json:"messages"`
	Tools       []anthropicTool    `json:"tools"`
	ToolChoice  map[string]string  `json:"tool_choice,omitempty"`
	Thinking    map[string]string  `json:"thinking,omitempty"`
	Temperature *float64           `json:"temperature,omitempty"`
}

type anthropicResponse struct {
	Model   string `json:"model"`
	Content []struct {
		Type string `json:"type"`
		Name string `json:"name"`
	} `json:"content"`
	Usage *struct {
		InputTokens              *int64 `json:"input_tokens"`
		CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
		OutputTokens             *int64 `json:"output_tokens"`
	} `json:"usage"`
}

func (a *AnthropicAPI) ID() string { return "anthropic:" + a.Config.ModelID }

func (a *AnthropicAPI) body(req eval.Request) anthropicRequest {
	tools := make([]anthropicTool, len(req.Tools))
	for i, t := range req.Tools {
		tools[i] = anthropicTool{Name: t.Name, Description: t.Description, InputSchema: paramsOf(t)}
	}
	body := anthropicRequest{
		Model:     a.Config.ModelID,
		MaxTokens: a.Config.MaxTokens,
		System:    req.SystemPrompt,
		Messages:  []anthropicMessage{{Role: "user", Content: req.Input}},
		Tools:     tools,
	}
	if body.MaxTokens == 0 {
		body.MaxTokens = 1024
	}
	if a.Config.AdaptiveThinking {
		body.Thinking = map[string]string{"type": "adaptive"}
	} else {
		body.ToolChoice = map[string]string{"type": "any"}
		body.Temperature = a.Config.Temperature
	}
	return body
}

func (a *AnthropicAPI) Classify(ctx context.Context, req eval.Request) eval.Response {
	var resp anthropicResponse
	call := httpCall{
		client: a.Client,
		url:    a.BaseURL + "/v1/messages",
		headers: map[string]string{
			"x-api-key":         a.Key,
			"anthropic-version": "2023-06-01",
		},
		body:   a.body(req),
		secret: a.Key,
		source: "anthropic",
	}
	if err := call.do(ctx, &resp); err != nil {
		return eval.Response{Err: err}
	}
	out := eval.Response{ResolvedModel: resp.Model}
	if resp.Usage != nil {
		out.InputTokens = sumPresent(resp.Usage.InputTokens, resp.Usage.CacheCreationInputTokens, resp.Usage.CacheReadInputTokens)
		out.CachedInputTokens = resp.Usage.CacheReadInputTokens
		out.OutputTokens = resp.Usage.OutputTokens
	}
	var names []string
	for _, block := range resp.Content {
		if block.Type == "tool_use" {
			names = append(names, block.Name)
		}
	}
	out.Tool, out.Err = eval.SelectOne(names, req.ToolNames(), "anthropic")
	return out
}
