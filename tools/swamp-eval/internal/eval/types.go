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

package eval

import (
	"fmt"
	"slices"
)

type Suite string

const (
	SuiteTrigger     Suite = "trigger"
	SuiteRouting     Suite = "routing"
	SuiteSufficiency Suite = "sufficiency"
)

var AllSuites = []Suite{SuiteTrigger, SuiteRouting, SuiteSufficiency}

// Tool is a choice offered to the model. Every tool takes one required string
// argument, and adapters render exactly that shape.
type Tool struct {
	Name string
	// Label is the name reports show; empty means Name.
	Label            string
	Description      string
	Param            string
	ParamDescription string
}

// Expect is how a case judges the selected tool. Avoid exists because a
// negative trigger case for one skill may legitimately select the other skill.
type Expect string

const (
	ExpectSelect Expect = "select"
	ExpectAvoid  Expect = "avoid"
)

type Case struct {
	ID           string
	Suite        Suite
	Description  string
	Input        string
	SystemPrompt string
	Tools        []Tool
	ExpectedTool string
	Expect       Expect
}

// Label is the reported name for one of c's tools.
func (c Case) Label(tool string) string {
	for _, t := range c.Tools {
		if t.Name == tool && t.Label != "" {
			return t.Label
		}
	}
	return tool
}

// Passes judges a tool the adapter has already validated as one of c.Tools.
func (c Case) Passes(selected string) bool {
	if c.Expect == ExpectAvoid {
		return selected != c.ExpectedTool
	}
	return selected == c.ExpectedTool
}

func (c Case) Request() Request {
	return Request{SystemPrompt: c.SystemPrompt, Input: c.Input, Tools: c.Tools}
}

type Request struct {
	SystemPrompt string
	Input        string
	Tools        []Tool
}

func (r Request) ToolNames() []string {
	names := make([]string, len(r.Tools))
	for i, t := range r.Tools {
		names[i] = t.Name
	}
	return names
}

type Response struct {
	Tool          string
	ResolvedModel string
	InputTokens   *int64
	OutputTokens  *int64
	Err           *Error
}

type ErrorCategory string

const (
	ErrTimeout       ErrorCategory = "timeout"
	ErrAuth          ErrorCategory = "auth"
	ErrRateLimit     ErrorCategory = "rate_limit"
	ErrNetwork       ErrorCategory = "network"
	ErrProvider      ErrorCategory = "provider"
	ErrBadResponse   ErrorCategory = "bad_response"
	ErrCLIExit       ErrorCategory = "cli_exit"
	ErrInvalidTool   ErrorCategory = "invalid_tool"
	ErrConfiguration ErrorCategory = "configuration"
	ErrCancelled     ErrorCategory = "cancelled"
)

type Error struct {
	Category ErrorCategory `json:"category"`
	Message  string        `json:"message"`
}

func (e *Error) Error() string { return fmt.Sprintf("%s: %s", e.Category, e.Message) }

func Errorf(category ErrorCategory, format string, args ...any) *Error {
	return &Error{Category: category, Message: fmt.Sprintf(format, args...)}
}

// SelectOne validates a model's tool calls: exactly one, from the offered set.
func SelectOne(names []string, offered []string, source string) (string, *Error) {
	switch {
	case len(names) == 0:
		return "", Errorf(ErrInvalidTool, "%s returned no tool call", source)
	case len(names) > 1:
		return "", Errorf(ErrInvalidTool, "%s returned %d tool calls: %v", source, len(names), names)
	case !slices.Contains(offered, names[0]):
		return "", Errorf(ErrInvalidTool, "%s selected unknown tool %q", source, Truncate(names[0], 80))
	}
	return names[0], nil
}

// Truncate cuts s to n runes.
func Truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n])
}
