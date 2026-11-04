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
	"net/url"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
)

const googleBaseURL = "https://generativelanguage.googleapis.com"

// GoogleAPI sends the key as a header rather than a query parameter, so a
// transport error that quotes the URL cannot carry it.
type GoogleAPI struct {
	Config  models.API
	Key     string
	BaseURL string
	Client  *http.Client
}

type googlePart struct {
	Text string `json:"text"`
}

type googleContent struct {
	Role  string       `json:"role,omitempty"`
	Parts []googlePart `json:"parts"`
}

type googleSchema struct {
	Type        string                  `json:"type"`
	Description string                  `json:"description,omitempty"`
	Properties  map[string]googleSchema `json:"properties,omitempty"`
	Required    []string                `json:"required,omitempty"`
}

type googleFunction struct {
	Name        string       `json:"name"`
	Description string       `json:"description"`
	Parameters  googleSchema `json:"parameters"`
}

type googleRequest struct {
	SystemInstruction googleContent   `json:"systemInstruction"`
	Contents          []googleContent `json:"contents"`
	Tools             []struct {
		FunctionDeclarations []googleFunction `json:"functionDeclarations"`
	} `json:"tools"`
	ToolConfig struct {
		FunctionCallingConfig struct {
			Mode string `json:"mode"`
		} `json:"functionCallingConfig"`
	} `json:"toolConfig"`
	GenerationConfig struct {
		Temperature     *float64 `json:"temperature,omitempty"`
		MaxOutputTokens int      `json:"maxOutputTokens,omitempty"`
	} `json:"generationConfig"`
}

type googleResponse struct {
	ModelVersion string `json:"modelVersion"`
	Candidates   []struct {
		Content struct {
			Parts []struct {
				FunctionCall *struct {
					Name string `json:"name"`
				} `json:"functionCall"`
			} `json:"parts"`
		} `json:"content"`
	} `json:"candidates"`
	UsageMetadata *struct {
		PromptTokenCount     *int64 `json:"promptTokenCount"`
		CachedTokenCount     *int64 `json:"cachedContentTokenCount"`
		CandidatesTokenCount *int64 `json:"candidatesTokenCount"`
		ThoughtsTokenCount   *int64 `json:"thoughtsTokenCount"`
	} `json:"usageMetadata"`
}

func (g *GoogleAPI) ID() string { return "google:" + g.Config.ModelID }

func (g *GoogleAPI) body(req eval.Request) googleRequest {
	var body googleRequest
	body.SystemInstruction = googleContent{Parts: []googlePart{{Text: req.SystemPrompt}}}
	body.Contents = []googleContent{{Role: "user", Parts: []googlePart{{Text: req.Input}}}}
	fns := make([]googleFunction, len(req.Tools))
	for i, t := range req.Tools {
		fns[i] = googleFunction{
			Name:        t.Name,
			Description: t.Description,
			Parameters: googleSchema{
				Type:       "OBJECT",
				Properties: map[string]googleSchema{t.Param: {Type: "STRING", Description: t.ParamDescription}},
				Required:   []string{t.Param},
			},
		}
	}
	body.Tools = make([]struct {
		FunctionDeclarations []googleFunction `json:"functionDeclarations"`
	}, 1)
	body.Tools[0].FunctionDeclarations = fns
	body.ToolConfig.FunctionCallingConfig.Mode = "ANY"
	body.GenerationConfig.Temperature = g.Config.Temperature
	body.GenerationConfig.MaxOutputTokens = g.Config.MaxTokens
	return body
}

func (g *GoogleAPI) Classify(ctx context.Context, req eval.Request) eval.Response {
	var resp googleResponse
	call := httpCall{
		client:  g.Client,
		url:     g.BaseURL + "/v1beta/models/" + url.PathEscape(g.Config.ModelID) + ":generateContent",
		headers: map[string]string{"x-goog-api-key": g.Key},
		body:    g.body(req),
		secret:  g.Key,
		source:  "google",
	}
	if err := call.do(ctx, &resp); err != nil {
		return eval.Response{Err: err}
	}
	out := eval.Response{ResolvedModel: resp.ModelVersion}
	if u := resp.UsageMetadata; u != nil {
		out.InputTokens = u.PromptTokenCount
		out.CachedInputTokens = u.CachedTokenCount
		// Thinking tokens are billed as output.
		out.OutputTokens = sumPresent(u.CandidatesTokenCount, u.ThoughtsTokenCount)
	}
	if len(resp.Candidates) == 0 {
		out.Err = eval.Errorf(eval.ErrBadResponse, "google returned no candidates")
		return out
	}
	var names []string
	for _, part := range resp.Candidates[0].Content.Parts {
		if part.FunctionCall != nil {
			names = append(names, part.FunctionCall.Name)
		}
	}
	out.Tool, out.Err = eval.SelectOne(names, req.ToolNames(), "google")
	return out
}
