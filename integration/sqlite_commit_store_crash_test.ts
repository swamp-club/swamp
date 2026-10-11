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

/**
 * Crash safety of the SQLite commit store (swamp-club#3236): an append that
 * dies part-way leaves no partial row.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import type { Commit } from "../src/domain/datastore_v3/commit.ts";
import {
  modelCommit,
  modelPartition,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import type {
  CrashWorkerMessage,
  CrashWorkerRequest,
} from "./sqlite_commit_store_crash_worker.ts";

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

/** The rows of every table, read through a separate connection. */
function rows(path: string) {
  const db = new DatabaseSync(path);
  // A terminated worker's lock is released asynchronously.
  db.exec("PRAGMA busy_timeout=5000");
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

Deno.test("SqliteCommitStore crash: a failure after the commit row leaves no partial row", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    const store = SqliteCommitStore.open(path);
    try {
      await store.append(await save(1));
      // Fail the head write, which the store makes after the commit row in
      // the same transaction.
      const db = new DatabaseSync(path);
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
      db.close();
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

Deno.test("SqliteCommitStore crash: a writer killed before COMMIT leaves no row", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "commits.db");
    // Create the schema, then hand the file to the doomed writer.
    await SqliteCommitStore.open(path).close();

    const commit = await save(1);
    const worker = new Worker(
      new URL("./sqlite_commit_store_crash_worker.ts", import.meta.url).href,
      { type: "module" },
    );
    let written = false;
    try {
      worker.onmessage = (event: MessageEvent<CrashWorkerMessage>) => {
        if (event.data === "written") written = true;
      };
      worker.postMessage(
        {
          dbPath: path,
          namespace: "",
          partition: modelPartition().toString(),
          seq: 1,
          txnId: commit.txnId,
          fence: 1,
          at: commit.at,
          body: JSON.stringify(commit.toJSON()),
        } satisfies CrashWorkerRequest,
      );
      await waitFor(() => written, "the worker to write its rows");
    } finally {
      worker.terminate();
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
