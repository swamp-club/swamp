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
import { dirname, join, relative } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import {
  bundleStagingDirName,
  type InstallJournalBounds,
  installJournalPath,
  STAGING_DIR_NAME,
} from "../../domain/extensions/install_journal.ts";
import {
  blockingLeftJournals,
  defaultInstallFsOps,
  ExtensionInstallTransaction,
  type InstallFsOps,
  isActiveInstallOwner,
  recoverInstallStaging,
  STAGING_SWEEP_AGE_MS,
} from "./extension_install_transaction.ts";
import {
  crashAware,
  SimulatedInstallCrash,
} from "./test_helpers/install_crash.ts";

const NAME = "@acme/thing";
const MANIFEST_V1 = "name: thing\nversion: 1\n";
const MANIFEST_V2 = "name: thing\nversion: 2\n";

interface Fixture {
  repoDir: string;
  pulledRoot: string;
  bundleKindDir: string;
  extRoot: string;
  bundleRoot: string;
  lockfilePath: string;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_install_tx_" });
  try {
    const pulledRoot = join(repoDir, ".swamp", "pulled-extensions");
    const bundleKindDir = join(repoDir, ".swamp", "bundles");
    await Deno.mkdir(pulledRoot, { recursive: true });
    await Deno.mkdir(bundleKindDir, { recursive: true });
    await fn({
      repoDir,
      pulledRoot,
      bundleKindDir,
      extRoot: join(pulledRoot, "@acme", "thing"),
      bundleRoot: join(bundleKindDir, "abcd1234"),
      lockfilePath: join(repoDir, "upstream_extensions.json"),
    });
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

function boundsOf(f: Fixture): InstallJournalBounds {
  return {
    repoDir: f.repoDir,
    pulledRoot: f.pulledRoot,
    allowedLockfilePaths: [f.lockfilePath],
    expectedLivePaths: () => ({
      extensionRoot: f.extRoot,
      bundleRoots: [f.bundleRoot],
    }),
  };
}

async function writeFiles(
  dir: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), content);
  }
}

/**
 * Every file, dir and symlink under `dir` (staging excluded) → content,
 * "<dir>" or "<link target>".
 */
async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      if (
        entry.name === STAGING_DIR_NAME ||
        entry.name.startsWith(".swamp-staging-")
      ) continue;
      const path = join(current, entry.name);
      const rel = relative(dir, path).replaceAll("\\", "/");
      if (entry.isSymlink) {
        out[rel] = `<link ${await Deno.readLink(path)}>`;
      } else if (entry.isDirectory) {
        out[rel] = "<dir>";
        await walk(path);
      } else {
        out[rel] = await Deno.readTextFile(path);
      }
    }
  };
  await walk(dir);
  return out;
}

async function exists(path: string): Promise<boolean> {
  return await defaultInstallFsOps.lstat(path) !== "absent";
}

/** Resets the fixture to a plain v1 install. */
async function seedFresh(f: Fixture): Promise<void> {
  await Deno.remove(f.extRoot, { recursive: true }).catch(() => {});
  await Deno.remove(join(f.pulledRoot, STAGING_DIR_NAME), { recursive: true })
    .catch(() => {});
  for await (const entry of Deno.readDir(f.bundleKindDir)) {
    await Deno.remove(join(f.bundleKindDir, entry.name), { recursive: true });
  }
  await seedV1(f);
}

/** Installs v1 the plain way: files in place, no staging. */
async function seedV1(f: Fixture): Promise<void> {
  await writeFiles(f.extRoot, {
    "models/a.ts": "v1 a",
    "models/old_only.ts": "v1 only",
    "manifest.yaml": MANIFEST_V1,
  });
  await writeFiles(f.bundleRoot, { "a.js": "v1 bundle" });
}

async function beginV2(
  f: Fixture,
  ops: InstallFsOps = crashAware(),
  opts: { bundleHasNew?: boolean; absentBundleRoots?: string[] } = {},
): Promise<ExtensionInstallTransaction> {
  const tx = await ExtensionInstallTransaction.begin({
    repoDir: f.repoDir,
    pulledRoot: f.pulledRoot,
    extensionName: NAME,
    lockfilePath: f.lockfilePath,
    newChecksum: "sum-v2",
    newManifestDigest: await computeChecksum(
      new TextEncoder().encode(MANIFEST_V2),
    ),
    roots: [
      { role: "extension", live: f.extRoot, hasNew: true },
      { role: "bundle", live: f.bundleRoot, hasNew: opts.bundleHasNew ?? true },
      // Bundle roots neither version has; journaled all the same.
      ...(opts.absentBundleRoots ?? []).map((live) => ({
        role: "bundle" as const,
        live,
        hasNew: false,
      })),
    ],
    nestedRoots: [],
    ops,
  });
  await writeFiles(tx.newPathOf(f.extRoot), {
    "models/a.ts": "v2 a",
    "models/new_only.ts": "v2 only",
  });
  if (opts.bundleHasNew ?? true) {
    await writeFiles(tx.newPathOf(f.bundleRoot), { "a.js": "v2 bundle" });
  }
  await Deno.writeTextFile(tx.stagedManifestPath, MANIFEST_V2);
  return tx;
}

interface Call {
  op: string;
  args: string[];
}

/**
 * Wraps the real ops: records every call, asserts no rename lands on an
 * existing path, and throws `failWith` on the `failAt`-th rename.
 */
