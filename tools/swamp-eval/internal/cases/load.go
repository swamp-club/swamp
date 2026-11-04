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
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

// FindRepoRoot walks upward from start to the first directory holding
// .claude/skills.
func FindRepoRoot(start string) (string, error) {
	dir, err := filepath.Abs(start)
	if err != nil {
		return "", err
	}
	for {
		if info, err := os.Stat(filepath.Join(dir, ".claude", "skills")); err == nil && info.IsDir() {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("no .claude/skills directory found above %s", start)
		}
		dir = parent
	}
}

// Build materializes the requested suites in fixture order and validates them
// before any provider is called.
func Build(root string, suites []eval.Suite) ([]eval.Case, error) {
	var all []eval.Case
	for _, suite := range suites {
		var built []eval.Case
		var err error
		switch suite {
		case eval.SuiteTrigger:
			built, err = buildTrigger(root)
		case eval.SuiteRouting:
			built, err = buildRouting(root)
		case eval.SuiteSufficiency:
			built, err = buildSufficiency(root)
		default:
			err = fmt.Errorf("unknown suite %q", suite)
		}
		if err != nil {
			return nil, fmt.Errorf("%s suite: %w", suite, err)
		}
		if len(built) == 0 {
			return nil, fmt.Errorf("%s suite: fixtures produced no cases", suite)
		}
		all = append(all, built...)
	}
	return all, validate(all)
}

func validate(all []eval.Case) error {
	seen := map[string]bool{}
	for _, c := range all {
		if seen[c.ID] {
			return fmt.Errorf("duplicate case %s: a fixture repeats a query", c.ID)
		}
		seen[c.ID] = true
		if len(c.Tools) < 2 {
			return fmt.Errorf("case %s offers fewer than two tools", c.ID)
		}
		names := map[string]bool{}
		for _, t := range c.Tools {
			if t.Name == "" || t.Description == "" {
				return fmt.Errorf("case %s has a tool with an empty name or description", c.ID)
			}
			if names[t.Name] {
				return fmt.Errorf("case %s offers tool %q twice", c.ID, t.Name)
			}
			names[t.Name] = true
		}
		if !names[c.ExpectedTool] {
			return fmt.Errorf("case %s expects %q, which it does not offer", c.ID, c.ExpectedTool)
		}
	}
	return nil
}

// caseID is stable under fixture reordering and insertion, so the same query
// lines up across models and runs.
func caseID(parts ...string) string {
	query := parts[len(parts)-1]
	sum := sha256.Sum256([]byte(query))
	return strings.Join(append(parts[:len(parts)-1:len(parts)-1], hex.EncodeToString(sum[:])[:10]), "/")
}

// readFixture decodes a JSON array strictly: unknown fields and trailing data
// are errors, so a typo in a fixture key cannot silently drop a case's intent.
func readFixture[T any](path string) ([]T, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	var rows []T
	if err := dec.Decode(&rows); err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	if dec.More() {
		return nil, fmt.Errorf("%s: trailing data after the JSON array", path)
	}
	return rows, nil
}

func requireQuery(path string, i int, q string) error {
	if strings.TrimSpace(q) == "" {
		return fmt.Errorf("%s: row %d has an empty query", path, i)
	}
	return nil
}

func queryTool(name, description, paramDescription string) eval.Tool {
	return eval.Tool{Name: name, Description: description, Param: "query", ParamDescription: paramDescription}
}
