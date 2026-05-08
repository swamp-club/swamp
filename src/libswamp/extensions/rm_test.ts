// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { dirname, join } from "@std/path";
import { assertErrors, collect } from "../testing.ts";
import { createLibSwampContext } from "../context.ts";
import {
  extensionRm,
  type ExtensionRmDeps,
  type ExtensionRmEvent,
  extensionRmPreview,
} from "./rm.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
import { ExtensionRepository } from "../../infrastructure/persistence/extension_repository.ts";
import { ExtensionCatalogStore } from "../../infrastructure/persistence/extension_catalog_store.ts";
import type { UpstreamExtensionsMap } from "../../infrastructure/persistence/upstream_extensions.ts";
import { UserError } from "../../domain/errors.ts";

function fakeCtx() {
  return createLibSwampContext();
}

const DEFAULT_UPSTREAM: UpstreamExtensionsMap = {
  "@test/ext": {
    version: "1.0.0",
    pulledAt: "2026-01-01T00:00:00Z",
    files: ["models/ext/model.yaml", "models/ext/model.ts"],
  },
};

/**
 * Spins up a real temp repo with a real lockfile + catalog so deps
 * exercise the W2 RemoveExtensionService path. Caller cleans up via
 * the returned `cleanup` fn.
 */
async function fakeDeps(
  overrides: Partial<ExtensionRmDeps> & {
    upstream?: UpstreamExtensionsMap;
  } = {},
): Promise<{ deps: ExtensionRmDeps; cleanup: () => Promise<void> }> {
  const { upstream, ...rest } = overrides;
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_rm_test_" });
  const lockfilePath = join(tmpDir, "upstream_extensions.json");
  const seedUpstream = upstream ?? DEFAULT_UPSTREAM;
  if (Object.keys(seedUpstream).length > 0) {
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify(seedUpstream, null, 2),
    );
  }
  const lockfileRepository = await LockfileRepository.create(lockfilePath);
  await Deno.mkdir(join(tmpDir, ".swamp"), { recursive: true });
  const catalog = new ExtensionCatalogStore(
    join(tmpDir, ".swamp", "_extension_catalog.db"),
  );
  const repository = new ExtensionRepository({
    catalog,
    lockfileRepository,
    repoRoot: tmpDir,
  });

  const cleanup = async () => {
    catalog.close();
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  };

  return {
    deps: {
      findDependents: () => Promise.resolve([]),
      lockfileRepository,
      repository,
      repoDir: tmpDir,
      ...rest,
    },
    cleanup,
  };
}

Deno.test("extensionRmPreview: returns preview for installed extension", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps();
  try {
    const preview = await extensionRmPreview(ctx, deps, {
      extensionName: "@test/ext",
    });

    assertEquals(preview.name, "@test/ext");
    assertEquals(preview.version, "1.0.0");
    assertEquals(preview.fileCount, 2);
    assertEquals(preview.dependents, []);
  } finally {
    await cleanup();
  }
});

Deno.test("extensionRmPreview: includes dependents", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps({
    findDependents: () => Promise.resolve(["@test/other"]),
  });
  try {
    const preview = await extensionRmPreview(ctx, deps, {
      extensionName: "@test/ext",
    });

    assertEquals(preview.dependents, ["@test/other"]);
  } finally {
    await cleanup();
  }
});

