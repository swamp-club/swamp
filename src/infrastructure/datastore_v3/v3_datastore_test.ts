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
  COMMITS_DB_FILE,
  datastoreKeyFilter,
  initializeV3Datastore,
  isFreshV3Skeleton,
  listV3Namespaces,
  openV3Datastore,
} from "./v3_datastore.ts";
import { writeDatastoreFormatMarker } from "../persistence/datastore_format_marker_writer.ts";
import {
  blobPut,
  deleteVersion,
  modelCommit,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { SOLO_NAMESPACE } from "../../domain/data/namespace.ts";

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

Deno.test("isFreshV3Skeleton: a writer's replication state does not make it a datastore with data", async () => {
  await withTempDir(async (root) => {
    const dir = join(root, "datastore");
    await Deno.mkdir(dir);
    await initializeV3Datastore(dir, "test");
    await Deno.mkdir(join(dir, ".commits.db-replication"));
    await Deno.mkdir(join(dir, ".commits.db-litestream"));
    assert(await isFreshV3Skeleton(dir));
    await Deno.mkdir(join(dir, "other"));
    assertEquals(await isFreshV3Skeleton(dir), false);
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

/** Commits one auto-definition to `datastorePath` in `namespace`. */
async function commitIn(
  dir: string,
  datastorePath: string,
  namespace: string,
): Promise<void> {
  const datastore = openV3Datastore({
    repoDir: join(dir, `checkout-${crypto.randomUUID()}`),
    datastorePath,
    namespace,
  });
  try {
    const engine = datastore.engineFor(() => Promise.resolve(), () => {
      throw new Error("no run repository needed");
    });
    await engine.runRoot({}, async () => {
      const unit = engine.openUnit() as unknown as CommitLogUnitOfWork;
      await unit.stageOps([
        new AutoDefinitionChanges(crypto.randomUUID()).write(
          recordKeyOf(["auto-definitions", "x.yaml"]),
          new TextEncoder().encode("name: x\n"),
        ),
      ]);
      await unit.commit();
    });
  } finally {
    await datastore.close();
  }
}

Deno.test("listV3Namespaces: names each namespace with commits, never the unnamespaced one", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), []);

    await commitIn(dir, datastorePath, "");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), []);

    await commitIn(dir, datastorePath, "team");
    await commitIn(dir, datastorePath, "infra");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), [
      "infra",
      "team",
    ]);
  });
});

Deno.test("listV3Namespaces: a datastore with no commits.db lists nothing and gains none", async () => {
  await withTempDir((dir) => {
    assertEquals(listV3Namespaces(dir, dir), []);
    assertEquals(
      [...Deno.readDirSync(dir)].map((entry) => entry.name),
      [],
    );
    return Promise.resolve();
  });
});

Deno.test("listV3Namespaces: reads a checkpointed commits.db without writing to it", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    await commitIn(dir, datastorePath, "team");
    const dbPath = join(datastorePath, COMMITS_DB_FILE);
    // The writer's close checkpoints the WAL away.
    assertEquals(
      [...Deno.readDirSync(datastorePath)].map((entry) => entry.name)
        .filter((name) => name.startsWith(`${COMMITS_DB_FILE}-`)),
      [],
    );
    const before = await Deno.readFile(dbPath);

    assertEquals(listV3Namespaces(datastorePath, datastorePath), ["team"]);

    assertEquals(await Deno.readFile(dbPath), before);
    // A writer opens it afterwards as before.
    await commitIn(dir, datastorePath, "infra");
    assertEquals(listV3Namespaces(datastorePath, datastorePath), [
      "infra",
      "team",
    ]);
  });
});

const DAY_MS = 24 * 60 * 60 * 1000;