function recordingOps(
  opts: { failAt?: number; failWith?: () => Error } = {},
): {
  ops: InstallFsOps;
  calls: Call[];
  renames: () => number;
  /** Set to make every later readFile throw. */
  control: { failReads: boolean };
} {
  const calls: Call[] = [];
  const control = { failReads: false };
  let renames = 0;
  const base = defaultInstallFsOps;
  const ops: InstallFsOps = {
    lstat: (p) => {
      calls.push({ op: "lstat", args: [p] });
      return base.lstat(p);
    },
    mtime: (p) => {
      calls.push({ op: "mtime", args: [p] });
      return base.mtime(p);
    },
    rename: async (from, to) => {
      calls.push({ op: "rename", args: [from, to] });
      renames++;
      if (opts.failAt === renames) {
        throw (opts.failWith ?? (() => new Error("injected rename failure")))();
      }
      assertEquals(
        await base.lstat(to),
        "absent",
        `rename onto existing ${to}`,
      );
      await base.rename(from, to);
    },
    mkdir: (p) => {
      calls.push({ op: "mkdir", args: [p] });
      return base.mkdir(p);
    },
    remove: (p) => {
      calls.push({ op: "remove", args: [p] });
      return base.remove(p);
    },
    removeIfEmpty: (p) => {
      calls.push({ op: "removeIfEmpty", args: [p] });
      return base.removeIfEmpty(p);
    },
    writeJournal: (p, t) => {
      calls.push({ op: "writeJournal", args: [p] });
      return base.writeJournal(p, t);
    },
    readText: (p) => {
      calls.push({ op: "readText", args: [p] });
      return base.readText(p);
    },
    readFile: (p) => {
      calls.push({ op: "readFile", args: [p] });
      if (control.failReads) throw new Error("injected read failure");
      return base.readFile(p);
    },
    readDir: (p) => {
      calls.push({ op: "readDir", args: [p] });
      return base.readDir(p);
    },
    isSimulatedCrash: (error) => error instanceof SimulatedInstallCrash,
  };
  return { ops, calls, renames: () => renames, control };
}

const V2_TREE_EXT = {
  "models": "<dir>",
  "models/a.ts": "v2 a",
  "models/new_only.ts": "v2 only",
  "manifest.yaml": MANIFEST_V2,
};

Deno.test("ExtensionInstallTransaction.begin: writes the journal before any other staging dir", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops, calls } = recordingOps();
    const tx = await beginV2(f, ops);
    try {
      const firstWrite = calls.findIndex((c) => c.op === "writeJournal");
      const mkdirs = calls.filter((c) => c.op === "mkdir");
      assertEquals(mkdirs[0].args[0], dirname(tx.stagedManifestPath));
      const beforeJournal = calls.slice(0, firstWrite).filter((c) =>
        c.op === "mkdir"
      );
      assertEquals(beforeJournal.length, 1);
      assert(
        await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
      );
      assert(isActiveInstallOwner(tx.journal.ownerId));
    } finally {
      await tx.settle(new Error("test done"), () => Promise.resolve(null));
    }
  });
});

Deno.test("ExtensionInstallTransaction: a first install swaps the new roots in and commits", async () => {
  await withFixture(async (f) => {
    const tx = await beginV2(f);
    await tx.swap();
    assertEquals(tx.journal.phase, "swapped");
    await tx.commit();
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
    assertEquals(
      await exists(join(f.pulledRoot, STAGING_DIR_NAME, tx.journal.stagingId)),
      false,
    );
    assertEquals(
      await exists(
        join(f.bundleKindDir, bundleStagingDirName(tx.journal.stagingId)),
      ),
      false,
    );
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
  });
});

Deno.test("ExtensionInstallTransaction: an upgrade drops files the new version lacks", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    await writeFiles(f.extRoot, { "models/extra_by_user.ts": "mine" });
    const tx = await beginV2(f);
    await tx.swap();
    await tx.commit();
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
  });
});

Deno.test("ExtensionInstallTransaction: a bundle root the new version lacks is removed", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const tx = await beginV2(f, defaultInstallFsOps, { bundleHasNew: false });
    await tx.swap();
    await tx.commit();
    assertEquals(await exists(f.bundleRoot), false);
  });
});

Deno.test("ExtensionInstallTransaction: a failure at each rename rolls back to the exact prior tree", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    const probe = recordingOps();
    const probeTx = await beginV2(f, probe.ops);
    await probeTx.swap();
    const total = probe.renames();
    await probeTx.settle(new Error("probe"), () => Promise.resolve(null));
    assertEquals(await readTree(f.repoDir), before);

    for (let failAt = 1; failAt <= total; failAt++) {
      const { ops } = recordingOps({ failAt });
      const tx = await beginV2(f, ops);
      await assertRejects(() => tx.swap(), Error, "injected rename failure");
      await tx.settle(new Error("swap failed"), () => Promise.resolve(null));
      assertEquals(
        await readTree(f.repoDir),
        before,
        `failure at rename ${failAt}`,
      );
      assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
    }
  });
});

Deno.test("ExtensionInstallTransaction.swap: only renames and journal I/O happen inside the swap window", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops, calls } = recordingOps();
    const tx = await beginV2(f, ops);
    const start = calls.length;
    await tx.swap();
    await tx.commit();
    const swapCalls = calls.slice(start);
    const firstRename = swapCalls.findIndex((c) => c.op === "rename");
    const swappedWrite = swapCalls.findIndex((c) => c.op === "writeJournal");
    assert(firstRename >= 0 && swappedWrite > firstRename);
    const inWindow = new Set(
      swapCalls.slice(firstRename, swappedWrite + 1).map((c) => c.op),
    );
    for (const op of inWindow) {
      assert(
        ["rename", "lstat", "readText", "writeJournal"].includes(op),
        `unexpected ${op} inside the swap window`,
      );
    }
  });
});

Deno.test("ExtensionInstallTransaction.swap: moves the manifest in last", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops, calls } = recordingOps();
    const tx = await beginV2(f, ops);
    await tx.swap();
    await tx.commit();
    const renames = calls.filter((c) => c.op === "rename");
    assertEquals(renames.at(-1)?.args[1], join(f.extRoot, "manifest.yaml"));
    assertEquals(renames.at(-2)?.args[1], f.extRoot);
  });
});

