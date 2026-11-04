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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/runner"
)

func ptr(v int64) *int64 { return &v }

func result(id string, suite eval.Suite, outcome runner.Outcome, in *int64) runner.Result {
	r := runner.Result{
		Case:        eval.Case{ID: id, Suite: suite, Description: "[x] " + id, ExpectedTool: "a", Expect: eval.ExpectSelect},
		Outcome:     outcome,
		InputTokens: in, OutputTokens: in,
	}
	switch outcome {
	case runner.Pass:
		r.Actual = "a"
	case runner.Fail:
		r.Actual = "b"
	case runner.Error:
		r.Err = eval.Errorf(eval.ErrRateLimit, "429")
	}
	return r
}

func build(t *testing.T, alias string, route models.Route, results []runner.Result) Artifact {
	t.Helper()
	m, err := models.Lookup(alias)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
	return Build(BuildInput{
		Model: m, Route: route, Options: RunOptions{Concurrency: 2, TimeoutMS: 1000, Threshold: 0.9},
		Suites: []eval.Suite{eval.SuiteTrigger, eval.SuiteRouting}, Results: results,
		StartedAt: now, FinishedAt: now.Add(time.Minute), WallClock: time.Minute,
	})
}

func TestBuildCountsErrorsAgainstThePassRate(t *testing.T) {
	results := []runner.Result{}
	for i := range 8 {
		results = append(results, result("t"+string(rune('a'+i)), eval.SuiteTrigger, runner.Pass, ptr(1_000_000)))
	}
	results = append(results,
		result("r1", eval.SuiteRouting, runner.Fail, ptr(1_000_000)),
		result("r2", eval.SuiteRouting, runner.Error, nil),
	)
	a := build(t, "sonnet", models.RouteAPI, results)
	s := a.Summary
	if s.Total != 10 || s.Passed != 8 || s.Failed != 1 || s.Errors != 1 || s.PassRate != 0.8 || s.MetThreshold {
		t.Fatalf("summary = %+v", s)
	}
	if s.ErrorCategories["rate_limit"] != 1 {
		t.Errorf("categories = %v", s.ErrorCategories)
	}
	if *s.TokenUsage.Input != 9_000_000 || s.EstimatedCostUSD == nil || *s.EstimatedCostUSD != 9*3+9*15 {
		t.Errorf("usage/cost = %v %v", *s.TokenUsage.Input, s.EstimatedCostUSD)
	}
	if len(a.Suites) != 2 || a.Suites[0].Total != 8 || a.Suites[1].Errors != 1 {
		t.Errorf("suites = %+v", a.Suites)
	}
	if a.Cases[9].ActualTool != nil || a.Cases[9].Error == nil {
		t.Errorf("errored case = %+v", a.Cases[9])
	}
}

func TestCLIRouteHasNoDollarCost(t *testing.T) {
	a := build(t, "opus", models.RouteCLI, []runner.Result{result("x", eval.SuiteTrigger, runner.Pass, ptr(10))})
	if a.Summary.EstimatedCostUSD != nil {
		t.Errorf("a subscription run must report null cost, got %v", *a.Summary.EstimatedCostUSD)
	}
	if a.Model.ConfiguredID != "opus" || !a.Summary.MetThreshold {
		t.Errorf("artifact = %+v", a.Summary)
	}
}

func TestMissingUsageStaysNull(t *testing.T) {
	a := build(t, "sonnet", models.RouteAPI, []runner.Result{result("x", eval.SuiteTrigger, runner.Pass, nil)})
	if a.Summary.TokenUsage.Input != nil || a.Summary.EstimatedCostUSD != nil {
		t.Error("absent usage must not become zero usage or zero cost")
	}
}

func TestCancelledRunNeverMeetsTheThreshold(t *testing.T) {
	a := build(t, "sonnet", models.RouteAPI, []runner.Result{
		result("x", eval.SuiteTrigger, runner.Pass, nil),
		result("y", eval.SuiteTrigger, runner.NotRun, nil),
	})
	if a.Summary.MetThreshold || a.Summary.NotRun != 1 || a.Summary.Total != 1 {
		t.Errorf("summary = %+v", a.Summary)
	}
}

func TestWriteAtomicAndLoadRoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "nested", "sonnet.json")
	a := build(t, "sonnet", models.RouteAPI, []runner.Result{result("x", eval.SuiteTrigger, runner.Pass, nil)})
	if err := WriteAtomic(path, a); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Errorf("temp file left behind: %v", entries)
	}
	got, err := Load(path)
	if err != nil || got.Summary.Passed != 1 || got.Model.Alias != "sonnet" {
		t.Fatalf("load = %+v, %v", got.Summary, err)
	}
	for name, content := range map[string]string{
		"old.json":     `{"schema_version": 0, "model": {"alias": "x"}}`,
		"corrupt.json": `{"schema_version"`,
		"pf.json":      `{"results": {"stats": {}}}`,
	} {
		p := filepath.Join(dir, name)
		_ = os.WriteFile(p, []byte(content), 0o644)
		if _, err := Load(p); err == nil {
			t.Errorf("%s: want error", name)
		}
	}
}

func TestCrossModelReport(t *testing.T) {
	dir := t.TempDir()
	shared := result("shared", eval.SuiteTrigger, runner.Fail, nil)
	only := result("only", eval.SuiteTrigger, runner.Error, nil)
	pass := result("p", eval.SuiteTrigger, runner.Pass, nil)
	write := func(name string, a Artifact) {
		if err := WriteAtomic(filepath.Join(dir, name, name+".json"), a); err != nil {
			t.Fatal(err)
		}
	}
	write("opus", build(t, "opus", models.RouteAPI, []runner.Result{shared, pass}))
	write("sonnet", build(t, "sonnet", models.RouteAPI, []runner.Result{shared, only}))
	var many []runner.Result
	for range 10 {
		many = append(many, pass)
	}
	write("fable", build(t, "fable", models.RouteAPI, many))
	_ = os.WriteFile(filepath.Join(dir, "junk.json"), []byte("{"), 0o644)

	col, err := LoadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(col.Artifacts) != 3 || len(col.Invalid) != 1 {
		t.Fatalf("loaded %d artifacts, %d invalid", len(col.Artifacts), len(col.Invalid))
	}
	md := CrossModelMarkdown(col, models.APIAliases(), 0.9)
	for _, want := range []string{
		"| fable | api | ✅ pass |",
		"| [x] shared | opus, sonnet | 2/3 |",
		"| [x] only | sonnet |",
		"| gpt-5.4 | — | ❌ missing |",
		"| gemini-3.1-pro | — | ❌ missing |",
		"| gemini-2.5-pro | — | ❌ missing |",
		"junk.json",
		"**gpt-5.4**: no artifact",
		"❌ **Action required**",
	} {
		if !strings.Contains(md, want) {
			t.Errorf("report lacks %q:\n%s", want, md)
		}
	}
}

func TestRunMarkdown(t *testing.T) {
	a := build(t, "sonnet", models.RouteAPI, []runner.Result{
		result("x", eval.SuiteTrigger, runner.Pass, nil),
		result("y|z", eval.SuiteRouting, runner.Error, nil),
	})
	md := RunMarkdown(a)
	for _, want := range []string{"## Skill Eval Results (sonnet)", "| **Combined** | **1** | **0** | **1** | **2** | **50.0%**", "❌ missed", `[x] y\|z`, "error: 429", "rate_limit ×1"} {
		if !strings.Contains(md, want) {
			t.Errorf("markdown lacks %q:\n%s", want, md)
		}
	}
}

func TestRunTextListsEveryCaseBySuite(t *testing.T) {
	a := build(t, "sonnet", models.RouteAPI, []runner.Result{
		result("ok", eval.SuiteTrigger, runner.Pass, nil),
		result("wrong", eval.SuiteTrigger, runner.Fail, nil),
		result("broke", eval.SuiteRouting, runner.Error, nil),
	})
	text := RunText(a)
	for _, want := range []string{
		"── trigger (1/2 passed) ──",
		"PASS  [x] ok",
		"FAIL  [x] wrong  → b (expected a)",
		"── routing (0/1 passed) ──",
		"ERROR  [x] broke  → error: 429 (expected a)",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("text lacks %q:\n%s", want, text)
		}
	}
	md := RunMarkdown(a)
	if !strings.Contains(md, "<details><summary>All trigger cases (1/2 passed)</summary>") || !strings.Contains(md, "| ✅ PASS | [x] ok |") {
		t.Errorf("markdown must list every case:\n%s", md)
	}
}
