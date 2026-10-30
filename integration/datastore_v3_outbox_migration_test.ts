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
 * The commit outbox's migrations (swamp-club#3564, swamp-club#3586) under openers
 * that race: each worker is its own connection, as two swamp processes
 * opening one checkout's outbox at once are.
 */

import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import { waitFor } from "@swamp-club/swamp-testing";
import {
  modelCommit,
  savePut,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import {
  COMMIT_OUTBOX_SCHEMA_VERSION,
  SqliteCommitOutbox,
} from "../src/infrastructure/datastore_v3/sqlite_commit_outbox.ts";
import type {
  OutboxOpenRequest,
  OutboxOpenResult,
} from "./datastore_v3_outbox_migration_worker.ts";

const OPENERS = 4;

/**
 * How long the openers get to start and to open the outbox. A loaded runner has
 * stalled the whole suite for longer than the default 10s (swamp-club#4160).
 */
const OPENER_WAIT_MS = 60_000;

/** What each schema's migration added, dropped to make an older file. */
const DOWNGRADES: Record<number, string> = {
  1: "ALTER TABLE outbox_entries DROP COLUMN writer_process; " +
    "ALTER TABLE outbox_entries DROP COLUMN left_at_fence; ",
  2: "ALTER TABLE outbox_entries DROP COLUMN abandoned_at; " +
    "ALTER TABLE outbox_chain DROP COLUMN pending_fence; ",
  3: "",
  4: "ALTER TABLE outbox_entries DROP COLUMN lease_id; " +
    "ALTER TABLE outbox_entries DROP COLUMN lease_fence; ",
};

/** The statements that turn a current outbox into one at `schema`. */
function downgradeTo(schema: number): string {
  let sql = "";
  for (
    let version = COMMIT_OUTBOX_SCHEMA_VERSION - 1;
    version >= schema;
    version--
  ) {
    sql += DOWNGRADES[version];
  }
  return sql + `PRAGMA user_version=${schema}`;
}

Deno.test("commit outbox: openers racing on a schema 1 outbox all end on the current schema, with its entry kept", async () => {
  await raceOpeners(1);
});

Deno.test("commit outbox: openers racing on a schema 2 outbox all end on the current schema, with its entry kept (swamp-club#3586)", async () => {
  await raceOpeners(2);
});

Deno.test("commit outbox: openers racing on a schema 3 outbox all end on the current schema, with its entry kept (swamp-club#3693)", async () => {
  await raceOpeners(3);
});

Deno.test("commit outbox: openers racing on a schema 4 outbox all end on schema 5, with its entry kept (swamp-club#4121)", async () => {
  assertEquals(COMMIT_OUTBOX_SCHEMA_VERSION, 5);
  await raceOpeners(4);
});

async function raceOpeners(schema: number): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "swamp-outbox-migration-" });
  const workers: Worker[] = [];
  try {
    const path = join(dir, "commits-outbox.db");
    // As a swamp at `schema` left it, with one entry.
    const outbox = new SqliteCommitOutbox(path);
    await outbox.prepare({
      commit: modelCommit(1, [await savePut("a", 1)]),
      unitId: "u",
      base: { seq: 0, txnId: undefined },
    });
    await outbox.close();
    const db = new DatabaseSync(path);
    db.exec(downgradeTo(schema));
    db.close();

    const start = new SharedArrayBuffer(4);
    const results: OutboxOpenResult[] = [];
    for (let i = 0; i < OPENERS; i++) {
      const worker = new Worker(
        new URL("./datastore_v3_outbox_migration_worker.ts", import.meta.url)
          .href,
        { type: "module" },
      );
      workers.push(worker);
      worker.onmessage = (event: MessageEvent<OutboxOpenResult>) => {
        results.push(event.data);
      };
      worker.postMessage({ path, start } satisfies OutboxOpenRequest);
    }
    await waitFor(
      () => results.filter((r) => r.kind === "ready").length === OPENERS,
      "every opener to be ready",
      { timeoutMs: OPENER_WAIT_MS },
    );
    const flag = new Int32Array(start);
    Atomics.store(flag, 0, 1);
    Atomics.notify(flag, 0);
    await waitFor(
      () => results.filter((r) => r.kind !== "ready").length === OPENERS,
      "every opener to open the outbox",
      { timeoutMs: OPENER_WAIT_MS },
    );
    assertEquals(
      results.filter((r) => r.kind !== "ready"),
      Array.from(
        { length: OPENERS },
        () => ({ kind: "opened" as const, entries: 1 }),
      ),
    );
    const check = new DatabaseSync(path);
    try {
      check.exec("PRAGMA busy_timeout=5000");
      assertEquals(
        (check.prepare("PRAGMA user_version").get() as {
          user_version: number;
        }).user_version,
        COMMIT_OUTBOX_SCHEMA_VERSION,
      );
    } finally {
      check.close();
    }
  } finally {
    for (const worker of workers) worker.terminate();
    if (Deno.build.os === "windows") {
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(dir, { recursive: true });
    }
  }
}
