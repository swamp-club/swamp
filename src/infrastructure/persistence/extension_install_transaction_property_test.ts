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

import { assert, assertEquals } from "@std/assert";
import fc from "fast-check";
import { dirname, join, relative } from "@std/path";
import { computeChecksum } from "../../domain/models/checksum.ts";
import { STAGING_DIR_NAME } from "../../domain/extensions/install_journal.ts";
import {
  defaultInstallFsOps,
  ExtensionInstallTransaction,
  type InstallFsOps,
  recoverInstallStaging,
  SimulatedInstallCrash,
} from "./extension_install_transaction.ts";

// For random old and new file sets (each root present or not, a nested
// child or not), a failure or crash at any point of the swap, and the
// lockfile write landing or not: after settle or crash recovery, the
// tree is exactly the old tree or exactly the new tree, never a mix.
// Trees are compared by their files plus which roots exist: a rolled-back
// first install may leave the empty scope dir begin() created.

const NAME = "@acme/thing";

const fileSet = fc.dictionary(
  fc.constantFrom("a.ts", "b.ts", "sub/c.ts", "sub/d.ts", "e.ts"),
  fc.string({ maxLength: 8 }),
  { maxKeys: 4 },
);

const scenario = fc.record({
  oldExt: fc.option(fileSet, { nil: null }),
  newExt: fileSet,
  oldBundle: fc.option(fileSet, { nil: null }),
  newBundle: fileSet,
  nestedChild: fc.boolean(),
  failAt: fc.integer({ min: 1, max: 6 }),
  crash: fc.boolean(),
  lockfileLanded: fc.boolean(),
});

async function writeFiles(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await Deno.mkdir(dirname(join(dir, rel)), { recursive: true });
    await Deno.writeTextFile(join(dir, rel), content);
  }
}

async function readTree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (
    const root of [
      join(".swamp", "pulled-extensions", "@acme", "thing"),
      join(".swamp", "bundles", "abcd1234"),
    ]
  ) {
    if (await defaultInstallFsOps.lstat(join(dir, root)) === "dir") {
      out[root.replaceAll("\\", "/")] = "<root>";
    }
  }
  const walk = async (current: string) => {
    for await (const entry of Deno.readDir(current)) {
      if (
        entry.name === STAGING_DIR_NAME ||
        entry.name.startsWith(".swamp-staging-")
      ) continue;
      const path = join(current, entry.name);
      const rel = relative(dir, path).replaceAll("\\", "/");
      if (entry.isDirectory) {
        await walk(path);
      } else {
        out[rel] = await Deno.readTextFile(path);
      }
    }
  };
  await walk(dir);
  return out;
}

