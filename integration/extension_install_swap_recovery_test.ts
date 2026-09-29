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
import { ensureDir, walk } from "@std/fs";
import { dirname, join, relative } from "@std/path";
import { computeChecksum } from "../src/domain/models/checksum.ts";
import { createTarGz } from "../src/infrastructure/archive/tar_archive.ts";
import {
  defaultInstallFsOps,
  ExtensionInstallTransaction,
  type InstallFsOps,
} from "../src/infrastructure/persistence/extension_install_transaction.ts";
import {
  crashAware,
  SimulatedInstallCrash,
} from "../src/infrastructure/persistence/test_helpers/install_crash.ts";
import { readInstalledExtensionDigest } from "../src/infrastructure/persistence/installed_extension_digest_reader.ts";
import { LockfileRepository } from "../src/infrastructure/persistence/lockfile_repository.ts";
import {
  extensionInstallRoots,
  resolvePulledExtensionsRoot,
} from "../src/infrastructure/persistence/paths.ts";
import { detectLocalEditsForExtension } from "../src/libswamp/extensions/local_edits.ts";
import {
  type InstallContext,
  installExtension,
} from "../src/libswamp/extensions/pull.ts";
import { recoverPulledExtensionStaging } from "../src/libswamp/extensions/recover_staging.ts";

// swamp-club#2723: an extension install stages the new version and swaps
// it in, with a journal that makes a crash at any point recoverable.
// These tests wire the real install, transaction, lockfile and recovery
// together on a temp filesystem: a crash mid-upgrade is put right by the
// next install or by the recovery entry point, and an entry nested under
// the upgraded one survives unchanged.

const V1 = "2026.01.01.1";
const V2 = "2026.01.02.1";

async function buildArchive(
  name: string,
  version: string,
  files: Record<string, string>,
): Promise<Uint8Array> {
  const archiveDir = await Deno.makeTempDir({ prefix: "swamp_2723_arc_" });
  try {
    const extDir = join(archiveDir, "extension");
    const models = Object.keys(files)
      .filter((f) => f.startsWith("models/"))
      .map((f) => f.slice("models/".length));
    await ensureDir(extDir);
    await Deno.writeTextFile(
      join(extDir, "manifest.yaml"),
      `manifestVersion: 1\nname: "${name}"\nversion: "${version}"\n` +
        `models:\n${models.map((m) => `  - ${m}\n`).join("")}`,
    );
    for (const [rel, content] of Object.entries(files)) {
      await ensureDir(dirname(join(extDir, rel)));
      await Deno.writeTextFile(join(extDir, rel), content);
    }
    await createTarGz(extDir, join(archiveDir, "a.tar.gz"));
    return await Deno.readFile(join(archiveDir, "a.tar.gz"));
  } finally {
    await Deno.remove(archiveDir, { recursive: true }).catch(() => {});
  }
}

interface Fixture {
  repoDir: string;
  parent: string;
  child: string;
  lockfile: LockfileRepository;
  install(name: string, version: string, force?: boolean): Promise<unknown>;
}

async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const repoDir = await Deno.makeTempDir({ prefix: "swamp_2723_int_" });
  try {
    const parent = `@test/swap-${crypto.randomUUID().slice(0, 8)}`;
    const child = `${parent}/child`;
    const archives: Record<string, Uint8Array> = {
      [`${parent}@${V1}`]: await buildArchive(parent, V1, {
        "models/a.ts": "// a v1\n",
        "models/b.ts": "// b v1\n",
        "bundles/a.js": "// a bundle v1\n",
      }),
      [`${parent}@${V2}`]: await buildArchive(parent, V2, {
        "models/a.ts": "// a v2\n",
        "models/c.ts": "// c v2\n",
        "bundles/a.js": "// a bundle v2\n",
      }),
      [`${child}@${V1}`]: await buildArchive(child, V1, {
        "models/x.ts": "// x\n",
        "bundles/x.js": "// x bundle\n",
      }),
    };
    const lockfile = await LockfileRepository.create(
      join(repoDir, "extensions", "models", "upstream_extensions.json"),
    );
    const install = (name: string, version: string, force = false) => {
      const ctx: InstallContext = {
        getExtension: (n) =>
          Promise.resolve({ name: n, description: "", latestVersion: version }),
        downloadArchive: (n, v) => Promise.resolve(archives[`${n}@${v}`]),
        getChecksum: () => Promise.resolve(null),
        lockfileRepository: lockfile,
        skillsDirs: [join(repoDir, ".claude", "skills")],
        repoDir,
        force,
        alreadyPulled: new Set(),
        depth: 0,
      };
      return installExtension({ name, version }, ctx);
    };
    await fn({ repoDir, parent, child, lockfile, install });
  } finally {
    await Deno.remove(repoDir, { recursive: true }).catch(() => {});
  }
}

