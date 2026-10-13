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
import { initializeLogging } from "../../infrastructure/logging/logger.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";
import {
  detectSupersededSkills,
  removeSupersededLocalSkills,
  removeSupersededSkills,
  resolveSupersededSkillDirs,
  SUPERSEDED_SKILL_PATHS,
  SUPERSEDED_SKILLS,
  supersededSkillDirs,
} from "./superseded_skills.ts";

await initializeLogging({});

async function withTempDir(
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp_superseded_test_" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

Deno.test("removeSupersededSkills: removes matching directories", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp-extension-model"));
    await Deno.mkdir(join(tempDir, "swamp-data-query"));
    await Deno.mkdir(join(tempDir, "swamp"));

    await removeSupersededSkills(tempDir);

    const remaining = [];
    for await (const entry of Deno.readDir(tempDir)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining, ["swamp"]);
  });
});

Deno.test("removeSupersededSkills: no-ops when directory has no superseded skills", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp"));
    await Deno.mkdir(join(tempDir, "my-custom-skill"));

    await removeSupersededSkills(tempDir);

    const remaining = [];
    for await (const entry of Deno.readDir(tempDir)) {
      remaining.push(entry.name);
    }
    assertEquals(remaining.sort(), ["my-custom-skill", "swamp"]);
  });
});

Deno.test("removeSupersededSkills: handles nonexistent directory gracefully", async () => {
  await removeSupersededSkills("/tmp/nonexistent-dir-superseded-test");
});

Deno.test("detectSupersededSkills: returns empty when no superseded dirs exist", async () => {
  await withTempDir(async (tempDir) => {
    const result = await detectSupersededSkills(tempDir);
    assertEquals(result, []);
  });
});

Deno.test("detectSupersededSkills: detects superseded skill directories", async () => {
  await withTempDir(async (tempDir) => {
    await Deno.mkdir(join(tempDir, "swamp-extension-model"));
    await Deno.mkdir(join(tempDir, "swamp-data-query"));
    await Deno.mkdir(join(tempDir, "swamp"));

    const result = await detectSupersededSkills(tempDir);
    assertEquals(result.sort(), ["swamp-data-query", "swamp-extension-model"]);
  });
});

Deno.test("SUPERSEDED_SKILLS: contains expected entries", () => {
  assertEquals(SUPERSEDED_SKILLS.includes("swamp-extension-model"), true);
  assertEquals(SUPERSEDED_SKILLS.includes("swamp-data-query"), true);
  assertEquals(SUPERSEDED_SKILLS.includes("swamp"), false);
});

async function seedSuperseded(dir: string): Promise<void> {
  for (const name of SUPERSEDED_SKILLS) {
    await Deno.mkdir(join(dir, name), { recursive: true });
    await Deno.writeTextFile(join(dir, name, "SKILL.md"), "old");
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

Deno.test("supersededSkillDirs: one dir per built-in tool, de-duplicated", () => {
  const dirs = supersededSkillDirs("/repo", ["claude", "codex", "copilot"]);
  assertEquals(dirs.length, 2);
  assertPathEquals(dirs[0], join("/repo", ".claude", "skills"));
  assertPathEquals(dirs[1], join("/repo", ".agents", "skills"));
});

Deno.test("supersededSkillDirs: ignores tools without a built-in skills dir", () => {
  assertEquals(supersededSkillDirs("/repo", ["none", "my-custom-tool"]), []);
});

Deno.test("supersededSkillDirs: falls back to the claude dir when no tools are set", () => {
  const dirs = supersededSkillDirs("/repo", []);
  assertEquals(dirs.length, 1);
  assertPathEquals(dirs[0], join("/repo", ".claude", "skills"));
});

Deno.test("removeSupersededLocalSkills: removes superseded skills and keeps others", async () => {
  await withTempDir(async (tempDir) => {
    const skillsDir = join(tempDir, ".claude", "skills");
    await seedSuperseded(skillsDir);
    await Deno.mkdir(join(skillsDir, "my-skill"));

    await removeSupersededLocalSkills(tempDir, ["claude"]);

    assertEquals(await detectSupersededSkills(skillsDir), []);
    assertEquals(await exists(join(skillsDir, "my-skill")), true);
  });
});

Deno.test("removeSupersededLocalSkills: no-ops when the skills dir does not exist", async () => {
  await withTempDir(async (tempDir) => {
    await removeSupersededLocalSkills(tempDir, ["claude", "kiro"]);
    assertEquals(await exists(join(tempDir, ".claude")), false);
  });
});

Deno.test("removeSupersededLocalSkills: skips a skills dir that resolves outside the repo", async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = join(tempDir, "repo");
    const outside = join(tempDir, "outside");
    await seedSuperseded(outside);
    await Deno.mkdir(join(repoDir, ".claude"), { recursive: true });
    await Deno.symlink(outside, join(repoDir, ".claude", "skills"), {
      type: "dir",
    });

    await removeSupersededLocalSkills(repoDir, ["claude"]);

    assertEquals(
      (await detectSupersededSkills(outside)).length,
      SUPERSEDED_SKILLS.length,
    );
  });
});

