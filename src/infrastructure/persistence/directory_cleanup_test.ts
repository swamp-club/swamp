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
import { ensureDir, exists } from "@std/fs";
import {
  cleanupEmptyParentDirs,
  type DirectoryCleanupFs,
  pruneOrphanFiles,
} from "./directory_cleanup.ts";
import { PathTraversalError } from "./safe_path.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-cleanup-test-" });
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

Deno.test("cleanupEmptyParentDirs removes empty parent directories", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, ".swamp", "data");
    const vpcDir = join(dataDir, "aws", "ec2", "vpc");
    await ensureDir(vpcDir);

    const filePath = join(vpcDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");

    await Deno.remove(filePath);

    await cleanupEmptyParentDirs(filePath, dataDir);

    assertEquals(await exists(join(dataDir, "aws", "ec2", "vpc")), false);
    assertEquals(await exists(join(dataDir, "aws", "ec2")), false);
    assertEquals(await exists(join(dataDir, "aws")), false);

    assertEquals(await exists(dataDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs stops at non-empty directory", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, ".swamp", "data");
    const vpcDir = join(dataDir, "aws", "ec2", "vpc");
    const subnetDir = join(dataDir, "aws", "ec2", "subnet");
    await ensureDir(vpcDir);
    await ensureDir(subnetDir);

    const vpcFile = join(vpcDir, "vpc.yaml");
    await Deno.writeTextFile(vpcFile, "test: content");

    const subnetFile = join(subnetDir, "subnet.yaml");
    await Deno.writeTextFile(subnetFile, "test: content");

    await Deno.remove(vpcFile);

    await cleanupEmptyParentDirs(vpcFile, dataDir);

    assertEquals(await exists(vpcDir), false);

    assertEquals(await exists(join(dataDir, "aws", "ec2")), true);

    assertEquals(await exists(join(dataDir, "aws")), true);

    assertEquals(await exists(subnetDir), true);
    assertEquals(await exists(subnetFile), true);
  });
});

Deno.test("cleanupEmptyParentDirs handles already deleted directories", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, ".swamp", "data");
    await ensureDir(dataDir);

    const nonExistentFile = join(dataDir, "aws", "ec2", "vpc", "test.yaml");

    await cleanupEmptyParentDirs(nonExistentFile, dataDir);

    assertEquals(await exists(dataDir), true);
  });
});

Deno.test("cleanupEmptyParentDirs does not go above stop directory", async () => {
  await withTempDir(async (tempDir) => {
    const swampDir = join(tempDir, ".swamp");
    const dataDir = join(swampDir, "data");
    const typeDir = join(dataDir, "swamp", "echo");
    await ensureDir(typeDir);

    const filePath = join(typeDir, "test.yaml");
    await Deno.writeTextFile(filePath, "test: content");
    await Deno.remove(filePath);

    await cleanupEmptyParentDirs(filePath, dataDir);

    assertEquals(await exists(typeDir), false);
    assertEquals(await exists(join(dataDir, "swamp")), false);

    assertEquals(await exists(dataDir), true);
    assertEquals(await exists(swampDir), true);
  });
});

function countingFs(): DirectoryCleanupFs & {
  calls: { lstat: number; remove: number; readDir: number };
} {
  const calls = { lstat: 0, remove: 0, readDir: 0 };
  return {
    calls,
    lstat: (path) => {
      calls.lstat++;
      return Deno.lstat(path);
    },
    remove: (path) => {
      calls.remove++;
      return Deno.remove(path);
    },
    readDir: (path) => {
      calls.readDir++;
      return Deno.readDir(path);
    },
  };
}