/** Every file under the repo (lockfile excluded) → content. */
async function tree(repoDir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const entry of walk(repoDir, { includeDirs: false })) {
    if (entry.name === "upstream_extensions.json") continue;
    out[relative(repoDir, entry.path).replaceAll("\\", "/")] = await Deno
      .readTextFile(entry.path);
  }
  return out;
}

/** Size and mtime of every file under `dir`. */
async function times(dir: string): Promise<Record<string, number | null>> {
  const out: Record<string, number | null> = {};
  for await (const entry of walk(dir, { includeDirs: false })) {
    out[relative(dir, entry.path)] = (await Deno.lstat(entry.path)).mtime
      ?.getTime() ?? null;
  }
  return out;
}

async function assertNoStaging(repoDir: string): Promise<void> {
  for await (const entry of walk(join(repoDir, ".swamp"))) {
    assert(!entry.name.startsWith(".swamp-staging"), entry.path);
  }
}

/**
 * Starts an upgrade of `name` the way applyInstall does and kills it:
 * at the `crashAt`-th rename, or (when omitted) after the swap and the
 * lockfile write, before commit.
 */
async function crashedUpgrade(
  f: Fixture,
  opts: { crashAt?: number; newChecksum?: string },
): Promise<void> {
  const roots = extensionInstallRoots(f.repoDir, f.parent);
  let renames = 0;
  const ops: InstallFsOps = crashAware({
    rename: async (from, to) => {
      if (++renames === opts.crashAt) {
        throw new SimulatedInstallCrash(`rename ${renames}`);
      }
      await defaultInstallFsOps.rename(from, to);
    },
  });
  const newChecksum = opts.newChecksum ?? "sum-crashed";
  const tx = await ExtensionInstallTransaction.begin({
    pulledRoot: resolvePulledExtensionsRoot(f.repoDir),
    extensionName: f.parent,
    lockfilePath: f.lockfile.lockfilePath,
    newChecksum,
    newManifestDigest: await computeChecksum(
      new TextEncoder().encode("half manifest\n"),
    ),
    roots: [
      { role: "extension", live: roots.extensionRoot, hasNew: true },
      ...roots.bundleRoots.map((r) => ({
        role: "bundle" as const,
        live: r.live,
        hasNew: r.sourceKind === "models",
      })),
    ],
    nestedRoots: [{ relDir: "child", strategy: "copied" }],
    ops,
  });
  const staged = tx.newPathOf(roots.extensionRoot);
  await ensureDir(join(staged, "models"));
  await Deno.writeTextFile(join(staged, "models", "half.ts"), "// half\n");
  await ensureDir(join(staged, "child"));
  await Deno.writeTextFile(tx.stagedManifestPath, "half manifest\n");
  await Deno.writeTextFile(
    join(tx.newPathOf(roots.bundleRoots[0].live), "half.js"),
    "// half bundle\n",
  );
  if (opts.crashAt !== undefined) {
    await assertRejects(() => tx.swap(), SimulatedInstallCrash);
  } else {
    await tx.swap();
    const entry = f.lockfile.getEntry(f.parent)!;
    await f.lockfile.writeEntry(f.parent, entry.version, entry.files ?? [], {
      checksum: newChecksum,
    });
  }
  await tx.settle(
    new SimulatedInstallCrash("process died"),
    () => Promise.resolve(null),
  );
}

