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
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/models"
	"github.com/swamp-club/swamp/tools/swamp-eval/internal/providers"
)

const (
	ExitOK        = 0
	ExitThreshold = 1
	ExitUsage     = 2
)

// Env carries every process dependency, so commands are testable in-process.
type Env struct {
	Stdout      io.Writer
	Stderr      io.Writer
	Getenv      func(string) string
	Getwd       func() (string, error)
	Now         func() time.Time
	NewProvider func(models.Model, models.Route, func(string) string) (providers.Provider, error)
	Revision    func(root string) *string
	CLIVersion  func(name string) string
	SourceTree  string
}

func DefaultEnv() Env {
	return Env{
		Stdout:      os.Stdout,
		Stderr:      os.Stderr,
		Getenv:      os.Getenv,
		Getwd:       os.Getwd,
		Now:         time.Now,
		NewProvider: providers.New,
		Revision:    gitRevision,
		CLIVersion:  cliVersion,
		SourceTree:  "dev",
	}
}

func gitRevision(root string) *string {
	out, err := exec.Command("git", "-C", root, "rev-parse", "HEAD").Output()
	if err != nil {
		return nil
	}
	rev := strings.TrimSpace(string(out))
	return &rev
}

// cliVersion records which claude or codex answered, since a CLI upgrade can
// change results as much as a skill edit; "unknown" never fails a run.
func cliVersion(name string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, "--version").Output()
	if err != nil {
		return "unknown"
	}
	return strings.TrimSpace(string(out))
}

const usage = `swamp-eval evaluates whether models route Swamp skill requests to the right tool.

Usage:
  swamp-eval run --model <alias> [flags]   run the suites against one model
  swamp-eval report <dir> [flags]          summarize the artifacts under dir
  swamp-eval cases [flags]                 print the materialized cases (no model calls)
  swamp-eval list-models                   print the model registry

Run "swamp-eval <command> -h" for a command's flags.
`

func Main(ctx context.Context, args []string, env Env) int {
	if len(args) == 0 {
		fmt.Fprint(env.Stderr, usage)
		return ExitUsage
	}
	switch args[0] {
	case "run":
		return runCommand(ctx, args[1:], env)
	case "report":
		return reportCommand(args[1:], env)
	case "cases":
		return casesCommand(args[1:], env)
	case "list-models":
		return listModelsCommand(args[1:], env)
	case "-h", "-help", "--help", "help":
		fmt.Fprint(env.Stdout, usage)
		return ExitOK
	}
	fmt.Fprintf(env.Stderr, "swamp-eval: unknown command %q\n\n%s", args[0], usage)
	return ExitUsage
}

func newFlagSet(name string, env Env) *flag.FlagSet {
	fs := flag.NewFlagSet("swamp-eval "+name, flag.ContinueOnError)
	fs.SetOutput(env.Stderr)
	return fs
}

// parseFlags lets positional arguments come before flags, which the flag
// package alone stops at.
func parseFlags(fs *flag.FlagSet, args []string) ([]string, error) {
	var positional []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		args = fs.Args()
		if len(args) == 0 {
			return positional, nil
		}
		positional = append(positional, args[0])
		args = args[1:]
	}
}

func parseSuites(value string) ([]eval.Suite, error) {
	if value == "all" {
		return eval.AllSuites, nil
	}
	var out []eval.Suite
	for _, part := range strings.Split(value, ",") {
		s := eval.Suite(strings.TrimSpace(part))
		found := false
		for _, known := range eval.AllSuites {
			if s == known {
				found = true
			}
		}
		if !found {
			return nil, fmt.Errorf("unknown suite %q (valid: trigger, routing, sufficiency, all)", part)
		}
		out = append(out, s)
	}
	return out, nil
}

func errorf(env Env, format string, args ...any) int {
	fmt.Fprintf(env.Stderr, "swamp-eval: "+format+"\n", args...)
	return ExitUsage
}

func isHelp(err error) bool { return errors.Is(err, flag.ErrHelp) }
