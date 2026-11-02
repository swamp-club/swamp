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
import { dirname, join } from "@std/path";
import { ensureDir } from "@std/fs";
import { PathTraversalError } from "../../infrastructure/persistence/safe_path.ts";
import {
  extensionInstall,
  type ExtensionInstallEvent,
  type InstallExtensionFn,
  needsInstallOrMigration,
  sweepLegacyPaths,
} from "./install.ts";
import { pruneOrphanFiles } from "../../infrastructure/persistence/directory_cleanup.ts";
import { readInstalledExtensionDigest } from "../../infrastructure/persistence/installed_extension_digest_reader.ts";
import { createLibSwampContext } from "../context.ts";
import type { InstallContext } from "./pull.ts";
import {
  ManagedLockfileTransaction,
  ManagedLockfileUnpublishedError,
  withManagedLockfileTransaction,
} from "./managed_lockfile_transaction.ts";
import { LockfileRepository } from "../../infrastructure/persistence/lockfile_repository.ts";
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
    await Deno.writeTextFile(lockfilePath, "{}");

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          return Promise.reject(new Error("should not be called"));
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
          return Promise.reject(
            new Error("should not be called for up-to-date"),
          );
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

Deno.test("extensionInstall: reinstalls when filesChecksum mismatches on-disk digest", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const pulledDir = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "models",
    );
    await ensureDir(pulledDir);
    await Deno.writeTextFile(join(pulledDir, "test.ts"), "// old version");

    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
    );
    const realDigest = await readInstalledExtensionDigest(extRoot);

    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "2.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@test/ext/models/test.ts"],
          filesChecksum: "a".repeat(64),
        },
      }),
    );

    if (realDigest === "a".repeat(64)) {
      throw new Error("test setup: digest should not match the fake checksum");
    }

    let installCalled = false;
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: async () => {
          installCalled = true;
          return {
            getExtension: () => Promise.resolve(null),
            downloadArchive: () => Promise.reject(new Error("test stub")),
            getChecksum: () => Promise.resolve(null),
            lockfileRepository: await LockfileRepository.create(lockfilePath),
            skillsDirs: [join(tmpDir, ".swamp/pulled-extensions/skills")],
            repoDir: tmpDir,
            force: true,
            alreadyPulled: new Set<string>(),
            depth: 0,
          };
        },
      }),
    );

    assertEquals(installCalled, true);

    const installing = events.find((e) => e.kind === "installing");
    assertEquals(installing?.kind, "installing");

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.failed, 1);
      assertEquals(completed.data.upToDate, 0);
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

Deno.test("extensionInstall: stays up_to_date when filesChecksum matches", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const pulledDir = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "models",
    );
    await ensureDir(pulledDir);
    await Deno.writeTextFile(join(pulledDir, "test.ts"), "// current version");

    const extRoot = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
    );
    const realDigest = await readInstalledExtensionDigest(extRoot);

    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          files: [".swamp/pulled-extensions/@test/ext/models/test.ts"],
          filesChecksum: realDigest,
        },
      }),
    );

    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: () => {
          return Promise.reject(
            new Error("should not be called for up-to-date"),
          );
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.upToDate, 1);
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.entries[0].status, "up_to_date");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
  }
});

for (
  const [label, digestOf] of [
    ["the digest without the nested entry", ["child"]],
    ["a legacy whole-tree digest", []],
  ] as const
) {
  Deno.test(`extensionInstall: a parent with a nested entry stays up_to_date with ${label} (swamp-club#2723)`, async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const extRoot = join(
        tmpDir,
        ".swamp",
        "pulled-extensions",
        "@test",
        "ext",
      );
      await ensureDir(join(extRoot, "models"));
      await ensureDir(join(extRoot, "child", "models"));
      await Deno.writeTextFile(join(extRoot, "models", "test.ts"), "// parent");
      await Deno.writeTextFile(
        join(extRoot, "child", "models", "c.ts"),
        "// child",
      );
      const digest = await readInstalledExtensionDigest(extRoot, {
        excludeRelDirs: [...digestOf],
      });

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/ext": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@test/ext/models/test.ts"],
            filesChecksum: digest,
          },
          "@test/ext/child": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@test/ext/child/models/c.ts"],
          },
        }),
      );

      const events = await collectEvents(
        extensionInstall(createLibSwampContext({}), {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 2);
        assertEquals(completed.data.installed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
    }
  });
}

