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
	"context"
	"fmt"
	"path/filepath"
	"runtime"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/cases"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/providers"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/report"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/runner"
)

const preflightTimeout = 120 * time.Second

func runCommand(ctx context.Context, args []string, env Env) int {
	fs := newFlagSet("run", env)
	model := fs.String("model", "", "model alias (required; see list-models)")
	route := fs.String("route", "", "api or cli (default: cli locally for models with one, api in GitHub Actions)")
	repoRoot := fs.String("repo-root", "", "repository root (default: nearest parent holding .claude/skills)")
	suiteFlag := fs.String("suite", "all", "trigger, routing, sufficiency, a comma list, or all")
	concurrency := fs.Int("concurrency", 0, "parallel cases (default: the model's registry value)")
	timeout := fs.Duration("timeout", 120*time.Second, "per-case deadline")
	threshold := fs.Float64("threshold", 0.9, "combined pass rate required to exit 0")
	out := fs.String("out", "", "artifact path (default: <repo-root>/eval-results/<model>.json)")
	summary := fs.String("github-summary", "", "append the Markdown summary to this file")
	positional, err := parseFlags(fs, args)
	if err != nil {
		if isHelp(err) {
			return ExitOK
		}
		return ExitUsage
	}
	if len(positional) > 0 {
		return errorf(env, "run takes no positional arguments, got %q", positional)
	}
	if *model == "" {
		return errorf(env, "run requires --model (one of %v)", models.Aliases())
	}
	if *threshold < 0 || *threshold > 1 {
		return errorf(env, "--threshold must be between 0 and 1")
	}
	if *timeout <= 0 {
		return errorf(env, "--timeout must be positive")
	}
	if *concurrency < 0 {
		return errorf(env, "--concurrency must be positive")
	}
	m, err := models.Lookup(*model)
	if err != nil {
		return errorf(env, "%v", err)
	}
	r, err := m.ResolveRoute(*route, env.Getenv("GITHUB_ACTIONS") != "")
	if err != nil {
		return errorf(env, "%v", err)
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
	workers := *concurrency
	if workers == 0 {
		workers = m.DefaultConcurrency(r)
	}
	workers = min(workers, runner.MaxConcurrency)
	artifactPath := *out
	if artifactPath == "" {
		artifactPath = filepath.Join(root, "eval-results", m.Alias+".json")
	}
	opts := report.RunOptions{Concurrency: workers, TimeoutMS: timeout.Milliseconds(), Threshold: *threshold}

	provider, err := env.NewProvider(m, r, env.Getenv)
	if err != nil {
		return errorf(env, "%v", err)
	}

	tool := report.ToolInfo{SourceTree: env.SourceTree, GoVersion: runtime.Version()}
	header := fmt.Sprintf("swamp-eval %s (%s)", tool.SourceTree, tool.GoVersion)
	if r == models.RouteCLI {
		v := env.CLIVersion(string(m.CLI.Kind))
		tool.CLIVersion = &v
		header += fmt.Sprintf(", %s %s", m.CLI.Kind, v)
	}
	fmt.Fprintln(env.Stdout, header)
	fmt.Fprintf(env.Stdout, "Preflight: %s via %s…\n", m.Alias, provider.ID())
	pctx, cancel := context.WithTimeout(ctx, preflightTimeout)
	pre := provider.Classify(pctx, providers.PreflightRequest())
	cancel()
	if pre.Err != nil {
		hint := ""
		switch {
		case r == models.RouteCLI && m.CLI.Kind == models.ClaudeCLI:
			hint = " Install Claude Code and run `claude` once to log in."
		case r == models.RouteCLI:
			hint = " Install and authenticate the Codex CLI."
		case pre.Err.Category == eval.ErrRateLimit:
			hint = " A 429 before any case usually means exhausted credits or billing, not a rate limit."
		}
		return errorf(env, "preflight failed for %s: %v.%s", m.Alias, pre.Err, hint)
	}
	resolved := pre.ResolvedModel
	if resolved == "" {
		resolved = m.ConfiguredID(r)
	}
	fmt.Fprintf(env.Stdout, "Preflight: ok (%s). Running %d cases, concurrency %d.\n", resolved, len(built), workers)

	var delay time.Duration
	if r == models.RouteAPI {
		delay = m.API.Delay
	}
	notPassed := 0
	started := env.Now()
	results := runner.Run(ctx, built, provider, runner.Options{
		Concurrency: workers,
		Timeout:     *timeout,
		Delay:       delay,
		Progress: func(done, total int, res runner.Result) {
			if res.Outcome != runner.Pass {
				notPassed++
			}
			if done%10 == 0 || done == total {
				fmt.Fprintf(env.Stdout, "  %d/%d cases done, %d not passed\n", done, total, notPassed)
			}
		},
	})
	finished := env.Now()
	a := report.Build(report.BuildInput{
		Model: m, Route: r, Options: opts, Suites: suites, Results: results,
		StartedAt: started, FinishedAt: finished, Revision: env.Revision(root), Tool: tool,
		Cancelled: ctx.Err() != nil,
		WallClock: finished.Sub(started),
	})
	printSummary(env, a)
	code := ExitOK
	if !a.Summary.MetThreshold {
		code = ExitThreshold
	}
	return finish(env, a, artifactPath, *summary, code)
}

func finish(env Env, a report.Artifact, path, summary string, code int) int {
	if err := report.WriteAtomic(path, a); err != nil {
		return errorf(env, "write artifact: %v", err)
	}
	fmt.Fprintf(env.Stdout, "Artifact: %s\n", path)
	if summary != "" {
		if err := report.AppendFile(summary, report.RunMarkdown(a)); err != nil {
			return errorf(env, "write summary: %v", err)
		}
	}
	return code
}

func printSummary(env Env, a report.Artifact) {
	fmt.Fprint(env.Stdout, report.RunText(a))
	fmt.Fprintln(env.Stdout)
	for _, s := range a.Suites {
		fmt.Fprintf(env.Stdout, "%-12s %3d/%-3d passed (%.1f%%), %d failed, %d errors\n", s.Suite, s.Passed, s.Total, s.PassRate*100, s.Failed, s.Errors)
	}
	t := a.Summary
	fmt.Fprintf(env.Stdout, "%-12s %3d/%-3d passed (%.1f%%), %d failed, %d errors\n", "combined", t.Passed, t.Total, t.PassRate*100, t.Failed, t.Errors)
	if t.NotRun > 0 {
		fmt.Fprintf(env.Stdout, "Cancelled: %d cases did not run.\n", t.NotRun)
	}
	if t.TokenUsage.Input != nil || t.TokenUsage.Output != nil {
		fmt.Fprintf(env.Stdout, "Tokens: %s input, %s output\n", fmtCount(t.TokenUsage.Input), fmtCount(t.TokenUsage.Output))
	}
	if t.EstimatedCostUSD != nil {
		fmt.Fprintf(env.Stdout, "Estimated cost: $%.2f\n", *t.EstimatedCostUSD)
	}
	if t.MetThreshold {
		fmt.Fprintf(env.Stdout, "PASS (%s): %.1f%% meets the %.0f%% threshold\n", a.Model.Alias, t.PassRate*100, a.Options.Threshold*100)
	} else {
		fmt.Fprintf(env.Stdout, "FAIL (%s): %.1f%% is below the %.0f%% threshold\n", a.Model.Alias, t.PassRate*100, a.Options.Threshold*100)
	}
}

func fmtCount(v *int64) string {
	if v == nil {
		return "unknown"
	}
	return fmt.Sprint(*v)
}

func resolveRoot(flagValue string, env Env) (string, error) {
	start := flagValue
	if start == "" {
		wd, err := env.Getwd()
		if err != nil {
			return "", err
		}
		start = wd
	}
	return cases.FindRepoRoot(start)
}
