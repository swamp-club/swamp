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
import { join } from "@std/path";
import { SkillAssets } from "./skill_assets.ts";

const EXPECTED_GUIDE_TOPICS = [
  "data",
  "extension",
  "extension-publish",
  "issue",
  "model",
  "repo",
  "report",
  "troubleshooting",
  "vault",
  "workflow",
];

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
