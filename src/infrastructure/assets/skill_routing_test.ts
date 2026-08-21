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

import { assertEquals } from "@std/assert";
import { existsSync } from "@std/fs";
import { join } from "@std/path";
import { SkillAssets } from "./skill_assets.ts";

/**
 * Directories under `.claude/skills/swamp/references/` that are deliberately
 * NOT routable guide topics and therefore need no eval coverage.
 *
 * Every entry here is a hole in the self-policing check below, so add one only
 * with a comment explaining why the directory is not a routing destination.
 * Currently empty — all reference directories are routable topics.
 */
const NON_ROUTABLE_REFERENCE_DIRS = new Set<string>([]);

/**
 * Derives the guide topics from the on-disk references directory rather than a
 * hardcoded list, so a newly added guide cannot ship without routing evals,
 * a SKILL.md routing entry, and a BUNDLED_SKILLS entry.
 *
 * A topic is any directory under `references/` that contains a `guide.md`.
 */
function discoverGuideTopics(skillsDir: string): string[] {
  const referencesDir = join(skillsDir, "swamp", "references");
  const topics: string[] = [];

  for (const entry of Deno.readDirSync(referencesDir)) {
    if (!entry.isDirectory) continue;
    if (NON_ROUTABLE_REFERENCE_DIRS.has(entry.name)) continue;
    if (!existsSync(join(referencesDir, entry.name, "guide.md"))) continue;
    topics.push(entry.name);
  }

  return topics.sort();
}

const EXPECTED_GUIDE_TOPICS = discoverGuideTopics(
  new SkillAssets().getSkillsDir(),
);

Deno.test("gateway routing: guide topics are discovered from the references directory", () => {
  // Guards against a path or filter bug silently emptying the derived list and
  // turning every coverage assertion below into a no-op.
  assertEquals(
    EXPECTED_GUIDE_TOPICS.length > 0,
    true,
    "No guide topics discovered under swamp/references — discovery is broken",
  );
  for (const topic of ["model", "workflow", "data"]) {
    assertEquals(
      EXPECTED_GUIDE_TOPICS.includes(topic),
      true,
      `Expected core guide topic missing from discovery: ${topic}`,
    );
  }
});

Deno.test("gateway routing: every guide topic has a guide.md in BUNDLED_SKILLS", () => {
  const assets = new SkillAssets();
  const skills = assets.listSkills();
  const guidePaths = skills
    .filter((s) => s.relativePath.endsWith("/guide.md"))
    .map((s) => s.relativePath);

  for (const topic of EXPECTED_GUIDE_TOPICS) {
    const expected = `swamp/references/${topic}/guide.md`;
    assertEquals(
      guidePaths.includes(expected),
      true,
      `Missing guide in BUNDLED_SKILLS: ${expected}`,
    );
  }
});

Deno.test("gateway routing: every guide.md file exists on disk", async () => {
  const assets = new SkillAssets();

  for (const topic of EXPECTED_GUIDE_TOPICS) {
    const path = `swamp/references/${topic}/guide.md`;
    const content = await assets.readSkill(path);
    assertEquals(
      content !== null,
      true,
      `Guide file missing from disk: ${path}`,
    );
    assertEquals(
      content!.length > 0,
      true,
      `Guide file is empty: ${path}`,
    );
  }
});

Deno.test("gateway routing: SKILL.md routing table references every guide topic", async () => {
  const assets = new SkillAssets();
  const skillMd = await assets.readSkill("swamp/SKILL.md");
  assertEquals(skillMd !== null, true, "swamp/SKILL.md not found");

  for (const topic of EXPECTED_GUIDE_TOPICS) {
    const guidePath = `references/${topic}/guide.md`;
    assertEquals(
      skillMd!.includes(guidePath),
      true,
      `SKILL.md routing table missing reference to: ${guidePath}`,
    );
  }
});

Deno.test("gateway routing: every BUNDLED_SKILLS file exists on disk", async () => {
  const assets = new SkillAssets();
  const skills = assets.listSkills();

  for (const skill of skills) {
    const content = await assets.readSkill(skill.relativePath);
    assertEquals(
      content !== null,
      true,
      `Bundled skill file missing from disk: ${skill.relativePath}`,
    );
  }
});

Deno.test("gateway routing: routing_evals.json covers every guide topic", async () => {
  const assets = new SkillAssets();
  const skillsDir = assets.getSkillsDir();
  const evalPath = join(skillsDir, "swamp", "evals", "routing_evals.json");
  const content = await Deno.readTextFile(evalPath);
  const evals = JSON.parse(content) as Array<
    { query: string; expected_guide: string }
  >;

  const coveredTopics = new Set(evals.map((e) => e.expected_guide));

  for (const topic of EXPECTED_GUIDE_TOPICS) {
    assertEquals(
      coveredTopics.has(topic),
      true,
      `routing_evals.json has no test cases for guide topic: ${topic}`,
    );
  }
});

Deno.test("gateway routing: routing_evals.json references only valid guide topics", async () => {
  const assets = new SkillAssets();
  const skillsDir = assets.getSkillsDir();
  const evalPath = join(skillsDir, "swamp", "evals", "routing_evals.json");
  const content = await Deno.readTextFile(evalPath);
  const evals = JSON.parse(content) as Array<
    { query: string; expected_guide: string }
  >;

  const validTopics = new Set(EXPECTED_GUIDE_TOPICS);
  for (const item of evals) {
    assertEquals(
      validTopics.has(item.expected_guide),
      true,
      `routing_evals.json references unknown guide topic: ${item.expected_guide}`,
    );
  }
});

Deno.test("gateway routing: guide_sufficiency_evals.json covers only and all guide topics", async () => {
  const assets = new SkillAssets();
  const skillsDir = assets.getSkillsDir();
  const evalPath = join(
    skillsDir,
    "swamp",
    "evals",
    "guide_sufficiency_evals.json",
  );
  const content = await Deno.readTextFile(evalPath);
  const evals = JSON.parse(content) as Array<
    { query: string; guide: string; answerable_from_guide: boolean }
  >;

  const coveredTopics = new Set(evals.map((e) => e.guide));

  for (const topic of EXPECTED_GUIDE_TOPICS) {
    assertEquals(
      coveredTopics.has(topic),
      true,
      `guide_sufficiency_evals.json has no test cases for guide topic: ${topic}`,
    );
  }

  const validTopics = new Set(EXPECTED_GUIDE_TOPICS);
  for (const item of evals) {
    assertEquals(
      validTopics.has(item.guide),
      true,
      `guide_sufficiency_evals.json references unknown guide topic: ${item.guide}`,
    );
  }
});
