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
	"slices"
	"strings"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

// ClaudeCLI answers through `claude -p` on the claude.ai login.
type ClaudeCLI struct {
	Model   string
	Effort  string
	Run     CommandRunner
	Environ func() []string
}

// claudeIsolationFlags cut `claude -p` off from tools, MCP servers and user
// settings so a case is answered from the prompt alone. `--bare` is not an
// option: it only accepts an API key.
var claudeIsolationFlags = []string{"--tools", "", "--strict-mcp-config", "--setting-sources", ""}

func (c *ClaudeCLI) ID() string { return "claude-cli:" + c.Model }

func (c *ClaudeCLI) Args(req eval.Request) []string {
	schema, _ := json.Marshal(toolChoiceSchema(req.ToolNames()))
	args := []string{"-p", req.Input, "--model", c.Model}
	args = append(args, claudeIsolationFlags...)
	args = append(args,
		"--system-prompt", withChoices(req),
		"--json-schema", string(schema),
		"--output-format", "json",
	)
	if c.Effort != "" {
		args = append(args, "--effort", c.Effort)
	}
	return args
}

func (c *ClaudeCLI) Classify(ctx context.Context, req eval.Request) eval.Response {
	res := c.Run(ctx, CommandSpec{
		Name: "claude",
		Args: c.Args(req),
		// ANTHROPIC_API_KEY is dropped so the CLI always uses the claude.ai
		// login, even in a shell that still exports a stale key.
		Env: environWithout(processEnviron(c.Environ), "ANTHROPIC_API_KEY"),
	})
	if ctx.Err() != nil || (res.Err != nil && len(strings.TrimSpace(string(res.Stdout))) == 0) {
		return eval.Response{Err: commandError(ctx, "claude -p", res)}
	}
	// A nonzero exit still prints a JSON document when the CLI reached the
	// API; it reports the failure through is_error.
	return parseClaudeOutput(res.Stdout, req.ToolNames())
}

type claudeOutput struct {
	IsError          bool            `json:"is_error"`
	Result           json.RawMessage `json:"result"`
	StructuredOutput *struct {
		Tool *string `json:"tool"`
	} `json:"structured_output"`
	Usage *struct {
		InputTokens              *int64 `json:"input_tokens"`
		CacheCreationInputTokens *int64 `json:"cache_creation_input_tokens"`
		CacheReadInputTokens     *int64 `json:"cache_read_input_tokens"`
		OutputTokens             *int64 `json:"output_tokens"`
	} `json:"usage"`
	ModelUsage map[string]json.RawMessage `json:"modelUsage"`
}

func parseClaudeOutput(stdout []byte, offered []string) eval.Response {
	var doc claudeOutput
	if err := json.Unmarshal(stdout, &doc); err != nil {
		return eval.Response{Err: eval.Errorf(eval.ErrBadResponse, "claude -p printed non-JSON output: %s", scrub(string(stdout)))}
	}
	var out eval.Response
	if len(doc.ModelUsage) > 0 {
		names := make([]string, 0, len(doc.ModelUsage))
		for name := range doc.ModelUsage {
			names = append(names, name)
		}
		slices.Sort(names)
		out.ResolvedModel = strings.Join(names, ",")
	}
	if doc.Usage != nil {
		out.InputTokens = sumPresent(doc.Usage.InputTokens, doc.Usage.CacheCreationInputTokens, doc.Usage.CacheReadInputTokens)
		out.OutputTokens = doc.Usage.OutputTokens
	}
	if doc.IsError {
		out.Err = eval.Errorf(eval.ErrCLIExit, "claude -p reported an error: %s", scrub(string(doc.Result)))
		return out
	}
	var names []string
	if doc.StructuredOutput != nil && doc.StructuredOutput.Tool != nil {
		names = []string{*doc.StructuredOutput.Tool}
	}
	out.Tool, out.Err = eval.SelectOne(names, offered, "claude -p")
	return out
}