Deno.test("extensionRmPreview: throws not_found for missing extension", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps({ upstream: {} });
  try {
    await assertRejects(
      () => extensionRmPreview(ctx, deps, { extensionName: "@test/missing" }),
      UserError,
      "is not installed",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("extensionRmPreview: throws validation_failed when no file tracking", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps({
    upstream: {
      "@test/ext": {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00Z",
      },
    },
  });
  try {
    await assertRejects(
      () => extensionRmPreview(ctx, deps, { extensionName: "@test/ext" }),
      UserError,
      "file tracking",
    );
  } finally {
    await cleanup();
  }
});

// Note: file-deletion behaviour (filesDeleted/filesSkipped counts,
// dirsRemoved pruning) is covered by remove_extension_service_test.ts
// which exercises the real filesystem via temp-dir fixtures. This file
// retains coverage for rm.ts's wrapper-specific behaviour: event
// shape (deleting → completed → error), lockfile/preview interactions,
// and the existing #120 regression tests.

Deno.test("extensionRm: yields error for missing extension", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps({ upstream: {} });
  try {
    await assertErrors<ExtensionRmEvent>(
      extensionRm(ctx, deps, { extensionName: "@test/missing" }),
      "not_found",
    );
  } finally {
    await cleanup();
  }
});

Deno.test("extensionRm: events include deleting then completed", async () => {
  const ctx = fakeCtx();
  const { deps, cleanup } = await fakeDeps();
  try {
    const events = await collect(
      extensionRm(ctx, deps, { extensionName: "@test/ext" }),
    );

    assertEquals(events.length, 2);
    assertEquals(events[0].kind, "deleting");
    assertEquals(events[1].kind, "completed");
  } finally {
    await cleanup();
  }
});

// --- issue 120 regression coverage ---

async function seedLockfileOnDisk(
  lockfilePath: string,
  entries: Record<string, string[]>,
): Promise<void> {
  await Deno.mkdir(dirname(lockfilePath), { recursive: true });
  const map: Record<string, unknown> = {};
  for (const [name, files] of Object.entries(entries)) {
    map[name] = {
      version: "1.0.0",
      pulledAt: "2026-01-01T00:00:00Z",
      files,
    };
  }
  await Deno.writeTextFile(lockfilePath, JSON.stringify(map, null, 2));
}

async function seedFile(repoDir: string, relPath: string): Promise<void> {
  const { join } = await import("@std/path");
  const abs = join(repoDir, relPath);
  await Deno.mkdir(dirname(abs), { recursive: true });
  await Deno.writeTextFile(abs, `// seed for ${relPath}`);
}

// Regression test for plan step 15. Two sibling extensions under a
// shared scope root (@swamp/aws/ec2 + @swamp/aws/eks) must cleanly
// support removing one without destroying the other's parent. Guards
// against pruneEmptyDirs over-walking upward past a still-populated
// intermediate directory.
Deno.test("extensionRm: removing one sibling leaves the other intact under a shared scope root", async () => {
  const { createExtensionRmDeps } = await import("./rm.ts");
  const { join } = await import("@std/path");

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );

    const ec2Files = [
      ".swamp/pulled-extensions/@swamp/aws/ec2/models/instance.ts",
      ".swamp/pulled-extensions/@swamp/aws/ec2/manifest.yaml",
    ];
    const eksFiles = [
      ".swamp/pulled-extensions/@swamp/aws/eks/models/cluster.ts",
      ".swamp/pulled-extensions/@swamp/aws/eks/manifest.yaml",
    ];

    for (const f of [...ec2Files, ...eksFiles]) {
      await seedFile(tmpDir, f);
    }
    await seedLockfileOnDisk(lockfilePath, {
      "@swamp/aws/ec2": ec2Files,
      "@swamp/aws/eks": eksFiles,
    });

    const ctx = createLibSwampContext({});
    const deps = await createExtensionRmDeps(tmpDir, lockfilePath);
    const events = await collect(
      extensionRm(ctx, deps, { extensionName: "@swamp/aws/ec2" }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");

    // ec2 subtree is gone
    const ec2Root = join(tmpDir, ".swamp/pulled-extensions/@swamp/aws/ec2");
    let ec2Exists = true;
    try {
      await Deno.stat(ec2Root);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) ec2Exists = false;
      else throw err;
    }
    assertEquals(ec2Exists, false, "@swamp/aws/ec2 subtree should be removed");

    // eks subtree is intact
    const eksModel = join(
      tmpDir,
      ".swamp/pulled-extensions/@swamp/aws/eks/models/cluster.ts",
    );
    const stat = await Deno.stat(eksModel);
    assertEquals(stat.isFile, true, "@swamp/aws/eks file must remain");

    // Crucially, the shared @swamp/aws/ scope parent must survive —
    // pruneEmptyDirs walks upward but must stop when it hits a
    // non-empty directory (eks still lives there).
    const awsScope = join(tmpDir, ".swamp/pulled-extensions/@swamp/aws");
    const awsStat = await Deno.stat(awsScope);
    assertEquals(awsStat.isDirectory, true, "@swamp/aws/ must still exist");

    // Sibling eks must still appear in the lockfile; only ec2 was removed.
    const lockfileAfter = JSON.parse(
      await Deno.readTextFile(lockfilePath),
    );
    assertEquals(lockfileAfter["@swamp/aws/ec2"], undefined);
    assertEquals(
      lockfileAfter["@swamp/aws/eks"].files,
      eksFiles,
      "eks lockfile entry must be untouched",
    );
    // Close the catalog opened by createExtensionRmDeps; on Windows the
    // open DB handle blocks the recursive remove below with EBUSY.
    deps.repository.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});

// findDependents regression — issue 120's manifest.yaml colocation
// fixes the latent bug where pull.ts never extracted manifest.yaml to
// disk, so rm.ts's findDependents (which searches entry.files for a
// manifest.yaml path) could never resolve a dependency graph. After
// issue 120, each installed extension tracks its manifest in the
// lockfile's files[], and findDependents works as documented.
Deno.test("extensionRmPreview: resolves dependents via the tracked per-extension manifest.yaml", async () => {
  const { createExtensionRmDeps } = await import("./rm.ts");
  const { join } = await import("@std/path");

  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(
      tmpDir,
      "extensions",
      "models",
      "upstream_extensions.json",
    );

    const baseFiles = [
      ".swamp/pulled-extensions/@fake/base/models/thing.ts",
      ".swamp/pulled-extensions/@fake/base/manifest.yaml",
    ];
    const consumerFiles = [
      ".swamp/pulled-extensions/@fake/consumer/models/consumer.ts",
      ".swamp/pulled-extensions/@fake/consumer/manifest.yaml",
    ];

    for (const f of [...baseFiles, ...consumerFiles]) {
      await seedFile(tmpDir, f);
    }

    // Consumer's manifest declares a dependency on @fake/base. Use a
    // valid CalVer version so parseExtensionManifest accepts it.
    await Deno.writeTextFile(
      join(tmpDir, consumerFiles[1]),
      [
        "manifestVersion: 1",
        'name: "@fake/consumer"',
        'version: "2026.01.01.1"',
        "models:",
        "  - consumer.ts",
        "dependencies:",
        '  - "@fake/base"',
      ].join("\n") + "\n",
    );

    await seedLockfileOnDisk(lockfilePath, {
      "@fake/base": baseFiles,
      "@fake/consumer": consumerFiles,
    });

    const ctx = createLibSwampContext({});
    const deps = await createExtensionRmDeps(tmpDir, lockfilePath);
    const preview = await extensionRmPreview(ctx, deps, {
      extensionName: "@fake/base",
    });

    assertEquals(preview.dependents, ["@fake/consumer"]);
    // Close the catalog opened by createExtensionRmDeps; on Windows the
    // open DB handle blocks the recursive remove below with EBUSY.
    deps.repository.close();
  } finally {
    if (Deno.build.os === "windows") {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tmpDir, { recursive: true });
    }
  }
});
