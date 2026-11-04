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
	"strings"
)

// splitFrontmatter returns the lines between the opening and closing `---`
// and the body after them.
func splitFrontmatter(content string) ([]string, string, error) {
	lines := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	if strings.TrimSpace(lines[0]) != "---" {
		return nil, "", fmt.Errorf("missing frontmatter opening ---")
	}
	for i := 1; i < len(lines); i++ {
		if strings.TrimSpace(lines[i]) == "---" {
			return lines[1:i], strings.Join(lines[i+1:], "\n"), nil
		}
	}
	return nil, "", fmt.Errorf("missing frontmatter closing ---")
}

// frontmatterScalar reads one top-level key in the two forms SKILL.md uses: a
// plain one-line scalar or a `>` folded block. Anything else is an error, not a
// guess, since the value is the tool description the model routes on.
func frontmatterScalar(content, key string) (string, error) {
	lines, _, err := splitFrontmatter(content)
	if err != nil {
		return "", err
	}
	for i, line := range lines {
		rest, ok := strings.CutPrefix(line, key+":")
		if !ok {
			continue
		}
		rest = strings.TrimSpace(rest)
		if rest == ">" {
			return foldedBlock(lines[i+1:])
		}
		if rest == "" || strings.ContainsAny(rest[:1], `>|"'`) {
			return "", fmt.Errorf("frontmatter %q: only plain scalars and > blocks are supported", key)
		}
		return rest, nil
	}
	return "", fmt.Errorf("frontmatter has no %q", key)
}

// foldedBlock applies YAML `>` folding with clip chomping: indented lines join
// with spaces, a blank line becomes a newline, and one newline ends the value.
func foldedBlock(lines []string) (string, error) {
	var paragraphs []string
	var current []string
	for _, line := range lines {
		if strings.TrimSpace(line) == "" {
			paragraphs = append(paragraphs, strings.Join(current, " "))
			current = nil
			continue
		}
		if !strings.HasPrefix(line, " ") {
			break
		}
		current = append(current, strings.TrimSpace(line))
	}
	paragraphs = append(paragraphs, strings.Join(current, " "))
	text := strings.Trim(strings.Join(paragraphs, "\n"), "\n")
	if text == "" {
		return "", fmt.Errorf("empty > block")
	}
	return text + "\n", nil
}

// skillBody is the SKILL.md text after the frontmatter, trimmed.
func skillBody(content string) (string, error) {
	_, body, err := splitFrontmatter(content)
	return strings.TrimSpace(body), err
}
