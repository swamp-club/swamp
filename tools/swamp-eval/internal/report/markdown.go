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
	"io"
	"os"
	"slices"
	"strings"
	"text/tabwriter"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/runner"
)

func pct(rate float64) string { return fmt.Sprintf("%.1f%%", rate*100) }

func cost(c *float64) string {
	if c == nil {
		return "—"
	}
	return fmt.Sprintf("$%.2f", *c)
}

func cell(s string) string {
	s = strings.ReplaceAll(s, "|", `\|`)
	return strings.Join(strings.Fields(s), " ")
}

func caseAnswer(c CaseRecord) string {
	if c.Error != nil {
		return "error: " + c.Error.Message
	}
	if c.ActualTool != nil {
		return *c.ActualTool
	}
	return "—"
}

func expectation(c CaseRecord) string {
	if c.Expect == "avoid" {
		return "not " + c.ExpectedTool
	}
	return c.ExpectedTool
}

// RunMarkdown is the per-model summary for a GitHub step summary.
func RunMarkdown(a Artifact) string {
	var b strings.Builder
	fmt.Fprintf(&b, "## Skill Eval Results (%s)\n\n", a.Model.Alias)
	if a.Status == StatusCancelled {
		fmt.Fprintf(&b, "**Cancelled** — %d cases did not run.\n\n", a.Summary.NotRun)
	}
	b.WriteString("| Suite | Passed | Failed | Errors | Total | Rate | Cost |\n|---|---|---|---|---|---|---|\n")
	for _, s := range a.Suites {
		fmt.Fprintf(&b, "| %s | %d | %d | %d | %d | %s | %s |\n", s.Suite, s.Passed, s.Failed, s.Errors, s.Total, pct(s.PassRate), cost(s.EstimatedCostUSD))
	}
	t := a.Summary
	fmt.Fprintf(&b, "| **Combined** | **%d** | **%d** | **%d** | **%d** | **%s** | **%s** |\n\n", t.Passed, t.Failed, t.Errors, t.Total, pct(t.PassRate), cost(t.EstimatedCostUSD))
	verdict := "✅ met"
	if !t.MetThreshold {
		verdict = "❌ missed"
	}
	fmt.Fprintf(&b, "Threshold %s: %s. Route: `%s`.", pct(a.Options.Threshold), verdict, a.Model.Route)
	if len(a.Model.ResolvedModels) > 0 {
		fmt.Fprintf(&b, " Resolved model: `%s`.", strings.Join(a.Model.ResolvedModels, "`, `"))
	}
	b.WriteString("\n\n")
	if len(t.ErrorCategories) > 0 {
		keys := make([]string, 0, len(t.ErrorCategories))
		for k := range t.ErrorCategories {
			keys = append(keys, k)
		}
		slices.Sort(keys)
		parts := make([]string, len(keys))
		for i, k := range keys {
			parts[i] = fmt.Sprintf("%s ×%d", k, t.ErrorCategories[k])
		}
		fmt.Fprintf(&b, "Errors by category: %s.\n\n", strings.Join(parts, ", "))
	}
	var failing []CaseRecord
	for _, c := range a.Cases {
		if c.Outcome == string(runner.Fail) || c.Outcome == string(runner.Error) {
			failing = append(failing, c)
		}
	}
	if len(failing) > 0 {
		b.WriteString("### Failed cases\n\n")
		caseTable(&b, failing)
	}
	for _, s := range a.Suites {
		fmt.Fprintf(&b, "<details><summary>All %s cases (%d/%d passed)</summary>\n\n", s.Suite, s.Passed, s.Total)
		var cases []CaseRecord
		for _, c := range a.Cases {
			if c.Suite == s.Suite {
				cases = append(cases, c)
			}
		}
		caseTable(&b, cases)
		b.WriteString("</details>\n\n")
	}
	return b.String()
}

func caseTable(b *strings.Builder, cases []CaseRecord) {
	b.WriteString("| Result | Case | Expected | Got |\n|---|---|---|---|\n")
	for _, c := range cases {
		fmt.Fprintf(b, "| %s | %s | %s | %s |\n", mark(c.Outcome), cell(c.Description), cell(expectation(c)), cell(eval.Truncate(caseAnswer(c), 120)))
	}
	b.WriteString("\n")
}

func mark(outcome string) string {
	switch runner.Outcome(outcome) {
	case runner.Pass:
		return "✅ PASS"
	case runner.Fail:
		return "❌ FAIL"
	case runner.Error:
		return "⚠️ ERROR"
	}
	return "— NOT RUN"
}

// RunText lists every case in fixture order, grouped by suite, for the console.
func RunText(a Artifact) string {
	var b strings.Builder
	for _, s := range a.Suites {
		fmt.Fprintf(&b, "\n── %s (%d/%d passed) ──\n", s.Suite, s.Passed, s.Total)
		w := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
		for _, c := range a.Cases {
			if c.Suite != s.Suite {
				continue
			}
			fmt.Fprintf(w, "%s\t%s", strings.ToUpper(c.Outcome), c.Description)
			if c.Outcome != string(runner.Pass) {
				fmt.Fprintf(w, "\t→ %s (expected %s)", eval.Truncate(caseAnswer(c), 100), expectation(c))
			}
			fmt.Fprintln(w)
		}
		_ = w.Flush()
	}
	return b.String()
}

// AppendFile adds text to a file such as $GITHUB_STEP_SUMMARY.
func AppendFile(path, text string) error {
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.WriteString(f, text); err != nil {
		f.Close()
		return err
	}
	return f.Close()
}