Deno.test("extensionInstall: no filesChecksum in lockfile skips digest check (grandfather)", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const pulledDir = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "models",
    );
    await ensureDir(pulledDir);
    await Deno.writeTextFile(join(pulledDir, "test.ts"), "// old version");

    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@test/ext": {
          version: "2.0.0",
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
          return Promise.reject(
            new Error("should not be called for up-to-date"),
          );
        },
      }),
    );

    const completed = events.find((e) => e.kind === "completed");
    assertEquals(completed?.kind, "completed");
    if (completed?.kind === "completed") {
      assertEquals(completed.data.upToDate, 1);
      assertEquals(completed.data.installed, 0);
      assertEquals(completed.data.entries[0].status, "up_to_date");
    }
  } finally {
    await Deno.remove(tmpDir, { recursive: true }).catch(() => {});
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
        createInstallContext: async (_name, _version) => {
          installCalled = true;
          return {
            getExtension: () => Promise.resolve(null),
            downloadArchive: () => Promise.reject(new Error("test stub")),
            getChecksum: () => Promise.resolve(null),
            lockfileRepository: await LockfileRepository.create(lockfilePath),
            skillsDirs: [join(tmpDir, ".swamp/pulled-extensions/skills")],
            repoDir: tmpDir,
            force: true,
            alreadyPulled: new Set<string>(),
            depth: 0,
          };
        },
      }),
    );

    assertEquals(installCalled, true);

    const installing = events.find((e) => e.kind === "installing");
    assertEquals(installing?.kind, "installing");
    if (installing?.kind === "installing") {
      assertEquals(installing.name, "@test/missing");
      assertEquals(installing.version, "2.0.0");
    }

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
          return Promise.reject(new Error("should not be called"));
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
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify({
        "@fake/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00Z",
          checksum: "0".repeat(64),
          files: [".swamp/pulled-extensions/@fake/ext/models/missing.ts"],
        },
      }),
    );

    // installExtension must throw on the checksum mismatch before tar
    // extraction, so the stub's bytes never matter
    const ctx = createLibSwampContext({});
    const events = await collectEvents(
      extensionInstall(ctx, {
        lockfilePath,
        repoDir: tmpDir,
        createInstallContext: async () => ({
          getExtension: () =>
            Promise.resolve({
              name: "@fake/ext",
              description: "test",
              latestVersion: "1.0.0",
            }),
          downloadArchive: () =>
            Promise.resolve(new TextEncoder().encode("drifted content")),
          getChecksum: () => Promise.resolve(null),
          lockfileRepository: await LockfileRepository.create(lockfilePath),
          skillsDirs: ["unused"],
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

async function makeStubInstallContext(
  tmpDir: string,
  lockfilePath: string,
): Promise<InstallContext> {
  return {
    // deno-lint-ignore no-explicit-any
    getExtension: () => Promise.resolve(null as any),
    downloadArchive: () => Promise.reject(new Error("unused")),
    getChecksum: () => Promise.resolve(null),
    lockfileRepository: await LockfileRepository.create(lockfilePath),
    skillsDirs: [join(tmpDir, ".swamp/pulled-extensions/skills")],
    repoDir: tmpDir,
    force: true,
    alreadyPulled: new Set<string>(),
    depth: 0,
  };
}

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
      binaries: [],
      conflicts: [],
      missingSourceFiles: [],
      hasSkills: false,
      hasSkillScripts: false,
      skillFiles: [],
      dependencies: [],
      dependencyResults: [],
      extendsTypes: [],
      pruned: prunedPaths,
      shadowedTypes: [],
      createdPaths: [
        `.swamp/pulled-extensions/${ref.name}/models/main.ts`,
      ],
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

// a Windows lockfile stores backslash paths; on POSIX each entry is one
// filename at the repo root. writing through join(repo, entry) creates
// whichever the platform means

Deno.test("needsInstallOrMigration: backslash gen-1 path on disk returns migrate", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const entry = "extensions\\models\\legacy.ts";
    const path = join(tmpDir, entry);
    await ensureDir(dirname(path));
    await Deno.writeTextFile(path, "// legacy");

    const result = await needsInstallOrMigration([entry], tmpDir);
    assertEquals(result, "migrate");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("needsInstallOrMigration: missing backslash gen-1 path returns install", async () => {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const result = await needsInstallOrMigration(
      ["extensions\\models\\ghost.ts"],
      tmpDir,
    );
    assertEquals(result, "install");
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
});

Deno.test("needsInstallOrMigration and sweepLegacyPaths: backslash traversal entry never reaches outside the repo", async () => {
  const rootDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const repoDir = join(rootDir, "repo");
    await ensureDir(repoDir);
    const keep = join(repoDir, "keep.txt");
    await Deno.writeTextFile(keep, "keep");
    const sentinel = join(rootDir, "outside");
    await Deno.writeTextFile(sentinel, "sentinel");
    const entry = "extensions\\models\\..\\..\\..\\outside";

    if (Deno.build.os === "windows") {
      await assertRejects(
        () => needsInstallOrMigration([entry], repoDir),
        PathTraversalError,
      );
      await assertRejects(
        () => sweepLegacyPaths([entry], repoDir),
        PathTraversalError,
      );
    } else {
      assertEquals(await needsInstallOrMigration([entry], repoDir), "install");
      await sweepLegacyPaths([entry], repoDir);
    }

    assertEquals(await Deno.readTextFile(sentinel), "sentinel");
    assertEquals(await Deno.readTextFile(keep), "keep");
  } finally {
    await Deno.remove(rootDir, { recursive: true });
  }
});

Deno.test(
  "needsInstallOrMigration: skill dir under tool-specific skillsDir does not trigger migrate",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const currentPath = join(
        tmpDir,
        ".swamp/pulled-extensions/@me/ext/models/main.ts",
      );
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions/@me/ext/models"),
      );
      await Deno.writeTextFile(currentPath, "// current");

      const skillDir = join(tmpDir, ".claude/skills/foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# foo");

      const result = await needsInstallOrMigration(
        [
          ".swamp/pulled-extensions/@me/ext/models/main.ts",
          ".claude/skills/foo",
        ],
        tmpDir,
        [".claude/skills"],
      );
      assertEquals(result, "up_to_date");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "needsInstallOrMigration: skill dir at tool=none fallback does not trigger migrate",
  async () => {
    // without the skillsDir filter, a skill path is indistinguishable from a
    // gen-2 model file path
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const currentPath = join(
        tmpDir,
        ".swamp/pulled-extensions/@me/ext/models/main.ts",
      );
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions/@me/ext/models"),
      );
      await Deno.writeTextFile(currentPath, "// current");

      const skillDir = join(tmpDir, ".swamp/pulled-extensions/skills/foo");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# foo");

      const result = await needsInstallOrMigration(
        [
          ".swamp/pulled-extensions/@me/ext/models/main.ts",
          ".swamp/pulled-extensions/skills/foo",
        ],
        tmpDir,
        [".swamp/pulled-extensions/skills"],
      );
      assertEquals(result, "up_to_date");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "needsInstallOrMigration: missing skill dir still triggers install (auto-recovery)",
  async () => {
    // the skill path stat check runs before the skillsDir filter, so a missing
    // skill returns install and the next pass re-pulls it
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const currentPath = join(
        tmpDir,
        ".swamp/pulled-extensions/@me/ext/models/main.ts",
      );
      await ensureDir(
        join(tmpDir, ".swamp/pulled-extensions/@me/ext/models"),
      );
      await Deno.writeTextFile(currentPath, "// current");

      const result = await needsInstallOrMigration(
        [
          ".swamp/pulled-extensions/@me/ext/models/main.ts",
          ".claude/skills/foo",
        ],
        tmpDir,
        [".claude/skills"],
      );
      assertEquals(result, "install");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "needsInstallOrMigration: no skillsDir param still catches gen-1 paths (back-compat)",
  async () => {
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
  },
);

Deno.test(
  "extensionInstall: gen-1 entry migrates, sweeps legacy files, sets status=migrated",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
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

      const migrating = events.find((e) => e.kind === "migrating");
      assertEquals(migrating?.kind, "migrating");

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.migrated, 1);
        assertEquals(completed.data.installed, 0);
        assertEquals(completed.data.failed, 0);
        assertEquals(completed.data.entries[0].status, "migrated");
        assertEquals(completed.data.entries[0].name, "@me/daemon");
      }

      for (const file of ["daemon.ts", "helper.ts"]) {
        let exists = true;
        try {
          await Deno.stat(join(legacyDir, file));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `legacy ${file} should be swept`);
      }

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

      const stat = await Deno.stat(join(legacyDir, "legacy.ts"));
      assertEquals(stat.isFile, true);

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

function makeSuccessfulInstallWithSkill(
  tmpDir: string,
  lockfilePath: string,
  skillsDirRelative: string,
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

    const skillDirAbs = join(tmpDir, skillsDirRelative, "good-planning");
    await ensureDir(skillDirAbs);
    await Deno.writeTextFile(
      join(skillDirAbs, "SKILL.md"),
      "# good-planning",
    );

    const upstream = await readUpstreamExtensions(lockfilePath);
    upstream[ref.name] = {
      ...upstream[ref.name],
      files: [
        `.swamp/pulled-extensions/${ref.name}/models/main.ts`,
        `${skillsDirRelative}/good-planning`,
      ],
      filesChecksum: "fake-anchor",
    };
    await Deno.writeTextFile(
      lockfilePath,
      JSON.stringify(upstream, null, 2),
    );
    return undefined;
  };
}

Deno.test(
  "extensionInstall: tool=claude migration preserves the skill dir (issue #207)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      // seed the gen-2 path on disk, or needsInstallOrMigration short-circuits
      // to install
      const gen2Path = join(
        tmpDir,
        ".swamp/pulled-extensions/models/legacy.ts",
      );
      await ensureDir(join(tmpDir, ".swamp/pulled-extensions/models"));
      await Deno.writeTextFile(gen2Path, "// legacy");

      const skillDir = join(tmpDir, ".claude/skills/good-planning");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# original");

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@magistr/good-planning": {
            version: "2026.05.01.1",
            pulledAt: "2026-05-01T00:00:00Z",
            files: [
              ".swamp/pulled-extensions/models/legacy.ts",
              ".claude/skills/good-planning",
            ],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          skillsDirsRelative: [".claude/skills"],
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeSuccessfulInstallWithSkill(
            tmpDir,
            lockfilePath,
            ".claude/skills",
          ),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.migrated, 1);
        assertEquals(completed.data.entries[0].status, "migrated");
      }

      let gen2Exists = true;
      try {
        await Deno.stat(gen2Path);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) gen2Exists = false;
      }
      assertEquals(gen2Exists, false, "gen-2 path should be swept");

      const stat = await Deno.stat(skillDir);
      assertEquals(
        stat.isDirectory,
        true,
        "skill dir must survive migration",
      );
      const skillFile = await Deno.stat(join(skillDir, "SKILL.md"));
      assertEquals(skillFile.isFile, true, "SKILL.md must survive migration");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: tool=none fallback migration preserves the skill dir (issue #207)",
  async () => {
    // the tool=none fallback puts skills at a gen-2 looking path, so skillsDir
    // must be threaded into the deps
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const gen2Path = join(
        tmpDir,
        ".swamp/pulled-extensions/models/legacy.ts",
      );
      await ensureDir(join(tmpDir, ".swamp/pulled-extensions/models"));
      await Deno.writeTextFile(gen2Path, "// legacy");

      const skillDir = join(
        tmpDir,
        ".swamp/pulled-extensions/skills/good-planning",
      );
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# original");

      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@magistr/good-planning": {
            version: "2026.05.01.1",
            pulledAt: "2026-05-01T00:00:00Z",
            files: [
              ".swamp/pulled-extensions/models/legacy.ts",
              ".swamp/pulled-extensions/skills/good-planning",
            ],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          skillsDirsRelative: [".swamp/pulled-extensions/skills"],
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeSuccessfulInstallWithSkill(
            tmpDir,
            lockfilePath,
            ".swamp/pulled-extensions/skills",
          ),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.migrated, 1);
        assertEquals(completed.data.entries[0].status, "migrated");
      }

      const stat = await Deno.stat(skillDir);
      assertEquals(
        stat.isDirectory,
        true,
        "tool=none skill dir must survive migration",
      );
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

      for (const p of [gen1, gen2]) {
        let exists = true;
        try {
          await Deno.stat(p);
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `${p} should be removed`);
      }

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
  "sweepLegacyPaths: removes backslash legacy paths, leaves current-layout paths",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const gen1 = "extensions\\models\\gen1.ts";
      const gen2 = ".swamp\\pulled-extensions\\models\\gen2.ts";
      const current = ".swamp\\pulled-extensions\\@ok\\ext\\models\\current.ts";
      for (const entry of [gen1, gen2, current]) {
        const path = join(tmpDir, entry);
        await ensureDir(dirname(path));
        await Deno.writeTextFile(path, "// x");
      }

      await sweepLegacyPaths([gen1, gen2, current], tmpDir);

      for (const entry of [gen1, gen2]) {
        let exists = true;
        try {
          await Deno.stat(join(tmpDir, entry));
        } catch (e) {
          if (e instanceof Deno.errors.NotFound) exists = false;
        }
        assertEquals(exists, false, `${entry} should be removed`);
      }
      const stat = await Deno.stat(join(tmpDir, current));
      assertEquals(stat.isFile, true);
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
      // sweep removes recursively because skill-style directory entries can
      // survive into legacy lockfile state
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
  "sweepLegacyPaths: leaves tool-specific skill dir intact when skillsDir is provided",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const skillDir = join(tmpDir, ".claude/skills/good-planning");
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# good-planning");

      const gen1 = join(tmpDir, "extensions/models/legacy.ts");
      await ensureDir(join(tmpDir, "extensions/models"));
      await Deno.writeTextFile(gen1, "// legacy");

      await sweepLegacyPaths(
        ["extensions/models/legacy.ts", ".claude/skills/good-planning"],
        tmpDir,
        [".claude/skills"],
      );

      let gen1Exists = true;
      try {
        await Deno.stat(gen1);
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) gen1Exists = false;
      }
      assertEquals(gen1Exists, false, "gen-1 path should be swept");

      const stat = await Deno.stat(skillDir);
      assertEquals(stat.isDirectory, true, "skill dir should survive sweep");
      const skillFile = await Deno.stat(join(skillDir, "SKILL.md"));
      assertEquals(skillFile.isFile, true, "SKILL.md should survive sweep");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: leaves tool=none skill dir intact when skillsDir is provided",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const skillDir = join(
        tmpDir,
        ".swamp/pulled-extensions/skills/good-planning",
      );
      await ensureDir(skillDir);
      await Deno.writeTextFile(join(skillDir, "SKILL.md"), "# good-planning");

      await sweepLegacyPaths(
        [".swamp/pulled-extensions/skills/good-planning"],
        tmpDir,
        [".swamp/pulled-extensions/skills"],
      );

      const stat = await Deno.stat(skillDir);
      assertEquals(
        stat.isDirectory,
        true,
        "tool=none skill dir should survive sweep",
      );
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "sweepLegacyPaths: no skillsDir param still sweeps gen-2 dir entries (back-compat)",
  async () => {
    // skillsDir is optional and defaults to no filter, so callers that do not
    // wire it keep the recursive removal of legacy skill-style entries
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const dirPath = join(tmpDir, ".swamp/pulled-extensions/skills/foo");
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
      assertEquals(
        exists,
        false,
        "skills/foo should still be removed when skillsDir is omitted",
      );
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
      // skills are tracked as directory paths, so the diff can hand over a
      // non-empty directory; recursive remove is required
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

/**
 * omits filesChecksum so the content check stays out of the way and each test
 * exercises the version comparison alone
 */
async function seedInstalledExtension(
  tmpDir: string,
  lockfilePath: string,
  opts: { pinnedVersion: string; manifestVersion: string | null },
): Promise<void> {
  const extRoot = join(tmpDir, ".swamp", "pulled-extensions", "@test", "ext");
  await ensureDir(join(extRoot, "models"));
  await Deno.writeTextFile(join(extRoot, "models", "main.ts"), "// installed");
  if (opts.manifestVersion !== null) {
    await Deno.writeTextFile(
      join(extRoot, "manifest.yaml"),
      `name: "@test/ext"\nversion: "${opts.manifestVersion}"\n`,
    );
  }
  await Deno.writeTextFile(
    lockfilePath,
    JSON.stringify({
      "@test/ext": {
        version: opts.pinnedVersion,
        pulledAt: "2026-01-01T00:00:00Z",
        files: [".swamp/pulled-extensions/@test/ext/models/main.ts"],
      },
    }),
  );
}

Deno.test(
  "extensionInstall: re-installs when the on-disk version differs from the pin (swamp-club#2150)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await seedInstalledExtension(tmpDir, lockfilePath, {
        pinnedVersion: "1.0.0",
        manifestVersion: "2.0.0",
      });

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

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.installed, 1);
        assertEquals(completed.data.upToDate, 0);
        assertEquals(completed.data.entries[0].status, "installed");
        assertEquals(completed.data.entries[0].version, "1.0.0");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: on-disk version matching the pin stays up to date",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await seedInstalledExtension(tmpDir, lockfilePath, {
        pinnedVersion: "1.0.0",
        manifestVersion: "1.0.0",
      });

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.installed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: an extension with no manifest.yaml keeps the existing behaviour",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await seedInstalledExtension(tmpDir, lockfilePath, {
        pinnedVersion: "1.0.0",
        manifestVersion: null,
      });

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.installed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a constraint pin never triggers a version re-pull",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await seedInstalledExtension(tmpDir, lockfilePath, {
        pinnedVersion: ">=1.0.0",
        manifestVersion: "1.2.0",
      });

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.installed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: restores an entry on its lockfile channel",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/beta": {
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@test/beta/models/main.ts"],
            checksum: "beta-checksum",
            channel: "beta",
          },
          "@test/stable": {
            version: "2026.01.01.1",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@test/stable/models/main.ts"],
          },
        }),
      );

      const seen = new Map<string, InstallContext>();
      const reinstall = makeSuccessfulInstall(tmpDir, lockfilePath);
      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: (ref, installCtx) => {
            seen.set(ref.name, installCtx);
            return reinstall(ref, installCtx);
          },
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.installed, 2);
      }
      assertEquals(seen.get("@test/beta")?.channel, "beta");
      assertEquals(seen.get("@test/beta")?.expectedChecksum, "beta-checksum");
      assertEquals(seen.get("@test/stable")?.channel, undefined);
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