Deno.test("ExtensionInstallTransaction.swap: refuses when the journal on disk has another owner", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    const tx = await beginV2(f);
    const journalPath = installJournalPath(f.pulledRoot, tx.journal.stagingId);
    const onDisk = JSON.parse(await Deno.readTextFile(journalPath));
    onDisk.ownerId = crypto.randomUUID();
    await Deno.writeTextFile(journalPath, JSON.stringify(onDisk));
    await assertRejects(() => tx.swap(), Error, "no longer owned");
    assertEquals(await readTree(f.repoDir), before);
    await tx.settle(new Error("refused"), () => Promise.resolve(null));
  });
});

/** Replaces the v1 extension root with a symlink to a dev copy of it. */
async function linkExtRoot(f: Fixture): Promise<string> {
  const target = join(f.repoDir, "elsewhere");
  await writeFiles(target, {
    "models/a.ts": "dev a",
    "manifest.yaml": MANIFEST_V1,
  });
  await Deno.remove(f.extRoot, { recursive: true }).catch(() => {});
  await Deno.mkdir(dirname(f.extRoot), { recursive: true });
  await Deno.symlink(target, f.extRoot, { type: "dir" });
  return target;
}

Deno.test("ExtensionInstallTransaction: a symlinked extension root is replaced, not written through", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const target = await linkExtRoot(f);
    const targetBefore = await readTree(target);
    const tx = await beginV2(f);
    assertEquals(tx.journal.roots[0].liveIsLink, true);
    await tx.swap();
    await tx.commit();
    assertEquals((await Deno.lstat(f.extRoot)).isDirectory, true);
    assertEquals(await readTree(f.extRoot), {
      "models": "<dir>",
      "models/a.ts": "v2 a",
      "models/new_only.ts": "v2 only",
      "manifest.yaml": MANIFEST_V2,
    });
    assertEquals(await readTree(target), targetBefore);
    assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
  });
});

Deno.test("recoverInstallStaging: puts a symlinked extension root back after a crash at every rename", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    await linkExtRoot(f);
    const before = await readTree(f.repoDir);
    for (let rename = 1; rename <= 4; rename++) {
      await crashAt(f, rename);
      const report = await recoverInstallStaging({
        bounds: boundsOf(f),
        bundleKindDirs: [f.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve("sum-v1"),
      });
      assertEquals(report.rolledBack, [NAME], `crash at rename ${rename}`);
      assertEquals(
        await readTree(f.repoDir),
        before,
        `crash at rename ${rename}`,
      );
    }
  });
});

Deno.test("ExtensionInstallTransaction.begin: refuses a bundle root that is a symlink", async () => {
  await withFixture(async (f) => {
    const target = join(f.repoDir, "elsewhere");
    await Deno.mkdir(target);
    await Deno.symlink(target, f.bundleRoot, { type: "dir" });
    await assertRejects(() => beginV2(f), Error, "is not a directory");
    assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
  });
});

Deno.test("ExtensionInstallTransaction.settle: a failing settle never throws, keeps the journal and releases the owner", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops, control } = recordingOps();
    const tx = await beginV2(f, ops);
    await tx.swap();
    control.failReads = true;
    await tx.settle(
      new Error("later step failed"),
      () => Promise.resolve(null),
    );
    assert(
      await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
    );
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);

    // Recovery with working ops finishes the roll-back.
    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(report.rolledBack, [NAME]);
    assertEquals((await readTree(f.extRoot))["models/old_only.ts"], "v1 only");
  });
});

Deno.test("ExtensionInstallTransaction.settle: rolls forward when the lockfile entry landed", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const tx = await beginV2(f);
    await tx.swap();
    await tx.settle(
      new Error("a dependency failed"),
      () => Promise.resolve("sum-v2"),
    );
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    assertEquals(
      await exists(join(f.pulledRoot, STAGING_DIR_NAME, tx.journal.stagingId)),
      false,
    );
  });
});

// ---- crash recovery ----

async function crashAt(f: Fixture, rename: number): Promise<string> {
  const { ops } = recordingOps({
    failAt: rename,
    failWith: () => new SimulatedInstallCrash(`rename ${rename}`),
  });
  const tx = await beginV2(f, ops);
  await assertRejects(() => tx.swap(), SimulatedInstallCrash);
  await tx.settle(
    new SimulatedInstallCrash("process died"),
    () => Promise.resolve(null),
  );
  assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
  return tx.journal.stagingId;
}

Deno.test("recoverInstallStaging: rolls back a crash at every rename", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    for (let rename = 1; rename <= 4; rename++) {
      const stagingId = await crashAt(f, rename);
      assert(await exists(installJournalPath(f.pulledRoot, stagingId)));
      const report = await recoverInstallStaging({
        bounds: boundsOf(f),
        bundleKindDirs: [f.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve("sum-v1"),
      });
      assertEquals(report.rolledBack, [NAME], `crash at rename ${rename}`);
      assertEquals(
        await readTree(f.repoDir),
        before,
        `crash at rename ${rename}`,
      );
    }
  });
});

Deno.test("recoverInstallStaging: rolls forward a swapped journal whose lockfile entry landed", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops } = recordingOps();
    const tx = await beginV2(f, ops);
    await tx.swap();
    // The process dies after the lockfile write, before commit.
    await tx.settle(
      new SimulatedInstallCrash("after lockfile"),
      () => Promise.resolve(null),
    );
    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: (path, name) => {
        assertEquals(path, f.lockfilePath);
        assertEquals(name, NAME);
        return Promise.resolve("sum-v2");
      },
    });
    assertEquals(report.rolledForward, [NAME]);
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
  });
});

Deno.test("recoverInstallStaging: rolls back a swapped journal whose lockfile entry did not land", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    const tx = await beginV2(f);
    await tx.swap();
    await tx.settle(
      new SimulatedInstallCrash("before lockfile"),
      () => Promise.resolve(null),
    );
    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve("sum-v1"),
    });
    assertEquals(report.rolledBack, [NAME]);
    assertEquals(await readTree(f.repoDir), before);
  });
});