Deno.test("removeSupersededLocalSkills: removes a symlinked superseded entry without touching its target", async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = join(tempDir, "repo");
    const target = join(tempDir, "target");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "keep.txt"), "keep");
    const skillsDir = join(repoDir, ".claude", "skills");
    await Deno.mkdir(skillsDir, { recursive: true });
    await Deno.symlink(target, join(skillsDir, "swamp-data"), { type: "dir" });

    await removeSupersededLocalSkills(repoDir, ["claude"]);

    assertEquals(await exists(join(skillsDir, "swamp-data")), false);
    assertEquals(await exists(join(target, "keep.txt")), true);
  });
});

Deno.test("resolveSupersededSkillDirs: splits dirs by containment and leaves out missing ones", async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = join(tempDir, "repo");
    const outside = join(tempDir, "outside");
    await Deno.mkdir(outside);
    await Deno.mkdir(join(repoDir, ".agents", "skills"), { recursive: true });
    await Deno.mkdir(join(repoDir, ".claude"), { recursive: true });
    await Deno.symlink(outside, join(repoDir, ".claude", "skills"), {
      type: "dir",
    });

    const { contained, outside: escaped } = await resolveSupersededSkillDirs(
      repoDir,
      ["claude", "codex", "kiro"],
    );

    assertEquals(contained.length, 1);
    assertPathEquals(
      contained[0],
      join(await Deno.realPath(repoDir), ".agents", "skills"),
    );
    assertEquals(escaped.length, 1);
    assertPathEquals(escaped[0], join(repoDir, ".claude", "skills"));
  });
});

Deno.test({
  name:
    "removeSupersededLocalSkills: a failing entry does not stop the rest of the dir",
  // Root ignores the read-only permission this test relies on.
  ignore: Deno.build.os === "windows" || Deno.uid() === 0,
  fn: async () => {
    await withTempDir(async (tempDir) => {
      const skillsDir = join(tempDir, ".claude", "skills");
      await seedSuperseded(skillsDir);
      // A read-only subdirectory makes the recursive delete of this entry fail.
      const locked = join(skillsDir, SUPERSEDED_SKILLS[0], "locked");
      await Deno.mkdir(locked);
      await Deno.writeTextFile(join(locked, "file"), "x");
      await Deno.chmod(locked, 0o500);
      try {
        await removeSupersededLocalSkills(tempDir, ["claude"]);

        assertEquals(await detectSupersededSkills(skillsDir), [
          SUPERSEDED_SKILLS[0],
        ]);
      } finally {
        await Deno.chmod(locked, 0o700);
      }
    });
  },
});

Deno.test("removeSupersededLocalSkills: a skills dir that cannot be resolved is skipped without aborting", async () => {
  await withTempDir(async (tempDir) => {
    // `.claude` is a file, so resolving `.claude/skills` fails.
    await Deno.writeTextFile(join(tempDir, ".claude"), "not a dir");
    const sharedDir = join(tempDir, ".agents", "skills");
    await seedSuperseded(sharedDir);

    await removeSupersededLocalSkills(tempDir, ["claude", "codex"]);

    assertEquals(await detectSupersededSkills(sharedDir), []);
  });
});

