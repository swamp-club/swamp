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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

type CommandSpec struct {
	Name  string
	Args  []string
	Env   []string
	Dir   string
	Stdin string
}

type CommandResult struct {
	Stdout []byte
	Stderr []byte
	Err    error
}

// CommandRunner is injected so adapter tests never need the real CLIs.
type CommandRunner func(ctx context.Context, spec CommandSpec) CommandResult

func ExecRunner(ctx context.Context, spec CommandSpec) CommandResult {
	cmd := exec.CommandContext(ctx, spec.Name, spec.Args...)
	cmd.Env = spec.Env
	cmd.Dir = spec.Dir
	cmd.Stdin = strings.NewReader(spec.Stdin)
	// A CLI that leaves children holding its pipes must not hang the case
	// past its deadline.
	cmd.WaitDelay = 5 * time.Second
	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	err := cmd.Run()
	return CommandResult{Stdout: stdout.Bytes(), Stderr: stderr.Bytes(), Err: err}
}

// environWithout copies the process environment minus the named variables.
func environWithout(environ []string, drop ...string) []string {
	out := make([]string, 0, len(environ))
	for _, kv := range environ {
		name, _, _ := strings.Cut(kv, "=")
		keep := true
		for _, d := range drop {
			if name == d {
				keep = false
				break
			}
		}
		if keep {
			out = append(out, kv)
		}
	}
	return out
}

func processEnviron(fn func() []string) []string {
	if fn != nil {
		return fn()
	}
	return os.Environ()
}

func commandError(ctx context.Context, source string, res CommandResult) *eval.Error {
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return eval.Errorf(eval.ErrTimeout, "%s timed out", source)
	}
	if errors.Is(ctx.Err(), context.Canceled) {
		return eval.Errorf(eval.ErrCancelled, "%s cancelled", source)
	}
	if errors.Is(res.Err, exec.ErrNotFound) {
		return eval.Errorf(eval.ErrConfiguration, "%s: executable not found on PATH", source)
	}
	return eval.Errorf(eval.ErrCLIExit, "%s failed: %v %s", source, res.Err, scrub(string(res.Stderr)))
}

// withChoices appends every tool's name and description to the system prompt.
// The CLI routes force the answer through a name enum, which carries no
// descriptions; without this the model routes on tool names alone.
func withChoices(req eval.Request) string {
	var choices bytes.Buffer
	enc := json.NewEncoder(&choices)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(openAITools(req.Tools))
	return req.SystemPrompt + "\n\nAvailable routing choices (names and descriptions):\n" + strings.TrimRight(choices.String(), "\n")
}

type enumSchema struct {
	Type                 string                    `json:"type"`
	Properties           map[string]enumSchemaProp `json:"properties"`
	Required             []string                  `json:"required"`
	AdditionalProperties bool                      `json:"additionalProperties"`
}

type enumSchemaProp struct {
	Type string   `json:"type"`
	Enum []string `json:"enum"`
}

// toolChoiceSchema forces the CLI's structured answer to one offered name.
func toolChoiceSchema(names []string) enumSchema {
	return enumSchema{
		Type:       "object",
		Properties: map[string]enumSchemaProp{"tool": {Type: "string", Enum: names}},
		Required:   []string{"tool"},
	}
}
