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
import { UpdateCheckCacheFileRepository } from "./update_check_cache_file_repository.ts";

Deno.test("read returns null when file does not exist", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "nonexistent.json");
    const repo = new UpdateCheckCacheFileRepository(filePath);
    const result = await repo.read();
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("read returns null for invalid JSON", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "cache.json");
    await Deno.writeTextFile(filePath, "not json");
    const repo = new UpdateCheckCacheFileRepository(filePath);
    const result = await repo.read();
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("read returns null for JSON with wrong shape", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "cache.json");
    await Deno.writeTextFile(filePath, JSON.stringify({ foo: "bar" }));
    const repo = new UpdateCheckCacheFileRepository(filePath);
    const result = await repo.read();
    assertEquals(result, null);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("write and read round-trip", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "cache.json");
    const repo = new UpdateCheckCacheFileRepository(filePath);

    const data = {
      latestVersion: "20260301.120000.0-sha.abc123",
      checkedAt: "2026-03-01T12:00:00.000Z",
    };

    await repo.write(data);
    const result = await repo.read();

    assertEquals(result, data);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("write creates parent directories", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    const filePath = join(tempDir, "nested", "dir", "cache.json");
    const repo = new UpdateCheckCacheFileRepository(filePath);

    const data = {
      latestVersion: "20260301.120000.0-sha.abc123",
      checkedAt: "2026-03-01T12:00:00.000Z",
    };

    await repo.write(data);
    const result = await repo.read();

    assertEquals(result, data);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
