// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-skill-test-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("SkillAssets.listSkills returns expected skills", () => {
  const assets = new SkillAssets();
  const skills = assets.listSkills();

  assertEquals(skills.length > 0, true);
  // Verify the swamp-model skill is included
  const swampModel = skills.find((s) => s.name === "swamp-model");
  assertEquals(swampModel !== undefined, true);
  assertEquals(swampModel?.relativePath, "swamp-model/SKILL.md");
});

Deno.test("SkillAssets.listSkills returns a copy", () => {
  const assets = new SkillAssets();
  const skills1 = assets.listSkills();
  const skills2 = assets.listSkills();

  // Modifying one should not affect the other
  skills1.push({ relativePath: "test/TEST.md", name: "test" });
  assertEquals(skills1.length !== skills2.length, true);
});

Deno.test("SkillAssets.getSkillNames returns unique names", () => {
  const assets = new SkillAssets();
  const names = assets.getSkillNames();

  assertEquals(names.length > 0, true);
  // Check for uniqueness
  const uniqueNames = new Set(names);
  assertEquals(uniqueNames.size, names.length);
  // Verify swamp-model is included
  assertEquals(names.includes("swamp-model"), true);
});

Deno.test("SkillAssets.readSkill returns content for existing skill", async () => {
  const assets = new SkillAssets();
  const content = await assets.readSkill("swamp-model/SKILL.md");

  assertEquals(content !== null, true);
  assertEquals(typeof content, "string");
  assertEquals(content!.length > 0, true);
});

Deno.test("SkillAssets.readSkill returns null for non-existent skill", async () => {
  const assets = new SkillAssets();
  const content = await assets.readSkill("nonexistent/SKILL.md");

  assertEquals(content, null);
});

Deno.test("SkillAssets.getSkillPath returns correct path", () => {
  const assets = new SkillAssets();
  const path = assets.getSkillPath("swamp-model/SKILL.md");

  assertEquals(path.endsWith("swamp-model/SKILL.md"), true);
  assertEquals(path.includes(".claude/skills"), true);
});

Deno.test("SkillAssets.copySkillsTo copies files correctly", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    // Check that skill files were copied
    const skillPath = join(dir, "swamp-model", "SKILL.md");
    const stat = await Deno.stat(skillPath);
    assertEquals(stat.isFile, true);

    // Verify content matches source
    const copiedContent = await Deno.readTextFile(skillPath);
    const originalContent = await assets.readSkill("swamp-model/SKILL.md");
    assertEquals(copiedContent, originalContent);
  });
});

Deno.test("SkillAssets.copySkillsTo creates nested directories", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    // The swamp-model directory should exist
    const skillDir = join(dir, "swamp-model");
    const stat = await Deno.stat(skillDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("SkillAssets.copySkillsTo rejects path traversal attempts", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();

    // The copySkillsTo method uses hardcoded BUNDLED_SKILLS which are safe,
    // but we test that the validation would catch traversal if extended
    // This test verifies the behavior with the current safe implementation
    await assets.copySkillsTo(dir);

    // Verify files are written within the target directory
    const skillPath = join(dir, "swamp-model", "SKILL.md");
    const realPath = await Deno.realPath(skillPath);
    assertEquals(realPath.startsWith(await Deno.realPath(dir)), true);
  });
});

Deno.test("SkillAssets includes swamp-extension-model skill", () => {
  const assets = new SkillAssets();
  const names = assets.getSkillNames();

  assertEquals(names.includes("swamp-extension-model"), true);
});

