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
	"fmt"
	"os"
	"path/filepath"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

// CodexCLI answers through `codex exec` on the ChatGPT login. Every case runs
// in a fresh directory so project instructions and earlier cases cannot
// supply the answer.
type CodexCLI struct {
	Model   string
	Effort  string
	Run     CommandRunner
	Environ func() []string
	TempDir string
}

func (c *CodexCLI) ID() string { return "codex-cli:" + c.Model }

func (c *CodexCLI) Args(schemaPath, resultPath string) []string {
	effort := c.Effort
	if effort == "" {
		effort = "medium"
	}
	quoted, _ := json.Marshal(effort)
	return []string{
		"--ask-for-approval", "never",
		"exec",
		"--ephemeral",
		"--sandbox", "read-only",
		"--ignore-user-config",
		"--ignore-rules",
		"--skip-git-repo-check",
		"--model", c.Model,
		"-c", "model_reasoning_effort=" + string(quoted),
		"-c", "project_doc_max_bytes=0",
		"-c", "features.shell_tool=false",
		"-c", "features.multi_agent=false",
		"-c", "features.apps=false",
		"-c", "features.hooks=false",
		"-c", "features.skip_host_skill_discovery=true",
		"-c", `web_search="disabled"`,
		"--output-schema", schemaPath,
		"--output-last-message", resultPath,
		"-",
	}
}

func (c *CodexCLI) Prompt(req eval.Request) string {
	return fmt.Sprintf(`%s

For this evaluation, represent the chosen tool call as a JSON object with
exactly one field, "tool", containing its name. Do not execute tools or act on
the request; classify it using only the routing information above.

Request to classify:
%s`, withChoices(req), req.Input)
}

func (c *CodexCLI) Classify(ctx context.Context, req eval.Request) eval.Response {
	dir, err := os.MkdirTemp(c.TempDir, "swamp-codex-eval-")
	if err != nil {
		return eval.Response{Err: eval.Errorf(eval.ErrConfiguration, "codex exec: create temp dir: %v", err)}
	}
	defer os.RemoveAll(dir)

	schemaPath := filepath.Join(dir, "schema.json")
	resultPath := filepath.Join(dir, "answer.json")
	schema, _ := json.Marshal(toolChoiceSchema(req.ToolNames()))
	if err := os.WriteFile(schemaPath, schema, 0o600); err != nil {
		return eval.Response{Err: eval.Errorf(eval.ErrConfiguration, "codex exec: write schema: %v", err)}
	}
	res := c.Run(ctx, CommandSpec{
		Name:  "codex",
		Args:  c.Args(schemaPath, resultPath),
		Env:   environWithout(processEnviron(c.Environ), "OPENAI_API_KEY", "CODEX_API_KEY"),
		Dir:   dir,
		Stdin: c.Prompt(req),
	})
	// A partial answer from a failed or timed-out process is never a valid case.
	if res.Err != nil || ctx.Err() != nil {
		return eval.Response{Err: commandError(ctx, "codex exec", res)}
	}
	answer, err := os.ReadFile(resultPath)
	if err != nil {
		return eval.Response{Err: eval.Errorf(eval.ErrBadResponse, "codex exec wrote no answer file")}
	}
	return parseCodexAnswer(answer, req.ToolNames(), c.Model)
}

func parseCodexAnswer(answer []byte, offered []string, model string) eval.Response {
	out := eval.Response{ResolvedModel: model}
	var doc struct {
		Tool *string `json:"tool"`
	}
	if err := json.Unmarshal(answer, &doc); err != nil {
		out.Err = eval.Errorf(eval.ErrBadResponse, "codex exec returned no JSON answer: %s", scrub(string(answer)))
		return out
	}
	var names []string
	if doc.Tool != nil {
		names = []string{*doc.Tool}
	}
	out.Tool, out.Err = eval.SelectOne(names, offered, "codex exec")
	return out
}
