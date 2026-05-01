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

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { ensureDir } from "@std/fs";
import {
  extensionInstall,
  type ExtensionInstallEvent,
  type InstallExtensionFn,
  needsInstallOrMigration,
  sweepLegacyPaths,
} from "./install.ts";
import { pruneOrphanFiles } from "../../infrastructure/persistence/directory_cleanup.ts";
import { createLibSwampContext } from "../context.ts";
import type { InstallContext } from "./pull.ts";
import { readUpstreamExtensions } from "../../infrastructure/persistence/upstream_extensions.ts";

async function collectEvents(
  gen: AsyncIterable<ExtensionInstallEvent>,
): Promise<ExtensionInstallEvent[]> {
  const events: ExtensionInstallEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

Deno.test("extensionInstall: empty lockfile yields all up to date", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    // Write empty lockfile
    await Deno.writeTextFile(lockfilePath, "{}");

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.upToDate, 0);
      assertEquals(completed.data.failed, 0);
      assertEquals(completed.data.entries, []);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: skips extensions with all files present", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Create the files on disk at the current per-extension subtree
    // layout (`.swamp/pulled-extensions/@scope/name/models/…`).
    const pulledDir = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "models",
    );
    await ensureDir(pulledDir);
    await Deno.writeTextFile(join(pulledDir, "test.ts"), "// test");

    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@test/ext/models/test.ts"],
        },
      }),
    );

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called for up-to-date");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.upToDate, 1);
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.entries[0].status, "up_to_date");
      assertEquals(completed.data.entries[0].name, "@test/ext");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: detects missing files and calls install", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/missing": {
          version: "2.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/models/missing.ts"],
        },
      }),
    );

    let installCalled = false;
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: (_name, _version) => {
          installCalled = true;
          // Return a minimal context that won't actually pull
          // (installExtension will fail, which we catch)
          return {
            getExtension: () => Promise.resolve(null),
            downloadArchive: () => Promise.reject(new Error("test stub")),
            getChecksum: () => Promise.resolve(null),
            lockfilePath,
            skillsDir: join(tmpDir, ".swamp/pulled-extensions/skills"),
            repoDir: tmpDir,
            force: true,
            alreadyPulled: new Set<string>(),
            depth: 0,
          };
        },
      }),
    );

    assertEquals(installCalled, true);

    // Should have an "installing" event
    const installing = events.find((e) => e.kind === "installing");
    assertEquals(installing?.kind, "installing");
    if (installing?.kind === "installing") {
      assertEquals(installing.name, "@test/missing");
      assertEquals(installing.version, "2.0.0");
    }

    // Install will fail since our stub rejects — that's fine, we're testing detection
    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.failed, 1);
      assertEquals(completed.data.entries[0].status, "failed");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: missing lockfile yields empty result", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const lockfilePath = join(tmpDir, "nonexistent.json");

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          throw new Error("should not be called");
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.entries.length, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("extensionInstall: lockfile-anchored checksum mismatch fails with drift message", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    // Seed a lockfile pointing at files that don't exist on disk (so
    // hasAnyMissingFiles triggers the install path) with a stored
    // checksum that will not match the "fresh download" bytes.
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@fake/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          // SHA-256 this value will never match our stub's bytes.
          checksum: "0".repeat(64),
          files: [".swamp/pulled-extensions/@fake/ext/models/missing.ts"],
        },
      }),
    );

    // Stub downloadArchive returns bytes that — when SHA-256'd — won't
    // match the stored checksum. installExtension must throw BEFORE
    // attempting tar extraction, so the nonsense bytes never matter.
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => ({
          getExtension: () =>
            Promise.resolve({
              name: "@fake/ext",
              description: "test",
              latestVersion: "1.0.0",
            }),
          downloadArchive: () =>
            Promise.resolve(new TextEncoder().encode("drifted content")),
          getChecksum: () => Promise.resolve(null),
          lockfilePath,
          skillsDir: "unused",
          repoDir: tmpDir,
          force: true,
          alreadyPulled: new Set<string>(),
          depth: 0,
        }),
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.failed, 1);
      assertEquals(completed.data.entries[0].status, "failed");
      // Error should name checksum, stored, fetched, and offer the
      // user-recovery hint (pull to accept).
      const err = completed.data.entries[0].error ?? "";
      if (!err.includes("Checksum mismatch")) {
        throw new Error(`expected drift message, got: ${err}`);
      }
      if (!err.includes("'swamp extension pull @fake/ext'")) {
        throw new Error(`expected recovery hint, got: ${err}`);
      }
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