Deno.test("openV3Datastore: compactBefore folds a quiet history up to the cutoff, never inside the safety window, and the sweep then reclaims removed content (swamp-club#3473)", async () => {
  await withTempDir(async (dir) => {
    const datastorePath = join(dir, "datastore");
    await initializeV3Datastore(datastorePath, "test");
    // Far past the chunks' real modification times, so only the release
    // grace keeps them; moved forward instead of slept.
    let now = Date.parse("2030-01-01T00:00:00.000Z");
    const handle = openV3Datastore({
      repoDir: join(dir, "a"),
      datastorePath,
      clock: () => new Date(now),
    });
    const signal = () => AbortSignal.timeout(30_000);
    const ago = (days: number) => new Date(now - days * DAY_MS).toISOString();
    const content = (text: string) =>
      handle.chunkStore.write(
        SOLO_NAMESPACE,
        new TextEncoder().encode(text.repeat(64)),
        signal(),
      );
    const storedChunks = async () => {
      const hashes: string[] = [];
      for await (const chunk of handle.storage.list("_default", signal())) {
        hashes.push(chunk.sha256);
      }
      return hashes.sort();
    };
    try {
      const reaped = await content("reaped");
      const kept = await content("kept");
      const history = [
        // Written long ago, then removed by retention 10 days ago.
        [30, [await blobPut("a", 1, reaped), versionOp("a", 1)]],
        [10, [deleteVersion("a", 1)]],
        // Older than a 3-day cutoff, but inside the 7-day safety window.
        [5, [await blobPut("b", 1, kept), versionOp("b", 1)]],
        // Newer than any cutoff here.
        [1, [await savePut("c", 1), versionOp("c", 1)]],
      ] as const;
      let seq = 1;
      for (const [days, ops] of history) {
        await handle.commitStore.append(
          modelCommit(seq, ops, { at: ago(days), txnId: `txn-${seq}` }),
        );
        seq++;
      }
      const reapedChunks = [...reaped.chunkHashes()].sort();
      const all = await storedChunks();

      // Well under the default policy's 10,000 commits: nothing is due.
      assertEquals(await handle.compactIfDue(signal()), undefined);

      // A 20-day cutoff folds only the write; the remove is newer, so the
      // base still names the reaped content.
      const older = await handle.compactBefore(
        new Date(now - 20 * DAY_MS),
        signal(),
      );
      assertEquals(older.bound.toISOString(), ago(20));
      assertEquals(older.compactedThrough, 1);
      assertEquals(older.report?.compacted, 1);
      now += DAY_MS + 60 * 60 * 1000;
      assertEquals((await handle.collectChunks(signal())).deleted, 0);
      assertEquals(await storedChunks(), all);

      // A 3-day cutoff is held back to the 7-day window: the remove folds,
      // the commits inside the window and after the cutoff stay.
      const cutoff = new Date(now - 3 * DAY_MS);
      const folded = await handle.compactBefore(cutoff, signal());
      assertEquals(folded.bound.toISOString(), ago(7));
      assertEquals(folded.compactedThrough, 2);
      assertEquals(folded.report?.compacted, 1);
      assertEquals(await handle.describe(), {
        storedCommits: 2,
        compactedThrough: 2,
      });
      // Within the release grace the reaped chunks are still kept.
      assertEquals((await handle.collectChunks(signal())).deleted, 0);
      // Past it, they are deleted and nothing else is.
      now += DAY_MS + 60 * 60 * 1000;
      const sweep = await handle.collectChunks(signal());
      assertEquals(sweep.deleted, reapedChunks.length);
      assertEquals(
        await storedChunks(),
        all.filter((hash) => !reapedChunks.includes(hash)),
      );
      for (const hash of kept.chunkHashes()) {
        assert((await storedChunks()).includes(hash));
      }

      // Two days on, the window has slid past the second write, which now
      // folds; the commit newer than the cutoff still stays.
      const later = await handle.compactBefore(cutoff, signal());
      assertEquals(later.bound.toISOString(), ago(7));
      assertEquals(later.compactedThrough, 3);
      assertEquals(await handle.describe(), {
        storedCommits: 1,
        compactedThrough: 3,
      });
      // Nothing more is older than the bound: another call folds nothing.
      const again = await handle.compactBefore(cutoff, signal());
      assertEquals(again.report, undefined);
      assertEquals(again.compactedThrough, 3);
    } finally {
      await handle.close();
    }
  });
});
