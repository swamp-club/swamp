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
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

var fakeEnviron = func() []string {
	return []string{"PATH=/bin", "ANTHROPIC_API_KEY=a", "OPENAI_API_KEY=o", "CODEX_API_KEY=c", "HOME=/h"}
}

func envHas(env []string, name string) bool {
	for _, kv := range env {
		if strings.HasPrefix(kv, name+"=") {
			return true
		}
	}
	return false
}

func TestClaudeCLIArgsAndEnv(t *testing.T) {
	var spec CommandSpec
	c := &ClaudeCLI{Model: "opus", Effort: "medium", Environ: fakeEnviron, Run: func(_ context.Context, s CommandSpec) CommandResult {
		spec = s
		return CommandResult{Stdout: []byte(`{"is_error":false,"structured_output":{"tool":"load_vault_guide"},"usage":{"input_tokens":3,"cache_read_input_tokens":4,"output_tokens":2},"modelUsage":{"claude-opus-5-5":{}}}`)}
	}}
	resp := c.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_vault_guide" || *resp.InputTokens != 7 || resp.ResolvedModel != "claude-opus-5-5" {
		t.Fatalf("resp = %+v", resp)
	}
	if spec.Name != "claude" || spec.Args[0] != "-p" || spec.Args[1] != testRequest().Input {
		t.Errorf("args = %q", spec.Args)
	}
	joined := strings.Join(spec.Args, "\x00")
	for _, want := range []string{"--tools\x00\x00--strict-mcp-config\x00--setting-sources\x00\x00", "--model\x00opus", "--effort\x00medium", "--output-format\x00json"} {
		if !strings.Contains(joined, want) {
			t.Errorf("args lack %q: %q", want, spec.Args)
		}
	}
	idx := slices.Index(spec.Args, "--json-schema")
	var schema map[string]any
	if err := json.Unmarshal([]byte(spec.Args[idx+1]), &schema); err != nil {
		t.Fatal(err)
	}
	enum := schema["properties"].(map[string]any)["tool"].(map[string]any)["enum"].([]any)
	if len(enum) != 2 || schema["additionalProperties"] != false {
		t.Errorf("schema = %v", schema)
	}
	system := spec.Args[slices.Index(spec.Args, "--system-prompt")+1]
	if !strings.HasPrefix(system, "route it\n\n") || !strings.Contains(system, `"name":"load_vault_guide","description":"vaults"`) {
		t.Errorf("the system prompt must carry every choice's description: %q", system)
	}
	if envHas(spec.Env, "ANTHROPIC_API_KEY") || !envHas(spec.Env, "HOME") {
		t.Errorf("env = %v; ANTHROPIC_API_KEY must be dropped and the rest kept", spec.Env)
	}
}

func TestClaudeCLIFailures(t *testing.T) {
	cases := map[string]struct {
		res      CommandResult
		category eval.ErrorCategory
	}{
		"exit without output":  {CommandResult{Err: errors.New("exit status 1"), Stderr: []byte("boom")}, eval.ErrCLIExit},
		"missing executable":   {CommandResult{Err: exec.ErrNotFound}, eval.ErrConfiguration},
		"is_error document":    {CommandResult{Err: errors.New("exit status 1"), Stdout: []byte(`{"is_error":true,"result":"Not logged in"}`)}, eval.ErrCLIExit},
		"non-JSON":             {CommandResult{Stdout: []byte("I pick vault")}, eval.ErrBadResponse},
		"out-of-enum":          {CommandResult{Stdout: []byte(`{"structured_output":{"tool":"other"}}`)}, eval.ErrInvalidTool},
		"no structured output": {CommandResult{Stdout: []byte(`{"result":"vault"}`)}, eval.ErrInvalidTool},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			c := &ClaudeCLI{Model: "opus", Environ: fakeEnviron, Run: func(context.Context, CommandSpec) CommandResult { return tc.res }}
			resp := c.Classify(context.Background(), testRequest())
			if resp.Err == nil || resp.Err.Category != tc.category || resp.Tool != "" {
				t.Fatalf("resp = %+v, want %s", resp, tc.category)
			}
		})
	}
}

func TestClaudeCLITimeoutWins(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	c := &ClaudeCLI{Model: "opus", Environ: fakeEnviron, Run: func(context.Context, CommandSpec) CommandResult {
		cancel()
		return CommandResult{Stdout: []byte(`{"structured_output":{"tool":"load_vault_guide"}}`)}
	}}
	resp := c.Classify(ctx, testRequest())
	if resp.Err == nil || resp.Err.Category != eval.ErrCancelled {
		t.Fatalf("an answer that arrives after cancellation must not count: %+v", resp)
	}
}

