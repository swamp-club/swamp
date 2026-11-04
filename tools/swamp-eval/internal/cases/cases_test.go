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
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/swamp-club/swamp/tools/swamp-eval/internal/eval"
)

func TestFrontmatterScalar(t *testing.T) {
	doc := strings.Join([]string{
		"---",
		"name: swamp",
		"description: >",
		"  first line",
		"  continues here.",
		"",
		"  New paragraph.",
		"metadata:",
		"  nested: x",
		"---",
		"body",
	}, "\n")
	for key, want := range map[string]string{
		"name":        "swamp",
		"description": "first line continues here.\nNew paragraph.\n",
	} {
		got, err := frontmatterScalar(doc, key)
		if err != nil || got != want {
			t.Errorf("%s = %q, %v; want %q", key, got, err, want)
		}
	}
	for _, bad := range []string{
		"---\nname: x\n---\n",
		"---\ndescription: >-\n  x\n---\n",
		"---\ndescription: \"quoted\"\n---\n",
		"---\ndescription: |\n  x\n---\n",
		"no frontmatter",
	} {
		if _, err := frontmatterScalar(bad, "description"); err == nil {
			t.Errorf("%q: want error", bad)
		}
	}
}

func TestSkillBodyStripsFrontmatter(t *testing.T) {
	got, err := skillBody("---\nname: x\n---\n\n# Title\n\ntext\n\n")
	if err != nil {
		t.Fatal(err)
	}
	if got != "# Title\n\ntext" {
		t.Errorf("body = %q", got)
	}
}

type fixtureRepo struct {
	t    *testing.T
	root string
}

func newFixtureRepo(t *testing.T) fixtureRepo {
	t.Helper()
	r := fixtureRepo{t: t, root: t.TempDir()}
	for _, skill := range triggerSkills {
		r.write(".claude/skills/"+skill+"/SKILL.md", "---\nname: "+skill+"\ndescription: >\n  The "+skill+" skill.\n---\n\n# "+skill+"\n\nRouting table.\n")
	}
	r.write(".claude/skills/swamp/evals/trigger_evals.json", `[
		{"query": "run my swamp workflow", "should_trigger": true},
		{"query": "write a react component", "should_trigger": false, "note": "unrelated"}
	]`)
	r.write(".claude/skills/swamp-getting-started/evals/trigger_evals.json", `[
		{"query": "I'm new to swamp", "should_trigger": true}
	]`)
	r.write(".claude/skills/swamp/evals/routing_evals.json", `[
		{"query": "store a secret", "expected_guide": "vault"},
		{"query": "publish my extension", "expected_guide": "extension-publish"}
	]`)
	r.write(".claude/skills/swamp/evals/guide_sufficiency_evals.json", `[
		{"query": "list vaults", "guide": "vault", "answerable_from_guide": true, "note": "table"},
		{"query": "how is the key derived", "guide": "vault", "answerable_from_guide": false, "note": "internals"}
	]`)
	r.write(".claude/skills/swamp/references/vault/guide.md", "Use `{{ vault.get('x') }}` to read.\n")
	return r
}

func (r fixtureRepo) write(rel, content string) {
	r.t.Helper()
	path := filepath.Join(r.root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		r.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		r.t.Fatal(err)
	}
}

