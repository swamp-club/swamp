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
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/providers"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/report"
)

type scripted struct {
	answer func(req eval.Request) eval.Response
}

func (s scripted) ID() string { return "scripted" }
func (s scripted) Classify(_ context.Context, req eval.Request) eval.Response {
	return s.answer(req)
}

// newRepo writes a minimal repository whose cases a scripted provider can
// answer from the input alone.
func newRepo(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for _, s := range []string{"swamp", "swamp-getting-started"} {
		write(".claude/skills/"+s+"/SKILL.md", "---\nname: "+s+"\ndescription: d\n---\nbody\n")
	}
	write(".claude/skills/swamp/evals/trigger_evals.json", `[{"query":"swamp one","should_trigger":true},{"query":"swamp two","should_trigger":true},{"query":"react","should_trigger":false}]`)
	write(".claude/skills/swamp-getting-started/evals/trigger_evals.json", `[{"query":"new here","should_trigger":true}]`)
	write(".claude/skills/swamp/evals/routing_evals.json", `[{"query":"secret","expected_guide":"vault"}]`)
	write(".claude/skills/swamp/evals/guide_sufficiency_evals.json", `[{"query":"list","guide":"vault","answerable_from_guide":true,"note":""}]`)
	write(".claude/skills/swamp/references/vault/guide.md", "guide\n")
	return root
}

// oracle answers every case correctly except inputs listed in wrong.
func oracle(wrong ...string) scripted {
	return scripted{func(req eval.Request) eval.Response {
		names := req.ToolNames()
		if req.SystemPrompt == providers.PreflightRequest().SystemPrompt {
			return eval.Response{Tool: "ready", ResolvedModel: "fake-1"}
		}
		for _, w := range wrong {
			if strings.HasPrefix(req.Input, w) {
				return eval.Response{Err: eval.Errorf(eval.ErrProvider, "HTTP 500")}
			}
		}
		pick := map[string]string{
			"swamp one": "skill_a", "swamp two": "skill_a", "react": "no_match", "new here": "skill_b",
			"secret": "load_vault_guide", "list": "answer_from_guide",
		}
		for prefix, tool := range pick {
			if strings.HasPrefix(req.Input, prefix) {
				return eval.Response{Tool: tool, ResolvedModel: "fake-1", InputTokens: ptr(10), OutputTokens: ptr(1)}
			}
		}
		return eval.Response{Tool: names[0]}
	}}
}

func ptr(v int64) *int64 { return &v }

type harness struct {
	env    Env
	stdout *bytes.Buffer
	stderr *bytes.Buffer
}

func newHarness(t *testing.T, p providers.Provider, vars map[string]string) harness {
	t.Helper()
	var out, errBuf bytes.Buffer
	return harness{
		stdout: &out, stderr: &errBuf,
		env: Env{
			Stdout: &out, Stderr: &errBuf,
			Getenv: func(k string) string { return vars[k] },
			Getwd:  func() (string, error) { return t.TempDir(), nil },
			Now:    time.Now,
			NewProvider: func(m models.Model, r models.Route, getenv func(string) string) (providers.Provider, error) {
				if r == models.RouteAPI && getenv(m.API.KeyEnv) == "" {
					return providers.New(m, r, getenv)
				}
				return p, nil
			},
			Revision:   func(string) *string { rev := "abc123"; return &rev },
			CLIVersion: func(name string) string { return name + " 9.9.9" },
			SourceTree: "tree123",
		},
	}
}

func TestRunPassesAndWritesTheArtifact(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle(), map[string]string{"ANTHROPIC_API_KEY": "k"})
	out := filepath.Join(t.TempDir(), "sonnet.json")
	summary := filepath.Join(t.TempDir(), "summary.md")
	code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "sonnet", "--route", "api", "--out", out, "--github-summary", summary}, h.env)
	if code != ExitOK {
		t.Fatalf("exit %d\nstdout:%s\nstderr:%s", code, h.stdout, h.stderr)
	}
	a, err := report.Load(out)
	if err != nil {
		t.Fatal(err)
	}
	if a.Summary.Total != 6 || a.Summary.Passed != 6 || len(a.Suites) != 3 || *a.RepositoryRevision != "abc123" {
		t.Errorf("artifact = %+v", a.Summary)
	}
	if a.Summary.EstimatedCostUSD == nil {
		t.Error("an API run with usage must estimate cost")
	}
	md, _ := os.ReadFile(summary)
	if !strings.Contains(string(md), "## Skill Eval Results (sonnet)") {
		t.Errorf("summary = %s", md)
	}
}

func TestRunMissesThresholdWhenProvidersError(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle("swamp one"), nil)
	out := filepath.Join(t.TempDir(), "opus.json")
	code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "opus", "--route", "cli", "--out", out}, h.env)
	if code != ExitThreshold {
		t.Fatalf("exit %d, want %d\n%s%s", code, ExitThreshold, h.stdout, h.stderr)
	}
	a, _ := report.Load(out)
	if a.Summary.Errors != 1 || a.Summary.PassRate >= 0.9 {
		t.Errorf("summary = %+v", a.Summary)
	}
	if a.Summary.EstimatedCostUSD != nil {
		t.Error("CLI runs have no dollar cost")
	}
	if a.Tool.SourceTree != "tree123" || a.Tool.CLIVersion == nil || *a.Tool.CLIVersion != "claude 9.9.9" || a.Tool.GoVersion == "" {
		t.Errorf("tool = %+v", a.Tool)
	}
	if !strings.Contains(h.stdout.String(), "FAIL (opus)") {
		t.Errorf("stdout = %s", h.stdout)
	}
}