Deno.test("cleanupEmptyParentDirs: a directory with siblings left is never listed, however many", async () => {
  for (const siblings of [1, 50, 500]) {
    await withTempDir(async (tempDir) => {
      const outputsDir = join(tempDir, "outputs");
      const methodDir = join(outputsDir, "command", "shell", "execute");
      await ensureDir(methodDir);
      for (let i = 0; i < siblings; i++) {
        await Deno.writeTextFile(join(methodDir, `kept-${i}.yaml`), "x");
      }
      const deleted = join(methodDir, "deleted.yaml");
      await Deno.writeTextFile(deleted, "x");
      await Deno.remove(deleted);

      const fs = countingFs();
      await cleanupEmptyParentDirs(deleted, outputsDir, fs);

      assertEquals(fs.calls, { lstat: 1, remove: 1, readDir: 0 });
      assertEquals(await exists(join(methodDir, "kept-0.yaml")), true);
    });
  }
});

Deno.test("cleanupEmptyParentDirs: a directory that gained a file after the delete is kept", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, "data");
    const vpcDir = join(dataDir, "aws", "vpc");
    await ensureDir(vpcDir);
    const deleted = join(vpcDir, "old.yaml");
    await Deno.writeTextFile(deleted, "x");
    await Deno.remove(deleted);
    await Deno.writeTextFile(join(vpcDir, "new.yaml"), "x");

    await cleanupEmptyParentDirs(deleted, dataDir);

    assertEquals(await exists(join(vpcDir, "new.yaml")), true);
    assertEquals(await exists(join(dataDir, "aws")), true);
  });
});

Deno.test("cleanupEmptyParentDirs: a symlinked directory whose target holds files is kept", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, "data");
    const target = join(tempDir, "elsewhere");
    await ensureDir(dataDir);
    await ensureDir(target);
    await Deno.writeTextFile(join(target, "kept.yaml"), "x");
    const link = join(dataDir, "linked");
    await Deno.symlink(target, link, { type: "dir" });

    await cleanupEmptyParentDirs(join(link, "deleted.yaml"), dataDir);

    assertEquals((await Deno.lstat(link)).isSymlink, true);
    assertEquals(await exists(join(target, "kept.yaml")), true);
  });
});

Deno.test("cleanupEmptyParentDirs: a symlinked directory whose target is empty is removed", async () => {
  await withTempDir(async (tempDir) => {
    const dataDir = join(tempDir, "data");
    const target = join(tempDir, "elsewhere");
    await ensureDir(join(dataDir, "type"));
    await ensureDir(target);
    const link = join(dataDir, "type", "linked");
    await Deno.symlink(target, link, { type: "dir" });

    await cleanupEmptyParentDirs(join(link, "deleted.yaml"), dataDir);

    assertEquals(await exists(link), false);
    assertEquals(await exists(join(dataDir, "type")), false);
    assertEquals(await exists(target), true);
  });
});

Deno.test("pruneOrphanFiles rejects path traversal in orphan paths", async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = join(tempDir, "repo");
    await ensureDir(repoDir);

    const victimDir = join(tempDir, "victim");
    await ensureDir(victimDir);
    await Deno.writeTextFile(join(victimDir, "secret.txt"), "sensitive");

    await assertRejects(
      () => pruneOrphanFiles(["../victim"], repoDir),
      PathTraversalError,
    );

    assertEquals(await exists(victimDir), true);
    assertEquals(
      await Deno.readTextFile(join(victimDir, "secret.txt")),
      "sensitive",
    );
  });
});

Deno.test("pruneOrphanFiles removes valid orphan paths", async () => {
  await withTempDir(async (tempDir) => {
    const repoDir = join(tempDir, "repo");
    await ensureDir(repoDir);
    const orphanFile = join(repoDir, ".swamp", "pulled-extensions", "old.ts");
    await ensureDir(join(repoDir, ".swamp", "pulled-extensions"));
    await Deno.writeTextFile(orphanFile, "old content");

    const removed = await pruneOrphanFiles(
      [".swamp/pulled-extensions/old.ts"],
      repoDir,
    );

    assertEquals(removed, [".swamp/pulled-extensions/old.ts"]);
    assertEquals(await exists(orphanFile), false);
  });
});
