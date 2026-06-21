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
import {
  copySourceSkills,
  removeSourceSkills,
  resolveSourceSkills,
} from "./source_skills.ts";

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir();
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function writeFile(path: string, content: string): Promise<void> {
  await Deno.mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await Deno.writeTextFile(path, content);
}

Deno.test("resolveSourceSkills: returns empty when no manifest exists", async () => {
  await withTempDir(async (dir) => {
    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills, []);
  });
});

Deno.test("resolveSourceSkills: returns empty when manifest has no skills", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@test/no-skills"
version: "2026.01.01.1"
models:
  - my-model.ts
`,
    );
    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills, []);
  });
});

Deno.test("resolveSourceSkills: resolves skills from manifest with paths.base=manifest", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@test/with-skills"
version: "2026.01.01.1"
paths:
  base: manifest
skills:
  - my-skill
`,
    );
    const skillDir = join(dir, ".claude", "skills", "my-skill");
    await Deno.mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# My Skill");

    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills.length, 1);
    assertEquals(skills[0].name, "my-skill");
    assertEquals(skills[0].absolutePath, skillDir);
  });
});

Deno.test("resolveSourceSkills: resolves skills from source root without paths.base", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@test/root-skills"
version: "2026.01.01.1"
skills:
  - root-skill
`,
    );
    const skillDir = join(dir, ".claude", "skills", "root-skill");
    await Deno.mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Root Skill");

    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills.length, 1);
    assertEquals(skills[0].name, "root-skill");
    assertEquals(skills[0].absolutePath, skillDir);
  });
});

Deno.test("resolveSourceSkills: resolves multiple skills", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@test/multi-skills"
version: "2026.01.01.1"
paths:
  base: manifest
skills:
  - skill-a
  - skill-b
`,
    );
    for (const name of ["skill-a", "skill-b"]) {
      const skillDir = join(dir, ".claude", "skills", name);
      await Deno.mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, "SKILL.md"), `# ${name}`);
    }

    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills.length, 2);
    assertEquals(skills[0].name, "skill-a");
    assertEquals(skills[1].name, "skill-b");
  });
});

Deno.test("resolveSourceSkills: skips skills not found in any candidate dir", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      join(dir, "manifest.yaml"),
      `manifestVersion: 1
name: "@test/missing-skill"
version: "2026.01.01.1"
paths:
  base: manifest
skills:
  - exists
  - missing
`,
    );
    const skillDir = join(dir, ".claude", "skills", "exists");
    await Deno.mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# Exists");

    const skills = await resolveSourceSkills(dir, ["claude"]);
    assertEquals(skills.length, 1);
    assertEquals(skills[0].name, "exists");
  });
});

Deno.test("copySourceSkills: copies skill directories to target", async () => {
  await withTempDir(async (dir) => {
    const srcSkill = join(dir, "src-skills", "my-skill");
    await Deno.mkdir(srcSkill, { recursive: true });
    await writeFile(join(srcSkill, "SKILL.md"), "# My Skill");
    await Deno.mkdir(join(srcSkill, "references"), { recursive: true });
    await writeFile(join(srcSkill, "references", "guide.md"), "guide content");

    const targetDir = join(dir, "target-skills");
    const copied = await copySourceSkills(
      [{ name: "my-skill", absolutePath: srcSkill }],
      targetDir,
    );

    assertEquals(copied, ["my-skill"]);

    const content = await Deno.readTextFile(
      join(targetDir, "my-skill", "SKILL.md"),
    );
    assertEquals(content, "# My Skill");

    const refContent = await Deno.readTextFile(
      join(targetDir, "my-skill", "references", "guide.md"),
    );
    assertEquals(refContent, "guide content");
  });
});

Deno.test("copySourceSkills: returns empty when no skills provided", async () => {
  const copied = await copySourceSkills([], "/nonexistent");
  assertEquals(copied, []);
});

Deno.test("removeSourceSkills: removes named skill directories", async () => {
  await withTempDir(async (dir) => {
    const skillDir = join(dir, "my-skill");
    await Deno.mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "# My Skill");

    await removeSourceSkills(["my-skill"], dir);

    let exists = true;
    try {
      await Deno.stat(skillDir);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  });
});

Deno.test("removeSourceSkills: silently skips missing directories", async () => {
  await withTempDir(async (dir) => {
    await removeSourceSkills(["nonexistent"], dir);
  });
});