func TestRunMissingKeyIsAConfigurationError(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle(), nil)
	out := filepath.Join(t.TempDir(), "fable.json")
	code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "fable", "--out", out}, h.env)
	if code != ExitUsage || !strings.Contains(h.stderr.String(), "ANTHROPIC_API_KEY") {
		t.Fatalf("exit %d, stderr %s", code, h.stderr)
	}
	if _, err := os.Stat(out); err == nil {
		t.Error("no artifact may be written for a configuration error")
	}
}

func TestRunPreflightFailureStopsBeforeAnyCase(t *testing.T) {
	root := newRepo(t)
	calls := 0
	p := scripted{func(eval.Request) eval.Response {
		calls++
		return eval.Response{Err: eval.Errorf(eval.ErrAuth, "HTTP 401")}
	}}
	h := newHarness(t, p, map[string]string{"OPENAI_API_KEY": "k"})
	code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "gpt-5.4", "--out", filepath.Join(t.TempDir(), "x.json")}, h.env)
	if code != ExitUsage || calls != 1 || !strings.Contains(h.stderr.String(), "preflight failed") {
		t.Fatalf("exit %d, calls %d, stderr %s", code, calls, h.stderr)
	}
}

func TestRunUsageErrors(t *testing.T) {
	root := newRepo(t)
	for _, args := range [][]string{
		{"run", "--model", ""},
		{"run", "--model", "gpt-4"},
		{"run", "--model", "fable", "--route", "cli"},
		{"run", "--model", "gpt-6-astra", "--route", "api"},
		{"run", "--model", "opus", "--suite", "nope"},
		{"run", "--model", "opus", "--threshold", "2"},
		{"run", "--model", "opus", "--repo-root", t.TempDir()},
		{"bogus"},
		{},
	} {
		h := newHarness(t, oracle(), nil)
		full := args
		if len(args) > 0 && args[0] == "run" && !strings.Contains(strings.Join(args, " "), "--repo-root") {
			full = append(append([]string{}, args...), "--repo-root", root)
		}
		if code := Main(context.Background(), full, h.env); code != ExitUsage {
			t.Errorf("%v: exit %d, want %d", args, code, ExitUsage)
		}
	}
}

func TestRunSingleSuite(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle(), nil)
	out := filepath.Join(t.TempDir(), "opus.json")
	if code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "opus", "--suite", "routing", "--out", out}, h.env); code != ExitOK {
		t.Fatalf("exit %d: %s", code, h.stderr)
	}
	a, _ := report.Load(out)
	if a.Summary.Total != 1 || len(a.Suites) != 1 || a.Suites[0].Suite != "routing" || a.Model.Route != "cli" {
		t.Errorf("artifact = %+v", a)
	}
}

func TestReportCommand(t *testing.T) {
	root := newRepo(t)
	dir := t.TempDir()
	h := newHarness(t, oracle(), map[string]string{"ANTHROPIC_API_KEY": "k"})
	if code := Main(context.Background(), []string{"run", "--repo-root", root, "--model", "sonnet", "--route", "api", "--out", filepath.Join(dir, "a", "sonnet.json")}, h.env); code != ExitOK {
		t.Fatal(h.stderr)
	}
	r := newHarness(t, oracle(), nil)
	summary := filepath.Join(t.TempDir(), "s.md")
	code := Main(context.Background(), []string{"report", dir, "--expect", "sonnet,opus", "--github-summary", summary}, r.env)
	if code != ExitThreshold {
		t.Fatalf("exit %d: %s", code, r.stderr)
	}
	md, _ := os.ReadFile(summary)
	if !strings.Contains(string(md), "| sonnet | api | ✅ pass |") || !strings.Contains(string(md), "| opus | — | ❌ missing |") {
		t.Errorf("report = %s", md)
	}
	if code := Main(context.Background(), []string{"report", dir, "--expect", "sonnet"}, r.env); code != ExitOK {
		t.Errorf("every expected model passed: exit %d", code)
	}
	if code := Main(context.Background(), []string{"report", dir, "--expect", "nope"}, r.env); code != ExitUsage {
		t.Errorf("unknown --expect alias: exit %d", code)
	}
}

func TestCasesAndListModels(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle(), nil)
	if code := Main(context.Background(), []string{"cases", "--repo-root", root, "--full"}, h.env); code != ExitOK {
		t.Fatal(h.stderr)
	}
	if !strings.Contains(h.stdout.String(), `"expect": "avoid"`) || !strings.Contains(h.stdout.String(), "Guide content:") {
		t.Errorf("cases output = %s", h.stdout)
	}
	l := newHarness(t, oracle(), nil)
	if code := Main(context.Background(), []string{"list-models"}, l.env); code != ExitOK || !strings.Contains(l.stdout.String(), "gemini-3.1-pro-preview") {
		t.Errorf("list-models = %s", l.stdout)
	}
}

func TestRunDefaultsToOpus(t *testing.T) {
	root := newRepo(t)
	h := newHarness(t, oracle(), nil)
	out := filepath.Join(t.TempDir(), "x.json")
	if code := Main(context.Background(), []string{"run", "--repo-root", root, "--out", out}, h.env); code != ExitOK {
		t.Fatalf("exit %d: %s", code, h.stderr)
	}
	if a, _ := report.Load(out); a.Model.Alias != "opus" {
		t.Errorf("model = %s, want opus", a.Model.Alias)
	}
}