/** Seeds an installed swamp skill holding the pre-#3332 model reference folder. */
async function seedOldSwampSkill(skillsDir: string): Promise<void> {
  const refs = join(skillsDir, "swamp", "references");
  await Deno.mkdir(join(refs, "model", "references"), { recursive: true });
  await Deno.writeTextFile(join(refs, "model", "guide.md"), "old");
  await Deno.writeTextFile(
    join(refs, "model", "references", "examples.md"),
    "old",
  );
  await Deno.mkdir(join(refs, "behavior"), { recursive: true });
  await Deno.writeTextFile(join(refs, "behavior", "guide.md"), "new");
  await Deno.mkdir(join(refs, "extension", "references", "model"), {
    recursive: true,
  });
  await Deno.writeTextFile(
    join(refs, "extension", "references", "model", "api.md"),
    "keep",
  );
  await Deno.writeTextFile(join(skillsDir, "swamp", "SKILL.md"), "keep");
}

Deno.test("SUPERSEDED_SKILL_PATHS: lists the moved swamp model reference folder", () => {
  assertEquals(SUPERSEDED_SKILL_PATHS, ["swamp/references/model"]);
});

Deno.test("removeSupersededSkills: removes the superseded skill path and keeps its siblings", async () => {
  await withTempDir(async (tempDir) => {
    await seedOldSwampSkill(tempDir);

    await removeSupersededSkills(tempDir);

    const refs = join(tempDir, "swamp", "references");
    assertEquals(await exists(join(refs, "model")), false);
    assertEquals(await exists(join(refs, "behavior", "guide.md")), true);
    assertEquals(
      await exists(join(refs, "extension", "references", "model", "api.md")),
      true,
    );
    assertEquals(await exists(join(tempDir, "swamp", "SKILL.md")), true);
  });
});

Deno.test("removeSupersededSkills: leaves a symlinked superseded path and its target alone", async () => {
  await withTempDir(async (tempDir) => {
    const target = join(tempDir, "target");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "keep.txt"), "keep");
    const skillsDir = join(tempDir, "skills");
    const refs = join(skillsDir, "swamp", "references");
    await Deno.mkdir(refs, { recursive: true });
    await Deno.symlink(target, join(refs, "model"), { type: "dir" });

    await removeSupersededSkills(skillsDir);

    assertEquals(await exists(join(refs, "model")), true);
    assertEquals(await exists(join(target, "keep.txt")), true);
  });
});

Deno.test("removeSupersededSkills: does not follow a symlinked parent of the superseded path", async () => {
  await withTempDir(async (tempDir) => {
    const target = join(tempDir, "target");
    await Deno.mkdir(join(target, "model"), { recursive: true });
    await Deno.writeTextFile(join(target, "model", "keep.txt"), "keep");
    const skillsDir = join(tempDir, "skills");
    await Deno.mkdir(join(skillsDir, "swamp"), { recursive: true });
    await Deno.symlink(target, join(skillsDir, "swamp", "references"), {
      type: "dir",
    });

    await removeSupersededSkills(skillsDir);

    assertEquals(await exists(join(target, "model", "keep.txt")), true);
  });
});

Deno.test("removeSupersededSkills: leaves a file at the superseded path alone", async () => {
  await withTempDir(async (tempDir) => {
    const refs = join(tempDir, "swamp", "references");
    await Deno.mkdir(refs, { recursive: true });
    await Deno.writeTextFile(join(refs, "model"), "a file, not the old folder");

    await removeSupersededSkills(tempDir);

    assertEquals(await exists(join(refs, "model")), true);
  });
});

Deno.test("removeSupersededLocalSkills: removes the superseded skill path from a repo-local skills dir", async () => {
  await withTempDir(async (tempDir) => {
    const skillsDir = join(tempDir, ".claude", "skills");
    await seedOldSwampSkill(skillsDir);

    await removeSupersededLocalSkills(tempDir, ["claude"]);

    const refs = join(skillsDir, "swamp", "references");
    assertEquals(await exists(join(refs, "model")), false);
    assertEquals(await exists(join(refs, "behavior", "guide.md")), true);
    assertEquals(
      await exists(join(refs, "extension", "references", "model", "api.md")),
      true,
    );
  });
});