func TestBuildMaterializesAllSuitesInFixtureOrder(t *testing.T) {
	repo := newFixtureRepo(t)
	all, err := Build(repo.root, eval.AllSuites)
	if err != nil {
		t.Fatal(err)
	}
	if len(all) != 7 {
		t.Fatalf("got %d cases, want 7", len(all))
	}
	want := []struct {
		suite    eval.Suite
		expected string
		expect   eval.Expect
	}{
		{eval.SuiteTrigger, "skill_a", eval.ExpectSelect},
		{eval.SuiteTrigger, "skill_a", eval.ExpectAvoid},
		{eval.SuiteTrigger, "skill_b", eval.ExpectSelect},
		{eval.SuiteRouting, "load_vault_guide", eval.ExpectSelect},
		{eval.SuiteRouting, "load_extension_publish_guide", eval.ExpectSelect},
		{eval.SuiteSufficiency, "answer_from_guide", eval.ExpectSelect},
		{eval.SuiteSufficiency, "need_reference", eval.ExpectSelect},
	}
	for i, w := range want {
		c := all[i]
		if c.Suite != w.suite || c.ExpectedTool != w.expected || c.Expect != w.expect {
			t.Errorf("case %d = %s/%s/%s, want %s/%s/%s", i, c.Suite, c.ExpectedTool, c.Expect, w.suite, w.expected, w.expect)
		}
	}

	trigger := all[0]
	if names := strings.Join(trigger.Request().ToolNames(), ","); names != "skill_a,skill_b,no_match" {
		t.Errorf("trigger tools = %s", names)
	}
	if trigger.Tools[0].Description != "The swamp skill.\n" {
		t.Errorf("skill description = %q", trigger.Tools[0].Description)
	}
	if !strings.HasPrefix(all[1].Description, "[swamp] should NOT trigger: ") {
		t.Errorf("negative description = %q", all[1].Description)
	}
	if len(all[3].Tools) != len(guideTopics) {
		t.Errorf("routing offers %d tools, want %d", len(all[3].Tools), len(guideTopics))
	}
	if !strings.Contains(all[3].SystemPrompt, "# swamp\n\nRouting table.") || strings.Contains(all[3].SystemPrompt, "description:") {
		t.Errorf("routing prompt must embed the SKILL.md body without frontmatter: %q", all[3].SystemPrompt)
	}
	suff := all[5]
	if suff.Input != "list vaults\n\n---\n\nGuide content:\n\nUse `{{ vault.get('x') }}` to read.\n" {
		t.Errorf("sufficiency input must carry the guide verbatim: %q", suff.Input)
	}
	if !strings.HasPrefix(suff.ID, "sufficiency/vault/") || suff.ID == all[6].ID {
		t.Errorf("unexpected sufficiency IDs %q, %q", suff.ID, all[6].ID)
	}
}

func TestNegativeTriggerPassesOnAnyOtherTool(t *testing.T) {
	repo := newFixtureRepo(t)
	all, err := Build(repo.root, []eval.Suite{eval.SuiteTrigger})
	if err != nil {
		t.Fatal(err)
	}
	negative := all[1]
	for tool, want := range map[string]bool{"skill_a": false, "no_match": true, "skill_b": true} {
		if got := negative.Passes(tool); got != want {
			t.Errorf("Passes(%q) = %v, want %v", tool, got, want)
		}
	}
	if !all[0].Passes("skill_a") || all[0].Passes("no_match") {
		t.Error("positive case must pass only on its own skill")
	}
}

func TestCaseIDsAreStableAcrossReordering(t *testing.T) {
	repo := newFixtureRepo(t)
	before, err := Build(repo.root, []eval.Suite{eval.SuiteRouting})
	if err != nil {
		t.Fatal(err)
	}
	repo.write(".claude/skills/swamp/evals/routing_evals.json", `[
		{"query": "new case", "expected_guide": "data"},
		{"query": "publish my extension", "expected_guide": "extension-publish"},
		{"query": "store a secret", "expected_guide": "vault"}
	]`)
	after, err := Build(repo.root, []eval.Suite{eval.SuiteRouting})
	if err != nil {
		t.Fatal(err)
	}
	if before[0].ID != after[2].ID || before[1].ID != after[1].ID {
		t.Errorf("IDs moved: %v vs %v", []string{before[0].ID, before[1].ID}, []string{after[2].ID, after[1].ID})
	}
}

func TestBuildRejectsInvalidFixtures(t *testing.T) {
	cases := map[string]struct{ path, content string }{
		"unknown routing guide":   {".claude/skills/swamp/evals/routing_evals.json", `[{"query": "q", "expected_guide": "nope"}]`},
		"unknown sufficiency":     {".claude/skills/swamp/evals/guide_sufficiency_evals.json", `[{"query": "q", "guide": "nope", "answerable_from_guide": true, "note": ""}]`},
		"missing boolean":         {".claude/skills/swamp/evals/trigger_evals.json", `[{"query": "q"}]`},
		"missing answerable flag": {".claude/skills/swamp/evals/guide_sufficiency_evals.json", `[{"query": "q", "guide": "vault", "note": ""}]`},
		"empty query":             {".claude/skills/swamp/evals/trigger_evals.json", `[{"query": "  ", "should_trigger": true}]`},
		"misspelled key":          {".claude/skills/swamp/evals/trigger_evals.json", `[{"query": "q", "should_triger": true}]`},
		"duplicate query":         {".claude/skills/swamp/evals/routing_evals.json", `[{"query": "q", "expected_guide": "vault"}, {"query": "q", "expected_guide": "data"}]`},
		"not an array":            {".claude/skills/swamp/evals/routing_evals.json", `{"query": "q"}`},
		"trailing data":           {".claude/skills/swamp/evals/routing_evals.json", `[] []`},
		"empty suite":             {".claude/skills/swamp/evals/routing_evals.json", `[]`},
		"skill name mismatch":     {".claude/skills/swamp/SKILL.md", "---\nname: other\ndescription: x\n---\n"},
		"missing guide file":      {".claude/skills/swamp/evals/guide_sufficiency_evals.json", `[{"query": "q", "guide": "data", "answerable_from_guide": true, "note": ""}]`},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			repo := newFixtureRepo(t)
			repo.write(tc.path, tc.content)
			if _, err := Build(repo.root, eval.AllSuites); err == nil {
				t.Fatal("want error")
			}
		})
	}
}