Deno.test("recoverInstallStaging: leaves the journal of an install still running in this process", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const tx = await beginV2(f);
    try {
      const report = await recoverInstallStaging({
        bounds: boundsOf(f),
        bundleKindDirs: [f.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve(null),
      });
      assertEquals(report, {
        rolledForward: [],
        rolledBack: [],
        left: [],
        swept: [],
      });
      assert(
        await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
      );
      assert(
        await exists(
          join(f.bundleKindDir, bundleStagingDirName(tx.journal.stagingId)),
        ),
      );
    } finally {
      await tx.settle(new Error("done"), () => Promise.resolve(null));
    }
  });
});

Deno.test("recoverInstallStaging: leaves an invalid or out-of-containment journal with a report", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const stagingId = await crashAt(f, 2);
    const journalPath = installJournalPath(f.pulledRoot, stagingId);
    const journal = JSON.parse(await Deno.readTextFile(journalPath));
    journal.roots[0].old = join(f.repoDir, "src");
    await Deno.writeTextFile(journalPath, JSON.stringify(journal));

    const garbageId = crypto.randomUUID();
    await writeFiles(join(f.pulledRoot, STAGING_DIR_NAME, garbageId), {
      "journal.json": "{not json",
    });

    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(
      report.left.map((l) => l.journalPath).sort(),
      [journalPath, installJournalPath(f.pulledRoot, garbageId)].sort(),
    );
    assertEquals(
      report.left.find((l) => l.journalPath === journalPath)?.extensionName,
      NAME,
    );
    assertEquals(report.rolledBack, []);
    // The live root stays wherever the crash left it: nothing moved.
    assertEquals(await exists(f.extRoot), false);
    // The bundle staging of a known journal is never swept.
    assert(
      await exists(join(f.bundleKindDir, bundleStagingDirName(stagingId))),
    );
  });
});

Deno.test("recoverInstallStaging: leaves a journal whose lockfile is not this repository's", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const stagingId = await crashAt(f, 1);
    const report = await recoverInstallStaging({
      bounds: {
        ...boundsOf(f),
        allowedLockfilePaths: [join(f.repoDir, "other.json")],
      },
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(report.left.map((l) => l.journalPath), [
      installJournalPath(f.pulledRoot, stagingId),
    ]);
    assertEquals(blockingLeftJournals(report, NAME).length, 1);
    assertEquals(blockingLeftJournals(report, `${NAME}/child`).length, 1);
    assertEquals(blockingLeftJournals(report, "@acme/other").length, 0);
  });
});

Deno.test("recoverInstallStaging: a left journal says where the extension root's copies are", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    // Phase 1 moved the extension root aside, then the process died.
    const stagingId = await crashAt(f, 2);
    const report = await recoverInstallStaging({
      bounds: {
        ...boundsOf(f),
        allowedLockfilePaths: [join(f.repoDir, "other.json")],
      },
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(report.left.length, 1);
    assertEquals(report.left[0].extensionRoot, {
      live: f.extRoot,
      liveState: "absent",
      old: join(f.pulledRoot, STAGING_DIR_NAME, stagingId, "old", "0"),
      oldState: "dir",
    });
  });
});

Deno.test("recoverInstallStaging: rolls back an install interrupted before the repo moved", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    await crashAt(f, 2);
    assertEquals(await exists(f.extRoot), false);

    const parent = await Deno.makeTempDir({ prefix: "swamp_install_moved_" });
    try {
      const moved = join(parent, "moved");
      await Deno.rename(f.repoDir, moved);
      const m: Fixture = {
        repoDir: moved,
        pulledRoot: join(moved, relative(f.repoDir, f.pulledRoot)),
        bundleKindDir: join(moved, relative(f.repoDir, f.bundleKindDir)),
        extRoot: join(moved, relative(f.repoDir, f.extRoot)),
        bundleRoot: join(moved, relative(f.repoDir, f.bundleRoot)),
        lockfilePath: join(moved, relative(f.repoDir, f.lockfilePath)),
      };
      const report = await recoverInstallStaging({
        bounds: boundsOf(m),
        bundleKindDirs: [m.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve("sum-v1"),
      });
      assertEquals(report.left, []);
      assertEquals(report.rolledBack, [NAME]);
      assertEquals(await readTree(moved), before);
      assertEquals(await exists(join(m.pulledRoot, STAGING_DIR_NAME)), false);
    } finally {
      await Deno.remove(parent, { recursive: true }).catch(() => {});
    }
  });
});

Deno.test("recoverInstallStaging: sweeps journal-less staging only past the age threshold", async () => {
  await withFixture(async (f) => {
    const staleId = crypto.randomUUID();
    const freshId = crypto.randomUUID();
    const orphanBundleId = crypto.randomUUID();
    const staleDir = join(f.pulledRoot, STAGING_DIR_NAME, staleId);
    const freshDir = join(f.pulledRoot, STAGING_DIR_NAME, freshId);
    const staleBundle = join(
      f.bundleKindDir,
      bundleStagingDirName(orphanBundleId),
    );
    const notOurs = join(f.bundleKindDir, ".swamp-staging-not-a-uuid");
    await writeFiles(staleDir, { "new/0/models/a.ts": "x" });
    await writeFiles(freshDir, { "new/0/models/a.ts": "x" });
    await writeFiles(staleBundle, { "new/1/a.js": "x" });
    await writeFiles(notOurs, { "a.js": "x" });

    const now = Date.now();
    const old = new Date(now - STAGING_SWEEP_AGE_MS - 60_000);
    for (const dir of [staleDir, staleBundle, notOurs]) {
      await Deno.utime(dir, old, old);
    }

    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
      now: () => now,
    });
    assertEquals(report.swept.sort(), [staleDir, staleBundle].sort());
    assertEquals(await exists(staleDir), false);
    assertEquals(await exists(staleBundle), false);
    assert(await exists(freshDir));
    assert(await exists(notOurs));
  });
});

