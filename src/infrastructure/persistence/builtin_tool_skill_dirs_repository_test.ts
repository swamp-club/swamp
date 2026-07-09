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
import { BuiltInToolSkillDirsRepository } from "./builtin_tool_skill_dirs_repository.ts";

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

Deno.test("BuiltInToolSkillDirsRepository: exists returns false when file does not exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(
      join(dir, "nonexistent.json"),
    );
    assertEquals(await repo.exists(), false);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: exists returns true after write", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write([]);
    assertEquals(await repo.exists(), true);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: read returns empty array when file does not exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(
      join(dir, "nonexistent.json"),
    );
    assertEquals(await repo.read(), []);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: write and read round-trips", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write([
      "/home/user/.claude/skills",
      "/home/user/.agents/skills",
    ]);
    assertEquals(await repo.read(), [
      "/home/user/.claude/skills",
      "/home/user/.agents/skills",
    ]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: write deduplicates entries", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write([
      "/home/user/.claude/skills",
      "/home/user/.claude/skills",
    ]);
    assertEquals(await repo.read(), ["/home/user/.claude/skills"]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: write with empty array creates file", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write([]);
    assertEquals(await repo.exists(), true);
    assertEquals(await repo.read(), []);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: addDirs appends new entries", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.claude/skills"]);
    await repo.addDirs(["/home/user/.agents/skills"]);
    assertEquals(await repo.read(), [
      "/home/user/.claude/skills",
      "/home/user/.agents/skills",
    ]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: addDirs is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.claude/skills"]);
    await repo.addDirs(["/home/user/.claude/skills"]);
    assertEquals(await repo.read(), ["/home/user/.claude/skills"]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: addDirs creates file when none exists", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.addDirs(["/home/user/.claude/skills"]);
    assertEquals(await repo.read(), ["/home/user/.claude/skills"]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: addDirs with empty array is no-op", async () => {
  await withTempDir(async (dir) => {
    const repo = new BuiltInToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.claude/skills"]);
    await repo.addDirs([]);
    assertEquals(await repo.read(), ["/home/user/.claude/skills"]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: read filters out non-string entries", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "dirs.json");
    await Deno.writeTextFile(
      filePath,
      JSON.stringify(["/valid", 42, null, "/also-valid"]),
    );
    const repo = new BuiltInToolSkillDirsRepository(filePath);
    assertEquals(await repo.read(), ["/valid", "/also-valid"]);
  });
});

Deno.test("BuiltInToolSkillDirsRepository: read returns empty for malformed JSON", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "dirs.json");
    await Deno.writeTextFile(filePath, "not json");
    const repo = new BuiltInToolSkillDirsRepository(filePath);
    assertEquals(await repo.read(), []);
  });
});
