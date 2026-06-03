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
import { validateExtensionSkills } from "./extension_skill_validator.ts";

async function createTempSkill(
  opts: {
    name?: string;
    skillMd?: string | null;
    extraFiles?: Record<string, string>;
    scripts?: boolean;
  } = {},
): Promise<{ dir: string; name: string; cleanup: () => Promise<void> }> {
  const tmpDir = await Deno.makeTempDir({ prefix: "skill_test_" });
  const name = opts.name ?? "test-skill";
  const skillDir = join(tmpDir, name);
  await Deno.mkdir(skillDir, { recursive: true });

  if (opts.skillMd !== null) {
    const content = opts.skillMd ??
      `---\nname: ${name}\ndescription: A test skill\n---\n# Test\n`;
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), content);
  }

  if (opts.scripts) {
    await Deno.mkdir(join(skillDir, "scripts"), { recursive: true });
    await Deno.writeTextFile(
      join(skillDir, "scripts", "setup.sh"),
      "#!/bin/bash\necho test",
    );
  }

  for (const [path, content] of Object.entries(opts.extraFiles ?? {})) {
    const fullPath = join(skillDir, path);
    await Deno.mkdir(join(fullPath, ".."), { recursive: true });
    await Deno.writeTextFile(fullPath, content);
  }

  return {
    dir: tmpDir,
    name,
    cleanup: () => Deno.remove(tmpDir, { recursive: true }),
  };
}

Deno.test("validateExtensionSkills: valid skill with frontmatter passes", async () => {
  const skill = await createTempSkill();
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 0);
    assertEquals(result.skills.length, 1);
    assertEquals(result.skills[0].name, "test-skill");
    assertEquals(result.skills[0].hasScripts, false);
  } finally {
    await skill.cleanup();
  }
});

Deno.test("validateExtensionSkills: missing SKILL.md is an error", async () => {
  const skill = await createTempSkill({ skillMd: null });
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0].skill, "test-skill");
  } finally {
    await skill.cleanup();
  }
});

Deno.test("validateExtensionSkills: missing frontmatter is an error", async () => {
  const skill = await createTempSkill({ skillMd: "# No frontmatter here\n" });
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0].message.includes("frontmatter"), true);
  } finally {
    await skill.cleanup();
  }
});

Deno.test("validateExtensionSkills: missing name field is an error", async () => {
  const skill = await createTempSkill({
    skillMd: "---\ndescription: test\n---\n# Test\n",
  });
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0].message.includes("name"), true);
  } finally {
    await skill.cleanup();
  }
});

Deno.test("validateExtensionSkills: missing description field is an error", async () => {
  const skill = await createTempSkill({
    skillMd: "---\nname: test\n---\n# Test\n",
  });
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 1);
    assertEquals(result.errors[0].message.includes("description"), true);
  } finally {
    await skill.cleanup();
  }
});

Deno.test("validateExtensionSkills: detects scripts per-skill", async () => {
  const withScripts = await createTempSkill({
    name: "with-scripts",
    scripts: true,
  });
  const noScripts = await createTempSkill({ name: "no-scripts" });
  try {
    const result = await validateExtensionSkills([
      {
        name: withScripts.name,
        absolutePath: join(withScripts.dir, withScripts.name),
      },
      {
        name: noScripts.name,
        absolutePath: join(noScripts.dir, noScripts.name),
      },
    ]);
    assertEquals(result.errors.length, 0);
    assertEquals(result.skills.length, 2);
    const ws = result.skills.find((s) => s.name === "with-scripts");
    const ns = result.skills.find((s) => s.name === "no-scripts");
    assertEquals(ws?.hasScripts, true);
    assertEquals(ns?.hasScripts, false);
  } finally {
    await withScripts.cleanup();
    await noScripts.cleanup();
  }
});

Deno.test("validateExtensionSkills: counts files correctly", async () => {
  const skill = await createTempSkill({
    extraFiles: { "references/api.md": "# API" },
  });
  try {
    const result = await validateExtensionSkills([
      { name: skill.name, absolutePath: join(skill.dir, skill.name) },
    ]);
    assertEquals(result.errors.length, 0);
    // SKILL.md + references/api.md = 2 files
    assertEquals(result.skills[0].fileCount, 2);
    assertEquals(result.skillFiles.length, 2);
  } finally {
    await skill.cleanup();
  }
});
