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
import { waitFor } from "@swamp-club/swamp-testing";
import { join } from "@std/path";
import { ChunkStore } from "../../domain/datastore_v3/chunk_store.ts";
import { type Op, putOp } from "../../domain/datastore_v3/op.ts";
import {
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import {
  base64,
  MemoryStorage,
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../../domain/datastore_v3/v3_test_helpers.ts";
import { withMockedEnv } from "../persistence/path_test_helpers.ts";
import { readModelStateDir } from "./record_path_guard.ts";
import { SqliteCommitStore } from "./sqlite_commit_store.ts";
import { SqliteReadModel } from "./sqlite_read_model.ts";
import { v3CacheRoot } from "./v3_datastore.ts";
import {
  applyPartitions,
  backlogPastBound,
  partitionPending,
  pendingAlwaysApplied,
  pendingCommitsIn,
  pendingPartitions,
  resolveScopedBacklogMax,
  SCOPED_BACKLOG_AGE_MS,
  SCOPED_BACKLOG_MAX,
  SCOPED_BACKLOG_MAX_ENV_VAR,
  type ScopedApplyTarget,
  startPeriodicApply,
} from "./scoped_read_model.ts";

const signal = () => AbortSignal.timeout(30_000);
const AT = "2026-10-11T00:00:00.000Z";

interface Env extends ScopedApplyTarget {
  readonly store: SqliteCommitStore;
  readonly readModel: SqliteReadModel;
  /** appends a commit to the partition at its next seq */
  append(
    partition: PartitionKey,
    ops: readonly Op[],
    at?: string,
  ): Promise<void>;
}

async function withEnv(fn: (env: Env) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-scoped-apply-" });
  const repoDir = join(dir, "repo");
  const store = SqliteCommitStore.open(join(dir, "commits.db"));
  const readModel = SqliteReadModel.open({
    commitStore: store,
    chunkStore: new ChunkStore(new MemoryStorage()),
    cacheRoot: (ns) => v3CacheRoot(repoDir, ns),
    stateDir: readModelStateDir(repoDir),
  });
  const seqs = new Map<string, number>();
  try {
    await fn({
      namespace: "",
      store,
      commitStore: store,
      readModel,
      append: async (partition, ops, at = AT) => {
        const seq = (seqs.get(partition.toString()) ?? 0) + 1;
        seqs.set(partition.toString(), seq);
        await store.append(modelCommit(seq, ops, {
          partition,
          txnId: crypto.randomUUID(),
          at,
        }));
      },
    });
  } finally {
    await readModel.close();
    await store.close();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const CONFIG = partitionOf({
  kind: "config",
  definitionKind: "model",
  name: "producer",
});
const MODEL = modelPartition();

function definitionPut(text: string): Promise<Op> {
  return putOp({
    intent: {
      kind: "definition.edit",
      definition: { kind: "model", name: "producer" },
    },
    key: RecordKey.create(
      "config/models/aws/3f0e7d1c-2b4a-4c6d-8e9f-0a1b2c3d4e5f.yaml",
    ),
    inline: base64(text),
  });
}

async function save(env: Env, version: number, at?: string): Promise<void> {
  await env.append(
    MODEL,
    [await savePut("out", version), versionOp("out", version)],
    at,
  );
}

Deno.test("resolveScopedBacklogMax: the env override replaces the bound when it is a positive integer", () => {
  withMockedEnv({ [SCOPED_BACKLOG_MAX_ENV_VAR]: "200" }, () => {
    assertEquals(resolveScopedBacklogMax(), 200);
  });
  for (const value of [undefined, "", "0", "-5", "1.5", "lots"]) {
    withMockedEnv({ [SCOPED_BACKLOG_MAX_ENV_VAR]: value }, () => {
      assertEquals(resolveScopedBacklogMax(), SCOPED_BACKLOG_MAX, value);
    });
  }
});

Deno.test("pendingAlwaysApplied: names config partitions with commits past what was applied, never a behavior's", async () => {
  await withEnv(async (env) => {
    await env.append(CONFIG, [await definitionPut("v1")]);
    await save(env, 1);
    await env.readModel.catchUp(signal());
    assertEquals(pendingAlwaysApplied(env), []);
    assertEquals(pendingPartitions(env), []);

    await env.append(CONFIG, [await definitionPut("v2")]);
    await save(env, 2);
    assertEquals(pendingAlwaysApplied(env).map(String), [CONFIG.toString()]);
    assertEquals(
      pendingPartitions(env).map(String).sort(),
      [CONFIG.toString(), MODEL.toString()].sort(),
    );
    assertEquals(await pendingCommitsIn(env, [CONFIG, MODEL]), 2);

    // applied ahead of the cursor, a partition is no longer pending
    await applyPartitions(env, pendingAlwaysApplied(env), signal());
    assertEquals(pendingAlwaysApplied(env), []);
    assertEquals(pendingPartitions(env).map(String), [MODEL.toString()]);
    assert(partitionPending(env, MODEL));
    assert(!partitionPending(env, CONFIG));
  });
});

Deno.test("applyPartitions: applies only the partitions named and leaves the cursor where the last whole apply left it", async () => {
  await withEnv(async (env) => {
    await save(env, 1);
    await env.readModel.catchUp(signal());
    const cursor = env.readModel.cursor();
    await env.append(CONFIG, [await definitionPut("v1")]);
    await save(env, 2);

    await applyPartitions(env, [CONFIG, CONFIG], signal());
    assertEquals(env.readModel.cursor(), cursor);
    assertEquals(env.readModel.appliedSeq("", CONFIG), 1);
    assertEquals(env.readModel.appliedSeq("", MODEL), 1);

    // the whole apply after it skips what the partition apply applied
    await env.readModel.catchUp(signal());
    assertEquals(env.readModel.appliedSeq("", MODEL), 2);
    assertEquals(env.readModel.cursor(), env.store.lastCursor());
  });
});

Deno.test("backlogPastBound: past the commit bound, or with its oldest unapplied commit past the age bound, the open applies everything", async () => {
  await withEnv(async (env) => {
    const now = Date.parse(AT);
    await save(env, 1);
    await env.readModel.catchUp(signal());
    assertEquals(await backlogPastBound(env, now), false);

    for (let version = 2; version <= 4; version++) await save(env, version);
    assertEquals(await backlogPastBound(env, now), false);
    await withMockedEnv({ [SCOPED_BACKLOG_MAX_ENV_VAR]: "3" }, async () => {
      assertEquals(await backlogPastBound(env, now), false);
    });
    await withMockedEnv({ [SCOPED_BACKLOG_MAX_ENV_VAR]: "2" }, async () => {
      assertEquals(await backlogPastBound(env, now), true);
    });

    assertEquals(
      await backlogPastBound(env, now + SCOPED_BACKLOG_AGE_MS),
      false,
    );
    assertEquals(
      await backlogPastBound(env, now + SCOPED_BACKLOG_AGE_MS + 1),
      true,
    );
  });
});

Deno.test("startPeriodicApply: applies at each interval after the last one settled, and stopping aborts the one running and runs no more", async () => {
  let applies = 0;
  let readied = 0;
  let running: AbortSignal | undefined;
  let release = () => {};
  const periodic = startPeriodicApply({
    intervalMs: 5,
    ready: () => {
      readied++;
      return Promise.resolve();
    },
    apply: (applySignal) => {
      applies++;
      if (applies < 3) return Promise.resolve();
      running = applySignal;
      return new Promise<void>((resolve) => release = resolve);
    },
  });
  try {
    await waitFor(() => running !== undefined, "a third apply to start");
    assertEquals(readied, 3);
  } finally {
    await periodic.stop();
  }
  assert(running!.aborted, "stopping aborts the apply in flight");
  release();
  const after = applies;
  // a settled apply schedules nothing once stopped
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  assertEquals(applies, after);
});

Deno.test("startPeriodicApply: a command shorter than the interval never applies", async () => {
  let applies = 0;
  const periodic = startPeriodicApply({
    intervalMs: 60_000,
    apply: () => {
      applies++;
      return Promise.resolve();
    },
  });
  await periodic.stop();
  assertEquals(applies, 0);
});

Deno.test("backlogPastBound: a copy compacted past the cursor applies everything, and a partition apply over the compaction loads its base", async () => {
  await withEnv(async (env) => {
    const now = Date.parse(AT);
    await save(env, 1);
    await env.readModel.catchUp(signal());
    await save(env, 2);
    await save(env, 3);
    await env.store.compactHistory(env.store.lastCursor());
    assertEquals(await backlogPastBound(env, now), true);

    await applyPartitions(env, [MODEL], signal());
    assertEquals(env.readModel.appliedSeq("", MODEL), 3);
    await env.readModel.catchUp(signal());
    assertEquals(env.readModel.appliedSeq("", MODEL), 3);
  });
});

Deno.test("backlogPastBound: the age bound passed in replaces the default", async () => {
  await withEnv(async (env) => {
    const now = Date.parse(AT);
    await save(env, 1);
    await env.readModel.catchUp(signal());
    await save(env, 2);
    assertEquals(await backlogPastBound(env, now + 5), false);
    assertEquals(await backlogPastBound(env, now + 5, 1), true);
  });
});
