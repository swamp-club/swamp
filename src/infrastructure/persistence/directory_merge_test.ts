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
import { ensureDir, exists } from "@std/fs";
import {
  dirContents,
  findFileCollisions,
  mergeDirInto,
  removeCatalogFiles,
  removeEmptyDirs,
} from "./directory_merge.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-merge-test-" });
  try {
    await fn(dir);
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}

// --- findFileCollisions ---

Deno.test("findFileCollisions: detects top-level file collision", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(src);
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "a.yaml"), "src");
    await Deno.writeTextFile(join(dst, "a.yaml"), "dst");
    await Deno.writeTextFile(join(src, "b.yaml"), "only-in-src");

    const collisions = await findFileCollisions(src, dst);
    assertEquals(collisions, ["a.yaml"]);
  });
});

Deno.test("findFileCollisions: detects nested collision two levels deep", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "model-a", "v1"));
    await ensureDir(join(dst, "model-a", "v1"));

    await Deno.writeTextFile(join(src, "model-a", "v1", "raw"), "src");
    await Deno.writeTextFile(join(dst, "model-a", "v1", "raw"), "dst");
    await Deno.writeTextFile(join(src, "model-a", "unique"), "src-only");

    const collisions = await findFileCollisions(src, dst);
    assertEquals(collisions, ["model-a/v1/raw"]);
  });
});

Deno.test("findFileCollisions: returns empty when no collisions", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(src);
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "a.yaml"), "src");
    await Deno.writeTextFile(join(dst, "b.yaml"), "dst");

    const collisions = await findFileCollisions(src, dst);
    assertEquals(collisions, []);
  });
});

Deno.test("findFileCollisions: detects symlink collision", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(src);
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "target"), "src");
    await Deno.symlink(join(src, "target"), join(src, "latest"), {
      type: "file",
    });
    await Deno.writeTextFile(join(dst, "target"), "dst");
    await Deno.symlink(join(dst, "target"), join(dst, "latest"), {
      type: "file",
    });

    const collisions = await findFileCollisions(src, dst);
    collisions.sort();
    assertEquals(collisions, ["latest", "target"]);
  });
});

// --- mergeDirInto ---

Deno.test("mergeDirInto: moves non-colliding files and preserves colliding source files", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(src);
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "colliding.yaml"), "source-version");
    await Deno.writeTextFile(join(dst, "colliding.yaml"), "dest-version");
    await Deno.writeTextFile(join(src, "unique.yaml"), "moved-data");

    const result = await mergeDirInto(src, dst);

    assertEquals(result.moved, 1);
    assertEquals(result.skipped, 1);
    assertEquals(result.skippedPaths, ["colliding.yaml"]);

    assertEquals(
      await Deno.readTextFile(join(dst, "colliding.yaml")),
      "dest-version",
    );
    assertEquals(
      await Deno.readTextFile(join(dst, "unique.yaml")),
      "moved-data",
    );

    assertEquals(
      await Deno.readTextFile(join(src, "colliding.yaml")),
      "source-version",
    );
  });
});

Deno.test("mergeDirInto: nested collision preserves source and ancestor dirs", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "model-a", "v1"));
    await ensureDir(join(dst, "model-a", "v1"));

    await Deno.writeTextFile(
      join(src, "model-a", "v1", "raw"),
      "src-content",
    );
    await Deno.writeTextFile(
      join(dst, "model-a", "v1", "raw"),
      "dst-content",
    );

    const result = await mergeDirInto(src, dst);

    assertEquals(result.skipped, 1);
    assertEquals(result.skippedPaths, ["model-a/v1/raw"]);

    assertEquals(
      await Deno.readTextFile(join(src, "model-a", "v1", "raw")),
      "src-content",
    );
    assertEquals(
      await Deno.readTextFile(join(dst, "model-a", "v1", "raw")),
      "dst-content",
    );

    assertEquals(await exists(join(src, "model-a", "v1")), true);
    assertEquals(await exists(join(src, "model-a")), true);
    assertEquals(await exists(src), true);
  });
});

Deno.test("mergeDirInto: cleans up empty source dirs after full merge", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "nested"));
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "a.yaml"), "data");
    await Deno.writeTextFile(join(src, "nested", "b.yaml"), "data");

    const result = await mergeDirInto(src, dst);

    assertEquals(result.moved, 2);
    assertEquals(result.skipped, 0);
    assertEquals(result.skippedPaths, []);

    assertEquals(await Deno.readTextFile(join(dst, "a.yaml")), "data");
    assertEquals(
      await Deno.readTextFile(join(dst, "nested", "b.yaml")),
      "data",
    );

    assertEquals(await exists(src), false);
  });
});