async function seedExtensionWithDependencies(
  tmpDir: string,
  name: string,
  dependencies: string[],
): Promise<{ version: string; pulledAt: string; files: string[] }> {
  const extRoot = join(tmpDir, ".swamp", "pulled-extensions", name);
  await ensureDir(join(extRoot, "models"));
  await Deno.writeTextFile(join(extRoot, "models", "main.ts"), "// installed");
  const depLines = dependencies.map((d) => `  - "${d}"\n`).join("");
  await Deno.writeTextFile(
    join(extRoot, "manifest.yaml"),
    `# generated header\nname: "${name}"\nversion: "1.0.0"\n` +
      (dependencies.length > 0 ? `dependencies:\n${depLines}` : ""),
  );
  return {
    version: "1.0.0",
    pulledAt: "2026-01-01T00:00:00Z",
    files: [
      `.swamp/pulled-extensions/${name}/models/main.ts`,
      `.swamp/pulled-extensions/${name}/manifest.yaml`,
    ],
  };
}

function makeInstallRecordingDependency(
  tmpDir: string,
  lockfilePath: string,
  dependency: string,
  calls: string[],
): InstallExtensionFn {
  return async (ref) => {
    calls.push(ref.name);
    const depEntry = await seedExtensionWithDependencies(
      tmpDir,
      dependency,
      [],
    );
    const upstream = await readUpstreamExtensions(lockfilePath);
    upstream[dependency] = depEntry;
    await Deno.writeTextFile(lockfilePath, JSON.stringify(upstream, null, 2));
    return undefined;
  };
}