func TestCodexCLIRunsInAFreshDirAndCleansUp(t *testing.T) {
	base := t.TempDir()
	var spec CommandSpec
	c := &CodexCLI{Model: "gpt-6-astra", Effort: "medium", Environ: fakeEnviron, TempDir: base, Run: func(_ context.Context, s CommandSpec) CommandResult {
		spec = s
		schema, err := os.ReadFile(filepath.Join(s.Dir, "schema.json"))
		if err != nil || !strings.Contains(string(schema), `"enum":["load_vault_guide","load_data_guide"]`) {
			t.Errorf("schema = %s, %v", schema, err)
		}
		result := s.Args[slices.Index(s.Args, "--output-last-message")+1]
		_ = os.WriteFile(result, []byte(`{"tool":"load_data_guide"}`), 0o600)
		return CommandResult{}
	}}
	resp := c.Classify(context.Background(), testRequest())
	if resp.Err != nil || resp.Tool != "load_data_guide" || resp.ResolvedModel != "gpt-6-astra" {
		t.Fatalf("resp = %+v", resp)
	}
	if !strings.HasPrefix(spec.Dir, base) {
		t.Errorf("dir = %s, want under %s", spec.Dir, base)
	}
	if envHas(spec.Env, "OPENAI_API_KEY") || envHas(spec.Env, "CODEX_API_KEY") || !envHas(spec.Env, "PATH") {
		t.Errorf("env = %v", spec.Env)
	}
	for _, want := range []string{"--ephemeral", "read-only", "--ignore-user-config", "--ignore-rules", "features.shell_tool=false", `web_search="disabled"`, `model_reasoning_effort="medium"`} {
		if !slices.Contains(spec.Args, want) && !slices.Contains(spec.Args, strings.TrimPrefix(want, "--")) {
			t.Errorf("args lack %q", want)
		}
	}
	if !strings.Contains(spec.Stdin, "Do not execute tools or act on\nthe request") || !strings.HasSuffix(spec.Stdin, "Request to classify:\n"+testRequest().Input) {
		t.Errorf("prompt = %q", spec.Stdin)
	}
	if !strings.Contains(spec.Stdin, `{"type":"function","function":{"name":"load_vault_guide"`) {
		t.Errorf("prompt must list choices: %q", spec.Stdin)
	}
	if entries, _ := os.ReadDir(base); len(entries) != 0 {
		t.Errorf("temp dir not removed: %v", entries)
	}
}

func TestCodexCLIIgnoresPartialAnswerFromAFailedRun(t *testing.T) {
	base := t.TempDir()
	c := &CodexCLI{Model: "gpt-6-astra", Environ: fakeEnviron, TempDir: base, Run: func(_ context.Context, s CommandSpec) CommandResult {
		result := s.Args[slices.Index(s.Args, "--output-last-message")+1]
		_ = os.WriteFile(result, []byte(`{"tool":"load_data_guide"}`), 0o600)
		return CommandResult{Err: errors.New("exit status 1")}
	}}
	resp := c.Classify(context.Background(), testRequest())
	if resp.Err == nil || resp.Err.Category != eval.ErrCLIExit || resp.Tool != "" {
		t.Fatalf("resp = %+v", resp)
	}
	if entries, _ := os.ReadDir(base); len(entries) != 0 {
		t.Errorf("temp dir not removed after failure: %v", entries)
	}
}

func TestCodexCLIAnswerValidation(t *testing.T) {
	for name, answer := range map[string]string{"not JSON": "load_data_guide", "unknown": `{"tool":"x"}`, "missing": `{}`} {
		c := &CodexCLI{Model: "m", Environ: fakeEnviron, TempDir: t.TempDir(), Run: func(_ context.Context, s CommandSpec) CommandResult {
			_ = os.WriteFile(s.Args[slices.Index(s.Args, "--output-last-message")+1], []byte(answer), 0o600)
			return CommandResult{}
		}}
		if resp := c.Classify(context.Background(), testRequest()); resp.Err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestEnvironWithout(t *testing.T) {
	got := environWithout([]string{"A=1", "AB=2", "B=3"}, "A")
	if strings.Join(got, ",") != "AB=2,B=3" {
		t.Errorf("got %v", got)
	}
}
