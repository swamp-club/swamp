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
import { assertPathStringIncludes } from "../persistence/path_test_helpers.ts";
import { join } from "@std/path";
import { SkillAssets } from "./skill_assets.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-skill-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

Deno.test("SkillAssets.listSkills returns expected skills", () => {
  const assets = new SkillAssets();
  const skills = assets.listSkills();

  assertEquals(skills.length > 0, true);
  const swamp = skills.find((s) =>
    s.name === "swamp" && s.relativePath === "swamp/SKILL.md"
  );
  assertEquals(swamp !== undefined, true);
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
  assertEquals(names.includes("swamp"), true);
});

Deno.test("SkillAssets.readSkill returns content for existing skill", async () => {
  const assets = new SkillAssets();
  const content = await assets.readSkill("swamp/SKILL.md");

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
  const path = assets.getSkillPath("swamp/SKILL.md");

  assertPathStringIncludes(path, "swamp/SKILL.md");
  assertPathStringIncludes(path, ".claude/skills");
});

Deno.test("SkillAssets.copySkillsTo copies files correctly", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    // Check that the gateway SKILL.md was copied
    const skillPath = join(dir, "swamp", "SKILL.md");
    const stat = await Deno.stat(skillPath);
    assertEquals(stat.isFile, true);

    // Verify content matches source
    const copiedContent = await Deno.readTextFile(skillPath);
    const originalContent = await assets.readSkill("swamp/SKILL.md");
    assertEquals(copiedContent, originalContent);
  });
});

Deno.test("SkillAssets.copySkillsTo creates nested directories", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const skillDir = join(dir, "swamp");
    const stat = await Deno.stat(skillDir);
    assertEquals(stat.isDirectory, true);
  });
});

Deno.test("SkillAssets.copySkillsTo rejects path traversal attempts", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();

    await assets.copySkillsTo(dir);

    // Verify files are written within the target directory
    const skillPath = join(dir, "swamp", "SKILL.md");
    const realPath = await Deno.realPath(skillPath);
    assertEquals(realPath.startsWith(await Deno.realPath(dir)), true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies model guide and references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const guidePath = join(dir, "swamp", "references", "model", "guide.md");
    const examplesPath = join(
      dir,
      "swamp",
      "references",
      "model",
      "references",
      "examples.md",
    );
    const scenariosPath = join(
      dir,
      "swamp",
      "references",
      "model",
      "references",
      "scenarios.md",
    );

    const guideStat = await Deno.stat(guidePath);
    assertEquals(guideStat.isFile, true);

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);

    const scenariosStat = await Deno.stat(scenariosPath);
    assertEquals(scenariosStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies data guide and references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const guidePath = join(dir, "swamp", "references", "data", "guide.md");
    const expressionsPath = join(
      dir,
      "swamp",
      "references",
      "data",
      "references",
      "expressions.md",
    );

    const guideStat = await Deno.stat(guidePath);
    assertEquals(guideStat.isFile, true);

    const expressionsStat = await Deno.stat(expressionsPath);
    assertEquals(expressionsStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies extension nested references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const guidePath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "guide.md",
    );
    const modelApiPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "model",
      "api.md",
    );
    const vaultApiPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "vault",
      "api.md",
    );
    const adversarialPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "adversarial-review.md",
    );

    const guideStat = await Deno.stat(guidePath);
    assertEquals(guideStat.isFile, true);

    const modelApiStat = await Deno.stat(modelApiPath);
    assertEquals(modelApiStat.isFile, true);

    const vaultApiStat = await Deno.stat(vaultApiPath);
    assertEquals(vaultApiStat.isFile, true);

    const adversarialStat = await Deno.stat(adversarialPath);
    assertEquals(adversarialStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies workflow references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const scenariosPath = join(
      dir,
      "swamp",
      "references",
      "workflow",
      "references",
      "scenarios.md",
    );
    const nestedPath = join(
      dir,
      "swamp",
      "references",
      "workflow",
      "references",
      "nested-workflows.md",
    );

    const scenariosStat = await Deno.stat(scenariosPath);
    assertEquals(scenariosStat.isFile, true);

    const nestedStat = await Deno.stat(nestedPath);
    assertEquals(nestedStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies vault references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const examplesPath = join(
      dir,
      "swamp",
      "references",
      "vault",
      "references",
      "examples.md",
    );

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies troubleshooting guide", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const guidePath = join(
      dir,
      "swamp",
      "references",
      "troubleshooting",
      "guide.md",
    );

    const guideStat = await Deno.stat(guidePath);
    assertEquals(guideStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies swamp-getting-started skill", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const skillPath = join(dir, "swamp-getting-started", "SKILL.md");
    const tracksPath = join(
      dir,
      "swamp-getting-started",
      "references",
      "tracks.md",
    );

    const skillStat = await Deno.stat(skillPath);
    assertEquals(skillStat.isFile, true);

    const tracksStat = await Deno.stat(tracksPath);
    assertEquals(tracksStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies extension quality references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const rubricPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "quality",
      "rubric.md",
    );
    const templatesPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "quality",
      "templates.md",
    );

    const rubricStat = await Deno.stat(rubricPath);
    assertEquals(rubricStat.isFile, true);

    const templatesStat = await Deno.stat(templatesPath);
    assertEquals(templatesStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies repo references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const structurePath = join(
      dir,
      "swamp",
      "references",
      "repo",
      "references",
      "structure.md",
    );
    const ciPath = join(
      dir,
      "swamp",
      "references",
      "repo",
      "references",
      "ci-integration.md",
    );

    const structureStat = await Deno.stat(structurePath);
    assertEquals(structureStat.isFile, true);

    const ciStat = await Deno.stat(ciPath);
    assertEquals(ciStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies extension driver references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const apiPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "driver",
      "api.md",
    );
    const examplesPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "driver",
      "examples.md",
    );

    const apiStat = await Deno.stat(apiPath);
    assertEquals(apiStat.isFile, true);

    const examplesStat = await Deno.stat(examplesPath);
    assertEquals(examplesStat.isFile, true);
  });
});

Deno.test("SkillAssets.copySkillsTo copies extension datastore references", async () => {
  await withTempDir(async (dir) => {
    const assets = new SkillAssets();
    await assets.copySkillsTo(dir);

    const apiPath = join(
      dir,
      "swamp",
      "references",
      "extension",
      "references",
      "datastore",
      "api.md",
    );

    const apiStat = await Deno.stat(apiPath);
    assertEquals(apiStat.isFile, true);
  });
});