/** Real ops whose remove() dies (a simulated crash) on the nth call. */
function crashOnRemove(nth: number): InstallFsOps {
  let removes = 0;
  return crashAware({
    remove: async (path) => {
      if (++removes === nth) throw new SimulatedInstallCrash(`remove ${nth}`);
      await defaultInstallFsOps.remove(path);
    },
  });
}

Deno.test("ExtensionInstallTransaction.commit: a crash while deleting staging never rolls the install back", async () => {
  await withFixture(async (f) => {
    for (const nth of [1, 2, 3]) {
      await seedFresh(f);
      const tx = await beginV2(f, crashOnRemove(nth));
      await tx.swap();
      await tx.commit();
      assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
      const report = await recoverInstallStaging({
        bounds: boundsOf(f),
        bundleKindDirs: [f.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve("sum-v2"),
      });
      assertEquals(report.rolledBack, [], `crash at remove ${nth}`);
      assertEquals(report.left, [], `crash at remove ${nth}`);
      assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    }
  });
});

Deno.test("ExtensionInstallTransaction.settle: a crash while deleting staging after a roll-back stays recoverable", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    for (const nth of [1, 2, 3]) {
      const tx = await beginV2(f, crashOnRemove(nth));
      await tx.swap();
      await tx.settle(
        new Error("later step failed"),
        () => Promise.resolve(null),
      );
      assertEquals(await readTree(f.repoDir), before, `crash at remove ${nth}`);
      const report = await recoverInstallStaging({
        bounds: boundsOf(f),
        bundleKindDirs: [f.bundleKindDir],
        readLockfileChecksum: () => Promise.resolve(null),
      });
      assertEquals(report.left, [], `crash at remove ${nth}`);
      assertEquals(await readTree(f.repoDir), before, `crash at remove ${nth}`);
    }
  });
});

Deno.test("ExtensionInstallTransaction.begin: a crash before the new dirs exist stays recoverable", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    let mkdirs = 0;
    const ops = crashAware({
      mkdir: async (path) => {
        if (++mkdirs === 2) throw new SimulatedInstallCrash("mkdir 2");
        await defaultInstallFsOps.mkdir(path);
      },
    });
    await assertRejects(() => beginV2(f, ops), SimulatedInstallCrash);
    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(report.rolledBack, [NAME]);
    assertEquals(report.left, []);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
  });
});

Deno.test("ExtensionInstallTransaction.swap: a bundle dir recreated mid-swap is superseded", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    let rebuilt = false;
    const ops = crashAware({
      rename: async (from, to) => {
        await defaultInstallFsOps.rename(from, to);
        if (!rebuilt && from === f.bundleRoot) {
          rebuilt = true;
          // A loader outside the lock rebuilds the bundle cache dir
          // right after phase 1 moved it aside.
          await writeFiles(f.bundleRoot, { "rebuilt.js": "cache" });
        }
      },
    });
    const tx = await beginV2(f, ops);
    await tx.swap();
    await tx.commit();
    assert(rebuilt);
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
    assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
  });
});

Deno.test("ExtensionInstallTransaction.swap: an undo step that fails does not stop the others", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    let undoing = false;
    let failedUndo = false;
    const ops = crashAware({
      rename: async (from, to) => {
        // The manifest rename fails, so the swap undoes; the first undo
        // step (the extension root back to new/) fails too.
        if (to.endsWith("manifest.yaml") && from.includes(STAGING_DIR_NAME)) {
          undoing = true;
          throw new Error("manifest rename failed");
        }
        if (undoing && !failedUndo) {
          failedUndo = true;
          throw new Error("undo failed");
        }
        await defaultInstallFsOps.rename(from, to);
      },
    });
    const tx = await beginV2(f, ops);
    await assertRejects(() => tx.swap(), Error, "manifest rename failed");
    assert(failedUndo);
    // The bundle root went back even though the step before it failed.
    assertEquals(await readTree(f.bundleRoot), { "a.js": "v1 bundle" });
    await tx.settle(new Error("swap failed"), () => Promise.resolve(null));
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await exists(join(f.pulledRoot, STAGING_DIR_NAME)), false);
  });
});

Deno.test("recoverInstallStaging: leaves a journal whose staging dir is a symlink", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const stagingId = await crashAt(f, 2);
    const bundleStaging = join(
      f.bundleKindDir,
      bundleStagingDirName(stagingId),
    );
    const outside = join(f.repoDir, "outside");
    await Deno.rename(bundleStaging, outside);
    await Deno.symlink(outside, bundleStaging, { type: "dir" });

    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
    });
    assertEquals(report.rolledBack, []);
    assertEquals(report.left.length, 1);
    assert(report.left[0].reason.includes("not a plain directory"));
    // Nothing was moved through the link.
    assertEquals(await exists(join(outside, "discard")), false);
  });
});

Deno.test("recoverInstallStaging: a stale leftover that cannot be removed only warns", async () => {
  await withFixture(async (f) => {
    const staleDir = join(f.pulledRoot, STAGING_DIR_NAME, crypto.randomUUID());
    await writeFiles(staleDir, { "new/0/a.ts": "x" });
    const now = Date.now();
    const old = new Date(now - STAGING_SWEEP_AGE_MS - 60_000);
    await Deno.utime(staleDir, old, old);
    const report = await recoverInstallStaging({
      bounds: boundsOf(f),
      bundleKindDirs: [f.bundleKindDir],
      readLockfileChecksum: () => Promise.resolve(null),
      now: () => now,
      ops: crashAware({
        remove: () => Promise.reject(new Error("EPERM")),
      }),
    });
    assertEquals(report.swept, []);
    assert(await exists(staleDir));
  });
});

Deno.test({
  name:
    "ExtensionInstallTransaction: an upgrade on Windows never renames onto an existing dir",
  ignore: Deno.build.os !== "windows",
  fn: async () => {
    await withFixture(async (f) => {
      await seedV1(f);
      const tx = await beginV2(f, defaultInstallFsOps);
      await tx.swap();
      await tx.commit();
      assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
      assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
    });
  },
});