Deno.test("mergeDirInto: moves symlink-to-directory as an entry", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "versions"));
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "versions", "v1.yaml"), "v1");
    // Relative symlink — stays valid after the move
    await Deno.symlink("versions", join(src, "latest"), { type: "dir" });
    await Deno.writeTextFile(join(dst, "other.yaml"), "existing");

    const result = await mergeDirInto(src, dst);

    assertEquals(
      await Deno.readTextFile(join(dst, "versions", "v1.yaml")),
      "v1",
    );
    const latestStat = await Deno.lstat(join(dst, "latest"));
    assertEquals(latestStat.isSymlink, true);

    assertEquals(result.skipped, 0);
    assertEquals(await exists(src), false);
  });
});

Deno.test("mergeDirInto: colliding symlink is skipped and source preserved", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(src);
    await ensureDir(dst);

    await Deno.writeTextFile(join(src, "target"), "src-data");
    await Deno.symlink(join(src, "target"), join(src, "latest"), {
      type: "file",
    });
    await Deno.writeTextFile(join(dst, "target"), "dst-data");
    await Deno.symlink(join(dst, "target"), join(dst, "latest"), {
      type: "file",
    });

    const result = await mergeDirInto(src, dst);

    assertEquals(result.skipped, 2);
    result.skippedPaths.sort();
    assertEquals(result.skippedPaths, ["latest", "target"]);

    assertEquals(
      await Deno.readTextFile(join(src, "target")),
      "src-data",
    );
    assertEquals(
      await Deno.readTextFile(join(dst, "target")),
      "dst-data",
    );
  });
});

Deno.test("mergeDirInto: mixed tree — partial collision preserves only colliding branch", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");

    await ensureDir(join(src, "model-a"));
    await ensureDir(join(src, "model-b"));
    await ensureDir(join(dst, "model-a"));

    await Deno.writeTextFile(join(src, "model-a", "raw"), "src-a");
    await Deno.writeTextFile(join(dst, "model-a", "raw"), "dst-a");
    await Deno.writeTextFile(join(src, "model-b", "raw"), "src-b");

    const result = await mergeDirInto(src, dst);

    assertEquals(result.moved, 1);
    assertEquals(result.skipped, 1);
    assertEquals(result.skippedPaths, ["model-a/raw"]);

    assertEquals(
      await Deno.readTextFile(join(src, "model-a", "raw")),
      "src-a",
    );
    assertEquals(await exists(join(src, "model-b")), false);
    assertEquals(await exists(join(src, "model-a")), true);

    assertEquals(
      await Deno.readTextFile(join(dst, "model-b", "raw")),
      "src-b",
    );
  });
});

// --- removeEmptyDirs ---

Deno.test("removeEmptyDirs: removes fully empty tree", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "empty");
    await ensureDir(join(dir, "a", "b"));
    await ensureDir(join(dir, "c"));

    const removed = await removeEmptyDirs(dir);
    assertEquals(removed, true);
    assertEquals(await exists(dir), false);
  });
});

Deno.test("removeEmptyDirs: preserves dir containing a file", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "notempty");
    await ensureDir(join(dir, "a"));
    await Deno.writeTextFile(join(dir, "a", "keep.txt"), "data");

    const removed = await removeEmptyDirs(dir);
    assertEquals(removed, false);
    assertEquals(await exists(join(dir, "a", "keep.txt")), true);
  });
});

Deno.test("removeEmptyDirs: removes empty siblings but preserves occupied dir", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "mixed");
    await ensureDir(join(dir, "empty-child"));
    await ensureDir(join(dir, "occupied"));
    await Deno.writeTextFile(join(dir, "occupied", "file"), "data");

    const removed = await removeEmptyDirs(dir);
    assertEquals(removed, false);
    assertEquals(await exists(join(dir, "empty-child")), false);
    assertEquals(await exists(join(dir, "occupied", "file")), true);
  });
});

Deno.test("mergeDirInto: leaves install staging in the source", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    const staging = join(src, `.swamp-staging-${crypto.randomUUID()}`);
    await ensureDir(join(src, "ns1"));
    await ensureDir(join(staging, "new", "1"));
    await ensureDir(dst);
    await Deno.writeTextFile(join(src, "ns1", "a.js"), "a");
    await Deno.writeTextFile(join(staging, "new", "1", "b.js"), "b");

    const result = await mergeDirInto(src, dst);
    assertEquals(result.moved, 1);
    assertEquals(await exists(join(dst, "ns1", "a.js")), true);
    assertEquals(await exists(join(staging, "new", "1", "b.js")), true);
    assertEquals(
      await findFileCollisions(src, dst),
      [],
    );
  });
});

// --- catalog files (swamp-club#3316) ---

const CATALOG_NAMES = [
  "_catalog.db",
  "_catalog.db-journal",
  "_catalog.db-wal",
  "_catalog.db-shm",
];

