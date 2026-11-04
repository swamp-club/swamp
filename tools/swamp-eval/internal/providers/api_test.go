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
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
)

const testKey = "sk-test-0123456789abcdef"

func testRequest() eval.Request {
	return eval.Request{
		SystemPrompt: "route it",
		Input:        "store a secret {{ vault.get('x') }}",
		Tools: []eval.Tool{
			{Name: "load_vault_guide", Description: "vaults", Param: "query", ParamDescription: "q"},
			{Name: "load_data_guide", Description: "data", Param: "query", ParamDescription: "q"},
		},
	}
}

type captured struct {
	path   string
	header http.Header
	body   map[string]any
}

func server(t *testing.T, status int, response string) (*httptest.Server, *captured) {
	t.Helper()
	got := &captured{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.path = r.URL.RequestURI()
		got.header = r.Header.Clone()
		data, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(data, &got.body); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		w.WriteHeader(status)
		_, _ = io.WriteString(w, response)
	}))
	t.Cleanup(srv.Close)
	return srv, got
}

func anthropicFor(srv *httptest.Server, cfg models.API) *AnthropicAPI {
	return &AnthropicAPI{Config: cfg, Key: testKey, BaseURL: srv.URL, Client: srv.Client()}
}

func TestAnthropicRequestAndParse(t *testing.T) {
	srv, got := server(t, 200, `{"model":"claude-sonnet-4-5-20250929","content":[{"type":"text","text":"ok"},{"type":"tool_use","name":"load_vault_guide","input":{}}],"usage":{"input_tokens":100,"cache_read_input_tokens":20,"output_tokens":7}}`)
	zero := 0.0
	a := anthropicFor(srv, models.API{ModelID: "claude-sonnet-4-5", MaxTokens: 200, Temperature: &zero})
	resp := a.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_vault_guide" {
		t.Fatalf("resp = %+v", resp)
	}
	if *resp.InputTokens != 120 || *resp.OutputTokens != 7 || resp.ResolvedModel != "claude-sonnet-4-5-20250929" {
		t.Errorf("usage/model = %v %v %s", *resp.InputTokens, *resp.OutputTokens, resp.ResolvedModel)
	}
	if got.path != "/v1/messages" || got.header.Get("x-api-key") != testKey || got.header.Get("anthropic-version") != "2023-06-01" {
		t.Errorf("request = %s %v", got.path, got.header)
	}
	if got.body["system"] != "route it" || got.body["max_tokens"] != 200.0 || got.body["temperature"] != 0.0 {
		t.Errorf("body = %v", got.body)
	}
	if tc, _ := got.body["tool_choice"].(map[string]any); tc["type"] != "any" {
		t.Errorf("tool_choice = %v, want any", got.body["tool_choice"])
	}
	msg := got.body["messages"].([]any)[0].(map[string]any)
	if msg["content"] != testRequest().Input {
		t.Errorf("input was altered: %v", msg["content"])
	}
	tool := got.body["tools"].([]any)[0].(map[string]any)
	schema := tool["input_schema"].(map[string]any)
	if tool["name"] != "load_vault_guide" || schema["type"] != "object" || schema["required"].([]any)[0] != "query" {
		t.Errorf("tool = %v", tool)
	}
}

func TestAnthropicAdaptiveThinkingDropsForcedChoice(t *testing.T) {
	srv, got := server(t, 200, `{"content":[{"type":"thinking"},{"type":"tool_use","name":"load_data_guide"}]}`)
	a := anthropicFor(srv, models.API{ModelID: "claude-opus-5-5", MaxTokens: 2048, AdaptiveThinking: true})
	resp := a.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_data_guide" {
		t.Fatalf("resp = %+v", resp)
	}
	if _, ok := got.body["tool_choice"]; ok {
		t.Error("tool_choice must be omitted with thinking")
	}
	if _, ok := got.body["temperature"]; ok {
		t.Error("temperature must be omitted with thinking")
	}
	if th, _ := got.body["thinking"].(map[string]any); th["type"] != "adaptive" {
		t.Errorf("thinking = %v", got.body["thinking"])
	}
	if resp.InputTokens != nil || resp.OutputTokens != nil {
		t.Error("absent usage must stay nil, not zero")
	}
}

