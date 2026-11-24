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

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import {
  atomicWriteFile,
  type AtomicWriteSync,
  atomicWriteTextFile,
  atomicWriteTextFileChunked,
  syncExistingFile,
  writeSyncedTempFile,
} from "./atomic_write.ts";
import { SyncFailedError } from "./sync_directory.ts";

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

    const badPath = join(dir, "nonexistent", "subdir", "test.yaml");
    await assertRejects(
      () => atomicWriteTextFile(badPath, "new content"),
    );

    const result = await Deno.readTextFile(filePath);
    assertEquals(result, "original");

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
    const error = await assertRejects(
      () =>
        atomicWriteTextFile(filePath, "new", {
          sync: {
            syncFile: () => Promise.reject(new Error("EIO")),
          },
        }),
      SyncFailedError,
      "EIO",
    );
    assertEquals(error.path, filePath);
    assertStringIncludes(error.message, `Could not sync ${filePath} to disk`);
    assertEquals(await Deno.readTextFile(filePath), "original");
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("atomicWriteTextFile: with sync, a directory sync failing after the rename keeps the new target and rethrows", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    await Deno.writeTextFile(filePath, "original");
    const error = await assertRejects(
      () =>
        atomicWriteTextFile(filePath, "new", {
          sync: {
            syncDirectory: () => Promise.reject(new Error("dir EIO")),
          },
        }),
      SyncFailedError,
      "dir EIO",
    );
    assertEquals(error.path, dir);
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

const CHUNKED_CASES: ReadonlyArray<readonly [string, string]> = [
  ["ascii", "hello: world\nfoo: bar\n"],
  ["multi-byte", "caf\u00e9 \u20ac \u4e2d\u6587"],
  ["astral", "rocket \u{1f680} and \u{10ffff}"],
  ["lone surrogates", "a\ud800b\udc00c\udbff"],
  ["empty", ""],
  // a 64 KiB chunk takes 21845 UTF-16 units, so each case below crosses one
  ["euro across the chunk boundary", "a".repeat(21_844) + "\u20ac".repeat(4)],
  ["pair across the chunk boundary", "a".repeat(21_844) + "\u{1f680}x"],
  ["lone high surrogate at the chunk boundary", "a".repeat(21_844) + "\ud800a"],
  [
    "lone high before a pair at the chunk boundary",
    "a".repeat(21_843) + "\ud800" + "\u{1f680}",
  ],
  ["several chunks", "\u{1f680}\u00e9z".repeat(40_000)],
];

for (const [name, content] of CHUNKED_CASES) {
  Deno.test(`atomicWriteTextFileChunked: writes the bytes Deno.writeTextFile writes (${name})`, async () => {
    await withTempDir(async (dir) => {
      const chunked = join(dir, "chunked.txt");
      const whole = join(dir, "whole.txt");

      await atomicWriteTextFileChunked(chunked, content);
      await Deno.writeTextFile(whole, content);

      assertEquals(await Deno.readFile(chunked), await Deno.readFile(whole));
    });
  });
}

Deno.test("atomicWriteTextFileChunked: overwrites the target and leaves no temp file", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    await Deno.writeTextFile(filePath, "original content");

    await atomicWriteTextFileChunked(filePath, "new content");

    assertEquals(await Deno.readTextFile(filePath), "new content");
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("atomicWriteTextFileChunked: resolves the identity of the file at the target", async () => {
  await withTempDir(async (dir) => {
    const filePath = join(dir, "test.yaml");
    const content = "\u{1f680}".repeat(50_000);

    const written = await atomicWriteTextFileChunked(filePath, content);

    const current = await Deno.stat(filePath);
    assert(written.isFile);
    assertEquals(written.ino, current.ino);
    assertEquals(written.dev, current.dev);
    assertEquals(written.size, current.size);
    assertEquals(written.size, new TextEncoder().encode(content).length);
    assertEquals(written.mtime?.getTime(), current.mtime?.getTime());
  });
});

Deno.test("atomicWriteTextFileChunked: a failed rename removes the temp file and leaves the target", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "occupied");
    await Deno.mkdir(target);
    await Deno.writeTextFile(join(target, "kept.txt"), "kept");

    await assertRejects(() => atomicWriteTextFileChunked(target, "content"));

    assertEquals(await listTmpFiles(dir), []);
    assertEquals(await Deno.readTextFile(join(target, "kept.txt")), "kept");
  });
});

Deno.test("atomicWriteTextFileChunked: a missing directory rejects and leaves no temp file", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () =>
        atomicWriteTextFileChunked(
          join(dir, "nonexistent", "test.yaml"),
          "content",
        ),
      Deno.errors.NotFound,
    );
    assertEquals(await listTmpFiles(dir), []);
  });
});

Deno.test("atomicWriteTextFileChunked: refuses a chunk too small for a code point", async () => {
  await withTempDir(async (dir) => {
    await assertRejects(
      () =>
        atomicWriteTextFileChunked(join(dir, "test.yaml"), "x", {
          chunkSize: 3,
        }),
      RangeError,
    );
    assertEquals(await listTmpFiles(dir), []);
  });
});