/** The tree a plain install of the new version produces. */
async function newTreeOf(s: {
  oldExt: Record<string, string> | null;
  newExt: Record<string, string>;
  newBundle: Record<string, string>;
  nestedChild: boolean;
}): Promise<Record<string, string>> {
  const dir = await Deno.makeTempDir({ prefix: "swamp_install_prop_new_" });
  try {
    const extRoot = join(dir, ".swamp", "pulled-extensions", "@acme", "thing");
    await Deno.mkdir(join(dir, ".swamp", "bundles"), { recursive: true });
    await writeFiles(extRoot, { ...s.newExt, "manifest.yaml": "new manifest" });
    if (s.oldExt && s.nestedChild) {
      await writeFiles(join(extRoot, "child"), { "models/x.ts": "child" });
    }
    if (Object.keys(s.newBundle).length > 0) {
      await writeFiles(join(dir, ".swamp", "bundles", "abcd1234"), s.newBundle);
    }
    return await readTree(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

async function stagingLeft(pulledRoot: string): Promise<string[]> {
  try {
    return (await Array.fromAsync(
      Deno.readDir(join(pulledRoot, STAGING_DIR_NAME)),
    )).map((e) => e.name);
  } catch {
    return [];
  }
}

Deno.test("ExtensionInstallTransaction: settle and recovery leave exactly the old or the new tree", async () => {
  await fc.assert(
    fc.asyncProperty(scenario, async (s) => {
      const repoDir = await Deno.makeTempDir({ prefix: "swamp_install_prop_" });
      try {
        const pulledRoot = join(repoDir, ".swamp", "pulled-extensions");
        const bundleKindDir = join(repoDir, ".swamp", "bundles");
        const extRoot = join(pulledRoot, "@acme", "thing");
        const bundleRoot = join(bundleKindDir, "abcd1234");
        const lockfilePath = join(repoDir, "upstream_extensions.json");
        await Deno.mkdir(pulledRoot, { recursive: true });
        await Deno.mkdir(bundleKindDir, { recursive: true });

        if (s.oldExt) {
          await writeFiles(extRoot, {
            ...s.oldExt,
            "manifest.yaml": "old manifest",
          });
          if (s.nestedChild) {
            await writeFiles(join(extRoot, "child"), {
              "models/x.ts": "child",
            });
          }
        }
        if (s.oldBundle) await writeFiles(bundleRoot, s.oldBundle);
        const oldTree = await readTree(repoDir);

        let renames = 0;
        const ops: InstallFsOps = {
          ...defaultInstallFsOps,
          rename: async (from, to) => {
            renames++;
            if (renames === s.failAt) {
              throw s.crash
                ? new SimulatedInstallCrash(`rename ${renames}`)
                : new Error(`rename ${renames} failed`);
            }
            await defaultInstallFsOps.rename(from, to);
          },
        };
        const tx = await ExtensionInstallTransaction.begin({
          pulledRoot,
          extensionName: NAME,
          lockfilePath,
          newChecksum: "sum-new",
          newManifestDigest: await computeChecksum(
            new TextEncoder().encode("new manifest"),
          ),
          roots: [
            { role: "extension", live: extRoot, hasNew: true },
            {
              role: "bundle",
              live: bundleRoot,
              hasNew: Object.keys(s.newBundle).length > 0,
            },
          ],
          nestedRoots: s.oldExt && s.nestedChild
            ? [{ relDir: "child", strategy: "copied" }]
            : [],
          ops,
        });
        await writeFiles(tx.newPathOf(extRoot), s.newExt);
        if (s.oldExt && s.nestedChild) {
          await writeFiles(join(tx.newPathOf(extRoot), "child"), {
            "models/x.ts": "child",
          });
        }
        if (Object.keys(s.newBundle).length > 0) {
          await writeFiles(tx.newPathOf(bundleRoot), s.newBundle);
        }
        await Deno.writeTextFile(tx.stagedManifestPath, "new manifest");

        let swapped = false;
        let failure: unknown = null;
        try {
          await tx.swap();
          swapped = true;
        } catch (error) {
          failure = error;
        }
        // A failure after the swap (the lockfile write or a dependency)
        // when the swap itself went through.
        const lockfileChecksum = swapped && s.lockfileLanded
          ? "sum-new"
          : "sum-old";
        await tx.settle(
          failure ??
            (s.crash
              ? new SimulatedInstallCrash("after swap")
              : new Error("later step failed")),
          () => Promise.resolve(lockfileChecksum),
        );
        await recoverInstallStaging({
          bounds: {
            pulledRoot,
            allowedLockfilePaths: [lockfilePath],
            expectedLivePaths: () => ({
              extensionRoot: extRoot,
              bundleRoots: [bundleRoot],
            }),
          },
          bundleKindDirs: [bundleKindDir],
          readLockfileChecksum: () => Promise.resolve(lockfileChecksum),
        });

        const after = await readTree(repoDir);
        if (swapped && s.lockfileLanded) {
          assertEquals(after, await newTreeOf(s));
        } else {
          assertEquals(after, oldTree);
        }
        assertEquals(await stagingLeft(pulledRoot), []);
        assert(
          !(await Array.fromAsync(Deno.readDir(bundleKindDir))).some((e) =>
            e.name.startsWith(".swamp-staging-")
          ),
        );
      } finally {
        await Deno.remove(repoDir, { recursive: true }).catch(() => {});
      }
    }),
    { numRuns: 60 },
  );
});
