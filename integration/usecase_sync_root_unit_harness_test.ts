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

// Self-test for the root-unit checks in usecase_sync_fixtures.ts
// (swamp-club#3032). No characterization row runs in a root unit yet, so
// these drive a synthetic composition through the same checks, under a CLI
// lock and under serve's sync gate, and show each check fails when what it
// guards breaks.

import { join } from "@std/path";
import { assertEquals, AssertionError, assertThrows } from "@std/assert";
import { isCustomDatastoreConfig } from "../src/domain/datastore/datastore_config.ts";
import { resolveCustomProvider } from "../src/infrastructure/persistence/datastore_global_lock.ts";
import {
  type RootUnitOfWork,
  runInRootUnitOfWork,
} from "../src/infrastructure/persistence/repo_unit_of_work.ts";
import {
  assertRootUnit,
  baseline,
  cacheDir,
  type CapturedUnit,
  captureUnits,
  type Composition,
  type Observation,
  observe,
  ObservedSyncGate,
  type RowRepos,
  syncOrder,
  withRowRepos,
} from "./usecase_sync_fixtures.ts";

interface Run {
  units: CapturedUnit[];
  observation: Observation;
  order: string[];
}

/**
 * Writes one file in A's cache and marks it through the root, then ends the
 * root, whose flush pushes and releases the lock or gate it holds (or, with
 * `pushAfterRelease`, releases first). `markOutside` also marks a second
 * file straight through the hook after the root ended.
 */
async function runSynthetic(
  repos: RowRepos,
  composition: Composition,
  options: { pushAfterRelease?: boolean; markOutside?: boolean } = {},
): Promise<Run> {
  const config = repos.a.datastoreConfig;
  if (!isCustomDatastoreConfig(config)) {
    throw new Error("row repos use a custom datastore type");
  }
  const gate = new ObservedSyncGate(repos);
  const hold = async (): Promise<() => Promise<void>> => {
    if (composition === "serve") {
      await gate.acquire();
      return () => {
        gate.release();
        return Promise.resolve();
      };
    }
    const lock = (await resolveCustomProvider(config)).createLock(
      config.datastorePath,
    );
    await lock.acquire();
    return () => lock.release();
  };
  const markDirty = repos.a.repoContext.markDirty!;
  const base = baseline(repos);
  const units = await captureUnits(async () => {
    const release = await hold();
    const push = () => repos.a.syncService!.pushChanged();
    await runInRootUnitOfWork(repos.a.repoContext, {
      flush: async () => {
        if (options.pushAfterRelease) {
          await release();
          await push();
        } else {
          await push();
          await release();
        }
      },
    }, async (root: RootUnitOfWork) => {
      const path = join(cacheDir(repos.repoA), "data", "synthetic.txt");
      await root.stage({ kind: "write", path });
      await Deno.mkdir(join(cacheDir(repos.repoA), "data"), {
        recursive: true,
      });
      await Deno.writeTextFile(path, "synthetic");
    });
    if (options.markOutside) {
      const outside = join(cacheDir(repos.repoA), "data", "outside.txt");
      await markDirty(outside);
      await Deno.writeTextFile(outside, "outside");
    }
  });
  return {
    units,
    observation: observe(repos, base),
    order: syncOrder(repos, base),
  };
}

const PINNED_ORDER = ["push", "release"];

for (const composition of ["cli", "serve"] as const) {
  const row = (order: string[]) => ({
    name: `synthetic root row`,
    syncOrder: { [composition]: order },
  });

  Deno.test(`usecase sync harness: a ${composition} root row passes when the root staged every mark and pushes stay put`, async () => {
    await withRowRepos({}, async (repos) => {
      const run = await runSynthetic(repos, composition);
      assertEquals(run.order, PINNED_ORDER);
      assertRootUnit(
        row(PINNED_ORDER),
        composition,
        repos,
        run.units,
        run.observation,
        run.order,
      );
    });
  });

  Deno.test(`usecase sync harness: a ${composition} root row fails when a push moves across the release`, async () => {
    await withRowRepos({}, async (repos) => {
      const run = await runSynthetic(repos, composition, {
        pushAfterRelease: true,
      });
      assertThrows(
        () =>
          assertRootUnit(
            row(PINNED_ORDER),
            composition,
            repos,
            run.units,
            run.observation,
            run.order,
          ),
        AssertionError,
        "pushes moved relative to lock release or gate exit",
      );
    });
  });

  Deno.test(`usecase sync harness: a ${composition} root row fails when a mark bypassed the root`, async () => {
    await withRowRepos({}, async (repos) => {
      const run = await runSynthetic(repos, composition, {
        markOutside: true,
      });
      assertThrows(
        () =>
          assertRootUnit(
            row(PINNED_ORDER),
            composition,
            repos,
            run.units,
            run.observation,
            run.order,
          ),
        AssertionError,
        "the root unit did not stage every mark the row made",
      );
    });
  });

  Deno.test(`usecase sync harness: a ${composition} root row fails without a pinned syncOrder`, async () => {
    await withRowRepos({}, async (repos) => {
      const run = await runSynthetic(repos, composition);
      assertThrows(
        () =>
          assertRootUnit(
            { name: "unpinned" },
            composition,
            repos,
            run.units,
            run.observation,
            run.order,
          ),
        AssertionError,
        "must pin syncOrder",
      );
    });
  });
}