/**
 * Minimal `InstallContext` for tests that inject a stubbed
 * `installExtensionFn`. Fields the stub reads are populated; the rest
 * are placeholders.
 */
function makeStubInstallContext(
  tmpDir: string,
  lockfilePath: string,
): InstallContext {
  return {
    // deno-lint-ignore no-explicit-any
    getExtension: () => Promise.resolve(null as any),
    downloadArchive: () => Promise.reject(new Error("unused")),
    getChecksum: () => Promise.resolve(null),
    lockfilePath,
    skillsDir: join(tmpDir, ".swamp/pulled-extensions/skills"),
    repoDir: tmpDir,
    force: true,
    alreadyPulled: new Set<string>(),
    depth: 0,
  };
}

/**
 * Returns a stub `installExtensionFn` that pretends to pull: writes a
 * single file under the per-extension subtree and updates the lockfile
 * entry to current-layout paths with a dummy `filesChecksum` anchor.
 * This is the shape real `installExtension` leaves the repo in on
 * success — simulating it here lets migrate-path tests exercise the
 * `migrated` status and sweep behavior without a real tar archive.
 */
function makeSuccessfulInstall(
  tmpDir: string,
  lockfilePath: string,
): InstallExtensionFn {
  return async (ref) => {
    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      ref.name,
      "models",
    );
    await ensureDir(extRoot);
    await Deno.writeTextFile(join(extRoot, "main.ts"), "// reinstalled");

    const upstream = await readUpstreamExtensions(lockfilePath);
    upstream[ref.name] = {
      ...upstream[ref.name],
      files: [`.swamp/pulled-extensions/${ref.name}/models/main.ts`],
      filesChecksum: "fake-anchor",
    };
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify(upstream, null, 2),
    );
    return undefined;
  };
}

function makeFailingInstall(): InstallExtensionFn {
  return () => Promise.reject(new Error("simulated download failure"));
}

/**
 * Stub that simulates a successful install AND surfaces a `pruned`
 * list on its InstallResult — the shape real `installExtension`
 * returns when prior-version files were dropped between versions.
 * Lets us verify that `extensionInstall` propagates the prune list
 * to the orphans-pruned event without needing a real archive.
 */
function makeInstallWithPruned(
  tmpDir: string,
  lockfilePath: string,
  prunedPaths: string[],
): InstallExtensionFn {
  return async (ref) => {
    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      ref.name,
      "models",
    );
    await ensureDir(extRoot);
    await Deno.writeTextFile(join(extRoot, "main.ts"), "// reinstalled");

    const upstream = await readUpstreamExtensions(lockfilePath);
    upstream[ref.name] = {
      ...upstream[ref.name],
      files: [`.swamp/pulled-extensions/${ref.name}/models/main.ts`],
      filesChecksum: "fake-anchor",
    };
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify(upstream, null, 2),
    );

    return {
      name: ref.name,
      version: "2.0.0",
      description: undefined,
      extractedFiles: [
        `.swamp/pulled-extensions/${ref.name}/models/main.ts`,
      ],
      integrityStatus: "verified",
      repository: undefined,
      platforms: [],
      safetyWarnings: [],
      conflicts: [],
      missingSourceFiles: [],
      hasSkills: false,
      hasSkillScripts: false,
      skillFiles: [],
      dependencyResults: [],
      pruned: prunedPaths,
    };
  };
}

