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

package report

import (
	"fmt"
	"io/fs"
	"path/filepath"
	"slices"
	"strings"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/runner"
)

type Invalid struct {
	Path   string
	Reason string
}

type Collection struct {
	Artifacts []Artifact
	Invalid   []Invalid
}

// LoadDir reads every *.json under dir. Files that are not artifacts are
// listed as invalid rather than failing the report.
func LoadDir(dir string) (Collection, error) {
	var col Collection
	err := filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() || !strings.HasSuffix(d.Name(), ".json") {
			return nil
		}
		a, err := Load(path)
		if err != nil {
			col.Invalid = append(col.Invalid, Invalid{Path: path, Reason: err.Error()})
			return nil
		}
		col.Artifacts = append(col.Artifacts, a)
		return nil
	})
	slices.SortFunc(col.Artifacts, func(a, b Artifact) int { return strings.Compare(a.Model.Alias, b.Model.Alias) })
	return col, err
}

type caseFailure struct {
	description string
	models      []string
}

// CrossModelMarkdown summarizes many runs. A model in expect with no artifact
// is reported missing, never assumed to have passed.
func CrossModelMarkdown(col Collection, expect []string, threshold float64) string {
	var b strings.Builder
	b.WriteString("## Cross-Model Skill Eval Analysis\n\n")

	present := map[string]bool{}
	for _, a := range col.Artifacts {
		present[a.Model.Alias] = true
	}
	var missing []string
	for _, m := range expect {
		if !present[m] {
			missing = append(missing, m)
		}
	}

	b.WriteString("### Results\n\n| Model | Route | Status | Pass Rate | Passed | Failed | Errors | Total | Cost |\n|---|---|---|---|---|---|---|---|---|\n")
	var below []string
	for _, a := range col.Artifacts {
		t := a.Summary
		status := "✅ pass"
		switch {
		case a.Status == StatusCancelled:
			status = "❌ cancelled"
		case t.Total == 0 || float64(t.Passed)/float64(t.Total) < threshold:
			status = "❌ below threshold"
		}
		if status != "✅ pass" {
			below = append(below, fmt.Sprintf("**%s**: %s", a.Model.Alias, pct(t.PassRate)))
		}
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %d | %d | %d | %d | %s |\n", a.Model.Alias, a.Model.Route, status, pct(t.PassRate), t.Passed, t.Failed, t.Errors, t.Total, cost(t.EstimatedCostUSD))
	}
	for _, m := range missing {
		fmt.Fprintf(&b, "| %s | — | ❌ missing | — | — | — | — | — | — |\n", m)
		below = append(below, fmt.Sprintf("**%s**: no artifact", m))
	}
	b.WriteString("\n")

	failures := map[string]*caseFailure{}
	var order []string
	for _, a := range col.Artifacts {
		for _, c := range a.Cases {
			if c.Outcome != string(runner.Fail) && c.Outcome != string(runner.Error) {
				continue
			}
			f, ok := failures[c.ID]
			if !ok {
				f = &caseFailure{description: c.Description}
				failures[c.ID] = f
				order = append(order, c.ID)
			}
			f.models = append(f.models, a.Model.Alias)
		}
	}
	slices.SortStableFunc(order, func(x, y string) int { return len(failures[y].models) - len(failures[x].models) })

	var shared, single []string
	for _, id := range order {
		if len(failures[id].models) > 1 {
			shared = append(shared, id)
		} else {
			single = append(single, id)
		}
	}
	if len(shared) > 0 {
		fmt.Fprintf(&b, "### Cross-Model Failures\n\nCases failing on more than one model point at the fixture or the skill text, not the model.\n\n| Case | Models failing | Count |\n|---|---|---|\n")
		for _, id := range shared {
			f := failures[id]
			fmt.Fprintf(&b, "| %s | %s | %d/%d |\n", cell(f.description), strings.Join(f.models, ", "), len(f.models), len(col.Artifacts))
		}
		b.WriteString("\n")
	}
	if len(single) > 0 {
		b.WriteString("### Model-Specific Failures\n\n| Case | Model |\n|---|---|\n")
		for _, id := range single {
			f := failures[id]
			fmt.Fprintf(&b, "| %s | %s |\n", cell(f.description), f.models[0])
		}
		b.WriteString("\n")
	}
	if len(col.Invalid) > 0 {
		b.WriteString("### Unreadable Artifacts\n\n")
		for _, inv := range col.Invalid {
			fmt.Fprintf(&b, "- `%s`: %s\n", inv.Path, cell(inv.Reason))
		}
		b.WriteString("\n")
	}

	b.WriteString("### Verdict\n\n")
	switch {
	case len(col.Artifacts) == 0 && len(missing) == 0:
		b.WriteString("❌ **No eval artifacts found.**\n")
	case len(below) == 0:
		fmt.Fprintf(&b, "✅ **All models pass** the %s threshold.\n", pct(threshold))
	default:
		fmt.Fprintf(&b, "❌ **Action required** — these models did not pass the %s threshold:\n\n", pct(threshold))
		for _, line := range below {
			fmt.Fprintf(&b, "- %s\n", line)
		}
	}
	return b.String()
}
