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
import { CustomToolSkillDirsRepository } from "./custom_tool_skill_dirs_repository.ts";

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

Deno.test("CustomToolSkillDirsRepository: read returns empty array when file does not exist", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(
      join(dir, "nonexistent.json"),
    );
    const result = await repo.read();
    assertEquals(result, []);
  });
});

Deno.test("CustomToolSkillDirsRepository: write and read round-trips", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.pi/agent/skills", "/home/user/.foo/skills"]);
    const result = await repo.read();
    assertEquals(result, [
      "/home/user/.pi/agent/skills",
      "/home/user/.foo/skills",
    ]);
  });
});

Deno.test("CustomToolSkillDirsRepository: write deduplicates entries", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.pi/skills", "/home/user/.pi/skills"]);
    const result = await repo.read();
    assertEquals(result, ["/home/user/.pi/skills"]);
  });
});

Deno.test("CustomToolSkillDirsRepository: addDir appends new entry", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.pi/skills"]);
    await repo.addDir("/home/user/.foo/skills");
    const result = await repo.read();
    assertEquals(result, ["/home/user/.pi/skills", "/home/user/.foo/skills"]);
  });
});

Deno.test("CustomToolSkillDirsRepository: addDir is idempotent", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.write(["/home/user/.pi/skills"]);
    await repo.addDir("/home/user/.pi/skills");
    const result = await repo.read();
    assertEquals(result, ["/home/user/.pi/skills"]);
  });
});

Deno.test("CustomToolSkillDirsRepository: read filters out non-string entries", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "dirs.json");
    await Deno.writeTextFile(
      filePath,
      JSON.stringify(["/valid", 42, null, "/also-valid"]),
    );
    const repo = new CustomToolSkillDirsRepository(filePath);
    const result = await repo.read();
    assertEquals(result, ["/valid", "/also-valid"]);
  });
});

Deno.test("CustomToolSkillDirsRepository: read returns empty for malformed JSON", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "dirs.json");
    await Deno.writeTextFile(filePath, "not json");
    const repo = new CustomToolSkillDirsRepository(filePath);
    const result = await repo.read();
    assertEquals(result, []);
  });
});

Deno.test("CustomToolSkillDirsRepository: addDir creates file when none exists", async () => {
  await withTempDir(async (dir) => {
    const repo = new CustomToolSkillDirsRepository(join(dir, "dirs.json"));
    await repo.addDir("/home/user/.pi/skills");
    const result = await repo.read();
    assertEquals(result, ["/home/user/.pi/skills"]);
  });
});
