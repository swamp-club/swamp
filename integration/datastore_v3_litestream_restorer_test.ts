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
 * The v3 copy restorer (swamp-club#3482) against a stand-in for the
 * Litestream binary: a script that answers `restore` the way Litestream
 * does, so the fallback, truncation and refusal paths run without a
 * replica whose TXIDs were compacted away. Ignored on Windows.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import { DatabaseSync } from "node:sqlite";
import type { LineageHead } from "../src/domain/datastore_v3/published_lineage.ts";
import {
  modelCommit,
  savePut,
  versionOp,
} from "../src/domain/datastore_v3/v3_test_helpers.ts";
import { SqliteCommitStore } from "../src/infrastructure/datastore_v3/sqlite_commit_store.ts";
import {
  installByRename,
  restoreV3Copy,
  V3RestoredDatabaseCorruptError,
  V3RestoreError,
} from "../src/infrastructure/datastore_v3/litestream/litestream_restorer.ts";
import {
  findSpan,
  withCapturedSpans,
} from "../src/infrastructure/tracing/span_test_helpers.ts";

const ignore = Deno.build.os === "windows";

type Mode = "exact" | "fallback" | "fail" | "slow";

/**
 * A fake `litestream`: copies `source` to the `-o` path. In "fallback" a
 * `-txid` restore answers as Litestream does for a TXID inside a range
 * compaction merged; "fail" always fails; "slow" hangs.
 */
async function fakeBinary(dir: string, source: string, mode: Mode) {
  const script = join(dir, "litestream");
  await Deno.writeTextFile(
    script,
    `#!/bin/sh
out=""; txid=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;;
    -txid) txid="$2"; shift ;;
  esac
  shift
done
echo "$txid" >> "${join(dir, "calls")}"
case "${mode}" in
  fail) echo "Error: replica unreachable" >&2; exit 1 ;;
  slow) exec sleep 30 ;;
  fallback) if [ -n "$txid" ]; then echo "Error: no matching backup files available" >&2; exit 1; fi ;;
esac
cp "${source}" "$out"
`,
  );
  await Deno.chmod(script, 0o755);
  return script;
}

async function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.realPath(await Deno.makeTempDir());
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** A store at `path` with commits 1..`count`, closed and checkpointed. */
async function storeWith(path: string, count: number): Promise<void> {
  const store = SqliteCommitStore.open(path);
  try {
    for (let seq = 1; seq <= count; seq++) {
      await store.append(
        modelCommit(seq, [await savePut("a", seq), versionOp("a", seq)], {
          fence: 1,
        }),
      );
    }
  } finally {
    await store.close();
  }
}

function count(path: string): number {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT COUNT(*) AS n FROM commits").get() as {
      n: number;
    }).n;
  } finally {
    db.close();
  }
}

function headAt(cursor: number, txnId = `txn-${cursor}`): LineageHead {
  return {
    fence: 3,
    txid: "0000000000000004",
    writerFence: 3,
    mark: cursor === 0 ? { cursor } : {
      cursor,
      commit: { namespace: "", partition: "", seq: cursor, txnId },
    },
    publishedAt: "2026-10-14T00:00:00.000Z",
  };
}

function partitionOf(path: string): string {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    return (db.prepare("SELECT partition FROM commits LIMIT 1").get() as {
      partition: string;
    }).partition;
  } finally {
    db.close();
  }
}

async function restore(
  dir: string,
  mode: Mode,
  head: (partition: string) => LineageHead,
  options: { readonly deadlineMs?: number } = {},
) {
  const source = join(dir, "source.db");
  const target = join(dir, "copy", "commits.db");
  await Deno.mkdir(join(dir, "copy"), { recursive: true });
  await Deno.mkdir(join(dir, "priv"), { recursive: true });
  const binary = await fakeBinary(dir, source, mode);
  const partition = partitionOf(source);
  const lineageHead = head(partition);
  return await restoreV3Copy({
    binary,
    replica: { type: "file", path: join(dir, "replica") },
    head: lineageHead,
    target,
    configDir: join(dir, "priv"),
    install: installByRename(target),
    deadlineMs: options.deadlineMs ?? 30_000,
  });
}

function withPartition(
  cursor: number,
  txnId?: string,
): (partition: string) => LineageHead {
  return (partition) => {
    const head = headAt(cursor, txnId);
    return head.mark.commit === undefined ? head : {
      ...head,
      mark: { ...head.mark, commit: { ...head.mark.commit, partition } },
    };
  };
}

async function leftovers(dir: string): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(join(dir, "copy"))) {
    if (entry.name.includes(".restore-")) names.push(entry.name);
  }
  return names;
}

Deno.test({
  name:
    "restoreV3Copy: restores the head's TXID and drops commits past the mark",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await storeWith(join(dir, "source.db"), 5);
      const result = await restore(dir, "exact", withPartition(3));
      assertEquals(result, { exactTxid: true, truncated: 2 });
      assertEquals(count(join(dir, "copy", "commits.db")), 3);
      assertEquals(
        (await Deno.readTextFile(join(dir, "calls"))).trim(),
        "0000000000000004",
      );
      assertEquals(await leftovers(dir), []);
    });
  },
});

