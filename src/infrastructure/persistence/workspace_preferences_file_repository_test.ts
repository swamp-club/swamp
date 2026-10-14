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
import { WorkspacePreferencesFileRepository } from "./workspace_preferences_file_repository.ts";

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

Deno.test("WorkspacePreferencesFileRepository: no preference when the file is missing", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspacePreferencesFileRepository(
      join(dir, "nonexistent", "workspaces.yaml"),
    );
    assertEquals(await repo.read(), {});
  });
});

Deno.test("WorkspacePreferencesFileRepository: round-trips and clears dir", async () => {
  await withTempDir(async (dir) => {
    const repo = new WorkspacePreferencesFileRepository(
      join(dir, "config", "workspaces.yaml"),
    );
    const folder = join(dir, "dev");
    await repo.write({ dir: folder });
    assertEquals(await repo.read(), { dir: folder });
    await repo.write({});
    assertEquals(await repo.read(), {});
  });
});

Deno.test("WorkspacePreferencesFileRepository: ignores a malformed file or a relative dir", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "workspaces.yaml");
    const repo = new WorkspacePreferencesFileRepository(filePath);
    await Deno.writeTextFile(filePath, "dir: [not, a, path");
    assertEquals(await repo.read(), {});
    await Deno.writeTextFile(filePath, "dir: relative/folder\n");
    assertEquals(await repo.read(), {});
    await Deno.writeTextFile(filePath, "dir: 42\n");
    assertEquals(await repo.read(), {});
  });
});