Deno.test(
  "extensionInstall: re-pulls a parent whose declared dependency has no lockfile entry (swamp-club#2646)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/parent": await seedExtensionWithDependencies(
            tmpDir,
            "@test/parent",
            ["@test/dep"],
          ),
        }),
      );

      const calls: string[] = [];
      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeInstallRecordingDependency(
            tmpDir,
            lockfilePath,
            "@test/dep",
            calls,
          ),
        }),
      );

      assertEquals(calls, ["@test/parent"]);
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.installed, 1);
        assertEquals(completed.data.upToDate, 0);
        assertEquals(completed.data.entries[0].status, "installed");
      }
      const upstream = await readUpstreamExtensions(lockfilePath);
      assertEquals(upstream["@test/dep"]?.version, "1.0.0");
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a parent whose declared dependencies are all recorded stays up to date",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/parent": await seedExtensionWithDependencies(
            tmpDir,
            "@test/parent",
            ["@test/dep"],
          ),
          "@test/dep": await seedExtensionWithDependencies(
            tmpDir,
            "@test/dep",
            [],
          ),
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 2);
        assertEquals(completed.data.installed, 0);
        assertEquals(completed.data.failed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a constrained dependency ref is matched by name",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/parent": await seedExtensionWithDependencies(
            tmpDir,
            "@test/parent",
            ["@test/dep@^1.0.0"],
          ),
          "@test/dep": await seedExtensionWithDependencies(
            tmpDir,
            "@test/dep",
            [],
          ),
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 2);
        assertEquals(completed.data.failed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a manifest with no dependencies stays up to date",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/solo": await seedExtensionWithDependencies(
            tmpDir,
            "@test/solo",
            [],
          ),
        }),
      );

      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            Promise.reject(new Error("should not be called for up-to-date")),
        }),
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.failed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a dependency installed earlier in the same run does not re-pull a second parent",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/first": await seedExtensionWithDependencies(
            tmpDir,
            "@test/first",
            ["@test/shared"],
          ),
          "@test/second": await seedExtensionWithDependencies(
            tmpDir,
            "@test/second",
            ["@test/shared"],
          ),
        }),
      );

      const calls: string[] = [];
      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeInstallRecordingDependency(
            tmpDir,
            lockfilePath,
            "@test/shared",
            calls,
          ),
        }),
      );

      assertEquals(calls, ["@test/first"]);
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.installed, 1);
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.entries[1].name, "@test/second");
        assertEquals(completed.data.entries[1].status, "up_to_date");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: a parent written before its dependency failed is retried on the next run",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/parent": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [
              ".swamp/pulled-extensions/@test/parent/models/main.ts",
              ".swamp/pulled-extensions/@test/parent/manifest.yaml",
            ],
          },
        }),
      );

      const ctx = createLibSwampContext({});
      const first = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: async () => {
            await seedExtensionWithDependencies(tmpDir, "@test/parent", [
              "@test/dep",
            ]);
            throw new Error("simulated dependency install failure");
          },
        }),
      );
      const firstCompleted = first.find((e) => e.kind === "completed");
      assertEquals(firstCompleted?.kind, "completed");
      if (firstCompleted?.kind === "completed") {
        assertEquals(firstCompleted.data.failed, 1);
      }

      const calls: string[] = [];
      const second = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: makeInstallRecordingDependency(
            tmpDir,
            lockfilePath,
            "@test/dep",
            calls,
          ),
        }),
      );

      assertEquals(calls, ["@test/parent"]);
      const completed = second.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.installed, 1);
        assertEquals(completed.data.upToDate, 0);
        assertEquals(completed.data.failed, 0);
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: an unparsable declared dependency fails only its entry",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@test/parent": await seedExtensionWithDependencies(
            tmpDir,
            "@test/parent",
            ["acme/dep"],
          ),
          "@test/other": await seedExtensionWithDependencies(
            tmpDir,
            "@test/other",
            [],
          ),
        }),
      );

      const calls: string[] = [];
      const ctx = createLibSwampContext({});
      const events = await collectEvents(
        extensionInstall(ctx, {
          lockfilePath,
          repoDir: tmpDir,
          createInstallContext: () =>
            makeStubInstallContext(tmpDir, lockfilePath),
          installExtensionFn: (ref) => {
            calls.push(ref.name);
            return Promise.reject(
              new Error(`Invalid extension name: "acme/dep"`),
            );
          },
        }),
      );

      assertEquals(calls, ["@test/parent"]);
      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.failed, 1);
        assertEquals(completed.data.upToDate, 1);
        assertEquals(completed.data.entries[0].status, "failed");
        assertEquals(completed.data.entries[1].status, "up_to_date");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