func TestFindRepoRootWalksUp(t *testing.T) {
	repo := newFixtureRepo(t)
	deep := filepath.Join(repo.root, "tools", "swamp-eval")
	if err := os.MkdirAll(deep, 0o755); err != nil {
		t.Fatal(err)
	}
	got, err := FindRepoRoot(deep)
	if err != nil {
		t.Fatal(err)
	}
	want, _ := filepath.EvalSymlinks(repo.root)
	if gotReal, _ := filepath.EvalSymlinks(got); gotReal != want {
		t.Errorf("root = %s, want %s", got, repo.root)
	}
	if _, err := FindRepoRoot(t.TempDir()); err == nil {
		t.Error("want error outside a repo")
	}
}

func TestRepositoryFixturesBuild(t *testing.T) {
	root, err := FindRepoRoot(".")
	if err != nil {
		t.Skip("not inside the swamp repository")
	}
	all, err := Build(root, eval.AllSuites)
	if err != nil {
		t.Fatalf("the repository's own fixtures must build: %v", err)
	}
	counts := map[eval.Suite]int{}
	for _, c := range all {
		counts[c.Suite]++
	}
	for _, s := range eval.AllSuites {
		if counts[s] == 0 {
			t.Errorf("suite %s built no cases", s)
		}
	}
	refs := filepath.Join(root, ".claude", "skills", "swamp", "references")
	for _, topic := range guideTopics {
		if _, err := os.Stat(filepath.Join(refs, topic.Key, "guide.md")); err != nil {
			t.Errorf("routing topic %q has no guide.md: %v", topic.Key, err)
		}
	}
	guides, _ := filepath.Glob(filepath.Join(refs, "*", "guide.md"))
	for _, g := range guides {
		if key := filepath.Base(filepath.Dir(g)); !guideKnown(key) {
			t.Errorf("references/%s has a guide the routing suite does not offer; add it to guideTopics", key)
		}
	}
}

// The trigger suite exists to test skill descriptions; a tool name that names
// the skill lets the model route on the name and pass with any description.
func TestTriggerToolNamesDoNotRevealTheSkill(t *testing.T) {
	repo := newFixtureRepo(t)
	all, err := Build(repo.root, []eval.Suite{eval.SuiteTrigger})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range all {
		for _, tool := range c.Tools {
			for _, skill := range triggerSkills {
				if strings.Contains(tool.Name, "swamp") || strings.Contains(tool.Name, skill) {
					t.Fatalf("tool %q reveals skill %q", tool.Name, skill)
				}
			}
		}
		if got := c.Label(c.ExpectedTool); got != strings.TrimPrefix(strings.SplitN(c.Description, "]", 2)[0], "[") {
			t.Errorf("case %s expects %s, labelled %q", c.ID, c.ExpectedTool, got)
		}
	}
}

func TestTriggerDescriptionsFollowTheRename(t *testing.T) {
	repo := newFixtureRepo(t)
	repo.write(".claude/skills/swamp/SKILL.md", "---\nname: swamp\ndescription: >\n  Swamp CLI. Do NOT use for onboarding (use swamp-getting-started).\n---\nbody\n")
	all, err := Build(repo.root, []eval.Suite{eval.SuiteTrigger})
	if err != nil {
		t.Fatal(err)
	}
	if got := all[0].Tools[0].Description; got != "Swamp CLI. Do NOT use for onboarding (use skill_b).\n" {
		t.Errorf("description = %q", got)
	}
}