// ---- rollback and release (swamp-club#2724) ----

/**
 * A bundle root, in a second bundle kind dir, that neither v1 nor v2
 * has: the catalog save's loaders create it after the swap.
 */
function absentBundleRootOf(f: Fixture): string {
  return join(f.repoDir, ".swamp", "vault-bundles", "abcd1234");
}

/** Seeds v1 and the (empty) kind dir of the absent bundle root. */
async function seedV1WithAbsentKind(f: Fixture): Promise<void> {
  await seedV1(f);
  await Deno.mkdir(dirname(absentBundleRootOf(f)), { recursive: true });
}

/** {@link boundsOf} that also accepts the absent bundle root. */
function boundsWithAbsent(f: Fixture): InstallJournalBounds {
  return {
    ...boundsOf(f),
    expectedLivePaths: () => ({
      extensionRoot: f.extRoot,
      bundleRoots: [f.bundleRoot, absentBundleRootOf(f)],
    }),
  };
}

/** Every staging dir left: the pulled one and each bundle kind dir's. */
async function stagingLeft(f: Fixture): Promise<string[]> {
  const left: string[] = [];
  const pulledStaging = join(f.pulledRoot, STAGING_DIR_NAME);
  if (await exists(pulledStaging)) left.push(pulledStaging);
  for (const kindDir of [f.bundleKindDir, dirname(absentBundleRootOf(f))]) {
    if (!(await exists(kindDir))) continue;
    for await (const entry of Deno.readDir(kindDir)) {
      if (entry.name.startsWith(".swamp-staging-")) {
        left.push(join(kindDir, entry.name));
      }
    }
  }
  return left;
}

interface RollbackOps {
  ops: InstallFsOps;
  /** Every rename that went through once `rollingBack` was set. */
  rollbackRenames: Array<{ from: string; to: string }>;
  control: { rollingBack: boolean };
}

/**
 * Real, crash-aware ops. Once `control.rollingBack` is set, each rename
 * attempt is numbered from 1 and passed to `before` (which may throw to
 * fail or crash it) and, once it went through, to `after`.
 */
function rollbackOps(hooks: {
  before?: (n: number, from: string, to: string) => void;
  after?: (n: number, from: string, to: string) => Promise<void>;
} = {}): RollbackOps {
  const rollbackRenames: Array<{ from: string; to: string }> = [];
  const control = { rollingBack: false };
  let attempts = 0;
  const ops = crashAware({
    rename: async (from, to) => {
      if (!control.rollingBack) {
        await defaultInstallFsOps.rename(from, to);
        return;
      }
      const n = ++attempts;
      hooks.before?.(n, from, to);
      await defaultInstallFsOps.rename(from, to);
      rollbackRenames.push({ from, to });
      await hooks.after?.(n, from, to);
    },
  });
  return { ops, rollbackRenames, control };
}

function recover(
  f: Fixture,
  lockfileChecksum: string | null,
  ops?: InstallFsOps,
) {
  return recoverInstallStaging({
    bounds: boundsWithAbsent(f),
    bundleKindDirs: [f.bundleKindDir, dirname(absentBundleRootOf(f))],
    readLockfileChecksum: () => Promise.resolve(lockfileChecksum),
    ops,
  });
}

Deno.test("ExtensionInstallTransaction.rollback: restores every root to its exact prior tree after a completed swap", async () => {
  await withFixture(async (f) => {
    await seedV1WithAbsentKind(f);
    const absent = absentBundleRootOf(f);
    const before = await readTree(f.repoDir);
    const tx = await beginV2(f, crashAware(), { absentBundleRoots: [absent] });
    const absentRoot = tx.journal.roots.find((r) => r.live === absent);
    assertEquals(absentRoot?.liveExisted, false);
    assertEquals(absentRoot?.hasNew, false);
    await tx.swap();
    // The catalog save's loaders write bundles after the swap: into the
    // new bundle root, and into a root that did not exist before.
    await writeFiles(f.bundleRoot, { "loaded.js": "loader" });
    await writeFiles(absent, { "loaded.js": "loader" });

    assertEquals(await tx.rollback(), true);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await exists(absent), false);
    assertEquals(await stagingLeft(f), []);
    assertEquals(
      await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
      false,
    );
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
  });
});

Deno.test("ExtensionInstallTransaction.rollback: restores a symlinked extension root as the symlink", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const target = await linkExtRoot(f);
    const before = await readTree(f.repoDir);
    const tx = await beginV2(f);
    assertEquals(tx.journal.roots[0].liveIsLink, true);
    await tx.swap();
    assertEquals((await Deno.lstat(f.extRoot)).isDirectory, true);

    assertEquals(await tx.rollback(), true);
    assertEquals((await Deno.lstat(f.extRoot)).isSymlink, true);
    assertEquals(await Deno.readLink(f.extRoot), target);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await stagingLeft(f), []);
  });
});

Deno.test("ExtensionInstallTransaction.rollback: a second rollback, and a commit after it, do nothing", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    const { ops, calls } = recordingOps();
    const tx = await beginV2(f, ops);
    await tx.swap();
    assertEquals(await tx.rollback(), true);
    const settled = calls.length;

    assertEquals(await tx.rollback(), false);
    await tx.commit();
    assertEquals(calls.slice(settled), []);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await stagingLeft(f), []);
  });
});

Deno.test("ExtensionInstallTransaction.rollback: does nothing after commit or settle", async () => {
  await withFixture(async (f) => {
    for (const finish of ["commit", "settle"] as const) {
      await seedFresh(f);
      const { ops, calls } = recordingOps();
      const tx = await beginV2(f, ops);
      await tx.swap();
      if (finish === "commit") {
        await tx.commit();
      } else {
        await tx.settle(
          new Error("a dependency failed"),
          () => Promise.resolve("sum-v2"),
        );
      }
      const finished = calls.length;

      assertEquals(await tx.rollback(), false, finish);
      assertEquals(calls.slice(finished), [], finish);
      assertEquals(await readTree(f.extRoot), V2_TREE_EXT, finish);
      assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
      assertEquals(isActiveInstallOwner(tx.journal.ownerId), false, finish);
    }
  });
});