Deno.test("findFileCollisions: ignores top-level catalog files", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "model"));
    await ensureDir(join(dst, "model"));
    for (const name of CATALOG_NAMES) {
      await Deno.writeTextFile(join(src, name), "live");
      await Deno.writeTextFile(join(dst, name), "stale");
    }
    // The same name below the top level is an ordinary file.
    await Deno.writeTextFile(join(src, "model", "_catalog.db"), "a");
    await Deno.writeTextFile(join(dst, "model", "_catalog.db"), "b");

    assertEquals(await findFileCollisions(src, dst), ["model/_catalog.db"]);
  });
});

Deno.test("mergeDirInto: leaves top-level catalog files in the source", async () => {
  await withTempDir(async (root) => {
    const src = join(root, "src");
    const dst = join(root, "dst");
    await ensureDir(join(src, "model"));
    await ensureDir(dst);
    for (const name of CATALOG_NAMES) {
      await Deno.writeTextFile(join(src, name), "live");
    }
    await Deno.writeTextFile(join(src, "model", "a.yaml"), "a");
    await Deno.writeTextFile(join(src, "model", "_catalog.db"), "nested");

    const result = await mergeDirInto(src, dst);

    assertEquals(result.moved, 1);
    assertEquals(result.skippedPaths, []);
    for (const name of CATALOG_NAMES) {
      assertEquals(await exists(join(src, name)), true, name);
      assertEquals(await exists(join(dst, name)), false, name);
    }
    assertEquals(await exists(join(src, "model")), false);
    assertEquals(await exists(join(dst, "model", "a.yaml")), true);
    assertEquals(await exists(join(dst, "model", "_catalog.db")), true);
  });
});

Deno.test("dirContents: counts top-level catalog files apart from other entries", async () => {
  await withTempDir(async (root) => {
    await ensureDir(join(root, "model"));
    await Deno.writeTextFile(join(root, "_catalog.db"), "c");
    await Deno.writeTextFile(join(root, "_catalog.db-shm"), "s");
    await Deno.writeTextFile(join(root, "other.yaml"), "o");

    assertEquals(await dirContents(root), { catalogFiles: 2, otherEntries: 2 });
    assertEquals(await dirContents(join(root, "missing")), {
      catalogFiles: 0,
      otherEntries: 0,
    });
  });
});

Deno.test("removeCatalogFiles: deletes catalog files and the directory they emptied", async () => {
  await withTempDir(async (root) => {
    const orphanDir = join(root, "ns", "data");
    const liveDir = join(root, "data");
    await ensureDir(orphanDir);
    await ensureDir(liveDir);
    for (const name of CATALOG_NAMES) {
      await Deno.writeTextFile(join(orphanDir, name), "stale");
    }
    await Deno.writeTextFile(join(liveDir, "_catalog.db"), "live");

    assertEquals(await removeCatalogFiles(orphanDir, liveDir), 4);
    assertEquals(await exists(orphanDir), false);
    assertEquals(await exists(join(liveDir, "_catalog.db")), true);
  });
});

Deno.test("removeCatalogFiles: keeps other entries and the directory holding them", async () => {
  await withTempDir(async (root) => {
    const orphanDir = join(root, "ns", "data");
    await ensureDir(join(orphanDir, "model"));
    await Deno.writeTextFile(join(orphanDir, "_catalog.db"), "stale");
    await Deno.writeTextFile(join(orphanDir, "model", "_catalog.db"), "kept");

    assertEquals(await removeCatalogFiles(orphanDir, join(root, "data")), 1);
    assertEquals(await exists(join(orphanDir, "_catalog.db")), false);
    assertEquals(await exists(join(orphanDir, "model", "_catalog.db")), true);
  });
});

Deno.test("removeCatalogFiles: never touches the live catalog directory", async () => {
  await withTempDir(async (root) => {
    const liveDir = join(root, "data");
    await ensureDir(liveDir);
    await Deno.writeTextFile(join(liveDir, "_catalog.db"), "live");
    const alias = join(root, "alias");
    await Deno.symlink(liveDir, alias, { type: "dir" });

    assertEquals(await removeCatalogFiles(liveDir, liveDir), 0);
    assertEquals(await removeCatalogFiles(alias, liveDir), 0);
    assertEquals(await removeCatalogFiles(join(liveDir, "."), liveDir), 0);
    assertEquals(await exists(join(liveDir, "_catalog.db")), true);
  });
});

Deno.test("removeCatalogFiles: a missing directory removes nothing", async () => {
  await withTempDir(async (root) => {
    assertEquals(
      await removeCatalogFiles(join(root, "ns", "data"), join(root, "data")),
      0,
    );
  });
});
