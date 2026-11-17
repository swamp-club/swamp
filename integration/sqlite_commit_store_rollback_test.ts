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
import { DatabaseSync } from "node:sqlite";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import {
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir({ prefix: "swamp-commit-crash-" });
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

async function save(seq: number): Promise<Commit> {
  return modelCommit(seq, [await savePut("a", seq), versionOp("a", seq)], {
    fence: 1,
  });
}

function rows(path: string) {
  const db = new DatabaseSync(path);
  try {
    return {
      commits: db.prepare("SELECT seq, txn_id FROM commits ORDER BY seq")
        .all(),
      heads: db.prepare("SELECT seq FROM partition_heads").all(),
    };
  } finally {
    db.close();
  }
}

Deno.test("SqliteCommitStore rollback: a failure after the commit row leaves no partial row", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(await save(1));
      // Fail the head write, which the store makes after the commit row in
      // the same transaction.
      const db = new DatabaseSync(path);
      try {
        db.exec(`
          CREATE TRIGGER fail_head BEFORE UPDATE ON partition_heads
          BEGIN SELECT RAISE(ABORT, 'simulated crash'); END;
        `);
        const before = rows(path);

        await assertRejects(
          async () => await store.append(await save(2)),
          Error,
          "simulated crash",
        );
        assertEquals(rows(path), before);

        db.exec("DROP TRIGGER fail_head");
      } finally {
        db.close();
      }
      // The commit lands at the seq it was refused at: neither the file nor
      // the store's cached partition kept the failed attempt.
      assertEquals(await store.append(await save(2)), {
        kind: "appended",
        seq: 2,
      });
      assertEquals(await store.append(await save(3)), {
        kind: "appended",
        seq: 3,
      });
    } finally {
      await store.close();
    }
  });
});

// A real kill is not modelled here: SQLite's recovery of a hot journal or WAL
// after a process dies needs a separate process, which this suite never starts.
Deno.test("SqliteCommitStore rollback: a writer's rows are unseen until COMMIT and gone once it ends without one", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    await SqliteCommitStore.open(path).close();
    const commit = await save(1);
    const writer = new DatabaseSync(path);
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer.prepare(
        "INSERT INTO commits (namespace, partition, seq, txn_id, fence, at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        "",
        modelPartition().toString(),
        1,
        commit.txnId,
        1,
        commit.at,
        JSON.stringify(commit.toJSON()),
      );
      writer.prepare(
        "INSERT INTO partition_heads (namespace, partition, seq, highest_fence) VALUES (?, ?, ?, ?)",
      ).run("", modelPartition().toString(), 1, 1);
      assertEquals(rows(path), { commits: [], heads: [] });
    } finally {
      writer.close();
    }
    assertEquals(rows(path), { commits: [], heads: [] });
    const store = SqliteCommitStore.open(path);
    try {
      assertEquals(await store.head("", modelPartition()), {
        seq: 0,
        highestFence: undefined,
      });
      assertEquals(await store.append(commit), { kind: "appended", seq: 1 });
      assert((await store.changesSince(0, 10)).length === 1);
    } finally {
      await store.close();
    }
  });
});