Deno.test("ExtensionInstallTransaction.rollback: a bundle dir recreated mid-rollback is moved to a free superseded path", async () => {
  for (const occupied of [false, true]) {
    await withFixture(async (f) => {
      await seedV1(f);
      const before = await readTree(f.repoDir);
      let swapRebuilt = false;
      let rollbackRebuilt = false;
      const { ops, rollbackRenames, control } = rollbackOps({
        after: async (_n, from) => {
          if (!rollbackRebuilt && from === f.bundleRoot) {
            // A loader outside the lock rebuilds the bundle cache dir
            // right after the rollback moved the new copy aside.
            rollbackRebuilt = true;
            await writeFiles(f.bundleRoot, { "rebuilt.js": "rollback" });
          }
        },
      });
      const swapOps: InstallFsOps = {
        ...ops,
        rename: async (from, to) => {
          await ops.rename(from, to);
          if (
            occupied && !control.rollingBack && !swapRebuilt &&
            from === f.bundleRoot
          ) {
            // Rebuilt mid-swap too, so phase 2 fills superseded/<i>.
            swapRebuilt = true;
            await writeFiles(f.bundleRoot, { "rebuilt.js": "swap" });
          }
        },
      };
      const tx = await beginV2(f, swapOps);
      const bundle = tx.journal.roots.find((r) => r.live === f.bundleRoot);
      assert(bundle);
      const superseded = join(bundle.stagingDir, "superseded");
      await tx.swap();
      if (occupied) {
        assert(swapRebuilt);
        assertEquals(
          await defaultInstallFsOps.lstat(
            join(superseded, String(bundle.index)),
          ),
          "dir",
        );
        // An earlier roll-back's slot is taken as well.
        await Deno.mkdir(join(superseded, `${bundle.index}-rollback-0`));
      }

      control.rollingBack = true;
      assertEquals(await tx.rollback(), true, `occupied: ${occupied}`);
      assert(rollbackRebuilt);
      const aside = join(
        superseded,
        `${bundle.index}-rollback-${occupied ? 1 : 0}`,
      );
      // The new copy went to discard/<i>; the rebuilt dir went to the
      // first free superseded path, never to discard/<i>.
      assertEquals(
        rollbackRenames.filter((r) => r.from === f.bundleRoot).map((r) => r.to),
        [join(bundle.stagingDir, "discard", String(bundle.index)), aside],
      );
      assertEquals(await readTree(f.repoDir), before);
      assertEquals(await stagingLeft(f), []);
      assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
    });
  }
});

Deno.test("ExtensionInstallTransaction.rollback: a state it cannot account for leaves the journal and moves nothing", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const { ops, rollbackRenames, control } = rollbackOps();
    const tx = await beginV2(f, ops);
    await tx.swap();
    const bundle = tx.journal.roots.find((r) => r.live === f.bundleRoot);
    assert(bundle);
    // discard/<i> is taken, so the new bundle root has nowhere to go.
    await Deno.mkdir(join(bundle.stagingDir, "discard", String(bundle.index)), {
      recursive: true,
    });
    const swapped = await readTree(f.repoDir);

    control.rollingBack = true;
    assertEquals(await tx.rollback(), false);
    assertEquals(rollbackRenames, []);
    assertEquals(await readTree(f.repoDir), swapped);
    assert(
      await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
    );
    assert(await exists(bundle.old));
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
  });
});

Deno.test("ExtensionInstallTransaction.rollback: a rename that fails for another reason leaves the journal, is not retried and never throws", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const before = await readTree(f.repoDir);
    let failed = 0;
    const { ops, rollbackRenames, control } = rollbackOps({
      before: (_n, from, to) => {
        // The old bundle root moving back: the hook's own root, with the
        // live path free, so only a non-occupied failure is left.
        if (to === f.bundleRoot && from.includes(".swamp-staging-")) {
          failed++;
          throw new Error("injected: device busy");
        }
      },
    });
    const tx = await beginV2(f, ops);
    await tx.swap();

    control.rollingBack = true;
    assertEquals(await tx.rollback(), false);
    assertEquals(failed, 1);
    assert(!rollbackRenames.some((r) => r.to.includes("superseded")));
    assert(
      await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
    );
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);

    // Recovery with working ops finishes the roll-back.
    const report = await recover(f, "sum-v1");
    assertEquals(report.rolledBack, [NAME]);
    assertEquals(report.left, []);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await stagingLeft(f), []);
  });
});

Deno.test("ExtensionInstallTransaction.release: leaves the journal, releases the owner, and recovery settles by the lockfile entry", async () => {
  const cases = [
    { swap: true, lockfile: "sum-v2", forward: true },
    { swap: true, lockfile: "sum-v1", forward: false },
    { swap: true, lockfile: null, forward: false },
    // Not swapped: back even when the entry names this install.
    { swap: false, lockfile: "sum-v2", forward: false },
  ];
  for (const c of cases) {
    await withFixture(async (f) => {
      const label = JSON.stringify(c);
      await seedV1WithAbsentKind(f);
      const absent = absentBundleRootOf(f);
      const before = await readTree(f.repoDir);
      const tx = await beginV2(f, crashAware(), {
        absentBundleRoots: [absent],
      });
      if (c.swap) {
        await tx.swap();
        await writeFiles(absent, { "loaded.js": "loader" });
      }
      const afterSwap = await readTree(f.repoDir);

      tx.release();
      const journalPath = installJournalPath(
        f.pulledRoot,
        tx.journal.stagingId,
      );
      assert(await exists(journalPath), label);
      assertEquals(isActiveInstallOwner(tx.journal.ownerId), false, label);
      assertEquals(await readTree(f.repoDir), afterSwap, label);
      // Released: a rollback no longer acts.
      assertEquals(await tx.rollback(), false, label);
      assert(await exists(journalPath), label);

      const report = await recover(f, c.lockfile);
      assertEquals(report.left, [], label);
      if (c.forward) {
        assertEquals(report.rolledForward, [NAME], label);
        assertEquals(await readTree(f.extRoot), V2_TREE_EXT, label);
        assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
        assertEquals(await readTree(absent), { "loaded.js": "loader" });
      } else {
        assertEquals(report.rolledBack, [NAME], label);
        assertEquals(await readTree(f.repoDir), before, label);
      }
      assertEquals(await exists(journalPath), false, label);
      assertEquals(await stagingLeft(f), [], label);
    });
  }
});