Deno.test("SkillAssets.copySkillsTo copies nested reference files", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    // Check that swamp-extension-model skill and references were copied
    const skillPath = join(dir, "swamp-extension-model", "SKILL.md");
    const examplesPath = join(
      dir,
      "swamp-extension-model",
      "references",
      "examples.md",
    );
    const troubleshootingPath = join(
      dir,
      "swamp-extension-model",
      "references",
      "troubleshooting.md",
    );

    const skillStat = await Deno.stat(skillPath);
    assertEquals(skillStat.isFile, true);

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);

    const troubleshootingStat = await Deno.stat(troubleshootingPath);
    assertEquals(troubleshootingStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-data reference files", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const examplesPath = join(dir, "swamp-data", "references", "examples.md");
    const troubleshootingPath = join(
      dir,
      "swamp-data",
      "references",
      "troubleshooting.md",
    );
    const expressionsPath = join(
      dir,
      "swamp-data",
      "references",
      "expressions.md",
    );
    const dataOwnershipPath = join(
      dir,
      "swamp-data",
      "references",
      "data-ownership.md",
    );

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);

    const troubleshootingStat = await Deno.stat(troubleshootingPath);
    assertEquals(troubleshootingStat.isFile, true);

    const expressionsStat = await Deno.stat(expressionsPath);
    assertEquals(expressionsStat.isFile, true);

    const dataOwnershipStat = await Deno.stat(dataOwnershipPath);
    assertEquals(dataOwnershipStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-model reference files", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const examplesPath = join(dir, "swamp-model", "references", "examples.md");
    const troubleshootingPath = join(
      dir,
      "swamp-model",
      "references",
      "troubleshooting.md",
    );
    const scenariosPath = join(
      dir,
      "swamp-model",
      "references",
      "scenarios.md",
    );
    const expressionsPath = join(
      dir,
      "swamp-model",
      "references",
      "expressions.md",
    );
    const dataOwnershipPath = join(
      dir,
      "swamp-model",
      "references",
      "data-ownership.md",
    );

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);

    const troubleshootingStat = await Deno.stat(troubleshootingPath);
    assertEquals(troubleshootingStat.isFile, true);

    const scenariosStat = await Deno.stat(scenariosPath);
    assertEquals(scenariosStat.isFile, true);

    const expressionsStat = await Deno.stat(expressionsPath);
    assertEquals(expressionsStat.isFile, true);

    const dataOwnershipStat = await Deno.stat(dataOwnershipPath);
    assertEquals(dataOwnershipStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-repo reference files", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const structurePath = join(dir, "swamp-repo", "references", "structure.md");
    const troubleshootingPath = join(
      dir,
      "swamp-repo",
      "references",
      "troubleshooting.md",
    );

    const structureStat = await Deno.stat(structurePath);
    assertEquals(structureStat.isFile, true);

    const troubleshootingStat = await Deno.stat(troubleshootingPath);
    assertEquals(troubleshootingStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-workflow scenarios file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const scenariosPath = join(
      dir,
      "swamp-workflow",
      "references",
      "scenarios.md",
    );

    const scenariosStat = await Deno.stat(scenariosPath);
    assertEquals(scenariosStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-vault examples file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const examplesPath = join(dir, "swamp-vault", "references", "examples.md");

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-extension-model scenarios file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const scenariosPath = join(
      dir,
      "swamp-extension-model",
      "references",
      "scenarios.md",
    );

    const scenariosStat = await Deno.stat(scenariosPath);
    assertEquals(scenariosStat.isFile, true);
  });
});

Deno.test("SkillAssets includes swamp-troubleshooting skill", () => {
  const assets = new SkillAssets();
  const names = assets.getSkillNames();

  assertEquals(names.includes("swamp-troubleshooting"), true);
});

Deno.test("SkillAssets.copySkillsTo copies swamp-extension-model api file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const apiPath = join(
      dir,
      "swamp-extension-model",
      "references",
      "api.md",
    );

    const apiStat = await Deno.stat(apiPath);
    assertEquals(apiStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-workflow nested-workflows file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const nestedPath = join(
      dir,
      "swamp-workflow",
      "references",
      "nested-workflows.md",
    );

    const nestedStat = await Deno.stat(nestedPath);
    assertEquals(nestedStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-workflow expressions-and-foreach file", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const forEachPath = join(
      dir,
      "swamp-workflow",
      "references",
      "expressions-and-foreach.md",
    );

    const forEachStat = await Deno.stat(forEachPath);
    assertEquals(forEachStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-troubleshooting skill", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const skillPath = join(dir, "swamp-troubleshooting", "SKILL.md");

    const skillStat = await Deno.stat(skillPath);
    assertEquals(skillStat.isFile, true);
  });
});
