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
import {
  enumeratePulledDatastoreExtensionsOnDisk,
  enumeratePulledExtensionDirs,
  purgeUnchosenPulledDatastoreRows,
} from "./enumerate_pulled.ts";
import { assertPathEquals } from "../../infrastructure/persistence/path_test_helpers.ts";

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

// ── enumeratePulledDatastoreExtensionsOnDisk (swamp-club#2483) ───────────────

const MANAGED = [".swamp", "config", "pulled-extensions"];
const LEGACY = [".swamp", "pulled-extensions"];

/**
 * Writes a pulled extension root: its manifest (named `manifestName`,
 * defaulting to `name`) and, when `withDatastore`, one datastore source.
 */
async function seedExtension(
  repoDir: string,
  rootSegments: string[],
  name: string,
  opts: { withDatastore?: boolean; manifestName?: string } = {},
): Promise<string> {
  const extRoot = join(repoDir, ...rootSegments, ...name.split("/"));
  await ensureDir(join(extRoot, "datastores"));
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `manifestVersion: 1\nname: "${
      opts.manifestName ?? name
    }"\nversion: "2026.01.01.1"\n`,
  );
  if (opts.withDatastore ?? true) {
    await Deno.writeTextFile(
      join(extRoot, "datastores", "store.ts"),
      "export const datastore = {};\n",
    );
  }
  return extRoot;
}

async function withTempRepo(fn: (dir: string) => Promise<void>) {
  const dir = await Deno.makeTempDir({ prefix: "swamp_test_" });
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

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: finds a datastore extension under the managed root", async () => {
  await withTempRepo(async (repo) => {
    const extRoot = await seedExtension(repo, MANAGED, "@swamp/s3-datastore");
    const found = await enumeratePulledDatastoreExtensionsOnDisk(repo, true);
    assertEquals(found.map((f) => f.name), ["@swamp/s3-datastore"]);
    assertPathEquals(found[0].datastoresDir, join(extRoot, "datastores"));
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: finds one left under the legacy root after migrate", async () => {
  await withTempRepo(async (repo) => {
    const extRoot = await seedExtension(repo, LEGACY, "@swamp/s3-datastore");
    const found = await enumeratePulledDatastoreExtensionsOnDisk(repo, true);
    assertEquals(found.map((f) => f.name), ["@swamp/s3-datastore"]);
    assertPathEquals(found[0].pulledRoot, join(repo, ...LEGACY));
    assertPathEquals(found[0].datastoresDir, join(extRoot, "datastores"));
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: dedupes by name, preferring the managed root in managed repos", async () => {
  await withTempRepo(async (repo) => {
    const managed = await seedExtension(repo, MANAGED, "@swamp/s3-datastore");
    const legacy = await seedExtension(repo, LEGACY, "@swamp/s3-datastore");
    const preferManaged = await enumeratePulledDatastoreExtensionsOnDisk(
      repo,
      true,
    );
    assertEquals(preferManaged.length, 1);
    assertPathEquals(
      preferManaged[0].datastoresDir,
      join(managed, "datastores"),
    );
    const preferLegacy = await enumeratePulledDatastoreExtensionsOnDisk(
      repo,
      false,
    );
    assertEquals(preferLegacy.length, 1);
    assertPathEquals(preferLegacy[0].datastoresDir, join(legacy, "datastores"));
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: ignores an empty datastores dir", async () => {
  await withTempRepo(async (repo) => {
    await seedExtension(repo, MANAGED, "@swamp/aws/cur", {
      withDatastore: false,
    });
    assertEquals(
      await enumeratePulledDatastoreExtensionsOnDisk(repo, true),
      [],
    );
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: requires the manifest name to match the path", async () => {
  await withTempRepo(async (repo) => {
    await seedExtension(repo, MANAGED, "@swamp/s3-datastore", {
      manifestName: "@evil/other",
    });
    assertEquals(
      await enumeratePulledDatastoreExtensionsOnDisk(repo, true),
      [],
    );
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: ignores gen-2 flat dirs that are not @-scoped", async () => {
  await withTempRepo(async (repo) => {
    const flat = join(repo, ...LEGACY, "datastores");
    await ensureDir(flat);
    await Deno.writeTextFile(join(flat, "store.ts"), "export {};\n");
    assertEquals(
      await enumeratePulledDatastoreExtensionsOnDisk(repo, true),
      [],
    );
  });
});

Deno.test("enumeratePulledDatastoreExtensionsOnDisk: finds nested names and skips scaffold dirs", async () => {
  await withTempRepo(async (repo) => {
    await seedExtension(repo, MANAGED, "@acme/store");
    await seedExtension(repo, MANAGED, "@acme/store/extra");
    // An unrelated manifest inside a scaffold dir must not count as a root.
    await seedExtension(repo, MANAGED, "@acme/store/files");
    const found = await enumeratePulledDatastoreExtensionsOnDisk(repo, true);
    assertEquals(found.map((f) => f.name).sort(), [
      "@acme/store",
      "@acme/store/extra",
    ]);
  });
});

Deno.test("purgeUnchosenPulledDatastoreRows: removes rows of the copy that lost the dedupe", async () => {
  await withTempRepo(async (repo) => {
    const managed = await seedExtension(repo, MANAGED, "@swamp/s3-datastore");
    const legacy = await seedExtension(repo, LEGACY, "@swamp/s3-datastore");
    const chosen = await enumeratePulledDatastoreExtensionsOnDisk(repo, true);
    const rows = [
      {
        source_path: join(managed, "datastores", "store.ts"),
        state: "Indexed",
      },
      { source_path: join(legacy, "datastores", "store.ts"), state: "Indexed" },
      {
        source_path: join(legacy, "datastores", "broken.ts"),
        state: "BundleBuildFailed",
      },
      {
        source_path: join(repo, "extensions", "datastores", "local.ts"),
        state: "Indexed",
      },
    ];
    const removed: string[] = [];
    purgeUnchosenPulledDatastoreRows(
      {
        findByKind: () => rows,
        removeByRawSourcePath: (p) => removed.push(p),
      },
      repo,
      chosen,
    );
    assertEquals(removed, [join(legacy, "datastores", "store.ts")]);
  });
});

Deno.test({
  name:
    "enumeratePulledDatastoreExtensionsOnDisk: an unreadable directory does not hide other datastore extensions",
  ignore: Deno.build.os === "windows",
  fn: async () => {
    await withTempRepo(async (repo) => {
      await seedExtension(repo, MANAGED, "@swamp/s3-datastore");
      const stray = join(repo, ...LEGACY, "@stray");
      await ensureDir(stray);
      await Deno.chmod(stray, 0o000);
      try {
        const found = await enumeratePulledDatastoreExtensionsOnDisk(
          repo,
          true,
        );
        assertEquals(found.map((f) => f.name), ["@swamp/s3-datastore"]);
      } finally {
        await Deno.chmod(stray, 0o755);
      }
    });
  },
});
