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

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

const sufficiencySystemPrompt = "You are evaluating whether a skill guide contains enough information for an AI agent to act on a user's query.\n\nThe guide content is included in the user message below the query. Based ONLY on the guide content provided, decide:\n- If the guide contains the CLI command, rule, concept, or procedure needed to act on the query → call answer_from_guide. A command in a Quick Reference table with its syntax IS sufficient — the agent can run it and inspect the output.\n- If the query asks about implementation details, internal mechanics, step-by-step walkthroughs, output shapes, or advanced configuration that the guide does not cover → call need_reference\n\nKey principle: if the guide shows the exact command to run (even in a table row), that is sufficient for queries asking how to DO something. Only call need_reference when the query asks about HOW something works internally or needs details beyond what the command table provides."

var sufficiencyTools = []eval.Tool{
	{
		Name:             "answer_from_guide",
		Description:      "Call this when the guide content provided is sufficient to answer the user's query. The guide contains the commands, rules, or information needed.",
		Param:            "answer",
		ParamDescription: "Brief answer derived from the guide content",
	},
	{
		Name:             "need_reference",
		Description:      "Call this when the guide content is NOT sufficient to answer the user's query. The guide lacks the detailed walkthrough, output shapes, or implementation specifics needed.",
		Param:            "missing",
		ParamDescription: "What information is missing from the guide",
	},
}

type sufficiencyRow struct {
	Query               string `json:"query"`
	Guide               string `json:"guide"`
	AnswerableFromGuide *bool  `json:"answerable_from_guide"`
	Note                string `json:"note"`
}

// sufficiencyInput is the user message: guide text is appended verbatim, with
// no templating, so `{{ ... }}` expressions in guides reach the model intact.
func sufficiencyInput(query, guide string) string {
	return query + "\n\n---\n\nGuide content:\n\n" + guide
}

func buildSufficiency(root string) ([]eval.Case, error) {
	dir := filepath.Join(root, ".claude", "skills", "swamp")
	path := filepath.Join(dir, "evals", "guide_sufficiency_evals.json")
	rows, err := readFixture[sufficiencyRow](path)
	if err != nil {
		return nil, err
	}
	guides := map[string]string{}
	out := make([]eval.Case, 0, len(rows))
	for i, row := range rows {
		if err := requireQuery(path, i, row.Query); err != nil {
			return nil, err
		}
		if !guideKnown(row.Guide) {
			return nil, fmt.Errorf("%s: row %d names unknown guide %q (valid: %s)", path, i, row.Guide, guideKeys())
		}
		if row.AnswerableFromGuide == nil {
			return nil, fmt.Errorf("%s: row %d is missing answerable_from_guide", path, i)
		}
		guide, ok := guides[row.Guide]
		if !ok {
			data, err := os.ReadFile(filepath.Join(dir, "references", row.Guide, "guide.md"))
			if err != nil {
				return nil, err
			}
			guide = string(data)
			guides[row.Guide] = guide
		}
		expected, label := "need_reference", "insufficient"
		if *row.AnswerableFromGuide {
			expected, label = "answer_from_guide", "sufficient"
		}
		out = append(out, eval.Case{
			ID:           caseID(string(eval.SuiteSufficiency), row.Guide, row.Query),
			Suite:        eval.SuiteSufficiency,
			Description:  fmt.Sprintf("[%s:%s] %s", row.Guide, label, eval.Truncate(row.Query, 50)),
			Input:        sufficiencyInput(row.Query, guide),
			SystemPrompt: sufficiencySystemPrompt,
			Tools:        sufficiencyTools,
			ExpectedTool: expected,
			Expect:       eval.ExpectSelect,
		})
	}
	return out, nil
}