Deno.test(
  "extensionInstall: an entry whose only failure is the lockfile publish counts as installed, then the restore rejects (swamp-club#2838)",
  async () => {
    const tmpDir = await Deno.makeTempDir({ prefix: "swamp-install-2838-" });
    try {
      const lockfilePath = join(tmpDir, "upstream_extensions.json");
      await Deno.writeTextFile(
        lockfilePath,
        JSON.stringify({
          "@me/missing": {
            version: "1.0.0",
            pulledAt: "2026-01-01T00:00:00Z",
            files: [".swamp/pulled-extensions/@me/missing/models/m.ts"],
          },
        }),
      );
      const events: ExtensionInstallEvent[] = [];

      await assertRejects(
        async () => {
          for await (
            const event of extensionInstall(createLibSwampContext({}), {
              lockfilePath,
              repoDir: tmpDir,
              createInstallContext: () =>
                makeStubInstallContext(tmpDir, lockfilePath),
              installExtensionFn: () =>
                Promise.reject(
                  new ManagedLockfileUnpublishedError(
                    new Error("push refused"),
                  ),
                ),
            })
          ) {
            events.push(event);
          }
        },
        ManagedLockfileUnpublishedError,
        "push refused",
      );

      const completed = events.find((e) => e.kind === "completed");
      assertEquals(completed?.kind, "completed");
      if (completed?.kind === "completed") {
        assertEquals(completed.data.failed, 0);
        assertEquals(completed.data.installed, 1);
        assertEquals(completed.data.entries[0].status, "installed");
      }
    } finally {
      await Deno.remove(tmpDir, { recursive: true });
    }
  },
);

