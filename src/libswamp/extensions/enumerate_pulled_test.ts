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
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { enumeratePulledExtensionDirs } from "./enumerate_pulled.ts";

async function seedLockfile(
  repoDir: string,
  entries: Record<string, { version: string; files?: string[] }>,
): Promise<string> {
  const lockfilePath = join(repoDir, "upstream_extensions.json");
  const map: Record<string, unknown> = {};
  for (const [name, { version, files }] of Object.entries(entries)) {
    map[name] = {
      version,
      pulledAt: "2026-01-01T00:00:00Z",
      ...(files ? { files } : {}),
    };
  }
  await Deno.writeTextFile(lockfilePath, JSON.stringify(map, null, 2));
  return lockfilePath;
}

Deno.test("enumeratePulledExtensionDirs: returns empty when lockfile missing", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const dirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    assertEquals(dirs, []);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("enumeratePulledExtensionDirs: returns only dirs that exist on disk", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": { version: "1.0.0" },
      "@fake/b": { version: "1.0.0" },
    });
    // Create only @fake/a's models dir
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/a/models"),
    );

    const dirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    assertEquals(dirs, [
      join(tmpDir, ".swamp/pulled-extensions/@fake/a/models"),
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("enumeratePulledExtensionDirs: sorts output deterministically", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/z": { version: "1.0.0" },
      "@fake/a": { version: "1.0.0" },
      "@fake/m": { version: "1.0.0" },
    });
    for (const name of ["@fake/z", "@fake/a", "@fake/m"]) {
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions", name, "workflows"),
      );
    }

    const dirs = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "workflows",
    );
    assertEquals(dirs, [
      join(tmpDir, ".swamp/pulled-extensions/@fake/a/workflows"),
      join(tmpDir, ".swamp/pulled-extensions/@fake/m/workflows"),
      join(tmpDir, ".swamp/pulled-extensions/@fake/z/workflows"),
    ]);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("enumeratePulledExtensionDirs: same lockfile → same result (stable)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": { version: "1.0.0" },
      "@fake/b": { version: "2.0.0" },
    });
    for (const name of ["@fake/a", "@fake/b"]) {
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions", name, "models"),
      );
    }

    const first = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    const second = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    assertEquals(first, second);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("enumeratePulledExtensionDirs: version bump → paths unchanged (name-keyed, not version-keyed)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": { version: "1.0.0" },
    });
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/a/models"),
    );

    const before = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );

    // Bump version in lockfile
    await seedLockfile(tmpDir, {
      "@fake/a": { version: "2.0.0" },
    });

    const after = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );

    assertEquals(before, after);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("enumeratePulledExtensionDirs: adding extension changes result", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = await seedLockfile(tmpDir, {
      "@fake/a": { version: "1.0.0" },
    });
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/a/models"),
    );

    const before = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    assertEquals(before.length, 1);

    await seedLockfile(tmpDir, {
      "@fake/a": { version: "1.0.0" },
      "@fake/b": { version: "1.0.0" },
    });
    await ensureDir(
      join(tmpDir, ".swamp/pulled-extensions/@fake/b/models"),
    );

    const after = await enumeratePulledExtensionDirs(
      lockfilePath,
      tmpDir,
      "models",
    );
    assertEquals(after.length, 2);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});