func TestAnthropicRejectsInvalidSelections(t *testing.T) {
	cases := map[string]struct {
		body     string
		category eval.ErrorCategory
	}{
		"no call":      {`{"content":[{"type":"text","text":"I think vault"}]}`, eval.ErrInvalidTool},
		"two calls":    {`{"content":[{"type":"tool_use","name":"load_vault_guide"},{"type":"tool_use","name":"load_data_guide"}]}`, eval.ErrInvalidTool},
		"unknown name": {`{"content":[{"type":"tool_use","name":"rm_rf"}]}`, eval.ErrInvalidTool},
		"invalid JSON": {`{"content":`, eval.ErrBadResponse},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			srv, _ := server(t, 200, tc.body)
			resp := anthropicFor(srv, models.API{ModelID: "m"}).Classify(context.Background(), testRequest())
			if resp.Err == nil || resp.Err.Category != tc.category || resp.Tool != "" {
				t.Fatalf("resp = %+v, want %s", resp, tc.category)
			}
		})
	}
}

func TestHTTPStatusCategoriesAndScrubbing(t *testing.T) {
	cases := map[int]eval.ErrorCategory{
		401: eval.ErrAuth, 403: eval.ErrAuth, 429: eval.ErrRateLimit,
		500: eval.ErrProvider, 529: eval.ErrProvider, 400: eval.ErrBadResponse,
	}
	for status, want := range cases {
		body := `{"error":"bad key ` + testKey + ` and AIzaSyA0123456789012345678901234"}` + strings.Repeat("x", 2000)
		srv, _ := server(t, status, body)
		resp := anthropicFor(srv, models.API{ModelID: "m"}).Classify(context.Background(), testRequest())
		if resp.Err == nil || resp.Err.Category != want {
			t.Errorf("HTTP %d: got %+v, want %s", status, resp.Err, want)
			continue
		}
		if strings.Contains(resp.Err.Message, testKey) || strings.Contains(resp.Err.Message, "AIzaSy") {
			t.Errorf("HTTP %d: message leaks a credential: %s", status, resp.Err.Message)
		}
		if len(resp.Err.Message) > maxExcerptBytes+100 {
			t.Errorf("HTTP %d: message not bounded (%d bytes)", status, len(resp.Err.Message))
		}
	}
}

func TestTimeoutIsCategorized(t *testing.T) {
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-release
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	resp := (&AnthropicAPI{Config: models.API{ModelID: "m"}, Key: testKey, BaseURL: srv.URL, Client: srv.Client()}).Classify(ctx, testRequest())
	if resp.Err == nil || resp.Err.Category != eval.ErrTimeout {
		t.Fatalf("resp = %+v, want timeout", resp)
	}
}

func TestOpenAIRequestAndParse(t *testing.T) {
	srv, got := server(t, 200, `{"model":"gpt-5.4-2026","choices":[{"message":{"tool_calls":[{"type":"function","function":{"name":"load_data_guide","arguments":"{}"}}]}}],"usage":{"prompt_tokens":50,"completion_tokens":9}}`)
	o := &OpenAIAPI{Config: models.API{ModelID: "gpt-5.4"}, Key: testKey, BaseURL: srv.URL, Client: srv.Client()}
	resp := o.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_data_guide" || *resp.InputTokens != 50 || *resp.OutputTokens != 9 {
		t.Fatalf("resp = %+v", resp)
	}
	if got.path != "/v1/chat/completions" || got.header.Get("Authorization") != "Bearer "+testKey {
		t.Errorf("request = %s", got.path)
	}
	if got.body["tool_choice"] != "required" {
		t.Errorf("tool_choice = %v", got.body["tool_choice"])
	}
	for _, absent := range []string{"temperature", "max_completion_tokens", "max_tokens"} {
		if _, ok := got.body[absent]; ok {
			t.Errorf("%s must not be sent to a reasoning model", absent)
		}
	}
	msgs := got.body["messages"].([]any)
	if msgs[0].(map[string]any)["role"] != "system" || msgs[1].(map[string]any)["content"] != testRequest().Input {
		t.Errorf("messages = %v", msgs)
	}
	fn := got.body["tools"].([]any)[0].(map[string]any)
	if fn["type"] != "function" || fn["function"].(map[string]any)["name"] != "load_vault_guide" {
		t.Errorf("tool = %v", fn)
	}
}