async function withWindowsLockfile(
  fn: (tmpDir: string, lockfilePath: string, written: string) => Promise<void>,
): Promise<void> {
  const tmpDir = await Deno.makeTempDir({ prefix: "swamp_test_" });
  try {
    const modelsDir = join(
      tmpDir,
      ".swamp",
      "pulled-extensions",
      "@test",
      "ext",
      "models",
    );
    await ensureDir(modelsDir);
    await Deno.writeTextFile(join(modelsDir, "test.ts"), "// test");
    const lockfilePath = join(tmpDir, "upstream_extensions.json");
    const written = JSON.stringify(
      {
        "@test/ext": {
          version: "1.0.0",
          pulledAt: "2026-01-01T00:00:00.000Z",
          files: [
            ".swamp\\bundles\\2f6574ec\\test.js",
            ".swamp\\pulled-extensions\\@test\\ext\\models\\test.ts",
          ],
        },
      },
      null,
      2,
    ) + "\n";
    await Deno.writeTextFile(lockfilePath, written);
    await fn(tmpDir, lockfilePath, written);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

function installUpToDate(
  tmpDir: string,
  lockfilePath: string,
): Promise<ExtensionInstallEvent[]> {
  return collectEvents(
    extensionInstall(createLibSwampContext({}), {
      lockfilePath,
      repoDir: tmpDir,
      createInstallContext: () =>
        Promise.reject(new Error("should not be called for up-to-date")),
    }),
  );
}

Deno.test("extensionInstall: rewrites a lockfile written on Windows without reinstalling", async () => {
  await withWindowsLockfile(async (tmpDir, lockfilePath) => {
    const events = await installUpToDate(tmpDir, lockfilePath);

    const completed = events.find((e) => e.kind === "completed");
    if (completed?.kind !== "completed") throw new Error("no completed event");
    assertEquals(completed.data.upToDate, 1);
    assertEquals(completed.data.installed, 0);
    const onDisk = JSON.parse(await Deno.readTextFile(lockfilePath));
    assertEquals(onDisk, {
      "@test/ext": {
        version: "1.0.0",
        pulledAt: "2026-01-01T00:00:00.000Z",
        files: [".swamp/pulled-extensions/@test/ext/models/test.ts"],
      },
    });

    const normalized = await Deno.readTextFile(lockfilePath);
    await installUpToDate(tmpDir, lockfilePath);
    assertEquals(await Deno.readTextFile(lockfilePath), normalized);
  });
});

Deno.test("extensionInstall: leaves a managed lockfile written on Windows as it is", async () => {
  await withWindowsLockfile(async (tmpDir, lockfilePath, written) => {
    const transaction = new ManagedLockfileTransaction({
      lockfilePath,
      inRoot: (fn) => fn(),
      lock: {
        acquire: () => Promise.resolve(),
        release: () => Promise.resolve(),
      },
      sync: {
        hydrate: () => Promise.resolve(),
        publish: () => Promise.resolve(),
      },
      pending: {
        read: () => Promise.resolve({ kind: "none" }),
        write: () => Promise.resolve(),
        clear: () => Promise.resolve(),
      },
    });
    await withManagedLockfileTransaction(
      transaction,
      () => installUpToDate(tmpDir, lockfilePath),
    );
    assertEquals(await Deno.readTextFile(lockfilePath), written);
  });
});
