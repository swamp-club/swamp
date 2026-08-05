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

import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  isReloading,
  performServeReload,
  resolveLockfilePath,
} from "./extension_reload.ts";

Deno.test("isReloading: returns false when no reload is in progress", () => {
  assertEquals(isReloading(), false);
});

Deno.test("resolveLockfilePath: returns path ending in upstream_extensions.json", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await Deno.writeTextFile(
      join(tmpDir, ".swamp.yaml"),
      "version: 1\n",
    );
    const result = await resolveLockfilePath(tmpDir);
    assertStringIncludes(result, "upstream_extensions.json");
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: succeeds with no-op for missing lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const result = await performServeReload(
      tmpDir,
      join(tmpDir, "nonexistent_lockfile.json"),
    );
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: returns zero count for empty lockfile", async () => {
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(lockfilePath, "{}");
    const catalogDbPath = join(tmpDir, ".swamp", "_extension_catalog.db");
    await Deno.writeTextFile(catalogDbPath, "");
    const result = await performServeReload(tmpDir, lockfilePath);
    assertEquals(result.success, true);
    assertEquals(result.reloadedCount, 0);
    assertEquals(result.errors.length, 0);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("performServeReload: reloading guard resets after completion", async () => {
  assertEquals(isReloading(), false);
  const tmpDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
    await performServeReload(tmpDir, join(tmpDir, "missing.json"));
    assertEquals(isReloading(), false);
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});
