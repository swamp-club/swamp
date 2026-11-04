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

type guideTopic struct {
	Key         string
	Description string
}

// guideTopics is the routing catalog, in the order tools are offered. Every
// topic is also a references/<key>/guide.md directory the sufficiency suite reads.
var guideTopics = []guideTopic{
	{"behavior", "Load this guide for behavior (model) operations — create, run, edit, delete, search types, method execution, behavior outputs"},
	{"workflow", "Load this guide for workflow operations — create, run, validate, DAG, history, scheduled workflows"},
	{"data", "Load this guide for data operations — list, query, versions, garbage collection, delete, CEL predicates"},
	{"vault", "Load this guide for vault operations — create, store/read secrets, list keys, vault expressions"},
	{"extension", "Load this guide for extension development — create models, vaults, drivers, datastores, reports, Zod schemas, smoke testing, quality scorecard"},
	{"extension-publish", "Load this guide for publishing — push extensions to registry, deprecate, version bumping"},
	{"repo", "Load this guide for repository management — init, upgrade, datastores, extension sources, CI/CD"},
	{"report", "Load this guide for report operations — run, configure, view, filter reports"},
	{"troubleshooting", "Load this guide for troubleshooting — errors, health checks, diagnostics, tracing, debugging"},
	{"issue", "Load this guide for issue operations — file bugs, feature requests, security reports, comments"},
	{"architecture", "Load this guide for architecture decisions — choosing between behavior, workflow, report, extension, vault, and design trade-offs"},
	{"share", "Load this guide for sharing a repo — promoting a solo repo to a team, datastore promotion, vault migration, joiner onboarding"},
	{"serve", "Load this guide for swamp serve — auth modes, grants, access control, groups, tokens, OAuth server login"},
}

func guideKnown(key string) bool {
	for _, t := range guideTopics {
		if t.Key == key {
			return true
		}
	}
	return false
}

func guideKeys() string {
	keys := make([]string, len(guideTopics))
	for i, t := range guideTopics {
		keys[i] = t.Key
	}
	return strings.Join(keys, ", ")
}

func guideToolName(key string) string {
	return "load_" + strings.ReplaceAll(key, "-", "_") + "_guide"
}

func routingSystemPrompt(skillBody string) string {
	return "You are a skill router inside the swamp gateway skill. The user's request has already been routed to the swamp skill. Your job is to load the correct guide by calling the matching tool.\n\nHere is the routing table:\n\n" +
		skillBody +
		"\n\nYou MUST call exactly one tool. NEVER respond with text. Route based on the topic and keywords."
}

type routingRow struct {
	Query         string `json:"query"`
	ExpectedGuide string `json:"expected_guide"`
	Note          string `json:"note"`
}

func buildRouting(root string) ([]eval.Case, error) {
	dir := filepath.Join(root, ".claude", "skills", "swamp")
	md, err := os.ReadFile(filepath.Join(dir, "SKILL.md"))
	if err != nil {
		return nil, err
	}
	body, err := skillBody(string(md))
	if err != nil {
		return nil, fmt.Errorf("swamp/SKILL.md: %w", err)
	}
	system := routingSystemPrompt(body)

	tools := make([]eval.Tool, len(guideTopics))
	for i, t := range guideTopics {
		tools[i] = queryTool(guideToolName(t.Key), t.Description, "The user's request to process")
	}

	path := filepath.Join(dir, "evals", "routing_evals.json")
	rows, err := readFixture[routingRow](path)
	if err != nil {
		return nil, err
	}
	out := make([]eval.Case, 0, len(rows))
	for i, row := range rows {
		if err := requireQuery(path, i, row.Query); err != nil {
			return nil, err
		}
		if !guideKnown(row.ExpectedGuide) {
			return nil, fmt.Errorf("%s: row %d names unknown guide %q (valid: %s)", path, i, row.ExpectedGuide, guideKeys())
		}
		out = append(out, eval.Case{
			ID:           caseID(string(eval.SuiteRouting), row.Query),
			Suite:        eval.SuiteRouting,
			Description:  fmt.Sprintf("[%s] %s", row.ExpectedGuide, eval.Truncate(row.Query, 60)),
			Input:        row.Query,
			SystemPrompt: system,
			Tools:        tools,
			ExpectedTool: guideToolName(row.ExpectedGuide),
			Expect:       eval.ExpectSelect,
		})
	}
	return out, nil
}
