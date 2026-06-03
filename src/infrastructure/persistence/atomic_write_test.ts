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

import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { atomicWriteFile, atomicWriteTextFile } from "./atomic_write.ts";

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
