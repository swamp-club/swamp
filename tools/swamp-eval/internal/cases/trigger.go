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

package cases

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

var triggerSkills = []string{"swamp", "swamp-getting-started"}

const noMatchTool = "no_match"

const noMatchDescription = "Use when the query does not match any available skill. Route here for general coding questions, git/PR operations, architecture planning, worktree management, cron/agent scheduling, or any task unrelated to the swamp CLI."

const triggerSystemPrompt = "You are a skill router for swamp, an AI-native automation framework. Your ONLY job is to route user requests to the correct skill by making a tool call. You MUST call exactly one tool for every request. If the request is NOT about the swamp CLI (e.g. general coding, git, PRs, architecture planning, worktree management, cron scheduling), call the no_match tool. NEVER respond with text. NEVER ask clarifying questions."

type triggerRow struct {
	Query         string `json:"query"`
	ShouldTrigger *bool  `json:"should_trigger"`
	Note          string `json:"note"`
}

func buildTrigger(root string) ([]eval.Case, error) {
	var tools []eval.Tool
	rowsBySkill := map[string][]triggerRow{}
	neutral := map[string]string{}
	for i, skill := range triggerSkills {
		neutral[skill] = fmt.Sprintf("skill_%c", 'a'+i)
		dir := filepath.Join(root, ".claude", "skills", skill)
		md, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
		if err != nil {
			return nil, err
		}
		name, err := frontmatterScalar(string(md), "name")
		if err != nil {
			return nil, fmt.Errorf("%s/SKILL.md: %w", skill, err)
		}
		if name != skill {
			return nil, fmt.Errorf("%s/SKILL.md: frontmatter name is %q", skill, name)
		}
		description, err := frontmatterScalar(string(md), "description")
		if err != nil {
			return nil, fmt.Errorf("%s/SKILL.md: %w", skill, err)
		}
		// The skill's own name would give the answer away: nearly every
		// positive query mentions swamp, so only the description may decide.
		tool := queryTool(neutral[skill], description, "The user's request to process")
		tool.Label = skill
		tools = append(tools, tool)

		path := filepath.Join(dir, "evals", "trigger_evals.json")
		rows, err := readFixture[triggerRow](path)
		if err != nil {
			return nil, err
		}
		for i, row := range rows {
			if err := requireQuery(path, i, row.Query); err != nil {
				return nil, err
			}
			if row.ShouldTrigger == nil {
				return nil, fmt.Errorf("%s: row %d is missing should_trigger", path, i)
			}
		}
		rowsBySkill[skill] = rows
	}
	// Descriptions refer to each other by name ("use swamp-getting-started"), so
	// those references follow the rename. The bare product word "swamp" is
	// left alone: it is not a reference to the skill.
	for i := range tools {
		for _, other := range triggerSkills {
			if strings.Contains(other, "-") {
				tools[i].Description = strings.ReplaceAll(tools[i].Description, other, neutral[other])
			}
		}
	}
	tools = append(tools, queryTool(noMatchTool, noMatchDescription, "The user's request"))

	var out []eval.Case
	for _, skill := range triggerSkills {
		for _, row := range rowsBySkill[skill] {
			direction, expect := "SHOULD", eval.ExpectSelect
			if !*row.ShouldTrigger {
				direction, expect = "should NOT", eval.ExpectAvoid
			}
			out = append(out, eval.Case{
				ID:           caseID(string(eval.SuiteTrigger), skill, row.Query),
				Suite:        eval.SuiteTrigger,
				Description:  fmt.Sprintf("[%s] %s trigger: %s", skill, direction, eval.Truncate(row.Query, 60)),
				Input:        row.Query,
				SystemPrompt: triggerSystemPrompt,
				Tools:        tools,
				ExpectedTool: neutral[skill],
				Expect:       expect,
			})
		}
	}
	return out, nil
}
