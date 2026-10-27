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

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  atomicWriteFile,
  type AtomicWriteSync,
  atomicWriteTextFile,
  syncExistingFile,
  writeSyncedTempFile,
} from "./atomic_write.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-atomic-write-test-" });
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

async function listTmpFiles(dir: string): Promise<string[]> {
  const tmpFiles: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.endsWith(".tmp")) {
      tmpFiles.push(entry.name);
    }
  }
  return tmpFiles;
}

Deno.test("atomicWriteTextFile writes text content correctly", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    const content = "hello: world\nfoo: bar\n";

    await atomicWriteTextFile(filePath, content);

    const result = await Deno.readTextFile(filePath);
    assertEquals(result, content);
  });
});

Deno.test("atomicWriteFile writes binary content correctly", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.bin");
    const content = new Uint8Array([0, 1, 2, 255, 128, 64]);

    await atomicWriteFile(filePath, content);

    const result = await Deno.readFile(filePath);
    assertEquals(result, content);
  });
});

Deno.test("atomicWriteTextFile overwrites existing file", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");

    await Deno.writeTextFile(filePath, "original content");
    await atomicWriteTextFile(filePath, "new content");

    const result = await Deno.readTextFile(filePath);
    assertEquals(result, "new content");
  });
});

Deno.test("atomicWriteTextFile leaves no temp files on success", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");

    await atomicWriteTextFile(filePath, "content");

    const tmpFiles = await listTmpFiles(dir);
    assertEquals(tmpFiles.length, 0);
  });
});

Deno.test("atomicWriteFile leaves no temp files on success", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.bin");

    await atomicWriteFile(filePath, new Uint8Array([1, 2, 3]));

    const tmpFiles = await listTmpFiles(dir);
    assertEquals(tmpFiles.length, 0);
  });
});

Deno.test("atomicWriteTextFile preserves original on directory error", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    await Deno.writeTextFile(filePath, "original");

    // Try to write to a non-existent directory — the temp file creation will fail
    const badPath = join(dir, "nonexistent", "subdir", "test.yaml");
    await assertRejects(
      () => atomicWriteTextFile(badPath, "new content"),
    );

    // Original file is untouched
    const result = await Deno.readTextFile(filePath);
    assertEquals(result, "original");

    // No temp files left behind
    const tmpFiles = await listTmpFiles(dir);
    assertEquals(tmpFiles.length, 0);
  });
});

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Sync hooks that record each call, and whether the target existed then. */
function recordingSync(
  events: string[],
  overrides: Partial<AtomicWriteSync> = {},
): AtomicWriteSync {
  return {
    syncFile: async (file, paths) => {
      await file.sync();
      events.push(`file ${paths.target} exists=${await exists(paths.target)}`);
    },
    syncDirectory: (dir) => {
      events.push(`dir ${dir}`);
      return Promise.resolve();
    },
    ...overrides,
  };
}

Deno.test("atomicWriteTextFile: with sync, syncs the file before the rename and the directory after", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    const events: string[] = [];
    await atomicWriteTextFile(filePath, "synced", {
      sync: recordingSync(events, {
        syncDirectory: async (d) => {
          events.push(`dir ${d} exists=${await exists(filePath)}`);
        },
      }),
    });
    assertEquals(events, [
      `file ${filePath} exists=false`,
      `dir ${dir} exists=true`,
    ]);
    assertEquals(await Deno.readTextFile(filePath), "synced");
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("atomicWriteFile: with sync and syncParent false, syncs the file but not the directory", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "raw");
    const events: string[] = [];
    await atomicWriteFile(filePath, new Uint8Array([1, 2, 3]), {
      sync: { ...recordingSync(events), syncParent: false },
    });
    assertEquals(events, [`file ${filePath} exists=false`]);
    assertEquals(await Deno.readFile(filePath), new Uint8Array([1, 2, 3]));
  });
});

Deno.test("atomicWriteFile: with the default sync hooks, writes the content", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "raw");
    await atomicWriteFile(filePath, new Uint8Array([9, 8]), { sync: {} });
    assertEquals(await Deno.readFile(filePath), new Uint8Array([9, 8]));
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test({
  name: "atomicWriteTextFile: with sync, honours mode",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const filePath = join(dir, "secret.json");
      await atomicWriteTextFile(filePath, "{}", { mode: 0o600, sync: {} });
      assertEquals((await Deno.stat(filePath)).mode! & 0o777, 0o600);
    });
  },
});

Deno.test("atomicWriteTextFile: with sync, a failed file sync removes the temp file and leaves the target", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    await Deno.writeTextFile(filePath, "original");
    await assertRejects(
      () =>
        atomicWriteTextFile(filePath, "new", {
          sync: {
            syncFile: () => Promise.reject(new Error("EIO")),
          },
        }),
      Error,
      "EIO",
    );
    assertEquals(await Deno.readTextFile(filePath), "original");
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("atomicWriteTextFile: with sync, a directory sync failing after the rename keeps the new target and rethrows", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    await Deno.writeTextFile(filePath, "original");
    await assertRejects(
      () =>
        atomicWriteTextFile(filePath, "new", {
          sync: {
            syncDirectory: () => Promise.reject(new Error("dir EIO")),
          },
        }),
      Error,
      "dir EIO",
    );
    assertEquals(await Deno.readTextFile(filePath), "new");
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("writeSyncedTempFile: syncs the content into a temp file and leaves the target alone", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "latest");
    await Deno.writeTextFile(target, "1");
    const events: string[] = [];
    const tmp = await writeSyncedTempFile(
      target,
      new TextEncoder().encode("2"),
      recordingSync(events),
    );
    assertEquals(events, [`file ${target} exists=true`]);
    assertEquals(await Deno.readTextFile(tmp), "2");
    assertEquals(await Deno.readTextFile(target), "1");
  });
});

Deno.test("syncExistingFile: resolves false for a missing file", async () => {
  await withTempDir(async (dir) => {
    const events: string[] = [];
    assertEquals(
      await syncExistingFile(join(dir, "raw"), recordingSync(events)),
      false,
    );
    assertEquals(events, []);
  });
});

Deno.test({
  name: "syncExistingFile: syncs a read-only file",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempDir(async (dir) => {
      const path = join(dir, "raw");
      await Deno.writeTextFile(path, "from a subprocess");
      await Deno.chmod(path, 0o444);
      const events: string[] = [];
      assert(await syncExistingFile(path, recordingSync(events)));
      assertEquals(events, [`file ${path} exists=true`]);
    });
  },
});
