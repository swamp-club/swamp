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
import { join } from "@std/path";
import {
  AutoDefinitionChanges,
  recordKeyOf,
} from "../../domain/datastore_v3/repository_changes.ts";
import type { CommitLogUnitOfWork } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { swampPath } from "../persistence/paths.ts";
import {
  datastoreKeyFilter,
  initializeV3Datastore,
  isFreshV3Skeleton,
  openV3Datastore,
} from "./v3_datastore.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-v3-datastore-" });
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

Deno.test("datastoreKeyFilter: the default layout admits datastore directories and nothing local", () => {
  const admits = datastoreKeyFilter(undefined, undefined);
  assert(admits("data/aws/ec2/id/result/1/raw"));
  assert(admits("workflow-runs/w/run.yaml"));
  assertEquals(admits("_read_model_v3/_catalog_v3.db"), false);
  assertEquals(admits("not-a-datastore-dir/x"), false);
});

Deno.test("datastoreKeyFilter: configured directories and exclude patterns keep keys local", () => {
  const admits = datastoreKeyFilter(["data", "outputs"], ["data/secret/**"]);
  assert(admits("data/aws/ec2/id/result/1/raw"));
  assertEquals(admits("workflow-runs/w/run.yaml"), false);
  assertEquals(admits("data/secret/x/raw"), false);
});

Deno.test("openV3Datastore: a root commits typed changes the read model of another checkout applies", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const writer = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    const reader = openV3Datastore({ repoDir: join(dir, "b"), datastorePath });
    try {
      const hook = () => Promise.resolve();
      const engine = writer.engineFor(hook, () => {
        throw new Error("no run repository needed");
      });
      const key = recordKeyOf(["auto-definitions", "x.yaml"]);
      const bytes = new TextEncoder().encode("name: x\n");
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(key, bytes),
        ]);
        await unit.commit();
      });
      assertEquals((await writer.describe()).storedCommits, 1);
      await reader.catchUp();
      assertEquals(
        await Deno.readFile(
          swampPath(join(dir, "b"), "auto-definitions", "x.yaml"),
        ),
        bytes,
      );
    } finally {
      await writer.close();
      await reader.close();
    }
  });
});

Deno.test("openV3Datastore: chunk GC and compaction run on an empty datastore", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    const handle = openV3Datastore({ repoDir: join(dir, "a"), datastorePath });
    try {
      const report = await handle.collectChunks(new AbortController().signal);
      assertEquals(report.deleted, 0);
      assertEquals(
        await handle.compactIfDue(new AbortController().signal),
        undefined,
      );
      assertEquals(await handle.describe(), {
        storedCommits: 0,
        compactedThrough: 0,
      });
    } finally {
      await handle.close();
      // Closing twice is harmless.
      await handle.close();
    }
  });
});

Deno.test("initializeV3Datastore: completes a fresh skeleton, and refuses a datastore that has commits", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    // A setup that stopped after the marker: the re-run completes it.
    await writeDatastoreFormatMarker(dir, { format: 3, minReaderFormat: 3 });
    assert(await isFreshV3Skeleton(dir));
    await initializeV3Datastore(dir, "test");
    assert(await isFreshV3Skeleton(dir), "still empty once completed");

    // One with a commit is no skeleton.
    const handle = openV3Datastore({
      repoDir: join(root, "repo"),
      datastorePath: dir,
    });
    try {
      const engine = handle.engineFor(() => Promise.resolve(), () => {
        throw new Error("no run repository needed");
      });
      await engine.runRoot({}, async () => {
        const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
        await unit.stageOps([
          new AutoDefinitionChanges(crypto.randomUUID()).write(
            recordKeyOf(["auto-definitions", "x.yaml"]),
            new TextEncoder().encode("x"),
          ),
        ]);
        await unit.commit();
      });
    } finally {
      await handle.close();
    }
    assertEquals(await isFreshV3Skeleton(dir), false);
    await assertRejects(() => initializeV3Datastore(dir, "test"));
  });
});