Deno.test("needsInstallOrMigration: current layout returns up_to_date", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const path = join(
      tmpDir,
      ".swamp/pulled-extensions/@test/ext/models/main.ts",
    );
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@test/ext/models"));
    await Deno.writeTextFile(path, "// x");

    const result = await needsInstallOrMigration(
      [".swamp/pulled-extensions/@test/ext/models/main.ts"],
      tmpDir,
    );
    assertEquals(result, "up_to_date");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("needsInstallOrMigration: gen-1 path on disk returns migrate", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const path = join(tmpDir, "extensions/models/legacy.ts");
    await ensureDir(join(tmpDir, "extensions/models"));
    await Deno.writeTextFile(path, "// legacy");

    const result = await needsInstallOrMigration(
      ["extensions/models/legacy.ts"],
      tmpDir,
    );
    assertEquals(result, "migrate");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("needsInstallOrMigration: gen-2 path on disk returns migrate", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const path = join(tmpDir, ".swamp/pulled-extensions/models/flat.ts");
    await ensureDir(join(tmpDir, ".swamp/pulled-extensions/models"));
    await Deno.writeTextFile(path, "// flat");

    const result = await needsInstallOrMigration(
      [".swamp/pulled-extensions/models/flat.ts"],
      tmpDir,
    );
    assertEquals(result, "migrate");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("needsInstallOrMigration: missing file beats legacy classification", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const result = await needsInstallOrMigration(
      ["extensions/models/ghost.ts"],
      tmpDir,
    );
    assertEquals(result, "install");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test(
  "extensionInstall: gen-1 entry migrates, sweeps legacy files, sets status=migrated",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // Seed gen-1 layout: user's files live under extensions/models/
      // and the lockfile tracks them at those paths.
      const legacyDir = join(tmpDir, "extensions", "models");
      await ensureDir(legacyDir);
      await Deno.writeTextFile(
        join(legacyDir, "daemon.ts"),
        "// legacy daemon",
      );
      await Deno.writeTextFile(
        join(legacyDir, "helper.ts"),
        "// legacy helper",
      );

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@me/daemon": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [
              "extensions/models/daemon.ts",
              "extensions/models/helper.ts",
            ],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeSuccessfulInstall(tmpDir, lockfilePath),
        }),
      );

      // Event: `migrating`, not `installing` — the trigger is layout,
      // not missing files.
      const migrating = events.find((e) => e.kind === "migrating");
      assertEquals(migrating?.kind, "migrating");

      // Completion: status is `migrated` and the counter ticked up.
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.migrated, 1);
        assertEquals(completed.data.installed, 0);
        assertEquals(completed.data.failed, 0);
        assertEquals(completed.data.entries[0].status, "migrated");
        assertEquals(completed.data.entries[0].name, "@me/daemon");
      }

      // Legacy files are swept (successful install → sweep runs).
      for (const file of ["daemon.ts", "helper.ts"]) {
        let exists = true;
        try {
          await Deno.stat(join(legacyDir, file));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `legacy ${file} should be swept`);
      }

      // Lockfile now points at current-layout paths with the anchor.
      const updated = await readUpstreamExtensions(lockfilePath);
      const entry = updated["@me/daemon"];
      assertEquals(entry.filesChecksum, "fake-anchor");
      assertEquals(entry.files?.every((f) => f.startsWith(".swamp/")), true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: mixed lockfile migrates only legacy entries",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // One entry at current layout (no work needed); one at gen-1
      // (migration needed).
      const currentDir = join(
        tmpDir,
        ".swamp/pulled-extensions/@current/ext/models",
      );
      await ensureDir(currentDir);
      await Deno.writeTextFile(join(currentDir, "main.ts"), "// current");

      const legacyDir = join(tmpDir, "extensions/models");
      await ensureDir(legacyDir);
      await Deno.writeTextFile(join(legacyDir, "legacy.ts"), "// legacy");

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@current/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@current/ext/models/main.ts"],
          },
          "@legacy/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: ["extensions/models/legacy.ts"],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeSuccessfulInstall(tmpDir, lockfilePath),
        }),
      );

      // Only the legacy entry emits `migrating`.
      const migratingEvents = events.filter((e) => e.kind === "migrating");
      assertEquals(migratingEvents.length, 1);
      if (migratingEvents[0].kind === "migrating") {
        assertEquals(migratingEvents[0].name, "@legacy/ext");
      }

      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.migrated, 1);
        assertEquals(completed.data.failed, 0);
        const current = completed.data.entries.find(
          (e) => e.name === "@current/ext",
        );
        assertEquals(current?.status, "up_to_date");
        const legacy = completed.data.entries.find(
          (e) => e.name === "@legacy/ext",
        );
        assertEquals(legacy?.status, "migrated");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: install failure preserves legacy files and marks status=failed",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const legacyDir = join(tmpDir, "extensions/models");
      await ensureDir(legacyDir);
      await Deno.writeTextFile(join(legacyDir, "legacy.ts"), "// legacy");

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      const originalLockfile = JSON.stringify({
        "@me/legacy": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: ["extensions/models/legacy.ts"],
        },
      });
      await Deno.writeTextFile(lockfilePath, originalLockfile);

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeFailingInstall(),
        }),
      );

      // Legacy file preserved — sweep only runs after successful install.
      const stat = await Deno.stat(join(legacyDir, "legacy.ts"));
      assertEquals(stat.isFile, true);

      // Lockfile unchanged — the failing install did not rewrite files[].
      const postLockfile = await Deno.readTextFile(lockfilePath);
      assertEquals(postLockfile, originalLockfile);

      const completed = events.find((e) => e.kind === "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.failed, 1);
        assertEquals(completed.data.migrated, 0);
        assertEquals(completed.data.entries[0].status, "failed");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: removes gen-1 and gen-2 paths, leaves current-layout paths",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const gen1 = join(tmpDir, "extensions/models/gen1.ts");
      const gen2 = join(tmpDir, ".swamp/pulled-extensions/models/gen2.ts");
      const current = join(
        tmpDir,
        ".swamp/pulled-extensions/@ok/ext/models/current.ts",
      );
      await ensureDir(join(tmpDir, "extensions/models"));
      await ensureDir(join(tmpDir, ".swamp/pulled-extensions/models"));
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions/@ok/ext/models"),
      );
      await Deno.writeTextFile(gen1, "// gen1");
      await Deno.writeTextFile(gen2, "// gen2");
      await Deno.writeTextFile(current, "// current");

      await sweepLegacyPaths(
        [
          "extensions/models/gen1.ts",
          ".swamp/pulled-extensions/models/gen2.ts",
          ".swamp/pulled-extensions/@ok/ext/models/current.ts",
        ],
        tmpDir,
      );

      // Gen-1 and gen-2 gone.
      for (const p of [gen1, gen2]) {
        let exists = true;
        try {
          await Deno.stat(p);
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `${p} should be removed`);
      }

      // Current-layout path untouched.
      const stat = await Deno.stat(current);
      assertEquals(stat.isFile, true);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: prunes empty nested parent dirs (e.g. _lib/)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const libDir = join(tmpDir, "extensions/models/_lib");
      await ensureDir(libDir);
      await Deno.writeTextFile(join(libDir, "aws.ts"), "// lib");
      await Deno.writeTextFile(
        join(tmpDir, "extensions/models/bucket.ts"),
        "// bucket",
      );

      await sweepLegacyPaths(
        [
          "extensions/models/bucket.ts",
          "extensions/models/_lib/aws.ts",
        ],
        tmpDir,
      );

      // Both files gone AND the now-empty _lib directory is pruned.
      // Regression guard: a prior bug where a relative repoDir (".")
      // broke startsWith() in cleanupEmptyParentDirs left _lib/ stranded.
      let libExists = true;
      try {
        await Deno.stat(libDir);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) libExists = false;
      }
      assertEquals(libExists, false, "_lib/ should be pruned when empty");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: tolerates NotFound on already-deleted files",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // Path is legacy-classified but does not exist — should not throw.
      await sweepLegacyPaths(
        ["extensions/models/ghost.ts"],
        tmpDir,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: removes a non-empty directory entry recursively",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // gen-2 path — `.swamp/pulled-extensions/<known-type>/...` —
      // pointing at a non-empty directory. Plain Deno.remove fails on
      // non-empty directories; sweep must use { recursive: true } to
      // handle skill-style directory entries that survive into legacy
      // lockfile state.
      const dirPath = join(
        tmpDir,
        ".swamp/pulled-extensions/skills/foo",
      );
      await ensureDir(dirPath);
      await Deno.writeTextFile(join(dirPath, "nested.ts"), "// nested");

      await sweepLegacyPaths(
        [".swamp/pulled-extensions/skills/foo"],
        tmpDir,
      );

      let exists = true;
      try {
        await Deno.stat(dirPath);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) exists = false;
      }
      assertEquals(exists, false, "skills/foo should be removed recursively");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "pruneOrphanFiles: returns the paths actually removed (file case)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const a = join(tmpDir, ".swamp/pulled-extensions/@x/y/models/a.ts");
      const b = join(tmpDir, ".swamp/pulled-extensions/@x/y/models/b.ts");
      await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@x/y/models"));
      await Deno.writeTextFile(a, "// a");
      await Deno.writeTextFile(b, "// b");

      const removed = await pruneOrphanFiles(
        [
          ".swamp/pulled-extensions/@x/y/models/a.ts",
          ".swamp/pulled-extensions/@x/y/models/b.ts",
        ],
        tmpDir,
      );

      assertEquals(removed.length, 2);
      assertEquals(
        removed.includes(".swamp/pulled-extensions/@x/y/models/a.ts"),
        true,
      );
      assertEquals(
        removed.includes(".swamp/pulled-extensions/@x/y/models/b.ts"),
        true,
      );

      for (const p of [a, b]) {
        let exists = true;
        try {
          await Deno.stat(p);
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `${p} should be removed`);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "pruneOrphanFiles: removes a non-empty directory recursively (skill case)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // Skills are tracked as directory paths in entry.files[]; the
      // diff against extractedFiles can hand us a directory entry that
      // is non-empty. recursive:true is mandatory here.
      const skillDir = join(tmpDir, ".claude/skills/foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# foo");
      await ensureDir(join(skillDir, "scripts"));
      await Deno.writeTextFile(
        join(skillDir, "scripts", "do.sh"),
        "#!/bin/sh\n",
      );

      const removed = await pruneOrphanFiles(
        [".claude/skills/foo"],
        tmpDir,
      );

      assertEquals(removed, [".claude/skills/foo"]);

      let exists = true;
      try {
        await Deno.stat(skillDir);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) exists = false;
      }
      assertEquals(exists, false, "skill dir should be removed recursively");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "pruneOrphanFiles: NotFound paths are tolerated and NOT in the return list",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // Mix: one path exists, one does not. Ground-truth contract: the
      // NotFound path must be excluded from the returned list.
      const real = join(
        tmpDir,
        ".swamp/pulled-extensions/@x/y/models/real.ts",
      );
      await ensureDir(join(tmpDir, ".swamp/pulled-extensions/@x/y/models"));
      await Deno.writeTextFile(real, "// real");

      const removed = await pruneOrphanFiles(
        [
          ".swamp/pulled-extensions/@x/y/models/real.ts",
          ".swamp/pulled-extensions/@x/y/models/ghost.ts",
        ],
        tmpDir,
      );

      assertEquals(removed, [
        ".swamp/pulled-extensions/@x/y/models/real.ts",
      ]);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "pruneOrphanFiles: prunes empty parent directories under repoDir",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // Solo file in a nested dir — after removal, the parent should
      // also be pruned via cleanupEmptyParentDirs.
      const nestedDir = join(
        tmpDir,
        ".swamp/pulled-extensions/@x/y/models/nested",
      );
      await ensureDir(nestedDir);
      await Deno.writeTextFile(join(nestedDir, "solo.ts"), "// solo");

      await pruneOrphanFiles(
        [".swamp/pulled-extensions/@x/y/models/nested/solo.ts"],
        tmpDir,
      );

      let exists = true;
      try {
        await Deno.stat(nestedDir);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) exists = false;
      }
      assertEquals(exists, false, "empty nested/ dir should be pruned");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "pruneOrphanFiles: empty input list returns empty result",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const removed = await pruneOrphanFiles([], tmpDir);
      assertEquals(removed, []);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: orphans-pruned event fires when result.pruned is non-empty",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      // Seed the lockfile so the entry isn't up-to-date — install is
      // triggered, the stub runs, and the orphans-pruned event has data.
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@me/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [
              ".swamp/pulled-extensions/@me/ext/models/missing.ts",
            ],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeInstallWithPruned(
            tmpDir,
            lockfilePath,
            [
              ".swamp/pulled-extensions/@me/ext/models/orphan.ts",
              ".swamp/bundles/abc/orphan.js",
            ],
          ),
        }),
      );

      const orphansPruned = events.find((e) => e.kind === "orphans-pruned");
      if (orphansPruned?.kind !== "orphans-pruned") {
        throw new Error(
          `expected orphans-pruned event, got: ${
            events.map((e) => e.kind).join(", ")
          }`,
        );
      }
      assertEquals(orphansPruned.name, "@me/ext");
      assertEquals(orphansPruned.version, "1.0.0");
      assertEquals(orphansPruned.paths.length, 2);
      assertEquals(
        orphansPruned.paths.includes(
          ".swamp/pulled-extensions/@me/ext/models/orphan.ts",
        ),
        true,
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: NO orphans-pruned event when result.pruned is empty",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@me/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@me/ext/models/missing.ts"],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          // Empty pruned list — no event should fire.
          installExtensionFn: makeInstallWithPruned(tmpDir, lockfilePath, []),
        }),
      );

      const orphansPruned = events.find((e) => e.kind === "orphans-pruned");
      assertEquals(orphansPruned, undefined);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);
