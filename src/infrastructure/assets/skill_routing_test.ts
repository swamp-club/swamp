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
import {
  dirname as posixDirname,
  join as posixJoin,
  normalize as posixNormalize,
} from "@std/path/posix";
import { SUPERSEDED_SKILLS } from "../../domain/repo/superseded_skills.ts";
import { SkillAssets } from "./skill_assets.ts";

/**
 * reference directories that are deliberately not routable guide topics and
 * need no eval coverage; each entry is a hole in the self-policing check, so
 * add one only with a reason
 */
const NON_ROUTABLE_REFERENCE_DIRS = new Set<string>([]);

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
  for (const topic of ["behavior", "workflow", "data"]) {
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

// the slash and hyphen guards spare datastore paths such as /tmp/swamp-data
const SUPERSEDED_SKILL_PATTERN = new RegExp(
  `(?<![\\w/-])(${
    [...SUPERSEDED_SKILLS].sort((a, b) => b.length - a.length).join("|")
  })(?![\\w-])`,
);

Deno.test("bundled skills: no markdown file names a superseded skill", async () => {
  const assets = new SkillAssets();

  for (const skill of assets.listSkills()) {
    if (!skill.relativePath.endsWith(".md")) continue;
    const content = await assets.readSkill(skill.relativePath);
    const lines = content!.split("\n");
    for (const [index, line] of lines.entries()) {
      const match = SUPERSEDED_SKILL_PATTERN.exec(line);
      assertEquals(
        match,
        null,
        `${skill.relativePath}:${index + 1} names the superseded skill ${
          match?.[1]
        }; link the matching references/<area>/guide.md instead`,
      );
    }
  }
});

Deno.test("bundled skills: every relative markdown link resolves to a bundled file", async () => {
  const assets = new SkillAssets();
  const bundled = new Set(assets.listSkills().map((s) => s.relativePath));

  for (const path of bundled) {
    if (!path.endsWith(".md")) continue;
    const content = await assets.readSkill(path);
    const prose = content!.replace(/```[\s\S]*?```/g, "");
    for (const [, target] of prose.matchAll(/\]\(\s*([^)\s]+)\s*\)/g)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#")) {
        continue;
      }
      const resolved = posixNormalize(
        posixJoin(posixDirname(path), target.split("#")[0]),
      );
      assertEquals(
        bundled.has(resolved),
        true,
        `${path} links to ${target}, which is not a bundled skill file`,
      );
    }
  }
});
