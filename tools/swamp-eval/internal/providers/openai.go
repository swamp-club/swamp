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

const openAIBaseURL = "https://api.openai.com"

type OpenAIAPI struct {
	Config  models.API
	Key     string
	BaseURL string
	Client  *http.Client
}

// openAITool is also the shape the Codex prompt lists choices in.
type openAITool struct {
	Type     string             `json:"type"`
	Function openAIToolFunction `json:"function"`
}

type openAIToolFunction struct {
	Name        string           `json:"name"`
	Description string           `json:"description"`
	Parameters  jsonSchemaParams `json:"parameters"`
}

func openAITools(tools []eval.Tool) []openAITool {
	out := make([]openAITool, len(tools))
	for i, t := range tools {
		out[i] = openAITool{Type: "function", Function: openAIToolFunction{Name: t.Name, Description: t.Description, Parameters: paramsOf(t)}}
	}
	return out
}

type openAIMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type openAIRequest struct {
	Model               string          `json:"model"`
	Messages            []openAIMessage `json:"messages"`
	Tools               []openAITool    `json:"tools"`
	ToolChoice          string          `json:"tool_choice"`
	Temperature         *float64        `json:"temperature,omitempty"`
	MaxCompletionTokens int             `json:"max_completion_tokens,omitempty"`
}

type openAIResponse struct {
	Model   string `json:"model"`
	Choices []struct {
		Message struct {
			ToolCalls []struct {
				Type     string `json:"type"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"message"`
	} `json:"choices"`
	Usage *struct {
		PromptTokens     *int64 `json:"prompt_tokens"`
		CompletionTokens *int64 `json:"completion_tokens"`
		InputTokens      *int64 `json:"input_tokens"`
		OutputTokens     *int64 `json:"output_tokens"`
	} `json:"usage"`
}

func (o *OpenAIAPI) ID() string { return "openai:" + o.Config.ModelID }

func (o *OpenAIAPI) body(req eval.Request) openAIRequest {
	return openAIRequest{
		Model: o.Config.ModelID,
		Messages: []openAIMessage{
			{Role: "system", Content: req.SystemPrompt},
			{Role: "user", Content: req.Input},
		},
		Tools:               openAITools(req.Tools),
		ToolChoice:          "required",
		Temperature:         o.Config.Temperature,
		MaxCompletionTokens: o.Config.MaxTokens,
	}
}

func (o *OpenAIAPI) Classify(ctx context.Context, req eval.Request) eval.Response {
	var resp openAIResponse
	call := httpCall{
		client:  o.Client,
		url:     o.BaseURL + "/v1/chat/completions",
		headers: map[string]string{"Authorization": "Bearer " + o.Key},
		body:    o.body(req),
		secret:  o.Key,
		source:  "openai",
	}
	if err := call.do(ctx, &resp); err != nil {
		return eval.Response{Err: err}
	}
	out := eval.Response{ResolvedModel: resp.Model}
	if resp.Usage != nil {
		out.InputTokens = firstPresent(resp.Usage.PromptTokens, resp.Usage.InputTokens)
		out.OutputTokens = firstPresent(resp.Usage.CompletionTokens, resp.Usage.OutputTokens)
	}
	if len(resp.Choices) == 0 {
		out.Err = eval.Errorf(eval.ErrBadResponse, "openai returned no choices")
		return out
	}
	var names []string
	for _, call := range resp.Choices[0].Message.ToolCalls {
		names = append(names, call.Function.Name)
	}
	out.Tool, out.Err = eval.SelectOne(names, req.ToolNames(), "openai")
	return out
}

func firstPresent(values ...*int64) *int64 {
	for _, v := range values {
		if v != nil {
			return v
		}
	}
	return nil
}