Deno.test("recoverInstallStaging: finds nothing to do after a committed install", async () => {
  await withFixture(async (f) => {
    await seedV1(f);
    const tx = await beginV2(f);
    await tx.swap();
    await tx.commit();
    const { ops, calls } = recordingOps();
    const report = await recover(f, "sum-v2", ops);
    assertEquals(report, {
      rolledForward: [],
      rolledBack: [],
      left: [],
      swept: [],
    });
    assertEquals(calls.filter((c) => c.op === "rename"), []);
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
  });
});

Deno.test("recoverInstallStaging: a rollback that crashed before deleting its staging needs no renames", async () => {
  await withFixture(async (f) => {
    await seedV1WithAbsentKind(f);
    const absent = absentBundleRootOf(f);
    const before = await readTree(f.repoDir);
    let removes = 0;
    const ops = crashAware({
      remove: async (path) => {
        // The first remove is the journal's, at the start of the staging
        // delete: the process dies there.
        if (++removes === 1) throw new SimulatedInstallCrash("remove 1");
        await defaultInstallFsOps.remove(path);
      },
    });
    const tx = await beginV2(f, ops, { absentBundleRoots: [absent] });
    await tx.swap();
    await writeFiles(absent, { "loaded.js": "loader" });

    assertEquals(await tx.rollback(), false);
    assertEquals(removes, 1);
    const journalPath = installJournalPath(f.pulledRoot, tx.journal.stagingId);
    assert(await exists(journalPath));
    assertEquals(isActiveInstallOwner(tx.journal.ownerId), false);
    // The originals are already live.
    assertEquals(await readTree(f.repoDir), before);

    const recording = recordingOps();
    const report = await recover(f, "sum-v1", recording.ops);
    assertEquals(report.left, []);
    assertEquals(report.rolledBack, [NAME]);
    assertEquals(recording.calls.filter((c) => c.op === "rename"), []);
    assertEquals(await readTree(f.repoDir), before);
    assertEquals(await exists(journalPath), false);
    assertEquals(await stagingLeft(f), []);
  });
});

Deno.test("recoverInstallStaging: puts the prior tree back after a crash at every rollback rename", async () => {
  await withFixture(async (f) => {
    await seedV1WithAbsentKind(f);
    const absent = absentBundleRootOf(f);
    const before = await readTree(f.repoDir);

    // How many renames a rollback of this install makes.
    const probe = rollbackOps();
    const probeTx = await beginV2(f, probe.ops, {
      absentBundleRoots: [absent],
    });
    await probeTx.swap();
    await writeFiles(absent, { "loaded.js": "loader" });
    probe.control.rollingBack = true;
    assertEquals(await probeTx.rollback(), true);
    const total = probe.rollbackRenames.length;
    // ext and bundle root: live -> discard, old -> live; absent: live -> discard.
    assertEquals(total, 5);
    assertEquals(await readTree(f.repoDir), before);

    for (let crashAt = 1; crashAt <= total; crashAt++) {
      const label = `crash at rollback rename ${crashAt}`;
      const { ops, control } = rollbackOps({
        before: (n) => {
          if (n === crashAt) {
            throw new SimulatedInstallCrash(`rollback rename ${n}`);
          }
        },
      });
      const tx = await beginV2(f, ops, { absentBundleRoots: [absent] });
      await tx.swap();
      await writeFiles(absent, { "loaded.js": "loader" });
      control.rollingBack = true;
      // The caller restored the lockfile entry before rolling back.
      assertEquals(await tx.rollback(), false, label);
      assert(
        await exists(installJournalPath(f.pulledRoot, tx.journal.stagingId)),
        label,
      );
      assertEquals(isActiveInstallOwner(tx.journal.ownerId), false, label);

      const report = await recover(f, "sum-v1");
      assertEquals(report.left, [], label);
      assertEquals(report.rolledBack, [NAME], label);
      assertEquals(await readTree(f.repoDir), before, label);
      assertEquals(await stagingLeft(f), [], label);
    }
  });
});

Deno.test("recoverInstallStaging: rolls forward a swapped install with a loader-filled absent bundle root when the handle was held", async () => {
  await withFixture(async (f) => {
    await seedV1WithAbsentKind(f);
    const absent = absentBundleRootOf(f);
    const tx = await beginV2(f, crashAware(), { absentBundleRoots: [absent] });
    await tx.swap();
    await writeFiles(absent, { "loaded.js": "loader" });
    // The process dies while the caller still holds the transaction,
    // after the lockfile entry landed.
    await tx.settle(
      new SimulatedInstallCrash("holding the handle"),
      () => Promise.resolve(null),
    );
    const journalPath = installJournalPath(f.pulledRoot, tx.journal.stagingId);
    assert(await exists(journalPath));
    assertEquals(tx.journal.phase, "swapped");

    const report = await recover(f, "sum-v2");
    assertEquals(report.left, []);
    assertEquals(blockingLeftJournals(report, NAME), []);
    assertEquals(report.rolledForward, [NAME]);
    assertEquals(await readTree(f.extRoot), V2_TREE_EXT);
    assertEquals(await readTree(f.bundleRoot), { "a.js": "v2 bundle" });
    assertEquals(await readTree(absent), { "loaded.js": "loader" });
    assertEquals(await exists(journalPath), false);
    assertEquals(await stagingLeft(f), []);
  });
});