func TestOpenAIRejectsMissingChoicesAndMultipleCalls(t *testing.T) {
	for name, body := range map[string]string{
		"no choices": `{"choices":[]}`,
		"no calls":   `{"choices":[{"message":{"content":"text"}}]}`,
		"two calls":  `{"choices":[{"message":{"tool_calls":[{"function":{"name":"load_data_guide"}},{"function":{"name":"load_vault_guide"}}]}}]}`,
	} {
		srv, _ := server(t, 200, body)
		resp := (&OpenAIAPI{Config: models.API{ModelID: "m"}, Key: testKey, BaseURL: srv.URL, Client: srv.Client()}).Classify(context.Background(), testRequest())
		if resp.Err == nil {
			t.Errorf("%s: want error, got %+v", name, resp)
		}
	}
}

func TestGoogleRequestAndParse(t *testing.T) {
	srv, got := server(t, 200, `{"modelVersion":"gemini-2.5-pro-001","candidates":[{"content":{"parts":[{"thoughtSignature":"x"},{"functionCall":{"name":"load_vault_guide","args":{}}}]}}],"usageMetadata":{"promptTokenCount":80,"candidatesTokenCount":5,"thoughtsTokenCount":40}}`)
	zero := 0.0
	g := &GoogleAPI{Config: models.API{ModelID: "gemini-2.5-pro", Temperature: &zero}, Key: testKey, BaseURL: srv.URL, Client: srv.Client()}
	resp := g.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_vault_guide" || *resp.InputTokens != 80 || *resp.OutputTokens != 45 {
		t.Fatalf("resp = %+v", resp)
	}
	if got.path != "/v1beta/models/gemini-2.5-pro:generateContent" {
		t.Errorf("path = %s (the key must not be in the URL)", got.path)
	}
	if got.header.Get("x-goog-api-key") != testKey {
		t.Error("key header missing")
	}
	mode := got.body["toolConfig"].(map[string]any)["functionCallingConfig"].(map[string]any)["mode"]
	if mode != "ANY" {
		t.Errorf("mode = %v", mode)
	}
	gen := got.body["generationConfig"].(map[string]any)
	if gen["temperature"] != 0.0 {
		t.Errorf("generationConfig = %v", gen)
	}
	if _, ok := gen["maxOutputTokens"]; ok {
		t.Error("maxOutputTokens must not cap a thinking model")
	}
	decl := got.body["tools"].([]any)[0].(map[string]any)["functionDeclarations"].([]any)
	if len(decl) != 2 {
		t.Errorf("declarations = %v", decl)
	}
}

func TestNewRequiresTheAPIKey(t *testing.T) {
	m, _ := models.Lookup("gemini-2.5-pro")
	if _, err := New(m, models.RouteAPI, func(string) string { return "" }); err == nil || !strings.Contains(err.Error(), "GOOGLE_API_KEY") {
		t.Fatalf("err = %v, want a missing GOOGLE_API_KEY", err)
	}
	p, err := New(m, models.RouteAPI, func(string) string { return "k" })
	if err != nil || p.ID() != "google:gemini-2.5-pro" {
		t.Fatalf("p = %v, err = %v", p, err)
	}
}