Deno.test({
  name:
    "restoreV3Copy: a TXID compaction merged away falls back to the latest state, truncated to the mark",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await storeWith(join(dir, "source.db"), 6);
      const result = await restore(dir, "fallback", withPartition(4));
      assertEquals(result, { exactTxid: false, truncated: 2 });
      assertEquals(count(join(dir, "copy", "commits.db")), 4);
      assertEquals(
        (await Deno.readTextFile(join(dir, "calls"))).split("\n").slice(0, -1),
        ["0000000000000004", ""],
      );
    });
  },
});

Deno.test({
  name:
    "restoreV3Copy: each litestream restore is its own span, so a fallback to a second full restore shows (swamp-club#3803)",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await storeWith(join(dir, "source.db"), 6);
      await withCapturedSpans(async (spans) => {
        await restore(dir, "fallback", withPartition(4));
        const attempts = spans.filter((span) =>
          span.name === "swamp.datastore.v3.restore.attempt"
        );
        assertEquals(
          attempts.map((span) => [
            span.attributes["swamp.datastore.v3.restore_txid"],
            span.attributes["swamp.datastore.v3.restore_outcome"],
          ]),
          [["0000000000000004", "unavailable"], ["latest", "ok"]],
        );
        for (
          const name of [
            "swamp.datastore.v3.restore.integrity_check",
            "swamp.datastore.v3.restore.truncate",
            "swamp.datastore.v3.restore.install",
          ]
        ) {
          findSpan(spans, name);
        }
      });
    });
  },
});

Deno.test({
  name:
    "restoreV3Copy: a restore that does not hold the acknowledged commit is refused",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await storeWith(join(dir, "source.db"), 3);
      await storeWith(join(dir, "copy-before.db"), 1);
      const error = await assertRejects(
        () => restore(dir, "exact", withPartition(2, "another-txn")),
        V3RestoreError,
      );
      assertStringIncludes(error.message, "another history");
      assertEquals(await leftovers(dir), []);
    });
  },
});

Deno.test({
  name:
    "restoreV3Copy: commits past the mark that were compacted are refused with the recovery",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      const source = join(dir, "source.db");
      await storeWith(source, 5);
      const store = SqliteCommitStore.open(source);
      try {
        await store.compactHistory(4);
      } finally {
        await store.close();
      }
      const error = await assertRejects(
        () => restore(dir, "exact", withPartition(2)),
        V3RestoreError,
      );
      assertStringIncludes(error.message, "compacted");
      assertStringIncludes(error.message, "_control/lineage/");
    });
  },
});

Deno.test({
  name:
    "restoreV3Copy: a damaged or newer database is refused, a copy left as it was",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await Deno.writeTextFile(join(dir, "source.db"), "not a database");
      const target = join(dir, "copy", "commits.db");
      await Deno.mkdir(join(dir, "copy"));
      await storeWith(target, 2);
      // partitionOf needs a database: the head is built without one.
      const binary = await fakeBinary(dir, join(dir, "source.db"), "exact");
      await Deno.mkdir(join(dir, "priv"));
      await assertRejects(
        () =>
          restoreV3Copy({
            binary,
            replica: { type: "file", path: join(dir, "replica") },
            head: headAt(0),
            target,
            configDir: join(dir, "priv"),
            install: installByRename(target),
            deadlineMs: 30_000,
          }),
        // SQLite fails the integrity check itself with SQLITE_NOTADB: a
        // damaged restore, which marks the lineage broken (swamp-club#3935).
        V3RestoredDatabaseCorruptError,
      );
      assertEquals(count(target), 2);
      assertEquals(await leftovers(dir), []);

      await Deno.remove(join(dir, "source.db"));
      await storeWith(join(dir, "source.db"), 1);
      const db = new DatabaseSync(join(dir, "source.db"));
      db.exec("PRAGMA user_version = 999");
      db.close();
      const newer = await assertRejects(
        () =>
          restoreV3Copy({
            binary,
            replica: { type: "file", path: join(dir, "replica") },
            head: headAt(0),
            target,
            configDir: join(dir, "priv"),
            install: installByRename(target),
            deadlineMs: 30_000,
          }),
        V3RestoreError,
      );
      assertStringIncludes(newer.message, "newer");
      // A newer schema is an upgrade to make, not a broken lineage.
      assertEquals(newer instanceof V3RestoredDatabaseCorruptError, false);
      assertEquals(count(target), 2);
    });
  },
});

Deno.test({
  name: "restoreV3Copy: a failed or overdue restore cleans up and says why",
  ignore,
  async fn() {
    await withDir(async (dir) => {
      await storeWith(join(dir, "source.db"), 1);
      const failed = await assertRejects(
        () => restore(dir, "fail", withPartition(1)),
        V3RestoreError,
      );
      assertStringIncludes(failed.message, "replica unreachable");
      const overdue = await assertRejects(
        () => restore(dir, "slow", withPartition(1), { deadlineMs: 300 }),
        V3RestoreError,
      );
      assertStringIncludes(overdue.message, "did not finish");
      assertEquals(await leftovers(dir), []);
    });
  },
});