Deno.test("swap recovery: the next install rolls back a crashed upgrade, then upgrades", async () => {
  await withFixture(async (f) => {
    await f.install(f.parent, V1);
    await f.install(f.child, V1);
    const childRoot = extensionInstallRoots(f.repoDir, f.child).extensionRoot;
    const childTimes = await times(childRoot);
    const before = await tree(f.repoDir);

    for (const crashAt of [1, 2, 3]) {
      await crashedUpgrade(f, { crashAt });
      const report = await recoverPulledExtensionStaging(f.repoDir);
      assertEquals(report.rolledBack, [f.parent], `crash at ${crashAt}`);
      assertEquals(await tree(f.repoDir), before, `crash at ${crashAt}`);
      await assertNoStaging(f.repoDir);
    }

    // A crash the next install finds and puts right before its own swap.
    await crashedUpgrade(f, { crashAt: 2 });
    await f.install(f.parent, V2, true);
    await assertNoStaging(f.repoDir);
    await f.lockfile.refresh();
    assertEquals(f.lockfile.getEntry(f.parent)?.version, V2);
    const after = await tree(f.repoDir);
    const parentRoot = extensionInstallRoots(f.repoDir, f.parent)
      .extensionRoot;
    const rel = (p: string) =>
      relative(f.repoDir, join(parentRoot, p)).replaceAll("\\", "/");
    assertEquals(after[rel("models/a.ts")], "// a v2\n");
    assertEquals(after[rel("models/c.ts")], "// c v2\n");
    assertEquals(after[rel("models/b.ts")], undefined);
    assertEquals(after[rel("models/half.ts")], undefined);

    // The nested entry is untouched, mtimes included.
    assertEquals(await times(childRoot), childTimes);
    assertEquals(after[rel("child/models/x.ts")], "// x\n");
    assertEquals(
      await detectLocalEditsForExtension(
        f.repoDir,
        f.child,
        f.lockfile.lockfilePath,
      ),
      "match",
    );
    assertEquals(
      await detectLocalEditsForExtension(
        f.repoDir,
        f.parent,
        f.lockfile.lockfilePath,
      ),
      "match",
    );
  });
});

Deno.test("swap recovery: rolls forward a crash after the lockfile write", async () => {
  await withFixture(async (f) => {
    await f.install(f.parent, V1);
    await crashedUpgrade(f, { newChecksum: "sum-crashed" });
    const report = await recoverPulledExtensionStaging(f.repoDir, {
      lockfilePaths: [f.lockfile.lockfilePath],
    });
    assertEquals(report.rolledForward, [f.parent]);
    await assertNoStaging(f.repoDir);
    const root = extensionInstallRoots(f.repoDir, f.parent).extensionRoot;
    assertEquals(
      await Deno.readTextFile(join(root, "models", "half.ts")),
      "// half\n",
    );
    assertEquals(
      await Deno.readTextFile(join(root, "manifest.yaml")),
      "half manifest\n",
    );
  });
});

Deno.test("swap recovery: a parent digest stored before nested roots were excluded still matches", async () => {
  await withFixture(async (f) => {
    await f.install(f.parent, V1);
    await f.install(f.child, V1);
    const parentRoot = extensionInstallRoots(f.repoDir, f.parent)
      .extensionRoot;
    // What an older swamp stored: the digest over the whole tree.
    const legacy = await readInstalledExtensionDigest(parentRoot);
    const entry = f.lockfile.getEntry(f.parent)!;
    await f.lockfile.writeEntry(f.parent, entry.version, entry.files ?? [], {
      checksum: entry.checksum,
      filesChecksum: legacy!,
    });
    assertEquals(
      await detectLocalEditsForExtension(
        f.repoDir,
        f.parent,
        f.lockfile.lockfilePath,
      ),
      "match",
    );
    // The next install stores the digest without the child.
    await f.install(f.parent, V2, true);
    await f.lockfile.refresh();
    assertEquals(
      f.lockfile.getEntry(f.parent)?.filesChecksum,
      await readInstalledExtensionDigest(parentRoot, {
        excludeRelDirs: ["child"],
      }),
    );
  });
});
