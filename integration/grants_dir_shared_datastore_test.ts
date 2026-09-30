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

// Two serve instances share one datastore and mount the same --grants-dir at
// different paths. Each auto-reload must see the other's grants as its own,
// not as grants of a file it no longer has (swamp-club#2848).

import { assertEquals } from "@std/assert";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { waitFor } from "@swamp-club/swamp-testing";
import { GrantsDirectoryPoller } from "../src/domain/access/grants_directory_poller.ts";
import {
  createFileGrantStore,
  type FileGrantStore,
} from "../src/domain/access/grant_file_reconciler.ts";
import { PolicySnapshotLoader } from "../src/domain/access/policy_snapshot_loader.ts";
import type { Grant } from "../src/domain/models/access/grant_model.ts";
import { createRepositoryContext } from "../src/infrastructure/persistence/repository_factory.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";

await initializeLogging({});

const DENY_YAML = `grants:
  - subject: "user:mallory"
    effect: deny
    actions: [run]
    resource: "workflow:*"
`;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-shared-grants-dir-" });
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

Deno.test("GrantsDirectoryPoller: instances mounting one --grants-dir at different paths never revoke each other's grants", async () => {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const repoGrantsDir = join(repoDir, "grants");
    await ensureDir(repoGrantsDir);
    const mountA = join(dir, "instance-a", "grants");
    const mountB = join(dir, "instance-b", "grants");
    await ensureDir(mountA);
    await ensureDir(mountB);

    const repoContext = createRepositoryContext({ repoDir });
    const store = createFileGrantStore(
      repoContext.definitionRepo,
      repoContext.definitionRepo,
      repoContext.unifiedDataRepo,
    );
    const revocations: Grant[] = [];
    const creations: Grant[] = [];
    const trackedStore: FileGrantStore = {
      ...store,
      writeGrant(modelId, instanceName, grant) {
        (grant.state === "revoked" ? revocations : creations).push(grant);
        return store.writeGrant(modelId, instanceName, grant);
      },
    };

    const reconciles = { a: 0, b: 0 };
    const pollerFor = (name: "a" | "b", mount: string) =>
      new GrantsDirectoryPoller({
        grantsDir: repoGrantsDir,
        externalGrantsDir: mount,
        fileGrantStore: trackedStore,
        policySnapshotLoader: new PolicySnapshotLoader(
          repoContext.unifiedDataRepo,
          repoContext.eventBus,
          "manual",
        ),
        pollIntervalMs: 20,
        commitReconcile: async (reconcile) => {
          await reconcile();
          reconciles[name]++;
        },
      });

    const activeDenies = async () =>
      [...(await store.queryFileGrants()).values()]
        .filter(({ grant }) => grant.state === "active")
        .map(({ grant }) => `${grant.source} ${grant.effect}`);

    const a = pollerFor("a", mountA);
    const b = pollerFor("b", mountB);
    await a.start();
    await b.start();
    try {
      await Deno.writeTextFile(join(mountA, "deny.yaml"), DENY_YAML);
      await waitFor(() => reconciles.a >= 1, "instance A to reconcile");
      assertEquals(creations.length, 1);
      assertEquals(await activeDenies(), ["file:grants-dir/deny.yaml deny"]);

      await Deno.writeTextFile(join(mountB, "deny.yaml"), DENY_YAML);
      await waitFor(() => reconciles.b >= 1, "instance B to reconcile");
      assertEquals(await activeDenies(), ["file:grants-dir/deny.yaml deny"]);

      await Deno.writeTextFile(
        join(mountA, "deny.yaml"),
        `${DENY_YAML}# touched\n`,
      );
      await waitFor(() => reconciles.a >= 2, "instance A to reconcile again");
      assertEquals(await activeDenies(), ["file:grants-dir/deny.yaml deny"]);

      assertEquals(revocations, []);
      assertEquals(creations.length, 1);
    } finally {
      await a.stop();
      await b.stop();
      repoContext.catalogStore.close();
    }
  });
});
