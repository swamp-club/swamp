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

package app

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/cases"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/report"
)

func reportCommand(args []string, env Env) int {
	fs := newFlagSet("report", env)
	summary := fs.String("github-summary", "", "append the Markdown report to this file")
	threshold := fs.Float64("threshold", 0.9, "pass rate each model must meet")
	expect := fs.String("expect", "", `models that must have an artifact: a comma list, or "all" for every API model`)
	positional, err := parseFlags(fs, args)
	if err != nil {
		if isHelp(err) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(positional) != 1 {
		return errorf(env, "report takes exactly one directory")
	}
	var expected []string
	switch strings.TrimSpace(*expect) {
	case "":
	case "all":
		expected = models.APIAliases()
	default:
		for _, part := range strings.Split(*expect, ",") {
			alias := strings.TrimSpace(part)
			if _, err := models.Lookup(alias); err != nil {
				return errorf(env, "--expect: %v", err)
			}
			expected = append(expected, alias)
		}
	}
	col, err := report.LoadDir(positional[0])
	if err != nil && !os.IsNotExist(err) {
		return errorf(env, "read %s: %v", positional[0], err)
	}
	md := report.CrossModelMarkdown(col, expected, *threshold)
	fmt.Fprint(env.Stdout, md)
	if *summary != "" {
		if err := report.AppendFile(*summary, md); err != nil {
			return errorf(env, "write summary: %v", err)
		}
	}
	return ExitOK
}

type caseView struct {
	ID           string     `json:"id"`
	Suite        string     `json:"suite"`
	Description  string     `json:"description"`
	Expect       string     `json:"expect"`
	ExpectedTool string     `json:"expected_tool"`
	Tools        []toolView `json:"tools"`
	SystemPrompt string     `json:"system_prompt,omitempty"`
	Input        string     `json:"input,omitempty"`
}

type toolView struct {
	Name             string `json:"name"`
	Description      string `json:"description,omitempty"`
	Param            string `json:"param,omitempty"`
	ParamDescription string `json:"param_description,omitempty"`
}

func casesCommand(args []string, env Env) int {
	fs := newFlagSet("cases", env)
	repoRoot := fs.String("repo-root", "", "repository root (default: nearest parent holding .claude/skills)")
	suiteFlag := fs.String("suite", "all", "trigger, routing, sufficiency, a comma list, or all")
	full := fs.Bool("full", false, "include system prompts, inputs and tool descriptions")
	positional, err := parseFlags(fs, args)
	if err != nil {
		if isHelp(err) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(positional) > 0 {
		return errorf(env, "cases takes no positional arguments")
	}
	suites, err := parseSuites(*suiteFlag)
	if err != nil {
		return errorf(env, "%v", err)
	}
	root, err := resolveRoot(*repoRoot, env)
	if err != nil {
		return errorf(env, "%v", err)
	}
	built, err := cases.Build(root, suites)
	if err != nil {
		return errorf(env, "invalid fixtures: %v", err)
	}
	views := make([]caseView, len(built))
	for i, c := range built {
		v := caseView{ID: c.ID, Suite: string(c.Suite), Description: c.Description, Expect: string(c.Expect), ExpectedTool: c.ExpectedTool}
		for _, t := range c.Tools {
			tv := toolView{Name: t.Name}
			if *full {
				tv.Description, tv.Param, tv.ParamDescription = t.Description, t.Param, t.ParamDescription
			}
			v.Tools = append(v.Tools, tv)
		}
		if *full {
			v.SystemPrompt, v.Input = c.SystemPrompt, c.Input
		}
		views[i] = v
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(views); err != nil {
		return errorf(env, "%v", err)
	}
	_, _ = env.Stdout.Write(buf.Bytes())
	return ExitOK
}

func listModelsCommand(args []string, env Env) int {
	if len(args) > 0 {
		return errorf(env, "list-models takes no arguments")
	}
	w := tabwriter.NewWriter(env.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(w, "ALIAS\tAPI MODEL\tROUTES\tAPI KEY\tAPI CONCURRENCY\tPRICING (IN/OUT PER 1M)\tCLI")
	for _, m := range models.Registry {
		apiModel, key, conc, price, cli := "—", "—", "—", "—", "—"
		if m.API != nil {
			apiModel, key, conc = m.API.ModelID, m.API.KeyEnv, fmt.Sprint(m.API.Concurrency)
			if m.API.Pricing != nil {
				price = fmt.Sprintf("$%.2f/$%.2f", m.API.Pricing.InputPerMillion, m.API.Pricing.OutputPerMillion)
			}
		}
		if m.CLI != nil {
			cli = fmt.Sprintf("%s --model %s (effort %s)", m.CLI.Kind, m.CLI.Model, m.CLI.Effort)
		}
		routes := make([]string, 0, 2)
		for _, r := range m.Routes() {
			routes = append(routes, string(r))
		}
		fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\t%s\t%s\n", m.Alias, apiModel, strings.Join(routes, ","), key, conc, price, cli)
	}
	_ = w.Flush()
	return ExitOK
}
