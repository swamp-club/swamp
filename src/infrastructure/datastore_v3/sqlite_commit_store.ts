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
 * The SQLite commit store (swamp-club#3236): `commits.db`, one per datastore,
 * holding the commits of every namespace. Dormant: nothing in production
 * opens it yet.
 *
 * - **One transaction per commit.** An append starts its write transaction
 *   up front (`BEGIN IMMEDIATE`): a deferred `BEGIN` in WAL mode can fail on
 *   a stale snapshot even with `busy_timeout`. Inside it the commit is
 *   applied through `Partition.append`, so the domain's rules decide, and
 *   only then are the commit row and the partition's head row written.
 * - **Rebuild from a snapshot.** Every {@link DEFAULT_SNAPSHOT_INTERVAL}th
 *   commit of a partition also writes the partition's whole state
 *   (`Partition.snapshot`) in the same transaction. A partition is rebuilt
 *   from its latest snapshot plus the commits after it, so a rebuild replays
 *   fewer than that many commits however large the partition grows: a
 *   replay from seq 1 took about 270 ms for 11,000 commits, most of it
 *   recomputing inline digests. Rebuilt partitions stay in a bounded
 *   per-process cache. Each append checks the cached seq against the head
 *   row inside its transaction, so a write from another connection is
 *   noticed rather than trusted away.
 * - **Checkpoints.** No checkpoint is ever forced: Litestream replicates the
 *   WAL, and forcing a `TRUNCATE` checkpoint made its replica 11 times larger
 *   (`design/enablers/datastore-litestream.md`). A copy Litestream replicates
 *   turns SQLite's auto-checkpoint off, so only Litestream checkpoints
 *   (swamp-club#3935); any other `commits.db` keeps SQLite's default.
 *
 * @module
 */

import {
  DatabaseSync,
  type SQLInputValue,
  type StatementSync,
} from "node:sqlite";
import { dirname, resolve } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { maxOf } from "../../domain/array_extrema.ts";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { readFileAccess } from "../../domain/datastore_v3/file_access.ts";
import type {
  LiveDataVersion,
  LiveVersionChanges,
} from "../../domain/datastore_v3/catalog_projection.ts";
import type { CatalogNameChange } from "../../domain/datastore_v3/catalog_state.ts";
import { DEFAULT_CHUNK_GRACE_MS } from "../../domain/datastore_v3/chunk_collector.ts";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import type { HeadIdentity } from "../../domain/datastore_v3/commit_outbox.ts";
import {
  type BaseDataName,
  type BaseIndexEntry,
  type BaseRemoval,
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
  type CommitStoreAppendResult,
  CommitStoreCorruptError,
  type CompactedBaseEntry,
  type CompactedBasePage,
  type CompactedPartitionMarks,
  type CompactHistoryOptions,
  type CompactionReport,
  type DataNameMarks,
  InvalidBasePageTokenError,
  type ObservedCopyRepair,
  ObservedDropRefusedError,
  type PartitionBase,
  type PartitionBaseRows,
  type PartitionHead,
  type PartitionLeaseMarks,
  type PartitionPageOfNames,
} from "../../domain/datastore_v3/commit_store.ts";
import { TimeSlice } from "../persistence/scan_permits.ts";
import {
  catalogNamesOfCommit,
  catalogNamesOfRawCommit,
} from "../../domain/datastore_v3/name_history_replay.ts";
import {
  type BaseRecord,
  type CompactedBaseWriter,
  foldCommit,
} from "../../domain/datastore_v3/compaction.ts";
import type {
  CompactionCandidate,
  CompactionRetention,
} from "../../domain/datastore_v3/compaction_policy.ts";
import type { FileOwnership } from "../../domain/datastore_v3/materialisation.ts";
import type { HighWaterMark } from "../../domain/datastore_v3/published_lineage.ts";
import {
  type DataMetadata,
  DataMetadataSchema,
} from "../../domain/data/data_metadata.ts";
import { MATERIALISED_SUBDIRS } from "./record_path_guard.ts";
import {
  CommitRejectedError,
  Partition,
} from "../../domain/datastore_v3/partition.ts";
import { WriterFencedError } from "../../domain/datastore_v3/writer_lease.ts";
import { DatastoreOwner } from "../../domain/datastore_v3/datastore_owner.ts";
import { UserError } from "../../domain/errors.ts";
import {
  PartitionKey,
  RUN_PARTITION_RANGE,
} from "../../domain/datastore_v3/partition_key.ts";
import { forwardedCommitClass } from "../../domain/datastore_v3/forwarded_commit_class.ts";
import { withSyncSpan } from "../tracing/tracer.ts";
import type { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import type { ObservedBaseEntry } from "../../domain/datastore_v3/observed_base.ts";
import { VersionRanges } from "../../domain/datastore_v3/version_ranges.ts";
import {
  addColumnsIfAbsent,
  runMigration,
  type SqliteMigration,
} from "./sqlite_migration.ts";
import { useWalJournal } from "./sqlite_wal.ts";

/**
 * The schema migrations, in order. Migration `i` takes a database at
 * `PRAGMA user_version` `i` to `i + 1`, so the schema version is this list's
 * length. Add a migration by appending to the list; never edit one that has
 * shipped.
 */
const MIGRATIONS: readonly SqliteMigration[] = [
  // 0 → 1: commits and partition heads.
  `
  CREATE TABLE commits (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    txn_id TEXT NOT NULL,
    fence INTEGER,
    at TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (namespace, partition, seq),
    UNIQUE (namespace, partition, txn_id)
  ) STRICT;
  CREATE TABLE partition_heads (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    highest_fence INTEGER,
    PRIMARY KEY (namespace, partition)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE partition_snapshots (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    body TEXT NOT NULL,
    PRIMARY KEY (namespace, partition)
  ) STRICT, WITHOUT ROWID;
  `,
  // 1 → 2: the chunks each namespace's commits name (swamp-club#3249), what
  // chunk garbage collection must keep. Backfilled from the stored commits
  // by the rule Commit.chunkRefs applies to each new one: a put's blob adds
  // its sha256 when it has no parts, otherwise every part's. A body that is
  // not JSON, or not shaped like a commit, is skipped rather than failing
  // the migration: it is reported as corruption when its partition is
  // rebuilt, as before. Indexing too much only keeps a chunk.
  `
  CREATE TABLE chunk_refs (
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (namespace, sha256)
  ) STRICT, WITHOUT ROWID;
  INSERT OR IGNORE INTO chunk_refs (namespace, sha256)
    SELECT namespace, sha256 FROM (
      SELECT c.namespace AS namespace,
        CASE WHEN part.value IS NULL
          THEN json_extract(op.value, '$.blob.sha256')
          ELSE json_extract(part.value, '$.sha256')
        END AS sha256
      FROM commits AS c,
        json_each(CASE WHEN json_valid(c.body) THEN c.body ELSE '[]' END)
          AS root,
        json_each(
          CASE WHEN root.key = 'ops' AND root.type = 'array'
            THEN root.value ELSE '[]' END
        ) AS op
      LEFT JOIN json_each(
        CASE WHEN op.type = 'object'
            AND json_type(op.value, '$.blob.parts') = 'array'
          THEN json_extract(op.value, '$.blob.parts') ELSE '[]' END
      ) AS part
      WHERE op.type = 'object'
        AND json_extract(op.value, '$.kind') = 'put'
        AND json_type(op.value, '$.blob') = 'object'
        AND (part.value IS NULL OR part.type = 'object')
    )
    WHERE typeof(sha256) = 'text';
  `,
  // 2 → 3: history compaction (swamp-club#3258). The compaction point and
  // the compacted base (each partition's present records, live versions,
  // catalog rows and forwards, compacted seq, and each key's file
  // ownership), the txnIds of compacted commits, and chunks whose last
  // reference was compacted away. chunk_refs becomes a count of the stored
  // commits and base records naming each chunk, backfilled from the commits
  // by the rule of migration 1 → 2, counting each commit once. A catalog
  // row is always a live version with the same metadata (an upsert records
  // both, a removal drops the row), so base_catalog holds versions and takes
  // their metadata from base_versions. IF NOT EXISTS: a file rolled back to
  // an older schema by hand may still hold the new tables.
  `
  CREATE TABLE IF NOT EXISTS compaction (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    point INTEGER NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO compaction (id, point) VALUES (1, 0);
  CREATE TABLE IF NOT EXISTS compacted_partitions (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS compacted_txns (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition, txn_id)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS base_records (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    record_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    inline TEXT,
    blob TEXT,
    PRIMARY KEY (namespace, partition, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS base_versions (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name, version)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS base_catalog (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition, name, version)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS base_forwards (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    renamed_to TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS base_files (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    mark INTEGER NOT NULL,
    present INTEGER NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS released_chunks (
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    released_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, sha256)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS chunk_ref_counts (
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    refs INTEGER NOT NULL,
    PRIMARY KEY (namespace, sha256)
  ) STRICT, WITHOUT ROWID;
  INSERT INTO chunk_ref_counts (namespace, sha256, refs)
    SELECT namespace, sha256, COUNT(*) FROM (
      SELECT DISTINCT cursor, namespace, sha256 FROM (
        SELECT c.cursor AS cursor, c.namespace AS namespace,
          CASE WHEN part.value IS NULL
            THEN json_extract(op.value, '$.blob.sha256')
            ELSE json_extract(part.value, '$.sha256')
          END AS sha256
        FROM commits AS c,
          json_each(CASE WHEN json_valid(c.body) THEN c.body ELSE '[]' END)
            AS root,
          json_each(
            CASE WHEN root.key = 'ops' AND root.type = 'array'
              THEN root.value ELSE '[]' END
          ) AS op
        LEFT JOIN json_each(
          CASE WHEN op.type = 'object'
              AND json_type(op.value, '$.blob.parts') = 'array'
            THEN json_extract(op.value, '$.blob.parts') ELSE '[]' END
        ) AS part
        WHERE op.type = 'object'
          AND json_extract(op.value, '$.kind') = 'put'
          AND json_type(op.value, '$.blob') = 'object'
          AND (part.value IS NULL OR part.type = 'object')
      )
      WHERE typeof(sha256) = 'text'
    )
    GROUP BY namespace, sha256;
  DROP TABLE chunk_refs;
  ALTER TABLE chunk_ref_counts RENAME TO chunk_refs;
  `,
  // 3 → 4: the store-wide writer fence (swamp-club#3359), the highest fence
  // any writer of this datastore has taken. A commit naming a lower fence,
  // or none once it is set, is refused whatever partition it is for. A
  // Phase 3 store keeps its unfenced history; the first fence starts it.
  `
  CREATE TABLE IF NOT EXISTS writer_fence (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    fence INTEGER NOT NULL
  ) STRICT;
  `,
  // 4 → 5: pruning compacted_txns (swamp-club#3490). When each compacted
  // commit was made, so txnIds older than the commit outbox's retry bound
  // can go; those compacted before this migration count from it. The
  // compaction point's own commit, whose txnId a high-water mark check
  // reads and pruning keeps. A partition head's txnId is looked up by seq
  // once its commit was compacted. IF NOT EXISTS, as for 2 → 3.
  `
  CREATE TABLE IF NOT EXISTS compacted_txn_times (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition, txn_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS compacted_txn_times_by_time
    ON compacted_txn_times (committed_at);
  INSERT OR IGNORE INTO compacted_txn_times (namespace, partition, txn_id, committed_at)
    SELECT namespace, partition, txn_id, CAST(strftime('%s', 'now') AS INTEGER) * 1000
    FROM compacted_txns;
  CREATE INDEX IF NOT EXISTS compacted_txns_by_seq
    ON compacted_txns (namespace, partition, seq);
  CREATE TABLE IF NOT EXISTS compaction_point_commit (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    txn_id TEXT NOT NULL
  ) STRICT;
  `,
  // 5 → 6: partition snapshots may carry each data name's removed versions
  // (swamp-club#3532). No table changes; the version number is the point.
  // A swamp at schema 5 or below rejects the new snapshot field as an
  // unknown one and would call the store corrupt, so it must refuse the
  // store as newer instead.
  `SELECT 1;`,
  // 6 → 7: a put may carry its file's access (swamp-club#3693), and the
  // compacted base keeps it. A swamp at schema 6 or below rejects the new
  // op field as an unknown one and would call the store corrupt, so the
  // bump makes it refuse the store as newer instead. NULL is a plain file,
  // which every record compacted before this schema is.
  addColumnsIfAbsent([
    { table: "base_records", column: "access", type: "TEXT" },
  ]),
  // 7 → 8: which partitions name each chunk (swamp-club#3915), so serve can
  // authorise a chunk read by the partitions a caller may read. Counted like
  // chunk_refs, per partition: each stored commit and each compacted base
  // record of the partition naming the chunk counts once, and the row goes
  // when the count reaches zero. Backfilled in the migration's one
  // transaction, by migration 1 → 2's rule for commits and the base's own
  // rule for records (a blob's parts, else its sha256), so a crash part-way
  // leaves the store at schema 7 and the next open starts the backfill
  // again. It is one INSERT ... SELECT: SQLite groups in a temporary b-tree,
  // so its memory does not grow with the store. A swamp at schema 7 would
  // leave the index behind on every append, so it must refuse the store as
  // newer. IF NOT EXISTS and the DELETE, as for 2 → 3.
  `
  CREATE TABLE IF NOT EXISTS chunk_partitions (
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    partition TEXT NOT NULL,
    refs INTEGER NOT NULL,
    PRIMARY KEY (namespace, sha256, partition)
  ) STRICT, WITHOUT ROWID;
  DELETE FROM chunk_partitions;
  INSERT INTO chunk_partitions (namespace, sha256, partition, refs)
    SELECT namespace, sha256, partition, COUNT(*) FROM (
      SELECT DISTINCT 'commit' AS source, CAST(cursor AS TEXT) AS id,
        namespace, partition, sha256 FROM (
        SELECT c.cursor AS cursor, c.namespace AS namespace,
          c.partition AS partition,
          CASE WHEN part.value IS NULL
            THEN json_extract(op.value, '$.blob.sha256')
            ELSE json_extract(part.value, '$.sha256')
          END AS sha256
        FROM commits AS c,
          json_each(CASE WHEN json_valid(c.body) THEN c.body ELSE '[]' END)
            AS root,
          json_each(
            CASE WHEN root.key = 'ops' AND root.type = 'array'
              THEN root.value ELSE '[]' END
          ) AS op
        LEFT JOIN json_each(
          CASE WHEN op.type = 'object'
              AND json_type(op.value, '$.blob.parts') = 'array'
            THEN json_extract(op.value, '$.blob.parts') ELSE '[]' END
        ) AS part
        WHERE op.type = 'object'
          AND json_extract(op.value, '$.kind') = 'put'
          AND json_type(op.value, '$.blob') = 'object'
          AND (part.value IS NULL OR part.type = 'object')
      )
      WHERE typeof(sha256) = 'text'
      UNION ALL
      SELECT DISTINCT 'record', record_key, namespace, partition, sha256 FROM (
        SELECT r.namespace AS namespace, r.partition AS partition,
          r.record_key AS record_key,
          CASE WHEN part.value IS NULL
            THEN json_extract(r.blob, '$.sha256')
            ELSE json_extract(part.value, '$.sha256')
          END AS sha256
        FROM base_records AS r
        LEFT JOIN json_each(
          CASE WHEN json_valid(r.blob) THEN
            CASE WHEN json_type(r.blob, '$.parts') = 'array'
              THEN json_extract(r.blob, '$.parts') ELSE '[]' END
          ELSE '[]' END
        ) AS part
        WHERE r.blob IS NOT NULL AND json_valid(r.blob)
          AND (part.value IS NULL OR part.type = 'object')
      )
      WHERE typeof(sha256) = 'text'
    )
    GROUP BY namespace, sha256, partition;
  `,
  // 8 → 9: the log's id (swamp-club#4049), random, minted once for the
  // log: a failover, a Litestream restore and a restore from backup keep
  // it, a fresh deployment or another bucket has another. Serve reports it
  // on every datastore API reply, so a checkout's copy can tell the log it
  // follows from another one at the same address. Minted here for an
  // existing log too; a swamp at schema 8 would not report it, so it must
  // refuse the store as newer.
  `
  CREATE TABLE IF NOT EXISTS log_identity (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    log_id TEXT NOT NULL
  ) STRICT;
  INSERT OR IGNORE INTO log_identity (id, log_id)
    VALUES (1, lower(hex(randomblob(16))));
  `,
  // 9 → 10: the datastore's owner (swamp-club#4063), the serve address
  // `swamp datastore claim` names, written under the writer fence. A direct
  // writer that finds a row refuses; a swamp at schema 9 would not look, so
  // it must refuse the store as newer.
  `
  CREATE TABLE IF NOT EXISTS datastore_owner (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    address TEXT NOT NULL,
    claimed_at TEXT NOT NULL,
    claimed_at_cursor INTEGER NOT NULL
  ) STRICT;
  `,
  // 10 → 11: a tombstone may expect the digest of the version it removes
  // (swamp-club#4097). No table changes; the version number is the point.
  // A swamp at schema 10 or below refuses the new op field as a bad one and
  // would call the store corrupt, so it must refuse the store as newer
  // instead.
  `SELECT 1;`,
  // 11 → 12: a partition snapshot may carry a lease fence, counted apart
  // from the writer fence (swamp-club#4121). No table changes; the version
  // number is the point. A swamp at schema 11 or below rejects the new
  // snapshot field as an unknown one and would call the store corrupt, so
  // it must refuse the store as newer instead.
  `SELECT 1;`,
  // 12 → 13: a run's partition may hold step starts, under intents a swamp at
  // schema 12 or below does not know and would call corrupt; no table changes.
  `SELECT 1;`,
  // 13 → 14: no backfill, as a NULL changed_seq sits at or below its horizon,
  // which starts at the compacted seq and is reset whenever this step runs.
  (db) => {
    addColumnsIfAbsent(
      [
        "base_records",
        "base_versions",
        "base_catalog",
        "base_forwards",
        "base_files",
      ].map((table) => ({ table, column: "changed_seq", type: "INTEGER" })),
    )(db);
    db.exec(`
      CREATE TABLE IF NOT EXISTS base_removed (
        namespace TEXT NOT NULL,
        partition TEXT NOT NULL,
        section TEXT NOT NULL,
        row_key TEXT NOT NULL,
        removed_seq INTEGER NOT NULL,
        removed_at INTEGER NOT NULL,
        PRIMARY KEY (namespace, partition, section, row_key)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS base_removed_by_time
        ON base_removed (removed_at);
      CREATE TABLE IF NOT EXISTS difference_horizons (
        namespace TEXT NOT NULL,
        partition TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (namespace, partition)
      ) STRICT, WITHOUT ROWID;
      INSERT OR REPLACE INTO difference_horizons (namespace, partition, seq)
        SELECT namespace, partition, seq FROM compacted_partitions;
      CREATE TABLE IF NOT EXISTS base_sources (
        namespace TEXT NOT NULL,
        partition TEXT NOT NULL,
        seq INTEGER NOT NULL,
        PRIMARY KEY (namespace, partition)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_partition (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        namespace TEXT NOT NULL,
        partition TEXT NOT NULL,
        seq INTEGER NOT NULL,
        next TEXT,
        complete INTEGER NOT NULL,
        rows INTEGER NOT NULL DEFAULT 0
      ) STRICT;
      CREATE TABLE IF NOT EXISTS follow_state (
        namespace TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        idle INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staging_page_limits (
        namespace TEXT NOT NULL,
        partition TEXT NOT NULL,
        entries INTEGER NOT NULL,
        PRIMARY KEY (namespace, partition)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_records (
        record_key TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        inline TEXT,
        blob TEXT,
        access TEXT
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_versions (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        metadata TEXT NOT NULL,
        PRIMARY KEY (name, version)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_catalog (
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        PRIMARY KEY (name, version)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_forwards (
        name TEXT PRIMARY KEY,
        renamed_to TEXT NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS staged_files (
        record_key TEXT PRIMARY KEY,
        present INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
    `);
  },
];

/**
 * a run lock knows only the run id, the tail of its partition key. Outside the
 * migrations: every checkout shares a filesystem datastore's commits.db, and a
 * schema bump would lock an older swamp out of all of them
 */
const RUN_TAIL_INDEX = `
  CREATE INDEX IF NOT EXISTS partition_heads_by_tail
    ON partition_heads (namespace, substr(partition, -36));
`;

/** The owner row of `db` (swamp-club#4063), undefined when it holds none. */
function readOwner(db: DatabaseSync): DatastoreOwner | undefined {
  const row = db.prepare(
    "SELECT address, claimed_at, claimed_at_cursor FROM datastore_owner WHERE id = 1",
  ).get() as
    | { address: string; claimed_at: string; claimed_at_cursor: number }
    | undefined;
  if (row === undefined) return undefined;
  return DatastoreOwner.create({
    address: row.address,
    claimedAt: row.claimed_at,
    claimedAtCursor: row.claimed_at_cursor,
  });
}

/**
 * The owner the `commits.db` at `path` names, read without opening the
 * store: no migration, no write, and undefined for a file that is absent,
 * unreadable or from before owners (swamp-club#4063). A hint for a writer
 * that does not hold the lease yet; only {@link SqliteCommitStore.owner},
 * read under the lease, decides.
 */
export function peekDatastoreOwner(path: string): DatastoreOwner | undefined {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    return readOwner(db);
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/**
 * the cursor highWaterMark() reports, read from a file this process does not
 * open as a store (a restored replica); undefined when it cannot be read
 */
export function peekHighWaterCursor(path: string): number | undefined {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return undefined;
  }
  try {
    db.exec("BEGIN");
    try {
      const row = db.prepare(
        "SELECT cursor FROM commits ORDER BY cursor DESC LIMIT 1",
      ).get() as { cursor: number } | undefined;
      if (row !== undefined) return row.cursor;
      return (db.prepare("SELECT point FROM compaction WHERE id = 1").get() as
        | { point: number }
        | undefined)?.point ?? 0;
    } finally {
      db.exec("COMMIT");
    }
  } catch {
    return undefined;
  } finally {
    db.close();
  }
}

/** Error code for a `commits.db` written by a newer swamp. */
export const COMMIT_STORE_SCHEMA_NEWER_CODE = "datastore_v3_schema_newer";

/** The schema version this store writes. */
export const COMMIT_STORE_SCHEMA_VERSION = MIGRATIONS.length;

/** by partition_heads_by_tail, so a lookup reads only the run's own rows */
export const RUN_PARTITIONS_SQL =
  "SELECT partition FROM partition_heads WHERE namespace = ? " +
  "AND substr(partition, -36) = ? AND partition >= ? AND partition < ?";

/** How many rebuilt partitions a store keeps by default. */
export const DEFAULT_CACHED_PARTITIONS = 1024;

/** A partition's state is snapshotted every this many commits by default. */
export const DEFAULT_SNAPSHOT_INTERVAL = 1000;

/** Rows read per query while rebuilding a partition. */
// a page holds whole commit bodies, so a large commit's page stays short
const REBUILD_PAGE = 50;

/**
 * Commits folded per compaction transaction by default. The fold runs
 * synchronously inside the transaction, like an append's fsync.
 */
export const COMPACTION_BATCH = 250;

const FOLD_SLICE_MS = 50;

/** Hashes looked up per query by `referencedChunks`. */
const REF_LOOKUP_PAGE = 500;

/** Counts one more reference of a partition to a chunk. */
const INCREMENT_PARTITION_REF_SQL =
  "INSERT INTO chunk_partitions (namespace, sha256, partition, refs) VALUES (?, ?, ?, 1) " +
  "ON CONFLICT (namespace, sha256, partition) DO UPDATE SET refs = refs + 1";

/** Options for {@link SqliteCommitStore.open}. */
export interface SqliteCommitStoreOptions {
  /** How many rebuilt partitions to keep; {@link DEFAULT_CACHED_PARTITIONS}. */
  readonly cachedPartitions?: number;
  /**
   * Snapshot a partition every this many commits;
   * {@link DEFAULT_SNAPSHOT_INTERVAL}.
   */
  readonly snapshotInterval?: number;
  /**
   * Whether appends queued together share one transaction
   * (swamp-club#3915); true by default. Turned off only by tests and
   * benchmarks comparing the two.
   */
  readonly groupCommit?: boolean;
  /**
   * Whether a cached partition is restored from each snapshot it writes, so
   * its in-memory txnIds stay within the snapshot interval
   * (swamp-club#3915); true by default. Turned off only by tests and
   * benchmarks.
   */
  readonly boundTxnIds?: boolean;
  /**
   * Called inside an append's transaction once its rows are written, just
   * before it is reported appended. Tests throw from it to fail an append
   * after it wrote (swamp-club#3915).
   */
  readonly afterAppendWrites?: (commit: Commit) => void;
  /**
   * auto-checkpoint off, so only Litestream checkpoints: 0.5.17 can lose its
   * read lock and miss frames an auto-checkpoint's WAL restart drops; a store
   * opened without it is switched by {@link stopAutoCheckpointAt}
   */
  readonly replicated?: boolean;
  /**
   * Follower mode (swamp-club#3985): this `commits.db` is a copy of serve's
   * commit log, filled from serve's changes feed. Serve leaves out the
   * commits a caller may not read, so a partition's seqs here can have
   * permanent holes. A follower store appends through
   * {@link Partition.appendObserved}, taking any commit whose seq is past
   * its partition's head and moving the head to that seq, so the head row
   * is still the highest stored seq. Snapshots are written when a commit
   * crosses a multiple of the snapshot interval rather than lands on one,
   * and a truncation takes a partition back to the highest seq it keeps.
   * Every other rule, duplicate txnIds included, is the solo store's.
   *
   * Off by default, which is the solo store exactly. A file a follower wrote
   * may hold gaps a solo store refuses to rebuild, so one file is always
   * opened in the same mode. Only serve's team-mode plumbing passes it
   * (`integration/datastore_v3_rules_test.ts`).
   */
  readonly follower?: boolean;
}

/**
 * How many more times a serve-mode checkout's copy rebuilds a partition that
 * went stale again because other processes reading through serve keep
 * landing commits on it (swamp-club#4207). Each retry follows another
 * process's progress, so this bounds only a pathological run.
 */
const FOLLOWER_STALE_RETRIES = 50;

/**
 * The most commits one group commit appends in a transaction
 * (swamp-club#3915).
 */
export const GROUP_COMMIT_MAX_COMMITS = 64;

/**
 * How long, in milliseconds, a group commit may spend rebuilding the
 * partitions of the commits it takes before it stops taking more
 * (swamp-club#3915): a commit already taken waits at most about this long
 * for later ones to join its transaction. The rest wait for the next one.
 */
export const GROUP_COMMIT_MAX_WAIT_MS = 50;

/** The savepoint each commit of a group commit runs in. */
const GROUP_SAVEPOINT = "group_commit";

/** An append waiting in a group (swamp-club#3915). */
interface PendingAppend {
  readonly commit: Commit;
  readonly resolve: (result: CommitStoreAppendResult) => void;
  readonly reject: (error: unknown) => void;
}

/** An append a group commit has taken, with its partition rebuilt. */
interface GroupedAppend {
  readonly entry: PendingAppend;
  readonly cacheKey: string;
  /** undefined: a follower commit judged from the file, see #appendUnloaded */
  readonly partition: Partition | undefined;
}

/** A partition snapshot an append wrote. */
interface WrittenSnapshot {
  readonly seq: number;
  readonly body: string;
}

/** How a store stands against a published {@link HighWaterMark}. */
export type MarkCheck = "match" | "mismatch" | "compacted-past";

/**
 * {@link SqliteCommitStore.truncateAfter} refused a high-water mark, and
 * changed nothing (swamp-club#3482):
 *
 * - `compacted-past`: commits above the mark were folded into the compacted
 *   base, or a partition's history below its snapshot was, so the store
 *   cannot be taken back to the mark;
 * - `mismatch`: the store holds a different commit at the mark, or none at
 *   or past it (the copy misses acknowledged commits).
 */
export class CommitStoreTruncateRefusedError extends Error {
  readonly reason: "compacted-past" | "mismatch";

  constructor(reason: "compacted-past" | "mismatch", mark: HighWaterMark) {
    super(
      reason === "compacted-past"
        ? `commits.db cannot be truncated to cursor ${mark.cursor}: commits after it were compacted`
        : `commits.db cannot be truncated to cursor ${mark.cursor}: it does not hold the commit the high-water mark names`,
    );
    this.name = "CommitStoreTruncateRefusedError";
    this.reason = reason;
  }
}

interface CommitRow {
  readonly cursor: number;
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txn_id: string;
  readonly body: string;
}

/**
 * The SQLite {@link CommitStore}. One instance holds one connection, which is
 * the process's only writer to the file: a second writing process is a bug
 * that the writer lease prevents. Appends are serialized in the process,
 * and their asynchronous parts (rebuilding a partition) never run inside a
 * transaction.
 *
 * An append is synchronous between `BEGIN IMMEDIATE` and `COMMIT`, so it
 * blocks the event loop for its `fsync` (`synchronous=FULL`). Appends queued
 * while one runs share the next transaction (group commit,
 * swamp-club#3915): a burst of them pays one `fsync`, each commit in a
 * savepoint of its own so it keeps its own result or refusal. At most
 * {@link GROUP_COMMIT_MAX_COMMITS} share one.
 */
export class SqliteCommitStore implements CommitStore, ObservedCopyRepair {
  readonly #db: DatabaseSync;
  readonly #cachedPartitions: number;
  readonly #snapshotInterval: number;
  /** Rebuilt partitions, least recently used first. */
  readonly #cache = new Map<string, Partition>();
  readonly #groupCommit: boolean;
  readonly #boundTxnIds: boolean;
  readonly #afterAppendWrites: ((commit: Commit) => void) | undefined;
  /** {@link SqliteCommitStoreOptions.follower}. */
  readonly #follower: boolean;
  readonly #indexCache = new Map<
    string,
    { point: number; entries: readonly BaseIndexEntry[] }
  >();
  /** base index builds under way, one per namespace, joined by every request for that point */
  readonly #indexBuilds = new Map<
    string,
    { point: number; build: Promise<readonly BaseIndexEntry[]> }
  >();
  #connectionKey: string | undefined;
  /** Append transactions committed; see {@link appendTransactions}. */
  #appendTransactions = 0;
  #rebuilds = 0;
  /** {@link onHeadMoved}'s listeners. */
  readonly #headListeners = new Set<(replaced: boolean) => void>();
  /** The leader's cursor {@link appendFromLeader} inserts its commit at. */
  #leaderCursor: number | undefined;
  #queue: Promise<unknown> = Promise.resolve();
  /**
   * The appends queued since the last other queued work, not yet started:
   * appends queued now join them (swamp-club#3915).
   */
  #openGroup: PendingAppend[] | undefined;
  #closed = false;

  readonly #selectHead: StatementSync;
  readonly #selectTxnSeq: StatementSync;
  readonly #selectTxnUpTo: StatementSync;
  readonly #selectTxnAtSeq: StatementSync;
  readonly #selectMaxSeq: StatementSync;
  readonly #insertCommit: StatementSync;
  readonly #selectHeadCursor: StatementSync;
  readonly #selectLastCursor: StatementSync;
  /**
   * the cursor of the newest commit that changes what other commits are judged
   * against; set at insert, so one rolled back may leave it past the last
   * cursor, which authorityCursor clamps
   */
  #authorityCursor: number;
  readonly #upsertHead: StatementSync;
  readonly #selectPartitionPage: StatementSync;
  readonly #selectNewestAfter: StatementSync;
  readonly #selectChanges: StatementSync;
  readonly #selectSnapshot: StatementSync;
  readonly #upsertSnapshot: StatementSync;
  readonly #insertChunkRef: StatementSync;
  readonly #insertChunkPartition: StatementSync;
  readonly #selectChunkPartitions: StatementSync;
  readonly #selectChunkPartitionsAfter: StatementSync;
  readonly #selectBaseKeysNaming: StatementSync;
  /** `referencedChunks` for a full page of {@link REF_LOOKUP_PAGE} hashes. */
  readonly #selectRefPage: StatementSync;
  readonly #selectPoint: StatementSync;
  readonly #selectCompactedSeq: StatementSync;
  readonly #selectWriterFence: StatementSync;
  readonly #upsertWriterFence: StatementSync;
  /** The compacted base's tables (swamp-club#3258). */
  readonly #base: SqliteCompactedBase;

  private constructor(
    db: DatabaseSync,
    cachedPartitions: number,
    snapshotInterval: number,
    groupCommit: boolean,
    boundTxnIds: boolean,
    afterAppendWrites: ((commit: Commit) => void) | undefined,
    follower: boolean,
  ) {
    this.#db = db;
    this.#follower = follower;
    this.#cachedPartitions = cachedPartitions;
    this.#snapshotInterval = snapshotInterval;
    this.#groupCommit = groupCommit;
    this.#boundTxnIds = boundTxnIds;
    this.#afterAppendWrites = afterAppendWrites;
    this.#selectHead = db.prepare(
      "SELECT seq, highest_fence FROM partition_heads WHERE namespace = ? AND partition = ?",
    );
    // A compacted commit's txnId lives on in compacted_txns, so a retry of
    // it is still a duplicate (swamp-club#3258).
    this.#selectTxnSeq = db.prepare(
      "SELECT seq FROM commits WHERE namespace = ?1 AND partition = ?2 AND txn_id = ?3 " +
        "UNION ALL SELECT seq FROM compacted_txns WHERE namespace = ?1 AND partition = ?2 AND txn_id = ?3 LIMIT 1",
    );
    this.#selectTxnUpTo = db.prepare(
      "SELECT 1 AS found FROM commits WHERE namespace = ?1 AND partition = ?2 AND txn_id = ?3 AND seq <= ?4 " +
        "UNION ALL SELECT 1 FROM compacted_txns WHERE namespace = ?1 AND partition = ?2 AND txn_id = ?3 AND seq <= ?4 LIMIT 1",
    );
    this.#selectTxnAtSeq = db.prepare(
      "SELECT txn_id FROM commits WHERE namespace = ?1 AND partition = ?2 AND seq = ?3 " +
        "UNION ALL SELECT txn_id FROM compacted_txns WHERE namespace = ?1 AND partition = ?2 AND seq = ?3 LIMIT 1",
    );
    // A partition's last stored seq, or its compacted seq when compaction
    // removed every commit it had.
    this.#selectMaxSeq = db.prepare(
      "SELECT MAX(seq) AS seq FROM (" +
        "SELECT MAX(seq) AS seq FROM commits WHERE namespace = ?1 AND partition = ?2 " +
        "UNION ALL SELECT seq FROM compacted_partitions WHERE namespace = ?1 AND partition = ?2)",
    );
    this.#insertCommit = db.prepare(
      "INSERT INTO commits (namespace, partition, seq, txn_id, fence, at, body) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.#selectHeadCursor = db.prepare(
      "SELECT cursor FROM commits WHERE namespace = ? AND partition = ? ORDER BY seq DESC LIMIT 1",
    );
    this.#selectLastCursor = db.prepare(
      "SELECT MAX(cursor) AS cursor FROM commits",
    );
    // Opened with history whose kind is not known: every commit so far counts.
    this.#authorityCursor = this.lastCursor();
    this.#upsertHead = db.prepare(
      "INSERT INTO partition_heads (namespace, partition, seq, highest_fence) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = excluded.seq, highest_fence = excluded.highest_fence",
    );
    this.#selectPartitionPage = db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
        "WHERE namespace = ? AND partition = ? AND seq >= ? ORDER BY seq LIMIT ?",
    );
    this.#selectNewestAfter = db.prepare(
      "SELECT body FROM commits WHERE namespace = ? AND partition = ? AND seq > ? ORDER BY seq DESC",
    );
    // a follower's history-only commits are in the base: the feed never serves them
    this.#selectChanges = db.prepare(
      follower
        ? "SELECT c.cursor, c.namespace, c.partition, c.seq, c.txn_id, c.body FROM commits AS c WHERE c.cursor > ? " +
          "AND NOT EXISTS (SELECT 1 FROM compacted_partitions AS p WHERE p.namespace = c.namespace AND p.partition = c.partition AND p.seq >= c.seq) " +
          "ORDER BY c.cursor LIMIT ?"
        : "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits WHERE cursor > ? ORDER BY cursor LIMIT ?",
    );
    this.#selectSnapshot = db.prepare(
      "SELECT seq, body FROM partition_snapshots WHERE namespace = ? AND partition = ?",
    );
    this.#upsertSnapshot = db.prepare(
      "INSERT INTO partition_snapshots (namespace, partition, seq, body) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = excluded.seq, body = excluded.body",
    );
    this.#insertChunkRef = db.prepare(
      "INSERT INTO chunk_refs (namespace, sha256, refs) VALUES (?, ?, 1) " +
        "ON CONFLICT (namespace, sha256) DO UPDATE SET refs = refs + 1",
    );
    this.#insertChunkPartition = db.prepare(INCREMENT_PARTITION_REF_SQL);
    this.#selectChunkPartitions = db.prepare(
      "SELECT partition FROM chunk_partitions WHERE namespace = ? AND sha256 = ? ORDER BY partition LIMIT ?",
    );
    this.#selectChunkPartitionsAfter = db.prepare(
      "SELECT partition FROM chunk_partitions WHERE namespace = ? AND sha256 = ? AND partition > ? ORDER BY partition LIMIT ?",
    );
    // As the chunk_partitions backfill reads a base record's blob: its
    // parts, or its own digest when it has none.
    this.#selectBaseKeysNaming = db.prepare(
      `SELECT DISTINCT r.record_key AS record_key
        FROM base_records AS r
        LEFT JOIN json_each(
          CASE WHEN json_valid(r.blob) AND json_type(r.blob, '$.parts') = 'array'
            THEN json_extract(r.blob, '$.parts') ELSE '[]' END
        ) AS part
        WHERE r.namespace = ? AND r.partition = ?
          AND r.blob IS NOT NULL AND json_valid(r.blob)
          AND (part.key IS NULL OR part.type = 'object')
          AND (CASE WHEN part.key IS NULL
            THEN json_extract(r.blob, '$.sha256')
            ELSE json_extract(part.value, '$.sha256')
          END) = ?
        ORDER BY r.record_key`,
    );
    this.#selectRefPage = db.prepare(selectRefsSql(REF_LOOKUP_PAGE));
    this.#selectPoint = db.prepare(
      "SELECT point FROM compaction WHERE id = 1",
    );
    this.#selectCompactedSeq = db.prepare(
      "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
    );
    this.#selectWriterFence = db.prepare(
      "SELECT fence FROM writer_fence WHERE id = 1",
    );
    this.#upsertWriterFence = db.prepare(
      "INSERT INTO writer_fence (id, fence) VALUES (1, ?) " +
        "ON CONFLICT (id) DO UPDATE SET fence = excluded.fence",
    );
    this.#base = new SqliteCompactedBase(db);
  }

  /**
   * Opens the store at `path`, creating the file and its schema when absent.
   * Refuses a database written by a newer schema.
   */
  static open(
    path: string,
    options: SqliteCommitStoreOptions = {},
  ): SqliteCommitStore {
    const cachedPartitions = options.cachedPartitions ??
      DEFAULT_CACHED_PARTITIONS;
    requirePositive(cachedPartitions, "cachedPartitions");
    const snapshotInterval = options.snapshotInterval ??
      DEFAULT_SNAPSHOT_INTERVAL;
    requirePositive(snapshotInterval, "snapshotInterval");
    const key = resolve(path);
    const store = new SqliteCommitStore(
      openCommitsDatabase(path, {
        replicated: options.replicated === true ||
          autoCheckpointOffAt.has(key),
      }),
      cachedPartitions,
      snapshotInterval,
      options.groupCommit ?? true,
      options.boundTxnIds ?? true,
      options.afterAppendWrites,
      options.follower === true,
    );
    store.#connectionKey = key;
    let connections = storeConnections.get(key);
    if (connections === undefined) {
      connections = new Set();
      storeConnections.set(key, connections);
    }
    connections.add(store.#db);
    return store;
  }

  /**
   * How many append transactions this store has committed: with group
   * commit, fewer than the commits it appended (swamp-club#3915). For tests
   * and benchmarks.
   */
  get appendTransactions(): number {
    return this.#appendTransactions;
  }

  /** the transaction's COMMIT is its fsync; the span counts what it covered */
  #commitAppends(commits: number): void {
    withSyncSpan(
      "swamp.datastore.v3.commit_store.fsync",
      { "swamp.datastore.v3.commits": commits },
      () => this.#db.exec("COMMIT"),
    );
    this.#appendTransactions++;
  }

  /** for tests */
  get rebuilds(): number {
    return this.#rebuilds;
  }

  /** How many rebuilt partitions the store holds; for tests and diagnostics. */
  get cachedPartitionCount(): number {
    return this.#cache.size;
  }

  /**
   * The log's id (swamp-club#4049): random, minted once for the log and
   * kept by every copy and restore of it, so two logs never share one.
   */
  logId(): string {
    this.#assertOpen();
    return (this.#db.prepare(
      "SELECT log_id FROM log_identity WHERE id = 1",
    ).get() as { log_id: string }).log_id;
  }

  /**
   * The datastore's owner (swamp-club#4063), or undefined while no serve
   * has claimed it. Read from the file, so a claim another connection wrote
   * is seen.
   */
  owner(): DatastoreOwner | undefined {
    this.#assertOpen();
    return readOwner(this.#db);
  }

  /**
   * Records `owner` as the datastore's owner, replacing any claim, for the
   * writer holding `fence`: a writer that lost its lease cannot claim.
   * Runs in its own write transaction, queued behind appends in flight.
   *
   * @throws WriterFencedError when the store has seen a higher fence
   */
  claimOwner(fence: number, owner: DatastoreOwner): Promise<void> {
    return this.#writeOwner(fence, () => {
      this.#db.prepare(
        "INSERT INTO datastore_owner (id, address, claimed_at, claimed_at_cursor) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET address = excluded.address, " +
          "claimed_at = excluded.claimed_at, claimed_at_cursor = excluded.claimed_at_cursor",
      ).run(owner.address, owner.claimedAt, owner.claimedAtCursor);
    });
  }

  /**
   * Removes the datastore's claim, for the writer holding `fence`; nothing
   * to remove is not an error.
   *
   * @throws WriterFencedError when the store has seen a higher fence
   */
  releaseOwner(fence: number): Promise<void> {
    return this.#writeOwner(fence, () => {
      this.#db.exec("DELETE FROM datastore_owner WHERE id = 1");
    });
  }

  #writeOwner(fence: number, write: () => void): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    if (this.#follower) {
      // A serve-mode copy follows serve's log: serve writes the claim.
      return Promise.reject(
        new Error(
          "Internal error: a serve-mode copy of a v3 datastore cannot be claimed or released",
        ),
      );
    }
    if (!Number.isSafeInteger(fence) || fence < 1) {
      return Promise.reject(
        new Error(`A writer fence must be an integer from 1: ${fence}`),
      );
    }
    return this.#enqueue(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#checkWriterFence(fence);
        write();
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        throw error;
      }
    });
  }

  /**
   * The highest writer fence this store has seen (swamp-club#3359), or
   * undefined while no fenced writer has written it.
   */
  writerFence(): number | undefined {
    this.#assertOpen();
    return this.#storedWriterFence();
  }

  /**
   * Records that the writer holding `fence` has taken over: from now on a
   * commit naming a lower fence, or none, is refused. Runs in its own write
   * transaction, queued behind appends in flight.
   *
   * @throws WriterFencedError when the store has seen a higher fence
   */
  raiseWriterFence(fence: number): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    if (!Number.isSafeInteger(fence) || fence < 1) {
      return Promise.reject(
        new Error(`A writer fence must be an integer from 1: ${fence}`),
      );
    }
    return this.#enqueue(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#checkWriterFence(fence);
        const stored = this.#storedWriterFence();
        if (stored === undefined || fence > stored) {
          this.#upsertWriterFence.run(fence);
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        throw error;
      }
    });
  }

  #storedWriterFence(): number | undefined {
    return (this.#selectWriterFence.get() as { fence: number } | undefined)
      ?.fence;
  }

  /**
   * Inside a write transaction: refuses a writer whose fence is below the
   * store's, or that has none once the store has one. What keeps a writer
   * that lost its lease from landing anything, on every partition at once.
   * Only {@link raiseWriterFence} moves the store's fence.
   */
  #checkWriterFence(fence: number | undefined): void {
    const stored = this.#storedWriterFence();
    if (stored === undefined) return;
    if (fence === undefined || fence < stored) {
      throw new WriterFencedError(fence, stored);
    }
  }

  /**
   * A data name's high-water mark in its partition, from the file: a cached
   * partition another connection has since written is rebuilt first.
   */
  dataHighWater(
    namespace: string,
    key: PartitionKey,
    name: string,
  ): Promise<number> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(async () => {
      let partition = await this.#partition(namespace, key);
      const head = this.#selectHead.get(namespace, key.toString()) as
        | { seq: number }
        | undefined;
      if ((head?.seq ?? 0) !== partition.seq) {
        this.#cache.delete(cacheKeyOf(namespace, key.toString()));
        partition = await this.#partition(namespace, key);
      }
      return partition.highWater(name);
    });
  }

  /**
   * The digest of record `record` as `key`'s partition holds it now, from
   * the file (swamp-club#4097); undefined when absent. A cached partition
   * another connection has since written is rebuilt first.
   */
  recordSha256(
    namespace: string,
    key: PartitionKey,
    record: RecordKey,
  ): Promise<string | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(async () => {
      let partition = await this.#partition(namespace, key);
      const head = this.#selectHead.get(namespace, key.toString()) as
        | { seq: number }
        | undefined;
      if ((head?.seq ?? 0) !== partition.seq) {
        this.#cache.delete(cacheKeyOf(namespace, key.toString()));
        partition = await this.#partition(namespace, key);
      }
      return partition.record(record)?.sha256;
    });
  }

  /**
   * A partition's lease fence and each data name's version marks as it
   * stands now, from the file (swamp-club#4121): what serve hands a model
   * lease's holder, so it allocates versions above every one already used
   * and serve issues a fence above every one a lease op carried.
   */
  leaseMarks(
    namespace: string,
    key: PartitionKey,
  ): Promise<PartitionLeaseMarks> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(async () => {
      let partition = await this.#partition(namespace, key);
      const head = this.#selectHead.get(namespace, key.toString()) as
        | { seq: number }
        | undefined;
      if ((head?.seq ?? 0) !== partition.seq) {
        this.#cache.delete(cacheKeyOf(namespace, key.toString()));
        partition = await this.#partition(namespace, key);
      }
      return {
        leaseFence: partition.leaseFence,
        names: partition.dataNameMarks(),
      };
    });
  }

  /**
   * A compacted partition's compacted seq, with each data name's version
   * marks as the partition stands now (swamp-club#4006); undefined when the
   * partition was never compacted. Serve sends them with the compacted
   * base, so a follower copy built from it never picks a version number
   * already used: a high-water mark only grows and removed ranges only
   * gain entries, so marks newer than the compacted seq are safe.
   */
  compactedPartition(
    namespace: string,
    key: PartitionKey,
  ): Promise<CompactedPartitionMarks | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(async () => {
      const row = this.#db.prepare(
        "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
      ).get(namespace, key.toString()) as { seq: number } | undefined;
      if (row === undefined) return undefined;
      let partition = await this.#partition(namespace, key);
      const head = this.#selectHead.get(namespace, key.toString()) as
        | { seq: number }
        | undefined;
      if ((head?.seq ?? 0) !== partition.seq) {
        this.#cache.delete(cacheKeyOf(namespace, key.toString()));
        partition = await this.#partition(namespace, key);
      }
      const names = partition.snapshot().names.map((name) => ({
        name: name.name,
        highWater: name.highWater,
        ...(name.removed === undefined ? {} : { removed: name.removed }),
      }));
      return { seq: row.seq, names };
    });
  }

  /**
   * A copy of `key` as this store holds it now (swamp-club#4195), for a
   * rebase to read: its versions, latest and high-water marks. It holds no
   * txnIds and never changes with later appends.
   */
  partitionState(namespace: string, key: PartitionKey): Promise<Partition> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(async () => {
      let partition = await this.#partition(namespace, key);
      const head = this.#selectHead.get(namespace, key.toString()) as
        | { seq: number }
        | undefined;
      if ((head?.seq ?? 0) !== partition.seq) {
        this.#cache.delete(cacheKeyOf(namespace, key.toString()));
        partition = await this.#partition(namespace, key);
      }
      return Partition.restore(key, partition.snapshot(), () => false);
    });
  }

  /**
   * Appends a commit a team follower received from its leader's commit feed
   * (swamp-club#4120) at the leader's own `cursor`, so cursors mean the same
   * commit on every node. The commit goes through the same rules as any
   * append: the partition's next seq, and a fence no lower than the
   * store's. A cursor this store already holds is a duplicate when it holds
   * the same commit there (a resubscribe overlapped), else the copy has
   * diverged from the leader: {@link FeedDivergedError}, and the follower
   * restores from the lineage instead.
   *
   * @throws FeedDivergedError when the copy cannot take the commit in order
   */
  appendFromLeader(
    change: CommitChange,
  ): Promise<CommitStoreAppendResult> {
    if (this.#closed) return Promise.reject(closedError());
    if (this.#follower) {
      return Promise.reject(
        new Error(
          "Internal error: a serve-mode checkout's copy takes serve's commits through append, not a leader's",
        ),
      );
    }
    const { cursor, commit } = change;
    return this.#enqueue(async () => {
      const held = this.#db.prepare(
        "SELECT namespace, partition, txn_id FROM commits WHERE cursor = ?",
      ).get(cursor) as
        | { namespace: string; partition: string; txn_id: string }
        | undefined;
      if (held !== undefined) {
        if (
          held.namespace === commit.namespace &&
          held.partition === commit.partition.toString() &&
          held.txn_id === commit.txnId
        ) {
          return { kind: "duplicate" as const, seq: commit.seq };
        }
        throw new FeedDivergedError(
          `this copy holds another commit at the leader's cursor ${cursor}`,
        );
      }
      const top = this.highWaterMark().cursor;
      if (cursor <= top) {
        throw new FeedDivergedError(
          `the leader's cursor ${cursor} is behind this copy's ${top}`,
        );
      }
      this.#leaderCursor = cursor;
      try {
        const result = await this.#append(commit, false);
        if (result.kind !== "appended") {
          throw new FeedDivergedError(
            `the leader's commit at cursor ${cursor} is already applied at another position`,
          );
        }
        return result;
      } catch (error) {
        if (error instanceof FeedDivergedError) throw error;
        throw new FeedDivergedError(
          `the leader's commit at cursor ${cursor} did not apply: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      } finally {
        this.#leaderCursor = undefined;
      }
    }).then((result) => {
      this.#notifyHeadMoved();
      return result;
    });
  }

  /** commits a base install could still fold, counted no further than `atMost` */
  foldableCommits(atMost = Number.MAX_SAFE_INTEGER): Promise<number> {
    if (this.#closed) return Promise.reject(closedError());
    return Promise.resolve(
      Number(
        (this.#db.prepare(
          "SELECT COUNT(*) AS n FROM (SELECT 1 FROM commits AS c WHERE NOT EXISTS (SELECT 1 FROM compacted_partitions AS p " +
            "WHERE p.namespace = c.namespace AND p.partition = c.partition AND p.seq >= c.seq) LIMIT ?)",
        ).get(atMost) as { n: number }).n,
      ),
    );
  }

  /** each partition's compacted seq, and the serve seq its base came from */
  basePositions(
    namespace: string,
  ): Promise<ReadonlyMap<string, { compacted: number; source?: number }>> {
    if (this.#closed) return Promise.reject(closedError());
    const positions = new Map<string, { compacted: number; source?: number }>();
    for (
      const row of this.#db.prepare(
        "SELECT p.partition, p.seq, s.seq AS source FROM compacted_partitions AS p " +
          "LEFT JOIN base_sources AS s USING (namespace, partition) WHERE p.namespace = ?",
      ).all(namespace) as {
        partition: string;
        seq: number;
        source: number | null;
      }[]
    ) {
      positions.set(row.partition, {
        compacted: row.seq,
        ...(row.source === null ? {} : { source: row.source }),
      });
    }
    return Promise.resolve(positions);
  }

  /** the partition being staged a page at a time, if any */
  stagedPartition(): Promise<StagedPartition | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    const row = this.#db.prepare(
      "SELECT namespace, partition, seq, next, complete, rows FROM staged_partition WHERE id = 1",
    ).get() as
      | {
        namespace: string;
        partition: string;
        seq: number;
        next: string | null;
        complete: number;
        rows: number;
      }
      | undefined;
    return Promise.resolve(
      row === undefined ? undefined : {
        namespace: row.namespace,
        partition: row.partition,
        seq: row.seq,
        ...(row.next === null ? {} : { next: row.next }),
        complete: row.complete === 1,
        rows: row.rows,
      },
    );
  }

  /**
   * Adds one page of a partition's whole base to the staging tables. A page of
   * another partition or seq starts the staging over: one base, one seq.
   */
  stagePartitionPage(page: {
    readonly namespace: string;
    readonly partition: string;
    readonly seq: number;
    readonly entries: readonly ObservedBaseEntry[];
    readonly next: string | undefined;
  }): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const marker = this.#db.prepare(
          "SELECT namespace, partition, seq FROM staged_partition WHERE id = 1",
        ).get() as
          | { namespace: string; partition: string; seq: number }
          | undefined;
        if (
          marker === undefined || marker.namespace !== page.namespace ||
          marker.partition !== page.partition || marker.seq !== page.seq
        ) {
          this.#clearStaging();
        }
        const put = {
          record: this.#db.prepare(
            "INSERT OR REPLACE INTO staged_records (record_key, sha256, inline, blob, access) VALUES (?, ?, ?, ?, ?)",
          ),
          version: this.#db.prepare(
            "INSERT OR REPLACE INTO staged_versions (name, version, metadata) VALUES (?, ?, ?)",
          ),
          catalog: this.#db.prepare(
            "INSERT OR REPLACE INTO staged_catalog (name, version) VALUES (?, ?)",
          ),
          forward: this.#db.prepare(
            "INSERT OR REPLACE INTO staged_forwards (name, renamed_to) VALUES (?, ?)",
          ),
          file: this.#db.prepare(
            "INSERT OR REPLACE INTO staged_files (record_key, present) VALUES (?, ?)",
          ),
        };
        let added = 0;
        for (const entry of page.entries) {
          if (entry.namespace !== page.namespace) {
            throw new Error(
              `A base entry of namespace ${entry.namespace} is not this copy's`,
            );
          }
          if (entry.kind !== "file" && entry.partition !== page.partition) {
            throw new Error(
              `A base entry of partition ${entry.partition} came in the base of ${page.partition}`,
            );
          }
          if (entry.kind !== "partition") added++;
          switch (entry.kind) {
            case "partition":
              break;
            case "record": {
              const blob = "blob" in entry.record.content
                ? entry.record.content.blob
                : undefined;
              put.record.run(
                entry.key,
                entry.record.sha256,
                "inline" in entry.record.content
                  ? entry.record.content.inline
                  : null,
                blob === undefined ? null : JSON.stringify(blob.toJSON()),
                entry.record.access ?? null,
              );
              break;
            }
            case "version":
              put.version.run(
                entry.version.metadata.name,
                entry.version.version,
                JSON.stringify(entry.version.metadata),
              );
              break;
            case "catalog-row":
              put.catalog.run(entry.metadata.name, entry.metadata.version);
              break;
            case "forward":
              put.forward.run(entry.name, entry.to);
              break;
            case "file":
              if (entry.ownership.owner !== page.partition) {
                throw new Error(
                  `A file owned by ${entry.ownership.owner} came in the base of ${page.partition}`,
                );
              }
              put.file.run(entry.key, entry.ownership.present ? 1 : 0);
              break;
          }
        }
        const before = (this.#db.prepare(
          "SELECT rows FROM staged_partition WHERE id = 1",
        ).get() as { rows: number } | undefined)?.rows ?? 0;
        this.#db.prepare(
          "INSERT OR REPLACE INTO staged_partition (id, namespace, partition, seq, next, complete, rows) VALUES (1, ?, ?, ?, ?, ?, ?)",
        ).run(
          page.namespace,
          page.partition,
          page.seq,
          page.next ?? null,
          page.next === undefined ? 1 : 0,
          before + added,
        );
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        throw error;
      }
      return Promise.resolve();
    });
  }

  /** the page size staging this partition last fell back to, if any */
  stagingPageLimit(
    namespace: string,
    partition: string,
  ): Promise<number | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    return Promise.resolve(
      (this.#db.prepare(
        "SELECT entries FROM staging_page_limits WHERE namespace = ? AND partition = ?",
      ).get(namespace, partition) as { entries: number } | undefined)
        ?.entries,
    );
  }

  /** undefined forgets it, once the partition is swapped in */
  setStagingPageLimit(
    namespace: string,
    partition: string,
    entries: number | undefined,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(() => {
      if (entries === undefined) {
        this.#db.prepare(
          "DELETE FROM staging_page_limits WHERE namespace = ? AND partition = ?",
        ).run(namespace, partition);
      } else {
        this.#db.prepare(
          "INSERT OR REPLACE INTO staging_page_limits (namespace, partition, entries) VALUES (?, ?, ?)",
        ).run(namespace, partition, entries);
      }
      return Promise.resolve();
    });
  }

  /** forgets a staged partition, for one serve has moved past or refused */
  clearStagedPartition(): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(() => {
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        this.#clearStaging();
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        throw error;
      }
      return Promise.resolve();
    });
  }

  #clearStaging(): void {
    for (
      const table of [
        "staged_partition",
        "staged_records",
        "staged_versions",
        "staged_catalog",
        "staged_forwards",
        "staged_files",
      ]
    ) {
      this.#db.exec(`DELETE FROM ${table}`);
    }
  }

  #stagedRows(): number {
    let rows = 0;
    for (
      const table of [
        "staged_records",
        "staged_versions",
        "staged_catalog",
        "staged_forwards",
        "staged_files",
      ]
    ) {
      rows += (this.#db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }).n;
    }
    return rows;
  }

  /** one set-based transaction, so no reader ever sees half a swapped base */
  installStagedPartition(
    readModelCursor: number,
  ): Promise<PartitionInstallOutcome> {
    if (this.#closed) return Promise.reject(closedError());
    if (!this.#follower) {
      return Promise.reject(
        new Error(
          "Internal error: only a serve-mode copy installs serve's base by partition",
        ),
      );
    }
    return this.#enqueue(() => this.#installStaged(readModelCursor)).finally(
      () => this.#notifyHeadMoved(true),
    );
  }

  async #installStaged(
    readModelCursor: number,
  ): Promise<PartitionInstallOutcome> {
    const marker = this.#db.prepare(
      "SELECT namespace, partition, seq, complete FROM staged_partition WHERE id = 1",
    ).get() as
      | { namespace: string; partition: string; seq: number; complete: number }
      | undefined;
    if (marker === undefined || marker.complete !== 1) {
      throw new Error("Internal error: no completely staged partition");
    }
    const { namespace, partition, seq } = marker;
    const ready = this.#installReady(
      namespace,
      partition,
      seq,
      readModelCursor,
    );
    if (ready !== undefined) return ready;
    const latest = this.#selectSnapshot.get(namespace, partition) as
      | { seq: number }
      | undefined;
    const removing = await this.#foldable(
      namespace,
      partition,
      Math.min(seq, latest?.seq ?? 0),
    );
    const mark = this.#markBelowLater(namespace, partition, seq);
    const rows = this.#stagedRows();
    const compacted = this.#compactedSeq(namespace, partition);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#compactedSeq(namespace, partition) !== compacted) {
        throw new Error(
          `Partition ${partition} was compacted during its base install: another process is writing the store`,
        );
      }
      const base = this.#base;
      base.begin(Date.now());
      this.#swapChunkCounts(base, namespace, partition);
      const scope = [namespace, partition] as const;
      this.#db.prepare(
        "DELETE FROM base_records WHERE namespace = ? AND partition = ?",
      ).run(...scope);
      this.#db.prepare(
        "INSERT INTO base_records (namespace, partition, record_key, sha256, inline, blob, access) " +
          "SELECT ?, ?, record_key, sha256, inline, blob, access FROM staged_records",
      ).run(...scope);
      this.#db.prepare(
        "DELETE FROM base_versions WHERE namespace = ? AND partition = ?",
      ).run(...scope);
      this.#db.prepare(
        "INSERT INTO base_versions (namespace, partition, name, version, metadata) " +
          "SELECT ?, ?, name, version, metadata FROM staged_versions",
      ).run(...scope);
      this.#db.prepare(
        "DELETE FROM base_catalog WHERE namespace = ? AND partition = ?",
      ).run(...scope);
      this.#db.prepare(
        "INSERT INTO base_catalog (namespace, partition, name, version) " +
          "SELECT ?, ?, name, version FROM staged_catalog",
      ).run(...scope);
      this.#db.prepare(
        "DELETE FROM base_forwards WHERE namespace = ? AND partition = ?",
      ).run(...scope);
      this.#db.prepare(
        "INSERT INTO base_forwards (namespace, partition, name, renamed_to) " +
          "SELECT ?, ?, name, renamed_to FROM staged_forwards",
      ).run(...scope);
      this.#db.prepare(
        "DELETE FROM base_files WHERE namespace = ? AND owner = ?",
      ).run(...scope);
      this.#db.prepare(
        "INSERT OR REPLACE INTO base_files (namespace, record_key, owner, mark, present) " +
          "SELECT ?, record_key, ?, ?, present FROM staged_files",
      ).run(namespace, partition, mark);
      this.#finishInstall(base, namespace, partition, seq, removing);
      this.#clearStaging();
      this.#assertChunkCounts(namespace, base.touched);
      this.#db.exec("COMMIT");
      this.#cache.delete(cacheKeyOf(namespace, partition));
      return { kind: "installed", rows, commitsRemoved: removing.rows.length };
    } catch (error) {
      rollbackQuietly(this.#db);
      this.#cache.delete(cacheKeyOf(namespace, partition));
      throw error;
    }
  }

  /**
   * Moves the partition's chunk counts from its current base records to the
   * staged ones, counting each record's chunks once, as putRecord does.
   */
  #swapChunkCounts(
    base: SqliteCompactedBase,
    namespace: string,
    partition: string,
  ): void {
    const chunksOf = (from: string, where: string) =>
      new Map(
        (this.#db.prepare(
          "SELECT sha, COUNT(*) AS n FROM (SELECT DISTINCT r.record_key AS k, " +
            "CASE WHEN json_type(r.blob, '$.parts') = 'array' THEN json_extract(p.value, '$.sha256') " +
            "ELSE json_extract(r.blob, '$.sha256') END AS sha " +
            `FROM ${from} AS r LEFT JOIN json_each(CASE WHEN json_type(r.blob, '$.parts') = 'array' ` +
            "THEN json_extract(r.blob, '$.parts') ELSE '[null]' END) AS p " +
            `WHERE r.blob IS NOT NULL${where}) GROUP BY sha`,
        ).all(...(where === "" ? [] : [namespace, partition])) as {
          sha: string;
          n: number;
        }[]).map((row) => [row.sha, row.n]),
      );
    const before = chunksOf(
      "base_records",
      " AND r.namespace = ? AND r.partition = ?",
    );
    const after = chunksOf("staged_records", "");
    for (const sha of new Set([...before.keys(), ...after.keys()])) {
      base.shiftChunk(
        namespace,
        partition,
        sha,
        (after.get(sha) ?? 0) - (before.get(sha) ?? 0),
      );
    }
  }

  /** never folds past what the read model applied or the copy's own head */
  installPartitionBase(
    install: PartitionBaseInstall,
  ): Promise<PartitionInstallOutcome> {
    if (this.#closed) return Promise.reject(closedError());
    if (!this.#follower) {
      return Promise.reject(
        new Error(
          "Internal error: only a serve-mode copy installs serve's base by partition",
        ),
      );
    }
    return this.#enqueue(() => this.#installPartition(install)).finally(() =>
      this.#notifyHeadMoved(true)
    );
  }

  async #installPartition(
    install: PartitionBaseInstall,
  ): Promise<PartitionInstallOutcome> {
    const { namespace, partition, seq } = install;
    const key = PartitionKey.parse(partition);
    const compacted = this.#compactedSeq(namespace, partition);
    if (seq <= compacted) return { kind: "skipped", reason: "not-newer" };
    const source = this.#db.prepare(
      "SELECT seq FROM base_sources WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined;
    if (install.mode === "difference" && source?.seq !== compacted) {
      return { kind: "skipped", reason: "no-source" };
    }
    const ready = this.#installReady(
      namespace,
      partition,
      seq,
      install.readModelCursor,
    );
    if (ready !== undefined) return ready;
    let snapshot: { seq: number; body: string } | undefined;
    let through: number;
    const latest = this.#selectSnapshot.get(namespace, partition) as
      | { seq: number }
      | undefined;
    if (install.mode === "whole" && (latest?.seq ?? 0) < seq) {
      // a rebuild below the newest snapshot would replay from seq 1, over commits a base already took
      if (latest === undefined && compacted > 0) {
        return { kind: "skipped", reason: "no-snapshot" };
      }
      const rebuilt = await this.#rebuild(namespace, key, seq);
      snapshot = { seq: rebuilt.seq, body: JSON.stringify(rebuilt.snapshot()) };
      through = rebuilt.seq;
    } else {
      // the newest snapshot needs no commit at or below it
      through = Math.min(seq, latest?.seq ?? 0);
    }
    const removing = await this.#foldable(namespace, partition, through);
    const mark = this.#markBelowLater(namespace, partition, seq);

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      if (this.#compactedSeq(namespace, partition) !== compacted) {
        throw new Error(
          `Partition ${partition} was compacted during its base install: another process is writing the store`,
        );
      }
      const base = this.#base;
      base.begin(Date.now());
      let written = 0;
      if (install.mode === "whole") {
        for (
          const row of this.#db.prepare(
            "SELECT record_key FROM base_records WHERE namespace = ? AND partition = ?",
          ).all(namespace, partition) as { record_key: string }[]
        ) {
          base.deleteRecord(namespace, partition, row.record_key);
        }
        for (
          const table of ["base_versions", "base_catalog", "base_forwards"]
        ) {
          this.#db.prepare(
            `DELETE FROM ${table} WHERE namespace = ? AND partition = ?`,
          ).run(namespace, partition);
        }
        this.#db.prepare(
          "DELETE FROM base_files WHERE namespace = ? AND owner = ?",
        ).run(namespace, partition);
      } else {
        for (const removal of install.removed) {
          written++;
          if (removal.section === "record") {
            base.deleteRecord(namespace, partition, removal.key);
            continue;
          }
          if (removal.section === "forward") {
            this.#db.prepare(
              "DELETE FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
            ).run(namespace, partition, removal.key);
            continue;
          }
          const split = removal.key.indexOf("/");
          const version = Number(removal.key.slice(0, split));
          const name = removal.key.slice(split + 1);
          this.#db.prepare(
            `DELETE FROM ${
              removal.section === "version" ? "base_versions" : "base_catalog"
            } WHERE namespace = ? AND partition = ? AND name = ? AND version = ?`,
          ).run(namespace, partition, name, version);
        }
      }
      for (const entry of install.entries) {
        if (entry.namespace !== namespace) {
          throw new Error(
            `A base entry of namespace ${entry.namespace} is not this copy's`,
          );
        }
        if (entry.kind !== "file" && entry.partition !== partition) {
          throw new Error(
            `A base entry of partition ${entry.partition} came in the install of ${partition}`,
          );
        }
        written++;
        switch (entry.kind) {
          case "partition":
            break;
          case "record":
            base.putRecord(namespace, partition, entry.key, entry.record);
            break;
          case "version":
            this.#db.prepare(
              "INSERT OR REPLACE INTO base_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
            ).run(
              namespace,
              partition,
              entry.version.metadata.name,
              entry.version.version,
              JSON.stringify(entry.version.metadata),
            );
            break;
          case "catalog-row":
            this.#db.prepare(
              "INSERT OR REPLACE INTO base_catalog (namespace, partition, name, version) VALUES (?, ?, ?, ?)",
            ).run(
              namespace,
              partition,
              entry.metadata.name,
              entry.metadata.version,
            );
            break;
          case "forward":
            this.#db.prepare(
              "INSERT OR REPLACE INTO base_forwards (namespace, partition, name, renamed_to) VALUES (?, ?, ?, ?)",
            ).run(namespace, partition, entry.name, entry.to);
            break;
          case "file":
            if (entry.ownership.owner !== partition) {
              throw new Error(
                `A file owned by ${entry.ownership.owner} came in the install of ${partition}`,
              );
            }
            base.setFileOwnership(namespace, entry.key, {
              ...entry.ownership,
              mark,
            });
            break;
        }
      }
      if (snapshot !== undefined) {
        this.#upsertSnapshot.run(
          namespace,
          partition,
          snapshot.seq,
          snapshot.body,
        );
      }
      this.#finishInstall(base, namespace, partition, seq, removing);
      this.#assertChunkCounts(namespace, base.touched);
      this.#db.exec("COMMIT");
      this.#cache.delete(cacheKeyOf(namespace, partition));
      return {
        kind: "installed",
        rows: written,
        commitsRemoved: removing.rows.length,
      };
    } catch (error) {
      rollbackQuietly(this.#db);
      this.#cache.delete(cacheKeyOf(namespace, partition));
      throw error;
    }
  }

  /**
   * why a partition cannot take serve's base at `seq` now, if it cannot; the
   * cursor is the copy's only reader's, as a serve copy lives under its checkout
   */
  #installReady(
    namespace: string,
    partition: string,
    seq: number,
    readModelCursor: number,
  ): PartitionInstallOutcome | undefined {
    const compacted = this.#compactedSeq(namespace, partition);
    if (seq <= compacted) return { kind: "skipped", reason: "not-newer" };
    const head = (this.#selectHead.get(namespace, partition) as
      | { seq: number }
      | undefined)?.seq ?? 0;
    if (head < seq) return { kind: "skipped", reason: "behind" };
    const unread = this.#db.prepare(
      "SELECT 1 AS found FROM commits WHERE namespace = ? AND partition = ? AND seq > ? AND seq <= ? AND cursor > ? LIMIT 1",
    ).get(namespace, partition, compacted, seq, readModelCursor);
    if (unread !== undefined) {
      return { kind: "skipped", reason: "read-model-behind" };
    }
    return undefined;
  }

  async #foldable(
    namespace: string,
    partition: string,
    through: number,
  ): Promise<{ rows: CommitRow[]; commits: Commit[] }> {
    const rows = this.#db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
        "WHERE namespace = ? AND partition = ? AND seq <= ? ORDER BY cursor",
    ).all(namespace, partition, through) as unknown as CommitRow[];
    const commits: Commit[] = [];
    for (const row of rows) commits.push(await parseRow(row));
    return { rows, commits };
  }

  /** below every later write of the partition, which alone compare against it */
  #markBelowLater(namespace: string, partition: string, seq: number): number {
    const after = this.#db.prepare(
      "SELECT MIN(cursor) AS cursor FROM commits WHERE namespace = ? AND partition = ? AND seq > ?",
    ).get(namespace, partition, seq) as { cursor: number | null };
    const last = (this.#db.prepare(
      "SELECT seq FROM sqlite_sequence WHERE name = 'commits'",
    ).get() as { seq: number } | undefined)?.seq ?? 0;
    return after.cursor === null ? last : after.cursor - 1;
  }

  #finishInstall(
    base: SqliteCompactedBase,
    namespace: string,
    partition: string,
    seq: number,
    removing: { rows: CommitRow[]; commits: Commit[] },
  ): void {
    base.setCompactedSeq(namespace, partition, seq);
    this.#advancePointPastFolded(base, removing.rows);
    removing.rows.forEach((row, i) => {
      base.compactCommit(
        row,
        removing.commits[i].chunkRefs(),
        Date.parse(removing.commits[i].at),
      );
    });
    this.#db.prepare(
      "INSERT INTO base_sources (namespace, partition, seq) VALUES (?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = excluded.seq",
    ).run(namespace, partition, seq);
  }

  /** never past the live read model, since installs fold nothing it has not applied */
  #advancePointPastFolded(
    base: SqliteCompactedBase,
    folding: readonly CommitRow[],
  ): void {
    const current = this.#point();
    const unfolded = this.#db.prepare(
      "SELECT MIN(c.cursor) AS cursor FROM commits AS c WHERE NOT EXISTS (SELECT 1 FROM compacted_partitions AS p " +
        "WHERE p.namespace = c.namespace AND p.partition = c.partition AND p.seq >= c.seq)",
    ).get() as { cursor: number | null };
    const highest = (this.#db.prepare(
      "SELECT MAX(cursor) AS cursor FROM commits",
    ).get() as { cursor: number | null }).cursor ?? current;
    const point = unfolded.cursor === null ? highest : unfolded.cursor - 1;
    if (point <= current) return;
    const at = (this.#db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits WHERE cursor <= ? ORDER BY cursor DESC LIMIT 1",
    ).get(point) as CommitRow | undefined) ??
      folding.findLast((row) => row.cursor <= point);
    if (at !== undefined && at.cursor === point) base.setPoint(at);
    else {
      this.#db.prepare("UPDATE compaction SET point = ? WHERE id = 1").run(
        point,
      );
    }
  }

  /**
   * An index row may be missing (it fails closed), so a partition's counts
   * may sum below the namespace's; above it means a count drifted.
   */
  #assertChunkCounts(namespace: string, chunks: ReadonlySet<string>): void {
    const check = this.#db.prepare(
      "SELECT COALESCE((SELECT refs FROM chunk_refs WHERE namespace = ?1 AND sha256 = ?2), 0) AS total, " +
        "COALESCE((SELECT SUM(refs) FROM chunk_partitions WHERE namespace = ?1 AND sha256 = ?2), 0) AS indexed",
    );
    for (const sha256 of chunks) {
      const { total, indexed } = check.get(namespace, sha256) as {
        total: number;
        indexed: number;
      };
      if (indexed > total || total < 0) {
        throw new ChunkCountDriftError(sha256, total, indexed);
      }
    }
  }

  /**
   * Calls `listener` whenever the store's rows may have moved: after a
   * commit lands (once its transaction committed, so a reader finds it),
   * and after compaction or an install replaced what the store holds, with
   * `replaced` true then: rows already read may have changed. The
   * commit feed waits on it rather than polling (swamp-club#4120). The
   * listener reads the store itself; a throwing listener is ignored.
   * Returns the call that removes it.
   */
  onHeadMoved(listener: (replaced: boolean) => void): () => void {
    this.#headListeners.add(listener);
    return () => this.#headListeners.delete(listener);
  }

  #notifyHeadMoved(replaced = false): void {
    for (const listener of [...this.#headListeners]) {
      try {
        listener(replaced);
      } catch {
        // A listener's failure is its own.
      }
    }
  }

  append(commit: Commit): Promise<CommitStoreAppendResult> {
    if (this.#closed) return Promise.reject(closedError());
    return new Promise<CommitStoreAppendResult>((resolve, reject) => {
      const entry: PendingAppend = {
        commit,
        resolve: (result) => {
          resolve(result);
          if (result.kind === "appended") this.#notifyHeadMoved();
        },
        reject,
      };
      // Appends queued back to back, with nothing else queued between them,
      // share one transaction (swamp-club#3915).
      const open = this.#openGroup;
      if (open !== undefined && open.length < GROUP_COMMIT_MAX_COMMITS) {
        open.push(entry);
        return;
      }
      const group = [entry];
      this.#openGroup = this.#groupCommit ? group : undefined;
      const run = this.#queue.then(() => {
        // Appends queued from here on wait for the next group.
        if (this.#openGroup === group) this.#openGroup = undefined;
        return this.#drain(group);
      });
      this.#queue = run.catch(() => {});
    });
  }

  /**
   * Queues anything but an append behind the work queued so far. It closes
   * the open group, so an append queued after it never lands before it.
   */
  #enqueue<T>(work: () => T | Promise<T>): Promise<T> {
    this.#openGroup = undefined;
    const run = this.#queue.then(work);
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Appends a group's commits, settling each one's promise. A group of one
   * is a solo append, exactly as before grouping; a larger one goes in
   * transactions of {@link #appendGroup}, in queue order.
   */
  async #drain(group: readonly PendingAppend[]): Promise<void> {
    let rest = group;
    while (rest.length > 0) {
      if (rest.length === 1) {
        const [{ commit, resolve, reject }] = rest;
        try {
          resolve(await this.#append(commit, false));
        } catch (error) {
          reject(error);
        }
        return;
      }
      rest = await this.#appendGroup(rest);
    }
  }

  async #append(
    commit: Commit,
    retried: boolean,
    staleRetries = 0,
  ): Promise<CommitStoreAppendResult> {
    const namespace = commit.namespace;
    const partitionKey = commit.partition.toString();
    const cacheKey = cacheKeyOf(namespace, partitionKey);
    if (!retried && this.#mayAppendUnloaded(cacheKey)) {
      const unloaded = this.#appendUnloaded(commit);
      if (unloaded !== "load") return unloaded;
    }
    const partition = await this.#partition(namespace, commit.partition);

    // Synchronous from BEGIN to COMMIT: nothing else runs in between.
    this.#db.exec("BEGIN IMMEDIATE");
    let outcome: CommitStoreAppendResult | "stale";
    let snapshot: WrittenSnapshot | undefined;
    try {
      outcome = this.#applyInTransaction(
        commit,
        partition,
        retried,
        (written) => snapshot = written,
      );
      if (outcome !== "stale" && outcome.kind === "appended") {
        this.#commitAppends(1);
      } else {
        this.#db.exec("ROLLBACK");
      }
    } catch (error) {
      rollbackQuietly(this.#db);
      // A refusal leaves the partition as it was. Any other failure may have
      // come after the commit was applied to the cached partition, which
      // would then be ahead of the file.
      if (!(error instanceof CommitRejectedError)) this.#cache.delete(cacheKey);
      throw error;
    }

    if (outcome !== "stale") {
      if (snapshot !== undefined) {
        this.#restoreFromSnapshot(commit, cacheKey, partition, snapshot);
      }
      return outcome;
    }
    // Another connection wrote this partition: rebuild it from the file.
    this.#cache.delete(cacheKey);
    // A serve-mode checkout's copy is caught up from serve's feed by every
    // process reading through serve, none holding the writer lock: another
    // may land commits between this rebuild and the next transaction, each
    // time progress, and this commit is then a duplicate or still to append
    // (swamp-club#4207). A solo store's writer holds the lock, so a second
    // stale partition is another process writing it.
    const mayRetry = !retried ||
      (this.#follower && staleRetries < FOLLOWER_STALE_RETRIES);
    if (!mayRetry) {
      throw new Error(
        `Partition ${partitionKey} changed in commits.db while appending: another process is writing the store`,
      );
    }
    return await this.#append(commit, true, retried ? staleRetries + 1 : 0);
  }

  /**
   * Group commit (swamp-club#3915): appends the leading commits of `entries`
   * in one `BEGIN IMMEDIATE ... COMMIT`, so they pay one fsync, and returns
   * the ones left for the next transaction.
   *
   * Their partitions are rebuilt first, outside the transaction, each once.
   * Rebuilding stops taking commits once it has run
   * {@link GROUP_COMMIT_MAX_WAIT_MS}, so the commits already taken are not
   * held back by later ones. Inside the transaction each commit runs in a
   * savepoint of its own, exactly as a solo append would run it: a refusal
   * rolls back that commit alone and is that commit's result, and a
   * duplicate writes nothing. A commit that leaves its partition in doubt,
   * a stale head or a failure after the partition took it, ends the group
   * there, so every commit after it is appended as it would have been
   * after it alone: the stale one is retried by itself, as a solo append
   * retries, and the rest go to the next transaction. Results are settled
   * only once the transaction has committed; if it fails, every commit it
   * tried fails with that error.
   */
  async #appendGroup(
    entries: readonly PendingAppend[],
  ): Promise<readonly PendingAppend[]> {
    const started = performance.now();
    const partitions = new Map<string, Partition>();
    const batch: GroupedAppend[] = [];
    let next = 0;
    for (; next < entries.length; next++) {
      if (
        batch.length > 0 &&
        performance.now() - started > GROUP_COMMIT_MAX_WAIT_MS
      ) {
        break;
      }
      const entry = entries[next];
      const { namespace, partition: key } = entry.commit;
      const cacheKey = cacheKeyOf(namespace, key.toString());
      let partition = partitions.get(cacheKey);
      if (
        partition === undefined &&
        this.#mayAppendUnloaded(cacheKey)
      ) {
        batch.push({ entry, cacheKey, partition: undefined });
        continue;
      }
      if (partition === undefined) {
        try {
          partition = await this.#partition(namespace, key);
        } catch (error) {
          // As a solo append whose rebuild fails.
          entry.reject(error);
          continue;
        }
        partitions.set(cacheKey, partition);
      }
      batch.push({ entry, cacheKey, partition });
    }

    /** Settles each commit's promise, run once the transaction committed. */
    const settle: (() => void)[] = [];
    const snapshots: {
      grouped: GroupedAppend;
      partition: Partition;
      snapshot: WrittenSnapshot;
    }[] = [];
    let tried = 0;
    let stale: GroupedAppend | undefined;
    try {
      this.#db.exec("BEGIN IMMEDIATE");
      for (const grouped of batch) {
        const { entry, cacheKey, partition } = grouped;
        tried++;
        this.#db.exec(`SAVEPOINT ${GROUP_SAVEPOINT}`);
        let outcome: CommitStoreAppendResult | "stale";
        try {
          if (partition === undefined) {
            // Needing its partition, it is appended after this group as a
            // stale one is.
            const unloaded = this.#applyUnloadedInTransaction(entry.commit);
            outcome = unloaded === "load" ? "stale" : unloaded;
          } else {
            outcome = this.#applyInTransaction(
              entry.commit,
              partition,
              false,
              (snapshot) => snapshots.push({ grouped, partition, snapshot }),
            );
          }
        } catch (error) {
          this.#rollbackSavepoint();
          if (error instanceof CommitRejectedError) {
            settle.push(() => entry.reject(error));
            continue;
          }
          // The partition may have taken the commit: it is ahead of the
          // file, and the commits after this one wait for a rebuild.
          settle.push(() => {
            this.#cache.delete(cacheKey);
            entry.reject(error);
          });
          break;
        }
        if (outcome === "stale") {
          this.#rollbackSavepoint();
          stale = grouped;
          break;
        }
        if (outcome.kind === "appended") {
          this.#db.exec(`RELEASE ${GROUP_SAVEPOINT}`);
        } else {
          this.#rollbackSavepoint();
        }
        const result = outcome;
        settle.push(() => entry.resolve(result));
      }
      this.#commitAppends(settle.length);
    } catch (error) {
      rollbackQuietly(this.#db);
      // Every partition the group touched may be ahead of the file.
      for (const { cacheKey } of batch) this.#cache.delete(cacheKey);
      for (const { entry } of batch.slice(0, Math.max(tried, 1))) {
        entry.reject(error);
      }
      return [
        ...batch.slice(Math.max(tried, 1)).map(({ entry }) => entry),
        ...entries.slice(next),
      ];
    }
    for (const run of settle) run();
    for (const { grouped, partition, snapshot } of snapshots) {
      this.#restoreFromSnapshot(
        grouped.entry.commit,
        grouped.cacheKey,
        partition,
        snapshot,
      );
    }
    const rest = [
      ...batch.slice(tried).map(({ entry }) => entry),
      ...entries.slice(next),
    ];
    if (stale !== undefined) {
      // As a solo append that found its partition stale.
      this.#cache.delete(stale.cacheKey);
      try {
        stale.entry.resolve(await this.#append(stale.entry.commit, true));
      } catch (error) {
        stale.entry.reject(error);
      }
    }
    return rest;
  }

  /** Rolls back the current group commit savepoint and ends it. */
  #rollbackSavepoint(): void {
    this.#db.exec(`ROLLBACK TO ${GROUP_SAVEPOINT}`);
    this.#db.exec(`RELEASE ${GROUP_SAVEPOINT}`);
  }

  /**
   * Bounds a cached partition's txnIds (swamp-club#3915): once an append
   * has committed a snapshot of the partition, the cached partition is
   * replaced by one restored from that snapshot, whose txnIds at or below it
   * are looked up in the file, as a rebuild's are. So a partition never
   * holds more txnIds than the snapshot interval, however long it stays
   * cached. Skipped when the cached partition has moved past the snapshot
   * (a later commit of its group) or is no longer the cached one.
   */
  #restoreFromSnapshot(
    commit: Commit,
    cacheKey: string,
    partition: Partition,
    snapshot: WrittenSnapshot,
  ): void {
    if (!this.#boundTxnIds) return;
    if (
      this.#cache.get(cacheKey) !== partition || partition.seq !== snapshot.seq
    ) {
      return;
    }
    try {
      const restored = this.#restoreSnapshot(
        commit.namespace,
        commit.partition,
        snapshot,
      );
      // Map.set keeps the entry's place in the LRU order.
      this.#cache.set(cacheKey, restored);
    } catch {
      // The next use rebuilds it from the file and reports any damage.
      this.#cache.delete(cacheKey);
    }
  }

  /**
   * A partition restored from a stored snapshot. The snapshot leaves out
   * txnIds; those it covers are looked up in the commits table, only up to
   * its seq, so the commits replayed after it are not taken for retries of
   * themselves. The lookup uses this store's connection, so a restored
   * partition must not outlive the store: close() clears the cache.
   */
  #restoreSnapshot(
    namespace: string,
    key: PartitionKey,
    snapshot: WrittenSnapshot,
  ): Partition {
    const upTo = snapshot.seq;
    return Partition.restore(
      key,
      JSON.parse(snapshot.body),
      (txnId) =>
        this.#selectTxnUpTo.get(namespace, key.toString(), txnId, upTo) !==
          undefined,
    );
  }

  /**
   * How many txnIds the cached partition holds in memory, or undefined
   * when it is not cached; for tests and benchmarks (swamp-club#3915).
   */
  cachedTxnIdCount(namespace: string, key: PartitionKey): number | undefined {
    return this.#cache.get(cacheKeyOf(namespace, key.toString()))?.txnIdCount;
  }

  #applyInTransaction(
    commit: Commit,
    partition: Partition,
    retried: boolean,
    onSnapshot: (snapshot: WrittenSnapshot) => void,
  ): CommitStoreAppendResult | "stale" {
    const namespace = commit.namespace;
    const partitionKey = commit.partition.toString();
    const head = this.#selectHead.get(namespace, partitionKey) as
      | { seq: number }
      | undefined;
    const headSeq = head?.seq ?? 0;
    if (headSeq !== partition.seq) {
      // Stale again just after a rebuild. Under the write lock nothing else
      // can write, so a head row that disagrees with the commits is damage,
      // not another writer.
      if (retried) {
        const last = (this.#selectMaxSeq.get(namespace, partitionKey) as {
          seq: number | null;
        }).seq ?? 0;
        if (last !== headSeq) {
          throw new CommitStoreCorruptError(
            namespace,
            partitionKey,
            headSeq,
            `its head row is at seq ${headSeq} but its commits end at seq ${last}`,
          );
        }
      }
      return "stale";
    }

    const before = partition.seq;
    const applied = this.#follower
      ? partition.appendObserved(commit)
      : partition.append(commit);
    if (applied.kind === "appended" && !this.#follower) {
      // After the partition's own rules, so their refusal is the one a
      // commit they refuse reports. The partition has taken the commit by
      // now: a refusal here drops it from the cache. A follower's commits
      // are serve's, fenced by serve's lease: the local fence orders only
      // this checkout's own processes (swamp-club#3985).
      this.#checkWriterFence(commit.fence);
    }
    if (applied.kind === "duplicate") {
      const row = this.#selectTxnSeq.get(
        namespace,
        partitionKey,
        commit.txnId,
      ) as { seq: number } | undefined;
      if (row === undefined) {
        throw new CommitStoreCorruptError(
          namespace,
          partitionKey,
          partition.seq,
          `it has applied txnId ${commit.txnId}, but no stored commit carries it`,
        );
      }
      return { kind: "duplicate", seq: row.seq };
    }
    // A lease op can raise the fence too, so take it from the partition.
    this.#writeAppended(commit, partition.seq, partition.highestFence);
    if (this.#snapshotDue(before, partition.seq)) {
      const body = JSON.stringify(partition.snapshot());
      this.#upsertSnapshot.run(namespace, partitionKey, partition.seq, body);
      onSnapshot({ seq: partition.seq, body });
    }
    this.#afterAppendWrites?.(commit);
    return applied;
  }

  #writeAppended(
    commit: Commit,
    headSeq: number,
    highestFence: number | undefined,
  ): void {
    const namespace = commit.namespace;
    const partitionKey = commit.partition.toString();
    const authority = forwardedCommitClass(commit.partition, commit.ops) ===
      "exclusive";
    if (this.#leaderCursor !== undefined) {
      if (authority) this.#authorityCursor = this.#leaderCursor;
      // A team follower keeps the leader's cursor, so a cursor a client
      // read from either node means the same commit (swamp-club#4120).
      this.#db.prepare(
        "INSERT INTO commits (cursor, namespace, partition, seq, txn_id, fence, at, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        this.#leaderCursor,
        namespace,
        partitionKey,
        commit.seq,
        commit.txnId,
        commit.fence ?? null,
        commit.at,
        JSON.stringify(commit.toJSON()),
      );
    } else {
      const inserted = this.#insertCommit.run(
        namespace,
        partitionKey,
        commit.seq,
        commit.txnId,
        commit.fence ?? null,
        commit.at,
        JSON.stringify(commit.toJSON()),
      );
      if (authority) this.#authorityCursor = Number(inserted.lastInsertRowid);
    }
    // In the commit's own transaction, so a refused or rolled-back append
    // leaves no reference behind.
    for (const sha256 of commit.chunkRefs()) {
      this.#insertChunkRef.run(namespace, sha256);
      this.#insertChunkPartition.run(namespace, sha256, partitionKey);
    }
    this.#upsertHead.run(
      namespace,
      partitionKey,
      headSeq,
      highestFence ?? null,
    );
  }

  /**
   * appendObserved's rules read only the head row, the txnId index and the
   * lease fence, so serve's commits to partitions a command never reads skip
   * their rebuild
   */
  #mayAppendUnloaded(cacheKey: string): boolean {
    return this.#follower && !this.#cache.has(cacheKey);
  }

  /** "load" when the commit needs its partition rebuilt first */
  #appendUnloaded(commit: Commit): CommitStoreAppendResult | "load" {
    this.#db.exec("BEGIN IMMEDIATE");
    let outcome: CommitStoreAppendResult | "load";
    try {
      outcome = this.#applyUnloadedInTransaction(commit);
      if (outcome !== "load" && outcome.kind === "appended") {
        this.#commitAppends(1);
      } else {
        this.#db.exec("ROLLBACK");
      }
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
    return outcome;
  }

  /** Partition.appendObserved's refusals, in its order */
  #applyUnloadedInTransaction(
    commit: Commit,
  ): CommitStoreAppendResult | "load" {
    const namespace = commit.namespace;
    const key = commit.partition.toString();
    const head = this.#selectHead.get(namespace, key) as
      | { seq: number; highest_fence: number | null }
      | undefined;
    const headSeq = head?.seq ?? 0;
    const highest = head?.highest_fence ?? undefined;
    const held = this.#selectTxnSeq.get(namespace, key, commit.txnId) as
      | { seq: number }
      | undefined;
    if (held !== undefined) return { kind: "duplicate", seq: held.seq };
    if (commit.seq <= headSeq) {
      throw new CommitRejectedError(
        "seq-gap",
        `Partition ${key} is at seq ${headSeq}; it accepts only a later seq, not ${commit.seq}`,
      );
    }
    if (commit.fence !== undefined) {
      if (highest !== undefined && commit.fence < highest) {
        throw new CommitRejectedError(
          "stale-fence",
          `Fence ${commit.fence} is below partition ${key}'s highest fence ${highest}`,
        );
      }
    } else if (highest !== undefined) {
      throw new CommitRejectedError(
        "unfenced",
        `Partition ${key} has seen fence ${highest}; a commit without a fence is refused`,
      );
    }
    const leases = commit.ops.filter((op) => op.kind === "lease");
    if (leases.length > 0) {
      let leaseFence = this.#leaseFenceOf(namespace, key);
      if (leaseFence === "load") return "load";
      for (const lease of leases) {
        if (leaseFence !== undefined && lease.fence < leaseFence) {
          throw new CommitRejectedError(
            "stale-lease",
            `Lease fence ${lease.fence} is below partition ${key}'s lease fence ${leaseFence}`,
          );
        }
        leaseFence = lease.fence;
      }
    }
    if (this.#snapshotDue(headSeq, commit.seq)) return "load";
    this.#writeAppended(commit, commit.seq, commit.fence);
    this.#afterAppendWrites?.(commit);
    return { kind: "appended", seq: commit.seq };
  }

  /**
   * The lease fence a rebuild reaches: lease fences only rise, so it is the
   * newest lease op replayed after the snapshot, else the snapshot's own.
   * "load" leaves a body it cannot read to the rebuild, which reports it.
   */
  #leaseFenceOf(namespace: string, key: string): number | undefined | "load" {
    const snapshot = this.#selectSnapshot.get(namespace, key) as
      | { seq: number; body: string }
      | undefined;
    const rows = this.#selectNewestAfter.iterate(
      namespace,
      key,
      snapshot?.seq ?? 0,
    ) as Iterable<{ body: string }>;
    for (const { body } of rows) {
      const ops = parsedField(body, "ops");
      if (!Array.isArray(ops)) return "load";
      let fence: number | undefined;
      for (const op of ops) {
        if (op?.kind === "lease") {
          if (!Number.isSafeInteger(op.fence) || op.fence < 0) return "load";
          fence = op.fence;
        }
      }
      if (fence !== undefined) return fence;
    }
    if (snapshot === undefined) return undefined;
    const fence = parsedField(snapshot.body, "leaseFence");
    if (fence === undefined) return undefined;
    return Number.isSafeInteger(fence) && (fence as number) >= 0
      ? fence as number
      : "load";
  }

  /**
   * Whether an append that moved a partition from seq `before` to `after`
   * writes a snapshot: one landing on a multiple of the snapshot interval.
   * A follower's seqs can skip that multiple (swamp-club#3985), so it
   * writes one on the first commit at or past each multiple instead; for
   * gapless seqs the two are the same.
   */
  #snapshotDue(before: number, after: number): boolean {
    const interval = this.#snapshotInterval;
    if (!this.#follower) return after % interval === 0;
    return Math.floor(before / interval) < Math.floor(after / interval);
  }

  /** The partition, from the cache or rebuilt from the file. */
  async #partition(
    namespace: string,
    key: PartitionKey,
  ): Promise<Partition> {
    const cacheKey = cacheKeyOf(namespace, key.toString());
    const cached = this.#cache.get(cacheKey);
    if (cached !== undefined) {
      // Re-insert to mark it most recently used.
      this.#cache.delete(cacheKey);
      this.#cache.set(cacheKey, cached);
      return cached;
    }
    const partition = await this.#rebuild(namespace, key);
    this.#rebuilds++;
    this.#cache.set(cacheKey, partition);
    if (this.#cache.size > this.#cachedPartitions) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return partition;
  }

  /**
   * Restores a partition's latest snapshot and replays the commits after it,
   * up to seq `upTo` when given.
   */
  async #rebuild(
    namespace: string,
    key: PartitionKey,
    upTo = Number.MAX_SAFE_INTEGER,
  ): Promise<Partition> {
    const stored = this.#selectSnapshot.get(namespace, key.toString()) as
      | { seq: number; body: string }
      | undefined;
    // A snapshot past `upTo` holds state the rebuild must not reach: only a
    // truncation (truncateAfter) asks for that, and replays from seq 1.
    const snapshot = stored !== undefined && stored.seq <= upTo
      ? stored
      : undefined;
    let partition: Partition;
    if (snapshot === undefined) {
      partition = Partition.empty(key);
    } else {
      try {
        partition = this.#restoreSnapshot(namespace, key, snapshot);
      } catch (error) {
        throw new CommitStoreCorruptError(
          namespace,
          key.toString(),
          snapshot.seq,
          `its snapshot is invalid: ${errorMessage(error)}`,
        );
      }
      if (partition.seq !== snapshot.seq) {
        throw new CommitStoreCorruptError(
          namespace,
          key.toString(),
          snapshot.seq,
          `its snapshot row is for seq ${snapshot.seq} but holds seq ${partition.seq}`,
        );
      }
    }
    let fromSeq = partition.seq + 1;
    const slice = new TimeSlice(undefined, FOLD_SLICE_MS);
    while (true) {
      if (slice.over) await slice.next();
      const rows = this.#selectPartitionPage.all(
        namespace,
        key.toString(),
        fromSeq,
        REBUILD_PAGE,
      ) as unknown as CommitRow[];
      for (const row of rows) {
        if (row.seq > upTo) return partition;
        const commit = await parseRow(row);
        let applied;
        try {
          applied = this.#follower
            ? partition.appendObserved(commit, { replay: true })
            : partition.append(commit, { replay: true });
        } catch (error) {
          throw corrupt(row, errorMessage(error));
        }
        if (applied.kind === "duplicate") {
          throw corrupt(row, `it repeats txnId ${commit.txnId}`);
        }
      }
      if (rows.length < REBUILD_PAGE) break;
      fromSeq = rows[rows.length - 1].seq + 1;
    }
    // The head row is written in the same transaction as each commit row, so
    // it is never behind the commits. Another writer can only move it ahead,
    // which the append's head check handles.
    const head = this.#selectHead.get(namespace, key.toString()) as
      | { seq: number }
      | undefined;
    if ((head?.seq ?? 0) < partition.seq) {
      throw new CommitStoreCorruptError(
        namespace,
        key.toString(),
        partition.seq,
        `its head row is at seq ${head?.seq ?? 0}, behind its commits`,
      );
    }
    return partition;
  }

  referencedChunks(
    namespace: string,
    hashes: readonly string[],
    releasedSince?: Date,
  ): Promise<Set<string>> {
    if (this.#closed) return Promise.reject(closedError());
    // Without a bound, every chunk compaction released still counts.
    const since = releasedSince?.getTime() ?? Number.MIN_SAFE_INTEGER;
    const found = new Set<string>();
    for (let at = 0; at < hashes.length; at += REF_LOOKUP_PAGE) {
      const page = hashes.slice(at, at + REF_LOOKUP_PAGE);
      // Only the last page can be short; it gets a statement of its own.
      const statement = page.length === REF_LOOKUP_PAGE
        ? this.#selectRefPage
        : this.#db.prepare(selectRefsSql(page.length));
      const rows = statement.all(
        namespace,
        ...page,
        namespace,
        ...page,
        since,
      ) as unknown as {
        sha256: string;
      }[];
      for (const row of rows) found.add(row.sha256);
    }
    return Promise.resolve(found);
  }

  partitionsReferencing(
    namespace: string,
    sha256: string,
    limit: number,
    after?: string,
  ): Promise<readonly PartitionKey[]> {
    if (this.#closed) return Promise.reject(closedError());
    try {
      requirePositive(limit, "limit");
    } catch (error) {
      return Promise.reject(error);
    }
    const rows =
      (after === undefined
        ? this.#selectChunkPartitions.all(namespace, sha256, limit)
        : this.#selectChunkPartitionsAfter.all(
          namespace,
          sha256,
          after,
          limit,
        )) as {
          partition: string;
        }[];
    const keys: PartitionKey[] = [];
    for (const row of rows) {
      try {
        keys.push(PartitionKey.parse(row.partition));
      } catch (error) {
        return Promise.reject(
          new CommitStoreCorruptError(
            namespace,
            row.partition,
            0,
            `chunk_partitions names it for chunk ${sha256}, but it is not a partition key: ${
              errorMessage(error)
            }`,
          ),
        );
      }
    }
    return Promise.resolve(keys);
  }

  /** a run's partition names its workflow too, which a lock on the run lacks */
  runPartitionsOf(namespace: string, runId: string): readonly PartitionKey[] {
    this.#assertOpen();
    const rows = this.#db.prepare(
      RUN_PARTITIONS_SQL,
    ).all(
      namespace,
      runId.toLowerCase(),
      RUN_PARTITION_RANGE.from,
      RUN_PARTITION_RANGE.to,
    ) as { partition: string }[];
    return rows.map((row) => PartitionKey.parse(row.partition));
  }

  baseRecordKeysNaming(
    namespace: string,
    partition: PartitionKey,
    sha256: string,
  ): Promise<readonly string[]> {
    if (this.#closed) return Promise.reject(closedError());
    const rows = this.#selectBaseKeysNaming.all(
      namespace,
      partition.toString(),
      sha256,
    ) as { record_key: string }[];
    return Promise.resolve(rows.map((row) => row.record_key));
  }

  async readPartition(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
    limit: number,
  ): Promise<readonly CommitChange[]> {
    this.#assertOpen();
    requirePositive(fromSeq, "fromSeq");
    requirePositive(limit, "limit");
    const rows = this.#readTransaction(() => {
      const compacted = this.#compactedSeq(namespace, partition.toString());
      if (fromSeq <= compacted) {
        throw new CommitsCompactedError(
          this.#point(),
          `Partition ${partition} is compacted through seq ${compacted}; commits from seq ${fromSeq} cannot be read`,
          compacted,
        );
      }
      return this.#selectPartitionPage.all(
        namespace,
        partition.toString(),
        fromSeq,
        limit,
      ) as unknown as CommitRow[];
    });
    const changes: CommitChange[] = [];
    for (const row of rows) {
      changes.push({ cursor: row.cursor, commit: await parseRow(row) });
    }
    return changes;
  }

  async readPartitionOfNames(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
    limit: number,
    names: ReadonlySet<string>,
  ): Promise<PartitionPageOfNames> {
    this.#assertOpen();
    requirePositive(fromSeq, "fromSeq");
    requirePositive(limit, "limit");
    // in pieces, each checked from where it starts; filled to the limit, so a
    // short page still means the partition's end
    const slice = new TimeSlice(undefined, FOLD_SLICE_MS);
    const changes: CommitChange[] = [];
    const seqs: number[] = [];
    let from = fromSeq;
    while (seqs.length < limit) {
      if (slice.over) await slice.next();
      const want = Math.min(REBUILD_PAGE, limit - seqs.length);
      const rows = this.#readTransaction(() => {
        const compacted = this.#compactedSeq(namespace, partition.toString());
        if (from <= compacted) {
          throw new CommitsCompactedError(
            this.#point(),
            `Partition ${partition} is compacted through seq ${compacted}; commits from seq ${from} cannot be read`,
            compacted,
          );
        }
        return this.#selectPartitionPage.all(
          namespace,
          partition.toString(),
          from,
          want,
        ) as unknown as CommitRow[];
      });
      for (const row of rows) {
        if (slice.over) await slice.next();
        seqs.push(row.seq);
        let touched: string[] | undefined;
        try {
          touched = catalogNamesOfRawCommit(JSON.parse(row.body));
        } catch {
          touched = undefined;
        }
        // a row the filter cannot read is decoded, so parseRow reports it
        if (touched !== undefined && !touched.some((name) => names.has(name))) {
          continue;
        }
        const commit = await parseRow(row);
        if (catalogNamesOfCommit(commit).some((name) => names.has(name))) {
          changes.push({ cursor: row.cursor, commit });
        }
      }
      if (rows.length < want) break;
      from = rows[rows.length - 1].seq + 1;
    }
    return { changes, seqs };
  }

  /**
   * A partition's head and the txnId of the commit at it (swamp-club#3490),
   * for the commit outbox's base: the stored commit's, else the compacted
   * one's. When compaction folded the head commit and its txnId was pruned
   * since, only the seq is known; a restore never takes the store below the
   * compaction point, so the seq alone still names that commit.
   */
  headIdentity(
    namespace: string,
    partition: PartitionKey,
  ): Promise<HeadIdentity> {
    if (this.#closed) return Promise.reject(closedError());
    const key = partition.toString();
    return Promise.resolve(this.#readTransaction(() => {
      const seq = (this.#selectHead.get(namespace, key) as
        | { seq: number }
        | undefined)?.seq ?? 0;
      if (seq === 0) return { seq, txnId: undefined };
      const row = this.#selectTxnAtSeq.get(namespace, key, seq) as
        | { txn_id: string }
        | undefined;
      return { seq, txnId: row?.txn_id };
    }));
  }

  /**
   * The seq a commit with `txnId` landed at in the partition, stored or
   * compacted, or undefined when none did (swamp-club#3490): how a recovery
   * tells an outbox entry that landed before its writer died.
   */
  landedSeq(
    namespace: string,
    partition: PartitionKey,
    txnId: string,
  ): Promise<number | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    const row = this.#selectTxnSeq.get(
      namespace,
      partition.toString(),
      txnId,
    ) as { seq: number } | undefined;
    return Promise.resolve(row?.seq);
  }

  lastCursor(): number {
    return (this.#selectLastCursor.get() as { cursor: number | null }).cursor ??
      0;
  }

  /** a read model applied through it holds every fact a shared commit is judged against */
  authorityCursor(): number {
    return Math.min(this.#authorityCursor, this.lastCursor());
  }

  /**
   * the cursor of the partition's last stored commit; "none" for a partition
   * never written, "compacted" when its last commit was folded away
   */
  partitionHeadCursor(
    namespace: string,
    partition: PartitionKey,
  ): number | "none" | "compacted" {
    const row = this.#selectHeadCursor.get(namespace, partition.toString()) as
      | { cursor: number }
      | undefined;
    if (row !== undefined) return row.cursor;
    return this.#selectHead.get(namespace, partition.toString()) === undefined
      ? "none"
      : "compacted";
  }

  head(namespace: string, partition: PartitionKey): Promise<PartitionHead> {
    if (this.#closed) return Promise.reject(closedError());
    const row = this.#selectHead.get(namespace, partition.toString()) as
      | { seq: number; highest_fence: number | null }
      | undefined;
    return Promise.resolve({
      seq: row?.seq ?? 0,
      highestFence: row?.highest_fence ?? undefined,
    });
  }

  async changesSince(
    cursor: number,
    limit: number,
  ): Promise<readonly CommitChange[]> {
    this.#assertOpen();
    if (!Number.isSafeInteger(cursor) || cursor < 0) {
      throw new Error(`cursor must be a non-negative integer: ${cursor}`);
    }
    requirePositive(limit, "limit");
    // read in pieces, each checked against the point from where it starts:
    // stored commits above the point never change, so the pieces join up
    const changes: CommitChange[] = [];
    const slice = new TimeSlice(undefined, FOLD_SLICE_MS);
    let from = cursor;
    while (changes.length < limit) {
      if (slice.over) await slice.next();
      const want = Math.min(REBUILD_PAGE, limit - changes.length);
      const rows = this.#readTransaction(() => {
        const point = this.#point();
        if (from < point) {
          throw new CommitsCompactedError(
            point,
            `The change feed from cursor ${from} cannot be read`,
          );
        }
        return this.#selectChanges.all(from, want) as unknown as CommitRow[];
      });
      for (const row of rows) {
        if (slice.over) await slice.next();
        changes.push({ cursor: row.cursor, commit: await parseRow(row) });
      }
      if (rows.length < want) break;
      from = rows[rows.length - 1].cursor;
    }
    return changes;
  }

  countChangesSince(cursor: number, atMost: number): Promise<number> {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT COUNT(*) AS n FROM (SELECT 1 FROM commits WHERE cursor > ? LIMIT ?)",
    ).get(cursor, atMost) as { n: number };
    return Promise.resolve(row.n);
  }

  /**
   * How much history the store holds, for `datastore status`
   * (swamp-club#3279): the commits stored above the compaction point, and
   * the point itself.
   */
  history(): Promise<{ storedCommits: number; compactedThrough: number }> {
    if (this.#closed) return Promise.reject(closedError());
    return Promise.resolve(this.#readTransaction(() => {
      const point = this.#point();
      const stored = (this.#db.prepare(
        "SELECT COUNT(*) AS n FROM commits WHERE cursor > ?",
      ).get(point) as { n: number }).n;
      return { storedCommits: stored, compactedThrough: point };
    }));
  }

  /**
   * The write time (`at`, ISO-8601) of the oldest commit stored above the
   * compaction point, or null when none is stored: how far back the history
   * that still holds removed content reaches, for `swamp doctor datastores
   * --retention` (swamp-club#3473).
   */
  oldestStoredCommitAt(): Promise<string | null> {
    if (this.#closed) return Promise.reject(closedError());
    return Promise.resolve(this.#readTransaction(() => {
      const row = this.#db.prepare(
        "SELECT MIN(at) AS at FROM commits WHERE cursor > ?",
      ).get(this.#point()) as { at: string | null };
      return row.at;
    }));
  }

  compactionStatus(
    retention: CompactionRetention,
  ): Promise<CompactionCandidate> {
    if (this.#closed) return Promise.reject(closedError());
    if (!Number.isSafeInteger(retention.commits) || retention.commits < 0) {
      return Promise.reject(
        new Error(
          `retention.commits must be a non-negative integer: ${retention.commits}`,
        ),
      );
    }
    return Promise.resolve(this.#readTransaction(() => {
      const point = this.#point();
      // The newest `commits` are kept: the highest compactable cursor is the
      // one just older than them.
      const byCount = (this.#db.prepare(
        "SELECT cursor FROM commits WHERE cursor > ? ORDER BY cursor DESC LIMIT 1 OFFSET ?",
      ).get(point, retention.commits) as { cursor: number } | undefined)
        ?.cursor;
      // Everything from the first commit written at or after `since` is kept,
      // so a writer whose clock runs behind never makes a newer one compactable.
      const firstRecent = (this.#db.prepare(
        "SELECT MIN(cursor) AS cursor FROM commits WHERE cursor > ? AND at >= ?",
      ).get(point, retention.since) as { cursor: number | null }).cursor;
      let through = byCount;
      if (through !== undefined && firstRecent !== null) {
        through = Math.min(through, firstRecent - 1);
      }
      if (through === undefined || through <= point) {
        return { point, through: undefined, commits: 0 };
      }
      const commits = (this.#db.prepare(
        "SELECT COUNT(*) AS n FROM commits WHERE cursor > ? AND cursor <= ?",
      ).get(point, through) as { n: number }).n;
      return { point, through, commits };
    }));
  }

  compactHistory(
    through: number,
    options: SqliteCompactHistoryOptions = {},
  ): Promise<CompactionReport> {
    if (this.#closed) return Promise.reject(closedError());
    if (
      this.#follower &&
      this.#db.prepare("SELECT 1 FROM base_sources LIMIT 1").get() !== undefined
    ) {
      // its history-only commits are already in the base: a fold would apply them twice
      return Promise.reject(
        new Error(
          "Internal error: a copy that installs serve's base by partition never compacts locally",
        ),
      );
    }
    return this.#compact(through, options).finally(() =>
      this.#notifyHeadMoved(true)
    );
  }

  /**
   * Compacts batch by batch, each batch its own turn in the queue, so an
   * append waits for one batch, never the whole compaction.
   */
  async #compact(
    through: number,
    options: SqliteCompactHistoryOptions,
  ): Promise<CompactionReport> {
    if (!Number.isSafeInteger(through) || through < 0) {
      throw new Error(`through must be a non-negative integer: ${through}`);
    }
    const batchSize = options.batchSize ?? COMPACTION_BATCH;
    requirePositive(batchSize, "batchSize");
    const retention = options.releasedRetentionMs ?? DEFAULT_CHUNK_GRACE_MS;
    if (!Number.isSafeInteger(retention) || retention < 0) {
      throw new Error(
        `releasedRetentionMs must be a non-negative integer: ${retention}`,
      );
    }
    const totals: CompactionTotals = {
      compacted: 0,
      batches: 0,
      released: 0,
      prunedTxns: 0,
      partitions: new Set<string>(),
    };
    for (;;) {
      this.#assertOpen();
      const folded = await this.#enqueue(() =>
        this.#compactBatch(through, batchSize, retention, options, totals)
      );
      if (!folded) break;
    }
    return {
      point: this.#point(),
      compacted: totals.compacted,
      batches: totals.batches,
      released: totals.released,
      partitions: totals.partitions.size,
      ...(options.pruneTxnsBefore !== undefined
        ? { prunedTxns: totals.prunedTxns }
        : {}),
    };
  }

  /**
   * false when no batch is left; the point is rechecked inside the
   * transaction, and base references are added before the commits' are
   * dropped, so a present chunk's count never reaches zero
   */
  async #compactBatch(
    through: number,
    batchSize: number,
    retention: number,
    options: SqliteCompactHistoryOptions,
    totals: CompactionTotals,
  ): Promise<boolean> {
    options.signal?.throwIfAborted();
    // Never past the last cursor assigned: a point above it would cover
    // commits not yet written. Read each turn, since appends land between.
    const last = (this.#db.prepare("SELECT MAX(cursor) AS cursor FROM commits")
      .get() as { cursor: number | null }).cursor ?? 0;
    const target = Math.min(through, last);
    const point = this.#point();
    if (point >= target) return false;
    const page = this.#db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
        "WHERE cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?",
    );
    // in pages, a turn between them: each row carries a whole commit body
    const reading = new TimeSlice(undefined, FOLD_SLICE_MS);
    const rows: CommitRow[] = [];
    let after = point;
    while (rows.length < batchSize) {
      if (reading.over) await reading.next();
      const want = Math.min(REBUILD_PAGE, batchSize - rows.length);
      const read = page.all(after, target, want) as unknown as CommitRow[];
      for (const row of read) rows.push(row);
      if (read.length < want) break;
      after = read[read.length - 1].cursor;
    }
    if (rows.length === 0) return false;
    const commits: Commit[] = [];
    for (const row of rows) {
      if (reading.over) await reading.next();
      commits.push(await parseRow(row));
    }

    // Each partition's last seq in the batch becomes its compacted seq. A
    // rebuild must never need a deleted commit, so a partition whose latest
    // snapshot is older gets one at that seq.
    const lastSeq = new Map<string, Commit>();
    for (const commit of commits) {
      totals.partitions.add(
        cacheKeyOf(commit.namespace, commit.partition.toString()),
      );
      lastSeq.set(
        cacheKeyOf(commit.namespace, commit.partition.toString()),
        commit,
      );
    }
    const snapshots: {
      namespace: string;
      partition: string;
      seq: number;
      body: string;
    }[] = [];
    for (const commit of lastSeq.values()) {
      const partition = commit.partition.toString();
      const current = this.#selectSnapshot.get(commit.namespace, partition) as
        | { seq: number }
        | undefined;
      if (current !== undefined && current.seq >= commit.seq) continue;
      // a rebuild costs the partition's size, so a spent budget stops before
      // one; nothing of this batch is written yet, and the first batch of a
      // run always finishes, so a backlog still folds run by run
      if (totals.batches > 0) options.signal?.throwIfAborted();
      const rebuilt = await this.#rebuild(
        commit.namespace,
        commit.partition,
        commit.seq,
      );
      if (rebuilt.seq !== commit.seq) {
        // Its commits changed between reading the batch and rebuilding.
        throw new Error(
          `Partition ${partition} changed in commits.db during compaction: another process is writing the store`,
        );
      }
      snapshots.push({
        namespace: commit.namespace,
        partition,
        seq: commit.seq,
        body: JSON.stringify(rebuilt.snapshot()),
      });
    }

    const now = (options.clock ?? (() => new Date()))().getTime();
    const pruneTxnsBefore = options.pruneTxnsBefore?.getTime();
    const pruneRemovedBefore = options.pruneRemovedBefore?.getTime();
    const sliceMs = options.sliceMs ?? FOLD_SLICE_MS;
    const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
    // Each snapshot lands in its own transaction before any of the batch's
    // commits is deleted, as an append's snapshot does, so a rebuild never
    // needs a deleted commit.
    for (const snapshot of snapshots) {
      await turn();
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        if (this.#point() !== point) {
          throw new Error(
            "The compaction point moved during compaction: another process is writing the store",
          );
        }
        this.#checkWriterFence(options.fence);
        this.#upsertSnapshot.run(
          snapshot.namespace,
          snapshot.partition,
          snapshot.seq,
          snapshot.body,
        );
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        this.#cache.clear();
        throw error;
      }
    }
    // The batch then folds in transactions of about a slice each, the loop
    // turning between them; each leaves the point at its last commit, as a
    // smaller batch would.
    let expected = point;
    let next = 0;
    this.#base.begin(now);
    while (next < rows.length) {
      if (next > 0) await turn();
      const from = next;
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        if (this.#point() !== expected) {
          throw new Error(
            "The compaction point moved during compaction: another process is writing the store",
          );
        }
        // Compaction is the writer's: one that lost its lease, or holds none
        // once the store has a fence, stops here.
        this.#checkWriterFence(options.fence);
        this.#base.beginSlice();
        const until = performance.now() + sliceMs;
        do {
          foldCommit(
            this.#base,
            commits[next],
            rows[next].cursor,
            MATERIALISED_SUBDIRS,
          );
          next++;
        } while (next < rows.length && performance.now() < until);
        for (let i = from; i < next; i++) {
          this.#base.compactCommit(
            rows[i],
            commits[i].chunkRefs(),
            Date.parse(commits[i].at),
          );
        }
        this.#base.setPoint(rows[next - 1]);
        totals.released += this.#base.finish(now - retention);
        if (next === rows.length) {
          if (pruneTxnsBefore !== undefined) {
            totals.prunedTxns += this.#base.pruneTxns(pruneTxnsBefore);
          }
          if (pruneRemovedBefore !== undefined) {
            this.#base.pruneRemoved(pruneRemovedBefore, BASE_REMOVED_CAP);
          }
        }
        options.beforeCommit?.();
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        // Cached partitions are unaffected by a rolled-back batch, but drop
        // them anyway so nothing rebuilt around it is trusted.
        this.#cache.clear();
        throw error;
      }
      totals.compacted += next - from;
      expected = rows[next - 1].cursor;
    }
    totals.batches++;
    return true;
  }

  compactionPoint(): Promise<number> {
    if (this.#closed) return Promise.reject(closedError());
    return Promise.resolve(this.#point());
  }

  readCompactedBase(
    after: string | undefined,
    limit: number,
  ): Promise<CompactedBasePage> {
    if (this.#closed) return Promise.reject(closedError());
    requirePositive(limit, "limit");
    try {
      return Promise.resolve(this.#readTransaction(() => {
        const page = this.#base.readPage(after, limit);
        return { point: this.#point(), ...page };
      }));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * One partition's whole base a page at a time, for a partition too large to
   * read at once; `next` is undefined on the last page.
   */
  readBaseOfPartitionPage(
    namespace: string,
    partition: string,
    after: string | undefined,
    limit: number,
  ): Promise<{
    seq: number;
    entries: CompactedBaseEntry[];
    next: string | undefined;
  }> {
    if (this.#closed) return Promise.reject(closedError());
    requirePositive(limit, "limit");
    try {
      return Promise.resolve(
        this.#readTransaction(() =>
          this.#base.readPartitionPage(namespace, partition, after, limit)
        ),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  async readBaseIndex(
    namespace: string,
    slice: BaseIndexSlice = BASE_INDEX_SLICE,
  ): Promise<readonly BaseIndexEntry[]> {
    if (this.#closed) throw closedError();
    // the base changes only when a fold moves the point, so one build per point
    const point = this.#readTransaction(() => this.#point());
    const cached = this.#indexCache.get(namespace);
    if (cached?.point === point) return cached.entries;
    const running = this.#indexBuilds.get(namespace);
    if (running?.point === point) return await running.build;
    const build = this.#buildBaseIndex(namespace, slice).then((built) => {
      this.#indexCache.set(namespace, built);
      return built.entries;
    });
    this.#indexBuilds.set(namespace, { point, build });
    try {
      return await build;
    } finally {
      if (this.#indexBuilds.get(namespace)?.build === build) {
        this.#indexBuilds.delete(namespace);
      }
    }
  }

  /**
   * builds the index in slices, each its own read transaction with the event
   * loop free between them; a fold moving the point mid-build starts it again
   */
  async #buildBaseIndex(
    namespace: string,
    slice: BaseIndexSlice,
  ): Promise<{ point: number; entries: readonly BaseIndexEntry[] }> {
    for (let attempt = 1; attempt <= BASE_INDEX_BUILD_ATTEMPTS; attempt++) {
      const built = await this.#buildBaseIndexAt(namespace, slice);
      if (built !== undefined) return built;
    }
    // folds outran every sliced build: one blocking read is still correct
    return this.#readTransaction(() => ({
      point: this.#point(),
      entries: this.#base.readIndex(namespace),
    }));
  }

  async #buildBaseIndexAt(
    namespace: string,
    slice: BaseIndexSlice,
  ): Promise<
    { point: number; entries: readonly BaseIndexEntry[] } | undefined
  > {
    let point = 0;
    const sliceAt = async <T>(body: () => T): Promise<T | undefined> => {
      await yieldToLoop();
      if (this.#closed) throw closedError();
      return this.#readTransaction(() =>
        this.#point() === point ? body() : undefined
      );
    };
    const first = this.#readTransaction(() => {
      point = this.#point();
      return {
        partitions: this.#base.indexPartitions(namespace),
        horizons: this.#base.indexHorizons(namespace),
      };
    });
    const counts = new Map<string, number>();
    const add = (from: ReadonlyMap<string, number>) => {
      for (const [partition, n] of from) {
        counts.set(partition, (counts.get(partition) ?? 0) + n);
      }
    };
    const contested = new Set<string>();
    const { partitions } = first;
    for (let i = 0; i < partitions.length; i += slice.partitions) {
      const range = partitions.slice(i, i + slice.partitions);
      const part = await sliceAt(() =>
        this.#base.indexPartitionCounts(
          namespace,
          range[0].partition,
          range[range.length - 1].partition,
        )
      );
      if (part === undefined) return undefined;
      add(part.counts);
      for (const partition of part.contested) contested.add(partition);
    }
    let after: string | undefined;
    for (;;) {
      const page = await sliceAt(() =>
        this.#base.indexFileOwners(namespace, after, slice.files)
      );
      if (page === undefined) return undefined;
      add(page.owners);
      if (page.last === undefined) break;
      after = page.last;
    }
    return {
      point,
      entries: partitions.map((row) => ({
        partition: row.partition,
        seq: row.seq,
        rows: counts.get(row.partition) ?? 0,
        horizon: first.horizons.get(row.partition) ?? 0,
        contested: contested.has(row.partition),
      })),
    };
  }

  /** when this copy last asked serve's index, and whether it found nothing to do */
  followState(
    namespace: string,
  ): Promise<{ checkedAt: number; idle: boolean } | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    const row = this.#db.prepare(
      "SELECT checked_at, idle FROM follow_state WHERE namespace = ?",
    ).get(namespace) as { checked_at: number; idle: number } | undefined;
    return Promise.resolve(
      row === undefined
        ? undefined
        : { checkedAt: row.checked_at, idle: row.idle === 1 },
    );
  }

  setFollowState(
    namespace: string,
    checkedAt: number,
    idle: boolean,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(() => {
      this.#db.prepare(
        "INSERT OR REPLACE INTO follow_state (namespace, checked_at, idle) VALUES (?, ?, ?)",
      ).run(namespace, checkedAt, idle ? 1 : 0);
      return Promise.resolve();
    });
  }

  /**
   * One partition's base, or its difference since `since`: "gone" when
   * `since` is below the partition's horizon, "too-large" past `limit` rows.
   */
  readBaseOfPartition(
    namespace: string,
    partition: string,
    since: number | undefined,
    limit: number,
  ): Promise<PartitionBaseRows | "gone" | "too-large"> {
    if (this.#closed) return Promise.reject(closedError());
    requirePositive(limit, "limit");
    try {
      return Promise.resolve(
        this.#readTransaction(() =>
          this.#base.readPartition(namespace, partition, since, limit)
        ),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  readPartitionBase(
    namespace: string,
    partition: PartitionKey,
    names: readonly string[],
  ): Promise<PartitionBase> {
    if (this.#closed) return Promise.reject(closedError());
    try {
      return Promise.resolve(
        this.#readTransaction(() =>
          this.#partitionBase(namespace, partition.toString(), names)
        ),
      );
    } catch (error) {
      return Promise.reject(error);
    }
  }

  #partitionBase(
    namespace: string,
    partition: string,
    names: readonly string[],
  ): PartitionBase {
    const seq = (this.#db.prepare(
      "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined)?.seq ?? 0;
    const versions = this.#db.prepare(
      "SELECT metadata FROM base_versions WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version",
    );
    const catalog = this.#db.prepare(
      "SELECT v.metadata FROM base_catalog AS c JOIN base_versions AS v " +
        "ON v.namespace = c.namespace AND v.partition = c.partition AND v.name = c.name AND v.version = c.version " +
        "WHERE c.namespace = ? AND c.partition = ? AND c.name = ? ORDER BY c.version",
    );
    const forward = this.#db.prepare(
      "SELECT renamed_to FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    );
    const found = new Map<string, BaseDataName>();
    for (const name of new Set(names)) {
      const live = (versions.all(namespace, partition, name) as {
        metadata: string;
      }[]).map((row) => {
        const metadata = parseMetadata(row.metadata);
        return { version: metadata.version, metadata };
      });
      const rows = (catalog.all(namespace, partition, name) as {
        metadata: string;
      }[]).map((row) => parseMetadata(row.metadata));
      const to = (forward.get(namespace, partition, name) as
        | { renamed_to: string }
        | undefined)?.renamed_to;
      if (live.length === 0 && rows.length === 0 && to === undefined) continue;
      found.set(name, { versions: live, catalogRows: rows, forward: to });
    }
    return { compactedSeq: seq, names: found };
  }

  readBaseRecord(
    namespace: string,
    partition: PartitionKey,
    key: string,
  ): Promise<BaseRecord | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    try {
      const row = this.#db.prepare(
        "SELECT sha256, inline, blob, access FROM base_records WHERE namespace = ? AND partition = ? AND record_key = ?",
      ).get(namespace, partition.toString(), key) as
        | Record<string, unknown>
        | undefined;
      return Promise.resolve(row === undefined ? undefined : baseRecordOf(row));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** which put the compacted base shows `key` at, as a base load stages it */
  baseFileOwnership(
    namespace: string,
    key: string,
  ): Promise<FileOwnership | undefined> {
    if (this.#closed) return Promise.reject(closedError());
    try {
      return Promise.resolve(this.#base.fileOwnership(namespace, key));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /**
   * The store's last commit position (swamp-club#3482): the highest cursor
   * still accounted for, from the stored commits, else the compaction point,
   * else 0; with the commit at it when that commit is still stored. Read
   * from the rows, never from `sqlite_sequence`, which a truncation leaves
   * ahead of them.
   */
  highWaterMark(): HighWaterMark {
    this.#assertOpen();
    return this.#readTransaction(() => {
      const row = this.#db.prepare(
        "SELECT cursor, namespace, partition, seq, txn_id FROM commits ORDER BY cursor DESC LIMIT 1",
      ).get() as Omit<CommitRow, "body"> | undefined;
      if (row === undefined) return { cursor: this.#point() };
      return {
        cursor: row.cursor,
        commit: {
          namespace: row.namespace,
          partition: row.partition,
          seq: row.seq,
          txnId: row.txn_id,
        },
      };
    });
  }

  /**
   * How the store stands against `mark` (swamp-club#3482):
   *
   * - `compacted-past` when the compaction point is past the mark, or a
   *   partition with commits past the mark was compacted and its only
   *   snapshot is past the mark too: its state at the mark is gone;
   * - `mismatch` when the store holds another commit than `mark.commit` at
   *   the mark's cursor (a compacted one is matched by its txnId), or holds
   *   no commit at or past a cursor above the compaction point: it misses
   *   commits the writer acknowledged;
   * - `match` otherwise: {@link truncateAfter} can take the store to it.
   */
  checkMark(mark: HighWaterMark): MarkCheck {
    this.#assertOpen();
    requireMark(mark);
    return this.#readTransaction(() => this.#checkMark(mark));
  }

  /** {@link checkMark}, inside the caller's transaction. */
  #checkMark(mark: HighWaterMark): MarkCheck {
    const point = this.#point();
    if (point > mark.cursor) return "compacted-past";
    const commit = mark.commit;
    if (commit !== undefined) {
      const row = this.#db.prepare(
        "SELECT namespace, partition, seq, txn_id FROM commits WHERE cursor = ?",
      ).get(mark.cursor) as Omit<CommitRow, "cursor" | "body"> | undefined;
      const found = row !== undefined
        ? row.namespace === commit.namespace &&
          row.partition === commit.partition && row.seq === commit.seq &&
          row.txn_id === commit.txnId
        // The mark's commit may be the last one compaction folded.
        : mark.cursor <= point &&
          (this.#db.prepare(
              "SELECT seq FROM compacted_txns WHERE namespace = ? AND partition = ? AND txn_id = ?",
            ).get(commit.namespace, commit.partition, commit.txnId) as
              | { seq: number }
              | undefined)?.seq === commit.seq;
      if (!found) return "mismatch";
    }
    if (mark.cursor > point) {
      const reaches = this.#db.prepare(
        "SELECT 1 AS found FROM commits WHERE cursor >= ? LIMIT 1",
      ).get(mark.cursor) !== undefined;
      if (!reaches) return "mismatch";
    }
    // A partition is rebuilt from its snapshot, or from seq 1. One whose
    // early commits were compacted and whose snapshot is past the mark could
    // not be rebuilt at the mark: its state there was never kept.
    const unrebuildable = this.#db.prepare(
      "SELECT 1 AS found FROM (" +
        "SELECT namespace, partition, MIN(seq) AS first FROM commits WHERE cursor > ? GROUP BY namespace, partition" +
        ") AS t JOIN partition_snapshots AS s USING (namespace, partition) " +
        "JOIN compacted_partitions AS c USING (namespace, partition) " +
        "WHERE s.seq >= t.first LIMIT 1",
    ).get(mark.cursor) !== undefined;
    return unrebuildable ? "compacted-past" : "match";
  }

  /**
   * Takes the store back to `mark` (swamp-club#3482): removes every commit
   * past its cursor, as if they were never appended. Their chunk references
   * are dropped (a chunk left unnamed is released, as compaction releases
   * one), each partition they touched gets the head its remaining commits
   * give (or none, when it has none and was never compacted), and a
   * snapshot past that head is replaced by the one an append would have
   * left: at the last multiple of the snapshot interval at or below it, or
   * none. The writer fence is left alone. Cursors are
   * never reused: later appends land past the removed ones.
   *
   * One thing is not undone: the data versions the removed commits recorded
   * (swamp-club#3532). Each touched partition keeps them in its names'
   * high-water marks and removed versions, written as a snapshot at its new
   * head, so a later write never gives one of those numbers to different
   * content. Apart from that the store is the one that appended only the
   * commits up to `mark`.
   *
   * Queued behind appends in flight, and applied in one write transaction.
   * The removed commits are read, and the touched partitions rebuilt at
   * their new heads, before it starts.
   *
   * @throws CommitStoreTruncateRefusedError unless {@link checkMark} is
   *   `match`; nothing is changed
   */
  truncateAfter(mark: HighWaterMark): Promise<{ removed: number }> {
    if (this.#closed) return Promise.reject(closedError());
    try {
      requireMark(mark);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(() => this.#truncate(mark));
  }

  async #truncate(mark: HighWaterMark): Promise<{ removed: number }> {
    const rows = this.#readTransaction(() => {
      const verdict = this.#checkMark(mark);
      if (verdict !== "match") {
        throw new CommitStoreTruncateRefusedError(verdict, mark);
      }
      const removing = this.#db.prepare(
        "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits WHERE cursor > ? ORDER BY cursor",
      ).all(mark.cursor) as unknown as CommitRow[];
      // a history-only commit is already in the base: removing it would
      // leave the partition's head below its compacted seq
      if (
        this.#follower &&
        removing.some((row) =>
          row.seq <= this.#compactedSeq(row.namespace, row.partition)
        )
      ) {
        throw new CommitStoreTruncateRefusedError("compacted-past", mark);
      }
      return removing;
    });
    const commits: Commit[] = [];
    for (const row of rows) commits.push(await parseRow(row));

    // Each touched partition keeps the commits before its first removed one
    // (a partition's seqs grow with its cursors).
    const touched = new Map<string, Commit>();
    for (const commit of commits) {
      const key = cacheKeyOf(commit.namespace, commit.partition.toString());
      if (!touched.has(key)) touched.set(key, commit);
    }
    const heads: {
      cacheKey: string;
      namespace: string;
      partition: string;
      partitionState: Partition;
      /** The snapshot replacing one past the new head, if any. */
      snapshot?: { seq: number; body: string };
    }[] = [];
    for (const [cacheKey, first] of touched) {
      // A follower's seqs can have holes (swamp-club#3985): it keeps the
      // highest seq below the first removed one, stored or compacted.
      const keep = this.#follower
        ? this.#highestSeqBelow(first.namespace, first.partition, first.seq)
        : first.seq - 1;
      const rebuilt = await this.#rebuild(
        first.namespace,
        first.partition,
        keep,
      );
      if (rebuilt.seq !== keep) {
        throw new Error(
          `Partition ${first.partition} changed in commits.db during truncation: another process is writing the store`,
        );
      }
      // The data versions the removed commits recorded stay out of reach of
      // later writes (swamp-club#3532): the writer that made them may have
      // shared them already. A snapshot at the new head keeps that, since a
      // replay of the kept commits alone would not.
      let retained = false;
      for (const [name, versions] of droppedVersions(commits, cacheKey)) {
        if (rebuilt.retainDroppedVersions(name, versions)) retained = true;
      }
      const stored = this.#selectSnapshot.get(
        first.namespace,
        first.partition.toString(),
      ) as { seq: number; body: string } | undefined;
      // A snapshot past the new head may hold versions an earlier truncation
      // retained, which no kept commit records: keep them too.
      if (stored !== undefined && stored.seq > keep) {
        const later = Partition.restore(
          first.partition,
          JSON.parse(stored.body),
          () => false,
        );
        if (rebuilt.retainVersionsOf(later)) retained = true;
      }
      // The partition's one snapshot row is past the new head: put back the
      // snapshot the appends up to it wrote last. A compacted partition's
      // snapshot is never past it (checkMark refuses that).
      const at = keep - keep % this.#snapshotInterval;
      let snapshot: { seq: number; body: string } | undefined;
      if (retained) {
        snapshot = { seq: keep, body: JSON.stringify(rebuilt.snapshot()) };
      } else if (stored !== undefined && stored.seq > keep && at > 0) {
        const state = at === keep ? rebuilt : await this.#rebuild(
          first.namespace,
          first.partition,
          at,
        );
        // A follower may hold no commit at `at`: its rebuild there stops at
        // the last seq it holds, which is as good a snapshot (or none).
        if (!this.#follower) {
          snapshot = { seq: at, body: JSON.stringify(state.snapshot()) };
        } else if (state.seq > 0) {
          snapshot = { seq: state.seq, body: JSON.stringify(state.snapshot()) };
        }
      }
      heads.push({
        cacheKey,
        namespace: first.namespace,
        partition: first.partition.toString(),
        partitionState: rebuilt,
        snapshot,
      });
    }

    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const verdict = this.#checkMark(mark);
      if (verdict !== "match") {
        throw new CommitStoreTruncateRefusedError(verdict, mark);
      }
      const tail = this.#db.prepare(
        "SELECT COUNT(*) AS n, MAX(cursor) AS last FROM commits WHERE cursor > ?",
      ).get(mark.cursor) as { n: number; last: number | null };
      if (
        tail.n !== rows.length ||
        (tail.last ?? undefined) !== rows[rows.length - 1]?.cursor
      ) {
        throw new Error(
          "The commits past the high-water mark changed during truncation: another process is writing the store",
        );
      }
      for (const commit of commits) {
        this.#base.releaseRefs(
          commit.namespace,
          commit.partition.toString(),
          commit.chunkRefs(),
          now,
        );
      }
      this.#db.prepare("DELETE FROM commits WHERE cursor > ?").run(mark.cursor);
      for (const { namespace, partition, partitionState, snapshot } of heads) {
        if (
          partitionState.seq === 0 &&
          this.#compactedSeq(namespace, partition) === 0
        ) {
          this.#db.prepare(
            "DELETE FROM partition_heads WHERE namespace = ? AND partition = ?",
          ).run(namespace, partition);
        } else {
          this.#upsertHead.run(
            namespace,
            partition,
            partitionState.seq,
            partitionState.highestFence ?? null,
          );
        }
        this.#db.prepare(
          "DELETE FROM partition_snapshots WHERE namespace = ? AND partition = ? AND seq > ?",
        ).run(namespace, partition, partitionState.seq);
        if (snapshot !== undefined) {
          this.#upsertSnapshot.run(
            namespace,
            partition,
            snapshot.seq,
            snapshot.body,
          );
        }
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    } finally {
      // Cached state of a touched partition is past its new head, or, after
      // a failure, not trusted.
      for (const { cacheKey } of heads) this.#cache.delete(cacheKey);
    }
    return { removed: rows.length };
  }

  /**
   * Drops `partition`'s commits from seq `fromSeq` up, as if this follower copy
   * never observed them: their chunk references go, the head falls back to the
   * highest seq kept, and a snapshot past it is replaced by one at it.
   */
  dropObservedFrom(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
  ): Promise<readonly Commit[]> {
    if (this.#closed) return Promise.reject(closedError());
    if (!this.#follower) {
      return Promise.reject(
        new Error(
          "Internal error: only a serve-mode copy of a v3 datastore drops the commits it observed",
        ),
      );
    }
    try {
      requirePositive(fromSeq, "fromSeq");
    } catch (error) {
      return Promise.reject(error);
    }
    return this.#enqueue(() =>
      this.#dropObserved(namespace, partition, fromSeq)
    )
      .finally(() => this.#notifyHeadMoved(true));
  }

  async #dropObserved(
    namespace: string,
    key: PartitionKey,
    fromSeq: number,
  ): Promise<readonly Commit[]> {
    const name = key.toString();
    const cacheKey = cacheKeyOf(namespace, name);
    const selectFrom = this.#db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
        "WHERE namespace = ? AND partition = ? AND seq >= ? ORDER BY seq",
    );
    const rows = this.#readTransaction(() => {
      const compacted = this.#compactedSeq(namespace, name);
      if (fromSeq <= compacted) {
        throw new ObservedDropRefusedError(
          `Partition ${name} is compacted through seq ${compacted}; its commits from seq ${fromSeq} cannot be dropped`,
        );
      }
      return selectFrom.all(namespace, name, fromSeq) as unknown as CommitRow[];
    });
    if (rows.length === 0) return [];
    const commits: Commit[] = [];
    for (const row of rows) commits.push(await parseRow(row));
    const keep = this.#highestSeqBelow(namespace, key, fromSeq);
    const stored = this.#selectSnapshot.get(namespace, name) as
      | { seq: number; body: string }
      | undefined;
    // A compacted partition replays from its snapshot: one past `keep` leaves
    // nothing to rebuild the kept state from.
    if (
      stored !== undefined && stored.seq > keep &&
      this.#compactedSeq(namespace, name) > 0
    ) {
      throw new ObservedDropRefusedError(
        `Partition ${name} of commits.db cannot drop its commits from seq ${fromSeq}: its only snapshot is past them and its earlier commits were compacted`,
      );
    }
    const rebuilt = await this.#rebuild(namespace, key, keep);
    if (rebuilt.seq !== keep) {
      throw new Error(
        `Partition ${name} changed in commits.db while its commits were dropped: another process is writing the store`,
      );
    }
    const now = Date.now();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const again = selectFrom.all(namespace, name, fromSeq) as unknown as {
        cursor: number;
      }[];
      if (
        again.length !== rows.length ||
        again.some((row, at) => row.cursor !== rows[at].cursor)
      ) {
        throw new Error(
          `Partition ${name} changed in commits.db while its commits were dropped: another process is writing the store`,
        );
      }
      for (const commit of commits) {
        this.#base.releaseRefs(namespace, name, commit.chunkRefs(), now);
      }
      this.#db.prepare(
        "DELETE FROM commits WHERE namespace = ? AND partition = ? AND seq >= ?",
      ).run(namespace, name, fromSeq);
      if (keep === 0 && this.#compactedSeq(namespace, name) === 0) {
        this.#db.prepare(
          "DELETE FROM partition_heads WHERE namespace = ? AND partition = ?",
        ).run(namespace, name);
      } else {
        this.#upsertHead.run(
          namespace,
          name,
          rebuilt.seq,
          rebuilt.highestFence ?? null,
        );
      }
      this.#db.prepare(
        "DELETE FROM partition_snapshots WHERE namespace = ? AND partition = ? AND seq > ?",
      ).run(namespace, name, keep);
      if (stored !== undefined && stored.seq > keep && keep > 0) {
        this.#upsertSnapshot.run(
          namespace,
          name,
          keep,
          JSON.stringify(rebuilt.snapshot()),
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    } finally {
      this.#cache.delete(cacheKey);
    }
    return commits;
  }

  /**
   * A partition's highest seq below `seq`, stored or compacted; 0 when it
   * has none. A follower's head after a truncation (swamp-club#3985).
   */
  #highestSeqBelow(namespace: string, key: PartitionKey, seq: number): number {
    const row = this.#db.prepare(
      "SELECT MAX(seq) AS seq FROM (" +
        "SELECT MAX(seq) AS seq FROM commits WHERE namespace = ?1 AND partition = ?2 AND seq < ?3 " +
        "UNION ALL SELECT seq FROM compacted_partitions WHERE namespace = ?1 AND partition = ?2 AND seq < ?3)",
    ).get(namespace, key.toString(), seq) as { seq: number | null };
    return row.seq ?? 0;
  }

  /** The compaction point; 0 before any compaction. */
  #point(): number {
    return (this.#selectPoint.get() as { point: number }).point;
  }

  /** A partition's compacted seq; 0 when none of its commits was compacted. */
  #compactedSeq(namespace: string, partition: string): number {
    return (this.#selectCompactedSeq.get(namespace, partition) as
      | { seq: number }
      | undefined)?.seq ?? 0;
  }

  /** Runs reads in one read transaction, so they see one state of the file. */
  #readTransaction<T>(body: () => T): T {
    this.#db.exec("BEGIN");
    try {
      const result = body();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  /**
   * Installs the content of the restored `commits.db` at `path` into this
   * store's database, in place (swamp-club#3482). The caller has checked and
   * truncated the restored file; this makes the store's file hold exactly
   * its content, in one write transaction, so every connection that has the
   * file open keeps working and sees the change at once.
   *
   * The restored file is first opened as {@link open} opens one, so it is
   * migrated to this schema; a newer schema is refused and nothing changes.
   * Every table is copied row by row from a connection to the restored
   * file (ATTACH DATABASE needs full permissions for the path, which the
   * compiled binary does not have), `sqlite_sequence` last so cursors are
   * never reused, and `writer_fence` like any other (the caller raises it
   * after).
   * Queued behind appends in flight. Rebuilt partitions are dropped.
   */
  replaceContentFrom(path: string): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    return this.#enqueue(() => this.#replaceContent(path)).finally(() =>
      this.#notifyHeadMoved(true)
    );
  }

  /**
   * Installs the compacted base `staging` holds in place of this follower
   * copy's content (swamp-club#4006): a copy whose cursor serve has
   * compacted past loads serve's base, filtered to what its caller may
   * read, rather than the commits. Every commit the copy held is at or
   * below serve's `point`, so the base replaces them.
   *
   * The staging file is finished first, nothing in this store changed:
   *
   * - the compaction point is the higher of serve's point and the copy's
   *   last cursor plus one, and the commits' sequence at least that. Base
   *   ownership marks are positions in serve's feed, at or below its point,
   *   so they sort before every later append, and a read model at any
   *   cursor this copy handed out sees the point past it and loads the base;
   * - each partition's head is its compacted seq, with a snapshot there
   *   built from its records and its data names' versions and marks, so a
   *   rebuild never needs a commit the copy never held;
   * - the rows that belong to this file, not its content, are carried from
   *   it: the log id, the writer fence and the owner.
   *
   * It is then installed in one write transaction, as
   * {@link replaceContentFrom} installs a restored file: a crash leaves
   * either the old content or the new.
   */
  installObservedBase(
    staging: ObservedBaseStaging,
    point: number,
  ): Promise<void> {
    if (this.#closed) return Promise.reject(closedError());
    if (!this.#follower) {
      return Promise.reject(
        new Error(
          "Internal error: only a serve-mode copy of a v3 datastore loads serve's compacted base",
        ),
      );
    }
    if (!Number.isSafeInteger(point) || point < 1) {
      return Promise.reject(
        new Error(`point must be a positive integer: ${point}`),
      );
    }
    return this.#enqueue(() => {
      // Installed from its path: a file gone from it would install as an
      // empty store, so it is refused instead.
      Deno.statSync(staging.path);
      const last = (this.#db.prepare(
        "SELECT seq FROM sqlite_sequence WHERE name = 'commits'",
      ).get() as { seq: number } | undefined)?.seq ?? 0;
      const local = Math.max(point, last + 1, this.#point());
      staging.finish(local, {
        logId: this.logId(),
        fence: this.#db.prepare("SELECT * FROM writer_fence").all(),
        owner: this.#db.prepare("SELECT * FROM datastore_owner").all(),
      });
      this.#replaceContent(staging.path);
    }).finally(() => this.#notifyHeadMoved(true));
  }

  #replaceContent(path: string): void {
    // Opened as open() opens a store: migrated, or refused when newer.
    const restored = openCommitsDatabase(path);
    try {
      // Read from a connection of its own: ATTACH DATABASE is disabled
      // without full permissions for the path, which the compiled binary
      // does not have.
      restored.exec("BEGIN");
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        const tables = (this.#db.prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' " +
            "AND (name NOT LIKE 'sqlite\\_%' ESCAPE '\\' OR name = 'sqlite_sequence') " +
            "ORDER BY name = 'sqlite_sequence', name",
        ).all() as { name: string }[]).map((row) => row.name);
        const present = new Set(
          (restored.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table'",
          ).all() as { name: string }[]).map((row) => row.name),
        );
        for (const table of tables) {
          const name = quoteIdentifier(table);
          this.#db.exec(`DELETE FROM ${name}`);
          if (!present.has(table)) continue;
          const columns = (this.#db.prepare(`PRAGMA table_info(${name})`)
            .all() as { name: string }[]).map((column) => column.name);
          const list = columns.map(quoteIdentifier).join(", ");
          const insert = this.#db.prepare(
            `INSERT INTO ${name} (${list}) VALUES (${
              columns.map(() => "?").join(", ")
            })`,
          );
          const select = restored.prepare(`SELECT ${list} FROM ${name}`);
          select.setReadBigInts(true);
          for (const row of select.iterate()) {
            const values = row as Record<string, SQLInputValue>;
            insert.run(...columns.map((column) => values[column]));
          }
        }
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        throw error;
      }
    } finally {
      this.#cache.clear();
      rollbackQuietly(restored);
      restored.close();
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#cache.clear();
    const key = this.#connectionKey;
    const connections = key === undefined
      ? undefined
      : storeConnections.get(key);
    connections?.delete(this.#db);
    if (key !== undefined && connections?.size === 0) {
      storeConnections.delete(key);
    }
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw closedError();
  }
}

/** keyed by the resolved `commits.db` path */
const storeConnections = new Map<string, Set<DatabaseSync>>();

/** Paths {@link stopAutoCheckpointAt} named: stores open there with it off. */
const autoCheckpointOffAt = new Set<string>();

/**
 * before a sidecar starts on `path`: auto-checkpoint off on every open store
 * connection there and on later opens; synchronous, so no commit lands between
 * two connections' switches
 */
export function stopAutoCheckpointAt(path: string): void {
  const key = resolve(path);
  autoCheckpointOffAt.add(key);
  for (const db of storeConnections.get(key) ?? []) {
    db.exec("PRAGMA wal_autocheckpoint=0");
  }
}

/** The connections open stores hold to the `commits.db` at `path`. For tests. */
export function storeConnectionsAt(path: string): readonly DatabaseSync[] {
  return [...storeConnections.get(resolve(path)) ?? []];
}

/**
 * Opens `commits.db` at `path` the way the store uses it, creating the file
 * and its schema when absent: WAL, `synchronous=FULL` so a commit is durable
 * when append returns, a busy timeout, and SQLite's default auto-checkpoint,
 * off when Litestream replicates the file
 * ({@link SqliteCommitStoreOptions.replicated}). Exported for tests, which
 * check these settings on the store's own connection.
 */
export function openCommitsDatabase(
  path: string,
  options: { readonly replicated?: boolean } = {},
): DatabaseSync {
  ensureDirSync(dirname(path));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    useWalJournal(db);
    db.exec("PRAGMA synchronous=FULL");
    if (options.replicated === true) db.exec("PRAGMA wal_autocheckpoint=0");
    migrate(db);
    db.exec(RUN_TAIL_INDEX);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function migrateCommitsDatabase(
  path: string,
  options: { readonly replicated?: boolean } = {},
): void {
  openCommitsDatabase(path, options).close();
}

/**
 * Brings the schema to {@link COMMIT_STORE_SCHEMA_VERSION}, in one
 * transaction. A database from a newer schema is refused rather than read
 * with the wrong expectations.
 */
function migrate(db: DatabaseSync): void {
  const read = () =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  const check = (version: number) => {
    if (version > COMMIT_STORE_SCHEMA_VERSION) {
      throw new UserError(
        `commits.db is at schema version ${version}, newer than this swamp's ${COMMIT_STORE_SCHEMA_VERSION}: upgrade swamp. ` +
          "A newer swamp has written this v3 datastore, and this one cannot " +
          "read or write it. Nothing was changed.",
        COMMIT_STORE_SCHEMA_NEWER_CODE,
      );
    }
  };
  check(read());
  if (read() === COMMIT_STORE_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    // Re-read under the lock: another opener may have migrated already.
    const version = read();
    check(version);
    for (let next = version; next < COMMIT_STORE_SCHEMA_VERSION; next++) {
      runMigration(db, MIGRATIONS[next]);
    }
    db.exec(`PRAGMA user_version=${COMMIT_STORE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

/**
 * Rolls back an open transaction without letting a failing `ROLLBACK` hide
 * the error that made it necessary.
 */
function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The caller rethrows the original error. SQLite rolls the transaction
    // back itself when the connection closes.
  }
}

/**
 * Looks up which of `count` hashes a namespace's commits or compacted base
 * name, or compaction released at or after a time: the namespace and hashes
 * twice, then the time.
 */
function selectRefsSql(count: number): string {
  const list = Array.from({ length: count }, () => "?").join(", ");
  return `SELECT sha256 FROM chunk_refs WHERE namespace = ? AND sha256 IN (${list}) ` +
    `UNION SELECT sha256 FROM released_chunks WHERE namespace = ? AND sha256 IN (${list}) AND released_at >= ?`;
}

export interface BaseIndexSlice {
  readonly partitions: number;
  readonly files: number;
}

export const BASE_INDEX_SLICE: BaseIndexSlice = {
  partitions: 256,
  files: 5_000,
};

const BASE_INDEX_BUILD_ATTEMPTS = 3;

function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function closedError(): Error {
  return new Error("The commit store is closed");
}

function cacheKeyOf(namespace: string, partition: string): string {
  return JSON.stringify([namespace, partition]);
}

/** The data versions `commits` recorded in one partition, by name. */
function droppedVersions(
  commits: readonly Commit[],
  cacheKey: string,
): Map<string, number[]> {
  const versions = new Map<string, number[]>();
  for (const commit of commits) {
    if (
      cacheKeyOf(commit.namespace, commit.partition.toString()) !== cacheKey
    ) {
      continue;
    }
    for (const op of commit.ops) {
      if (op.kind !== "data-version") continue;
      const { name, version } = op.metadata;
      versions.set(name, [...versions.get(name) ?? [], version]);
    }
  }
  return versions;
}

/**
 * Parses a stored commit through {@link Commit.fromJSON}, so a row passes the
 * same checks as a commit a client sends, and checks it is the row's commit.
 */
async function parseRow(row: CommitRow): Promise<Commit> {
  let commit: Commit;
  try {
    commit = await Commit.fromJSON(JSON.parse(row.body));
  } catch (error) {
    throw corrupt(row, errorMessage(error));
  }
  if (
    commit.seq !== row.seq || commit.namespace !== row.namespace ||
    commit.partition.toString() !== row.partition ||
    commit.txnId !== row.txn_id
  ) {
    throw corrupt(
      row,
      `its body is commit ${commit.seq} of ${commit.partition} with txnId ${commit.txnId}, not this row's`,
    );
  }
  return commit;
}

function corrupt(row: CommitRow, detail: string): CommitStoreCorruptError {
  return new CommitStoreCorruptError(
    row.namespace,
    row.partition,
    row.seq,
    detail,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** An SQL identifier, double-quoted. */
function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Refuses a high-water mark that names no cursor, or names one badly. */
function requireMark(mark: HighWaterMark): void {
  if (!Number.isSafeInteger(mark.cursor) || mark.cursor < 0) {
    throw new Error(
      `A high-water mark's cursor must be a non-negative integer: ${mark.cursor}`,
    );
  }
  const commit = mark.commit;
  if (
    commit !== undefined &&
    (!Number.isSafeInteger(commit.seq) || commit.seq < 1)
  ) {
    throw new Error(
      `A high-water mark's commit seq must be a positive integer: ${commit.seq}`,
    );
  }
}

function requirePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer: ${value}`);
  }
}

interface CompactionTotals {
  compacted: number;
  batches: number;
  released: number;
  prunedTxns: number;
  partitions: Set<string>;
}

/** Test hooks for {@link SqliteCommitStore.compactHistory}. */
interface CompactionTestHooks {
  /**
   * Called inside each of a batch's transactions just before it commits.
   * Tests use it to fail or stop a batch there.
   */
  readonly beforeCommit?: () => void;
  /** how long one of a batch's transactions folds before the loop turns */
  readonly sliceMs?: number;
}

/** {@link CompactHistoryOptions} with the SQLite store's test hooks. */
export type SqliteCompactHistoryOptions =
  & CompactHistoryOptions
  & CompactionTestHooks;

/** One table of the compacted base, as {@link SqliteCompactedBase.readPage} pages it. */
interface BaseSection {
  /** The table paged by its key; `select` may join others onto it. */
  readonly table: string;
  /** Extra columns and the join that supplies them, if any. */
  readonly join?: string;
  /** The primary key, in order: the page order and the resume point. */
  readonly keys: readonly string[];
  readonly entry: (row: Record<string, unknown>) => CompactedBaseEntry;
}

const BASE_SECTIONS: readonly BaseSection[] = [
  {
    table: "compacted_partitions",
    keys: ["namespace", "partition"],
    entry: (row) => ({
      kind: "partition",
      namespace: row.namespace as string,
      partition: row.partition as string,
      seq: row.seq as number,
    }),
  },
  {
    table: "base_records",
    keys: ["namespace", "partition", "record_key"],
    entry: (row) => ({
      kind: "record",
      namespace: row.namespace as string,
      partition: row.partition as string,
      key: row.record_key as string,
      record: baseRecordOf(row),
    }),
  },
  {
    table: "base_versions",
    keys: ["namespace", "partition", "name", "version"],
    entry: (row) => {
      const metadata = parseMetadata(row.metadata as string);
      return {
        kind: "version",
        namespace: row.namespace as string,
        partition: row.partition as string,
        version: { version: metadata.version, metadata },
      };
    },
  },
  {
    table: "base_catalog",
    join:
      "JOIN base_versions AS v ON v.namespace = t.namespace AND v.partition = t.partition " +
      "AND v.name = t.name AND v.version = t.version",
    keys: ["namespace", "partition", "name", "version"],
    entry: (row) => ({
      kind: "catalog-row",
      namespace: row.namespace as string,
      partition: row.partition as string,
      metadata: parseMetadata(row.metadata as string),
    }),
  },
  {
    table: "base_forwards",
    keys: ["namespace", "partition", "name"],
    entry: (row) => ({
      kind: "forward",
      namespace: row.namespace as string,
      partition: row.partition as string,
      name: row.name as string,
      to: row.renamed_to as string,
    }),
  },
  {
    table: "base_files",
    keys: ["namespace", "record_key"],
    entry: (row) => ({
      kind: "file",
      namespace: row.namespace as string,
      key: row.record_key as string,
      ownership: {
        owner: row.owner as string,
        mark: row.mark as number,
        present: row.present === 1,
      },
    }),
  },
];

export interface StagedPartition {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly next?: string;
  readonly complete: boolean;
  readonly rows: number;
}

/** One partition of serve's base to install into a copy, whole or as a difference. */
export interface PartitionBaseInstall {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly entries: readonly ObservedBaseEntry[];
  readonly removed: readonly BaseRemoval[];
  readonly mode: "whole" | "difference";
  /** the read model's applied cursor: nothing it has not applied is folded */
  readonly readModelCursor: number;
}

export type PartitionInstallOutcome =
  | {
    readonly kind: "installed";
    readonly rows: number;
    readonly commitsRemoved: number;
  }
  | {
    readonly kind: "skipped";
    readonly reason:
      | "not-newer"
      | "no-source"
      | "behind"
      | "read-model-behind"
      | "no-snapshot";
  };

export class ChunkCountDriftError extends Error {
  constructor(sha256: string, total: number, indexed: number) {
    super(
      `Chunk ${sha256} is counted ${indexed} times by partition but ${total} times in all`,
    );
    this.name = "ChunkCountDriftError";
  }
}

/** bounds serve's removal log when churn outpaces the age prune */
export const BASE_REMOVED_CAP = 500_000;

/** the base_removed section names, one per partition-keyed base table */
export type BaseRowSection = "record" | "version" | "catalog" | "forward";

/** a data name cannot hold "/", so the version is everything before the first */
export function versionRowKey(name: string, version: number): string {
  return `${version}/${name}`;
}

/**
 * The compacted base over `commits.db`'s base tables (swamp-club#3258): the
 * {@link CompactedBaseWriter} the fold writes through inside a compaction's
 * transaction, the chunk reference counts it keeps, and the paged reader.
 * Uses the store's connection; the store opens and commits the transaction.
 */
class SqliteCompactedBase implements CompactedBaseWriter {
  readonly #db: DatabaseSync;
  readonly #selectRecordBlob: StatementSync;
  readonly #upsertRecord: StatementSync;
  readonly #deleteRecord: StatementSync;
  readonly #selectGreatestVersions: StatementSync;
  readonly #selectVersion: StatementSync;
  readonly #deleteVersion: StatementSync;
  readonly #insertVersion: StatementSync;
  readonly #updateVersion: StatementSync;
  readonly #selectCatalogVersions: StatementSync;
  readonly #selectGreatestCatalogRows: StatementSync;
  readonly #selectCatalogRow: StatementSync;
  readonly #deleteCatalogRow: StatementSync;
  readonly #insertCatalog: StatementSync;
  readonly #stampCatalogRow: StatementSync;
  readonly #selectForward: StatementSync;
  readonly #upsertForward: StatementSync;
  readonly #deleteForward: StatementSync;
  readonly #selectFile: StatementSync;
  readonly #upsertFile: StatementSync;
  readonly #selectFileUnder: StatementSync;
  readonly #upsertCompactedSeq: StatementSync;
  readonly #incrementRef: StatementSync;
  readonly #decrementRef: StatementSync;
  readonly #deleteRef: StatementSync;
  readonly #incrementPartitionRef: StatementSync;
  readonly #decrementPartitionRef: StatementSync;
  readonly #deletePartitionRef: StatementSync;
  readonly #upsertReleased: StatementSync;
  readonly #pruneReleased: StatementSync;
  readonly #insertCompactedTxn: StatementSync;
  readonly #insertTxnTime: StatementSync;
  readonly #pruneTxns: StatementSync;
  readonly #pruneTxnTimes: StatementSync;
  readonly #upsertPointCommit: StatementSync;
  readonly #deleteCommit: StatementSync;
  readonly #updatePoint: StatementSync;
  readonly #upsertRemoved: StatementSync;
  readonly #clearRemoved: StatementSync;
  readonly #countRemoved: StatementSync;
  readonly #removedCutoffForCap: StatementSync;
  readonly #raiseHorizons: StatementSync;
  readonly #deleteRemovedBefore: StatementSync;
  /** The batch's time, for released chunks. */
  #now = 0;
  /** null outside a fold: a staged base records no changes */
  #at: number | null = null;
  /** chunks whose counts the batch changed, for an install's invariant check */
  readonly touched = new Set<string>();
  /** each metadata object is serialised once: a fold compares a name's live versions on every commit */
  readonly #serialized = new WeakMap<object, string>();
  /** Chunks released in the batch so far. */
  #released = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#selectRecordBlob = db.prepare(
      "SELECT blob FROM base_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#upsertRecord = db.prepare(
      "INSERT INTO base_records (namespace, partition, record_key, sha256, inline, blob, access, changed_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, record_key) DO UPDATE SET sha256 = excluded.sha256, inline = excluded.inline, blob = excluded.blob, access = excluded.access, changed_seq = excluded.changed_seq",
    );
    this.#deleteRecord = db.prepare(
      "DELETE FROM base_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#selectGreatestVersions = db.prepare(
      "SELECT version, metadata FROM base_versions WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version DESC LIMIT ?",
    );
    this.#selectVersion = db.prepare(
      "SELECT metadata FROM base_versions WHERE namespace = ? AND partition = ? AND name = ? AND version = ?",
    );
    this.#deleteVersion = db.prepare(
      "DELETE FROM base_versions WHERE namespace = ? AND partition = ? AND name = ? AND version = ?",
    );
    this.#insertVersion = db.prepare(
      "INSERT INTO base_versions (namespace, partition, name, version, metadata, changed_seq) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#updateVersion = db.prepare(
      "UPDATE base_versions SET metadata = ?, changed_seq = ? WHERE namespace = ? AND partition = ? AND name = ? AND version = ?",
    );
    this.#selectCatalogVersions = db.prepare(
      "SELECT version FROM base_catalog WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version",
    );
    this.#selectGreatestCatalogRows = db.prepare(
      "SELECT version FROM base_catalog WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version DESC LIMIT ?",
    );
    this.#selectCatalogRow = db.prepare(
      "SELECT v.metadata FROM base_catalog AS c LEFT JOIN base_versions AS v " +
        "USING (namespace, partition, name, version) " +
        "WHERE c.namespace = ? AND c.partition = ? AND c.name = ? AND c.version = ?",
    );
    this.#deleteCatalogRow = db.prepare(
      "DELETE FROM base_catalog WHERE namespace = ? AND partition = ? AND name = ? AND version = ?",
    );
    this.#insertCatalog = db.prepare(
      "INSERT INTO base_catalog (namespace, partition, name, version, changed_seq) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stampCatalogRow = db.prepare(
      "UPDATE base_catalog SET changed_seq = ? WHERE namespace = ? AND partition = ? AND name = ? AND version = ?",
    );
    this.#selectForward = db.prepare(
      "SELECT renamed_to FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#upsertForward = db.prepare(
      "INSERT INTO base_forwards (namespace, partition, name, renamed_to, changed_seq) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, name) DO UPDATE SET renamed_to = excluded.renamed_to, changed_seq = excluded.changed_seq",
    );
    this.#deleteForward = db.prepare(
      "DELETE FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#selectFile = db.prepare(
      "SELECT owner, mark, present FROM base_files WHERE namespace = ? AND record_key = ?",
    );
    this.#upsertFile = db.prepare(
      "INSERT INTO base_files (namespace, record_key, owner, mark, present, changed_seq) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, record_key) DO UPDATE SET owner = excluded.owner, mark = excluded.mark, present = excluded.present, changed_seq = excluded.changed_seq",
    );
    // Keys under `key/` sort between `key/` and `key0` ('0' follows '/').
    this.#selectFileUnder = db.prepare(
      "SELECT 1 AS found FROM base_files WHERE namespace = ? AND record_key > ? AND record_key < ? AND present = 1 LIMIT 1",
    );
    this.#upsertCompactedSeq = db.prepare(
      "INSERT INTO compacted_partitions (namespace, partition, seq) VALUES (?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = excluded.seq",
    );
    this.#incrementRef = db.prepare(
      "INSERT INTO chunk_refs (namespace, sha256, refs) VALUES (?, ?, 1) " +
        "ON CONFLICT (namespace, sha256) DO UPDATE SET refs = refs + 1",
    );
    this.#decrementRef = db.prepare(
      "UPDATE chunk_refs SET refs = refs - 1 WHERE namespace = ? AND sha256 = ? RETURNING refs",
    );
    this.#deleteRef = db.prepare(
      "DELETE FROM chunk_refs WHERE namespace = ? AND sha256 = ?",
    );
    this.#incrementPartitionRef = db.prepare(INCREMENT_PARTITION_REF_SQL);
    this.#decrementPartitionRef = db.prepare(
      "UPDATE chunk_partitions SET refs = refs - 1 WHERE namespace = ? AND sha256 = ? AND partition = ? RETURNING refs",
    );
    this.#deletePartitionRef = db.prepare(
      "DELETE FROM chunk_partitions WHERE namespace = ? AND sha256 = ? AND partition = ?",
    );
    this.#upsertReleased = db.prepare(
      "INSERT INTO released_chunks (namespace, sha256, released_at) VALUES (?, ?, ?) " +
        "ON CONFLICT (namespace, sha256) DO UPDATE SET released_at = excluded.released_at",
    );
    this.#pruneReleased = db.prepare(
      "DELETE FROM released_chunks WHERE released_at < ?",
    );
    this.#insertCompactedTxn = db.prepare(
      "INSERT INTO compacted_txns (namespace, partition, txn_id, seq) VALUES (?, ?, ?, ?)",
    );
    this.#insertTxnTime = db.prepare(
      "INSERT OR REPLACE INTO compacted_txn_times (namespace, partition, txn_id, committed_at) VALUES (?, ?, ?, ?)",
    );
    // Never the compaction point's own commit: a high-water mark at the
    // point is checked against it. Driven by the time index, so a batch
    // costs what it prunes.
    const old =
      "SELECT t.namespace, t.partition, t.txn_id FROM compacted_txn_times AS t " +
      "WHERE t.committed_at < ?1 AND NOT EXISTS (SELECT 1 FROM compaction_point_commit AS p " +
      "WHERE p.namespace = t.namespace AND p.partition = t.partition AND p.txn_id = t.txn_id)";
    this.#pruneTxns = db.prepare(
      `DELETE FROM compacted_txns WHERE (namespace, partition, txn_id) IN (${old})`,
    );
    this.#pruneTxnTimes = db.prepare(
      `DELETE FROM compacted_txn_times WHERE (namespace, partition, txn_id) IN (${old})`,
    );
    this.#upsertPointCommit = db.prepare(
      "INSERT INTO compaction_point_commit (id, namespace, partition, txn_id) VALUES (1, ?, ?, ?) " +
        "ON CONFLICT (id) DO UPDATE SET namespace = excluded.namespace, " +
        "partition = excluded.partition, txn_id = excluded.txn_id",
    );
    this.#deleteCommit = db.prepare("DELETE FROM commits WHERE cursor = ?");
    this.#updatePoint = db.prepare(
      "UPDATE compaction SET point = ? WHERE id = 1",
    );
    this.#upsertRemoved = db.prepare(
      "INSERT INTO base_removed (namespace, partition, section, row_key, removed_seq, removed_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, section, row_key) DO UPDATE SET removed_seq = excluded.removed_seq, removed_at = excluded.removed_at",
    );
    this.#clearRemoved = db.prepare(
      "DELETE FROM base_removed WHERE namespace = ? AND partition = ? AND section = ? AND row_key = ?",
    );
    this.#countRemoved = db.prepare("SELECT COUNT(*) AS n FROM base_removed");
    this.#removedCutoffForCap = db.prepare(
      "SELECT removed_at FROM base_removed ORDER BY removed_at DESC LIMIT 1 OFFSET ?",
    );
    this.#raiseHorizons = db.prepare(
      "INSERT INTO difference_horizons (namespace, partition, seq) " +
        "SELECT namespace, partition, MAX(removed_seq) FROM base_removed WHERE removed_at < ? GROUP BY namespace, partition " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = MAX(seq, excluded.seq)",
    );
    this.#deleteRemovedBefore = db.prepare(
      "DELETE FROM base_removed WHERE removed_at < ?",
    );
  }

  /**
   * forgets removals before `before`, or the oldest beyond `cap`; horizons
   * rise first, in the same transaction, so none falls below a forgotten row
   */
  pruneRemoved(before: number, cap: number): void {
    let cutoff = before;
    const count = (this.#countRemoved.get() as { n: number }).n;
    if (count > cap) {
      const kept = this.#removedCutoffForCap.get(cap - 1) as
        | { removed_at: number }
        | undefined;
      if (kept !== undefined) cutoff = Math.max(cutoff, kept.removed_at);
    }
    this.#raiseHorizons.run(cutoff);
    this.#deleteRemovedBefore.run(cutoff);
  }

  atCommit(_namespace: string, _partition: string, seq: number): void {
    this.#at = seq;
  }

  /** a row written again is no longer removed, so a difference never sends both */
  #written(
    namespace: string,
    partition: string,
    section: BaseRowSection,
    rowKey: string,
  ): void {
    if (this.#at !== null) {
      this.#clearRemoved.run(namespace, partition, section, rowKey);
    }
  }

  #removed(
    namespace: string,
    partition: string,
    section: BaseRowSection,
    rowKey: string,
  ): void {
    if (this.#at === null) return;
    this.#upsertRemoved.run(
      namespace,
      partition,
      section,
      rowKey,
      this.#at,
      this.#now,
    );
  }

  /** Starts a batch at time `now` (epoch milliseconds). */
  begin(now: number): void {
    this.#now = now;
    this.beginSlice();
  }

  beginSlice(): void {
    this.#at = null;
    this.touched.clear();
    this.#released = 0;
  }

  putRecord(
    namespace: string,
    partition: string,
    key: string,
    record: BaseRecord,
  ): void {
    const before = this.#recordChunks(namespace, partition, key);
    const blob = "blob" in record.content ? record.content.blob : undefined;
    // Count the new content before dropping the old, so a chunk both name
    // never reaches zero.
    for (const sha256 of distinctChunks(blob)) {
      this.#incrementRef.run(namespace, sha256);
      this.#incrementPartitionRef.run(namespace, sha256, partition);
      this.touched.add(sha256);
    }
    this.#upsertRecord.run(
      namespace,
      partition,
      key,
      record.sha256,
      "inline" in record.content ? record.content.inline : null,
      blob === undefined ? null : JSON.stringify(blob.toJSON()),
      record.access ?? null,
      this.#at,
    );
    this.#written(namespace, partition, "record", key);
    for (const sha256 of before) this.#release(namespace, partition, sha256);
  }

  deleteRecord(namespace: string, partition: string, key: string): void {
    const before = this.#recordChunks(namespace, partition, key);
    const deleted = this.#deleteRecord.run(namespace, partition, key);
    if (Number(deleted.changes) > 0) {
      this.#removed(namespace, partition, "record", key);
    }
    for (const sha256 of before) this.#release(namespace, partition, sha256);
  }

  greatestLiveVersion(
    namespace: string,
    partition: string,
    name: string,
    excluding: ReadonlySet<number>,
  ): LiveDataVersion | undefined {
    for (
      const row of this.#selectGreatestVersions.all(
        namespace,
        partition,
        name,
        excluding.size + 1,
      ) as { version: number; metadata: string }[]
    ) {
      if (excluding.has(row.version)) continue;
      return { version: row.version, metadata: parseMetadata(row.metadata) };
    }
    return undefined;
  }

  applyLiveVersions(
    namespace: string,
    partition: string,
    name: string,
    changes: LiveVersionChanges,
  ): void {
    for (const version of changes.removed) {
      const deleted = this.#deleteVersion.run(
        namespace,
        partition,
        name,
        version,
      ).changes;
      if (Number(deleted) === 0) continue;
      this.#removed(
        namespace,
        partition,
        "version",
        versionRowKey(name, version),
      );
    }
    for (const { version, metadata } of changes.put) {
      const before = this.#liveVersion(namespace, partition, name, version);
      if (before === undefined) {
        this.#insertVersion.run(
          namespace,
          partition,
          name,
          version,
          this.#serialize(metadata),
          this.#at,
        );
      } else if (!this.#same(before, metadata)) {
        this.#updateVersion.run(
          this.#serialize(metadata),
          this.#at,
          namespace,
          partition,
          name,
          version,
        );
      } else {
        continue;
      }
      this.#written(
        namespace,
        partition,
        "version",
        versionRowKey(name, version),
      );
    }
  }

  #liveVersion(
    namespace: string,
    partition: string,
    name: string,
    version: number,
  ): LiveDataVersion["metadata"] | undefined {
    const row = this.#selectVersion.get(namespace, partition, name, version) as
      | { metadata: string }
      | undefined;
    return row === undefined ? undefined : parseMetadata(row.metadata);
  }

  #serialize(metadata: LiveDataVersion["metadata"]): string {
    let text = this.#serialized.get(metadata);
    if (text === undefined) {
      text = JSON.stringify(metadata);
      this.#serialized.set(metadata, text);
    }
    return text;
  }

  #same(
    a: LiveDataVersion["metadata"],
    b: LiveDataVersion["metadata"],
  ): boolean {
    return a === b || this.#serialize(a) === this.#serialize(b);
  }

  greatestCatalogRow(
    namespace: string,
    partition: string,
    name: string,
    excluding: ReadonlySet<number>,
  ): number | undefined {
    for (
      const row of this.#selectGreatestCatalogRows.all(
        namespace,
        partition,
        name,
        excluding.size + 1,
      ) as { version: number }[]
    ) {
      if (!excluding.has(row.version)) return row.version;
    }
    return undefined;
  }

  catalogRow(
    namespace: string,
    partition: string,
    name: string,
    version: number,
  ): LiveDataVersion["metadata"] | undefined {
    const row = this.#selectCatalogRow.get(
      namespace,
      partition,
      name,
      version,
    ) as { metadata: string | null } | undefined;
    if (row === undefined) return undefined;
    if (row.metadata === null) {
      throw new Error(
        `The compacted base has a catalog row for ${name}@${version} that is not a live version`,
      );
    }
    return parseMetadata(row.metadata);
  }

  catalogForward(
    namespace: string,
    partition: string,
    name: string,
  ): string | undefined {
    return (this.#selectForward.get(namespace, partition, name) as
      | { renamed_to: string }
      | undefined)?.renamed_to;
  }

  applyCatalogChange(
    namespace: string,
    partition: string,
    name: string,
    change: CatalogNameChange,
  ): void {
    const remove = (version: number) => {
      const deleted = this.#deleteCatalogRow.run(
        namespace,
        partition,
        name,
        version,
      ).changes;
      if (Number(deleted) === 0) return;
      this.#removed(
        namespace,
        partition,
        "catalog",
        versionRowKey(name, version),
      );
    };
    if (change.cleared) {
      for (
        const { version } of this.#selectCatalogVersions.all(
          namespace,
          partition,
          name,
        ) as { version: number }[]
      ) {
        if (!change.put.has(version)) remove(version);
      }
    }
    for (const version of change.removed) remove(version);
    for (const [version, { metadata, before }] of change.put) {
      // a row that is not its live version is a broken invariant: refused
      const shown = this.#liveVersion(namespace, partition, name, version);
      if (shown === undefined || !this.#same(shown, metadata)) {
        throw new Error(
          `A catalog row of ${name}@${version} is not the live version's metadata`,
        );
      }
      if (before === undefined) {
        this.#insertCatalog.run(namespace, partition, name, version, this.#at);
      } else if (!this.#same(before, metadata)) {
        // its metadata is read through base_versions: a difference resends it
        this.#stampCatalogRow.run(
          this.#at,
          namespace,
          partition,
          name,
          version,
        );
      } else {
        continue;
      }
      this.#written(
        namespace,
        partition,
        "catalog",
        versionRowKey(name, version),
      );
    }
    if (change.forward === undefined) {
      this.#deleteForward.run(namespace, partition, name);
      if (change.forwardBefore !== undefined) {
        this.#removed(namespace, partition, "forward", name);
      }
    } else {
      this.#upsertForward.run(
        namespace,
        partition,
        name,
        change.forward,
        this.#at,
      );
      this.#written(namespace, partition, "forward", name);
    }
  }

  fileOwnership(namespace: string, key: string): FileOwnership | undefined {
    const row = this.#selectFile.get(namespace, key) as
      | { owner: string; mark: number; present: number }
      | undefined;
    return row === undefined
      ? undefined
      : { owner: row.owner, mark: row.mark, present: row.present === 1 };
  }

  setFileOwnership(
    namespace: string,
    key: string,
    ownership: FileOwnership,
  ): void {
    this.#upsertFile.run(
      namespace,
      key,
      ownership.owner,
      ownership.mark,
      ownership.present ? 1 : 0,
      this.#at,
    );
  }

  hasPresentFileUnder(namespace: string, key: string): boolean {
    return this.#selectFileUnder.get(namespace, `${key}/`, `${key}0`) !==
      undefined;
  }

  setCompactedSeq(namespace: string, partition: string, seq: number): void {
    this.#upsertCompactedSeq.run(namespace, partition, seq);
  }

  /**
   * Removes a folded commit: its txnId moves to compacted_txns, the
   * references it counted are dropped, and its row is deleted.
   */
  compactCommit(
    row: CommitRow,
    chunkRefs: readonly string[],
    committedAt: number,
  ): void {
    this.#insertCompactedTxn.run(
      row.namespace,
      row.partition,
      row.txn_id,
      row.seq,
    );
    this.#insertTxnTime.run(
      row.namespace,
      row.partition,
      row.txn_id,
      Number.isFinite(committedAt) ? committedAt : this.#now,
    );
    for (const sha256 of chunkRefs) {
      this.#release(row.namespace, row.partition, sha256);
    }
    this.#deleteCommit.run(row.cursor);
  }

  /** Moves the compaction point to the folded commit `row`. */
  setPoint(row: CommitRow): void {
    this.#updatePoint.run(row.cursor);
    this.#upsertPointCommit.run(row.namespace, row.partition, row.txn_id);
  }

  /**
   * Forgets the txnIds of compacted commits made before `before` (epoch
   * milliseconds), except the compaction point's own; returns how many.
   */
  pruneTxns(before: number): number {
    const pruned = Number(this.#pruneTxns.run(before).changes);
    this.#pruneTxnTimes.run(before);
    return pruned;
  }

  /**
   * Ends a batch: forgets chunks released before `pruneBefore`, which no
   * sweep within its grace period still needs, and returns how many chunks
   * the batch released.
   */
  finish(pruneBefore: number): number {
    this.#pruneReleased.run(pruneBefore);
    return this.#released;
  }

  indexPartitions(namespace: string): { partition: string; seq: number }[] {
    return this.#db.prepare(
      "SELECT partition, seq FROM compacted_partitions WHERE namespace = ? ORDER BY partition",
    ).all(namespace) as { partition: string; seq: number }[];
  }

  indexHorizons(namespace: string): Map<string, number> {
    return new Map(
      (this.#db.prepare(
        "SELECT partition, seq FROM difference_horizons WHERE namespace = ?",
      ).all(namespace) as { partition: string; seq: number }[]).map((
        row,
      ) => [row.partition, row.seq]),
    );
  }

  indexPartitionCounts(
    namespace: string,
    first: string,
    last: string,
  ): { counts: Map<string, number>; contested: Set<string> } {
    const counts = new Map<string, number>();
    for (
      const table of [
        "base_records",
        "base_versions",
        "base_catalog",
        "base_forwards",
      ]
    ) {
      for (
        const row of this.#db.prepare(
          `SELECT partition, COUNT(*) AS n FROM ${table} ` +
            "WHERE namespace = ? AND partition >= ? AND partition <= ? GROUP BY partition",
        ).all(namespace, first, last) as { partition: string; n: number }[]
      ) {
        counts.set(row.partition, (counts.get(row.partition) ?? 0) + row.n);
      }
    }
    const contested = new Set(
      (this.#db.prepare(
        "SELECT DISTINCT r.partition AS partition FROM base_records AS r JOIN base_files AS f " +
          "ON f.namespace = r.namespace AND f.record_key = r.record_key " +
          "WHERE r.namespace = ? AND r.partition >= ? AND r.partition <= ? AND f.owner != r.partition",
      ).all(namespace, first, last) as { partition: string }[]).map((row) =>
        row.partition
      ),
    );
    return { counts, contested };
  }

  indexFileOwners(
    namespace: string,
    after: string | undefined,
    limit: number,
  ): { owners: Map<string, number>; last: string | undefined } {
    const rows = this.#db.prepare(
      "SELECT record_key, owner FROM base_files WHERE namespace = ? AND record_key > ? " +
        "ORDER BY record_key LIMIT ?",
    ).all(namespace, after ?? "", limit) as {
      record_key: string;
      owner: string;
    }[];
    const owners = new Map<string, number>();
    for (const row of rows) {
      owners.set(row.owner, (owners.get(row.owner) ?? 0) + 1);
    }
    return {
      owners,
      last: rows.length < limit ? undefined : rows[rows.length - 1].record_key,
    };
  }

  readIndex(namespace: string): BaseIndexEntry[] {
    const counts = new Map<string, number>();
    const add = (sql: string) => {
      for (
        const row of this.#db.prepare(sql).all(namespace) as {
          partition: string;
          n: number;
        }[]
      ) {
        counts.set(row.partition, (counts.get(row.partition) ?? 0) + row.n);
      }
    };
    for (
      const table of [
        "base_records",
        "base_versions",
        "base_catalog",
        "base_forwards",
      ]
    ) {
      add(
        `SELECT partition, COUNT(*) AS n FROM ${table} WHERE namespace = ? GROUP BY partition`,
      );
    }
    add(
      "SELECT owner AS partition, COUNT(*) AS n FROM base_files WHERE namespace = ? GROUP BY owner",
    );
    const horizons = new Map(
      (this.#db.prepare(
        "SELECT partition, seq FROM difference_horizons WHERE namespace = ?",
      ).all(namespace) as { partition: string; seq: number }[]).map((
        row,
      ) => [row.partition, row.seq]),
    );
    const contested = new Set(
      (this.#db.prepare(
        "SELECT DISTINCT r.partition AS partition FROM base_records AS r JOIN base_files AS f " +
          "ON f.namespace = r.namespace AND f.record_key = r.record_key " +
          "WHERE r.namespace = ? AND f.owner != r.partition",
      ).all(namespace) as { partition: string }[]).map((row) => row.partition),
    );
    return (this.#db.prepare(
      "SELECT partition, seq FROM compacted_partitions WHERE namespace = ? ORDER BY partition",
    ).all(namespace) as { partition: string; seq: number }[]).map((row) => ({
      partition: row.partition,
      seq: row.seq,
      rows: counts.get(row.partition) ?? 0,
      horizon: horizons.get(row.partition) ?? 0,
      contested: contested.has(row.partition),
    }));
  }

  readPartitionPage(
    namespace: string,
    partition: string,
    after: string | undefined,
    limit: number,
  ): { seq: number; entries: CompactedBaseEntry[]; next: string | undefined } {
    const seq = (this.#db.prepare(
      "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined)?.seq ?? 0;
    let { section, key } = parsePageToken(after);
    // section 0 is the partitions table, never paged here: a key for it is not ours
    if (section === 0) {
      section = 1;
      key = undefined;
    }
    const entries: CompactedBaseEntry[] = [];
    while (section < BASE_SECTIONS.length) {
      const { table, join, keys, entry } = BASE_SECTIONS[section];
      const owner = table === "base_files" ? "owner" : "partition";
      const order = keys.map((k) => `t.${k}`).join(", ");
      const from = key === undefined
        ? ""
        : ` AND (${order}) > (${keys.map(() => "?").join(", ")})`;
      const columns = join === undefined ? "t.*" : "t.*, v.metadata";
      const rows = this.#db.prepare(
        `SELECT ${columns} FROM ${table} AS t ${
          join ?? ""
        } WHERE t.namespace = ? AND t.${owner} = ?${from} ORDER BY ${order} LIMIT ?`,
      ).all(
        namespace,
        partition,
        ...(key ?? []),
        limit - entries.length,
      ) as Record<
        string,
        unknown
      >[];
      for (const row of rows) entries.push(entry(row));
      if (entries.length === limit) {
        const last = rows[rows.length - 1];
        return {
          seq,
          entries,
          next: JSON.stringify({
            section,
            key: keys.map((k) => last[k] as string | number),
          }),
        };
      }
      section++;
      key = undefined;
    }
    return { seq, entries, next: undefined };
  }

  readPartition(
    namespace: string,
    partition: string,
    since: number | undefined,
    limit: number,
  ): PartitionBaseRows | "gone" | "too-large" {
    const compacted = this.#db.prepare(
      "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined;
    const horizon = (this.#db.prepare(
      "SELECT seq FROM difference_horizons WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined)?.seq ?? 0;
    if (since !== undefined && since < horizon) return "gone";
    const changed = since === undefined ? "" : " AND t.changed_seq > ?";
    const args = (...head: (string | number)[]) =>
      since === undefined ? head : [...head, since];
    const entries: CompactedBaseEntry[] = [];
    // one past the limit, so a partition at exactly the limit still fits
    const room = () => limit + 1 - entries.length;
    for (const { table, join, keys, entry } of BASE_SECTIONS) {
      if (table === "compacted_partitions") continue;
      const owner = table === "base_files" ? "owner" : "partition";
      const columns = join === undefined ? "t.*" : "t.*, v.metadata";
      const rows = this.#db.prepare(
        `SELECT ${columns} FROM ${table} AS t ${
          join ?? ""
        } WHERE t.namespace = ? AND t.${owner} = ?${changed} ORDER BY ${
          keys.map((k) => `t.${k}`).join(", ")
        } LIMIT ?`,
      ).all(...args(namespace, partition), room()) as Record<string, unknown>[];
      for (const row of rows) entries.push(entry(row));
      if (entries.length > limit) return "too-large";
    }
    const removed = since === undefined ? [] : (this.#db.prepare(
      "SELECT section, row_key FROM base_removed WHERE namespace = ? AND partition = ? AND removed_seq > ? ORDER BY section, row_key LIMIT ?",
    ).all(namespace, partition, since, room()) as {
      section: BaseRemoval["section"];
      row_key: string;
    }[]).map((row) => ({ section: row.section, key: row.row_key }));
    if (entries.length + removed.length > limit) return "too-large";
    return { seq: compacted?.seq ?? 0, horizon, entries, removed };
  }

  /** One page of the base, resuming after `after`. */
  readPage(
    after: string | undefined,
    limit: number,
  ): { entries: CompactedBaseEntry[]; next: string | undefined } {
    let { section, key } = parsePageToken(after);
    const entries: CompactedBaseEntry[] = [];
    while (section < BASE_SECTIONS.length) {
      const { table, join, keys, entry } = BASE_SECTIONS[section];
      // Keyset paging on the table's own primary key, so each page is an
      // index range however large the base.
      const order = keys.map((k) => `t.${k}`).join(", ");
      const where = key === undefined
        ? ""
        : `WHERE (${order}) > (${keys.map(() => "?").join(", ")}) `;
      const columns = join === undefined ? "t.*" : "t.*, v.metadata";
      const rows = this.#db.prepare(
        `SELECT ${columns} FROM ${table} AS t ${
          join ?? ""
        } ${where}ORDER BY ${order} LIMIT ?`,
      ).all(...(key ?? []), limit - entries.length) as Record<
        string,
        unknown
      >[];
      for (const row of rows) entries.push(entry(row));
      if (entries.length === limit) {
        const last = rows[rows.length - 1];
        return {
          entries,
          next: JSON.stringify({
            section,
            key: keys.map((k) => last[k] as string | number),
          }),
        };
      }
      section++;
      key = undefined;
    }
    return { entries, next: undefined };
  }

  /** The distinct chunks a base record's blob names; none when inline or absent. */
  #recordChunks(
    namespace: string,
    partition: string,
    key: string,
  ): readonly string[] {
    const row = this.#selectRecordBlob.get(namespace, partition, key) as
      | { blob: string | null }
      | undefined;
    if (row?.blob == null) return [];
    return distinctChunks(BlobRef.fromJSON(JSON.parse(row.blob)));
  }

  /**
   * Drops a truncated commit's references, outside any compaction batch: a
   * chunk no longer named is released at `now` (epoch milliseconds).
   */
  releaseRefs(
    namespace: string,
    partition: string,
    chunkRefs: readonly string[],
    now: number,
  ): void {
    this.#now = now;
    for (const sha256 of chunkRefs) this.#release(namespace, partition, sha256);
  }

  /** moves a chunk's partition and namespace counts by `delta` at once */
  shiftChunk(
    namespace: string,
    partition: string,
    sha256: string,
    delta: number,
  ): void {
    if (delta === 0) return;
    this.touched.add(sha256);
    if (delta > 0) {
      for (let i = 0; i < delta; i++) {
        this.#incrementRef.run(namespace, sha256);
        this.#incrementPartitionRef.run(namespace, sha256, partition);
      }
      return;
    }
    for (let i = 0; i < -delta; i++) {
      this.#release(namespace, partition, sha256);
    }
  }

  /**
   * Drops one reference of `partition`; at zero the partition no longer
   * names the chunk, and at zero over the namespace the chunk is released.
   */
  #release(namespace: string, partition: string, sha256: string): void {
    this.touched.add(sha256);
    const own = this.#decrementPartitionRef.get(namespace, sha256, partition) as
      | { refs: number }
      | undefined;
    // A missing row only narrows which partitions may read the chunk
    // (swamp-club#3915): the index fails closed, so it never stops a
    // compaction the namespace count allows.
    if (own !== undefined && own.refs <= 0) {
      this.#deletePartitionRef.run(namespace, sha256, partition);
    }
    const row = this.#decrementRef.get(namespace, sha256) as
      | { refs: number }
      | undefined;
    if (row === undefined) {
      throw new Error(
        `chunk_refs counts no reference to chunk ${sha256} in namespace "${namespace}", which a compacted commit or base record names`,
      );
    }
    if (row.refs > 0) return;
    this.#deleteRef.run(namespace, sha256);
    this.#upsertReleased.run(namespace, sha256, this.#now);
    this.#released++;
  }
}

/** The rows of a follower's `commits.db` that belong to the file, not its content. */
export interface ObservedBaseFileRows {
  readonly logId: string;
  readonly fence: readonly Record<string, SQLInputValue>[];
  readonly owner: readonly Record<string, SQLInputValue>[];
}

/**
 * A compacted base serve sent, staged in a `commits.db` of its own beside a
 * follower copy before {@link SqliteCommitStore.installObservedBase}
 * installs it (swamp-club#4006). Each page is added in one transaction; a
 * load cut off leaves only this file, which {@link ObservedBaseStaging.create}
 * removes before staging again. Nothing reads it as a copy.
 */
export class ObservedBaseStaging {
  readonly path: string;
  readonly #db: DatabaseSync;
  readonly #namespace: string;
  /** Each partition's compacted seq and its data names' marks. */
  readonly #partitions = new Map<
    string,
    { seq: number; names: readonly DataNameMarks[] }
  >();
  #closed = false;

  private constructor(path: string, db: DatabaseSync, namespace: string) {
    this.path = path;
    this.#db = db;
    this.#namespace = namespace;
  }

  /** A fresh staging file at `path`, removing whatever a cut-off load left. */
  static create(path: string, namespace: string): ObservedBaseStaging {
    removeDatabaseFiles(path);
    const db = openCommitsDatabase(path);
    db.exec(STAGING_PROGRESS_SCHEMA);
    return new ObservedBaseStaging(path, db, namespace);
  }

  /**
   * The staging file a cut-off load left at `path`, to page on from where it
   * stopped; undefined, with the file removed, unless it staged part of the
   * same serve's base of the same namespace and reads back whole
   */
  static resume(
    path: string,
    namespace: string,
    serve: string,
  ): { staging: ObservedBaseStaging; progress: StagingProgress } | undefined {
    try {
      Deno.statSync(path);
    } catch {
      return undefined;
    }
    let db: DatabaseSync | undefined;
    try {
      db = openCommitsDatabase(path);
      const check = db.prepare("PRAGMA quick_check").get() as
        | { quick_check: string }
        | undefined;
      const row = check?.quick_check === "ok"
        ? db.prepare(
          "SELECT namespace, serve, point, next, pages FROM staging_progress WHERE id = 1",
        ).get() as
          | {
            namespace: string;
            serve: string;
            point: number;
            next: string;
            pages: number;
          }
          | undefined
        : undefined;
      if (
        row === undefined || row.namespace !== namespace ||
        row.serve !== serve
      ) {
        db.close();
        removeDatabaseFiles(path);
        return undefined;
      }
      const staging = new ObservedBaseStaging(path, db, namespace);
      for (
        const partition of db.prepare(
          "SELECT partition, seq, names FROM staging_partitions",
        ).all() as { partition: string; seq: number; names: string }[]
      ) {
        staging.#partitions.set(partition.partition, {
          seq: partition.seq,
          names: JSON.parse(partition.names) as DataNameMarks[],
        });
      }
      return {
        staging,
        progress: { point: row.point, next: row.next, pages: row.pages },
      };
    } catch {
      // unreadable: the load starts over
      try {
        db?.close();
      } catch { /* already closed */ }
      removeDatabaseFiles(path);
      return undefined;
    }
  }

  heads(): { namespace: string; partition: string; seq: number }[] {
    return [...this.#partitions].map(([partition, { seq }]) => ({
      namespace: this.#namespace,
      partition,
      seq,
    }));
  }

  /** Removes the staging file at `path` and its WAL, if there. */
  static remove(path: string): void {
    removeDatabaseFiles(path);
  }

  /**
   * Adds one page of serve's entries. A partition named twice with another
   * seq is refused: one point has one seq per partition.
   */
  add(
    entries: readonly ObservedBaseEntry[],
    progress?: { readonly serve: string } & StagingProgress,
  ): void {
    this.#assertOpen();
    const insertPartition = this.#db.prepare(
      "INSERT OR REPLACE INTO staging_partitions (partition, seq, names) VALUES (?, ?, ?)",
    );
    const base = new SqliteCompactedBase(this.#db);
    const insertVersion = this.#db.prepare(
      "INSERT OR REPLACE INTO base_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
    );
    const insertCatalog = this.#db.prepare(
      "INSERT OR REPLACE INTO base_catalog (namespace, partition, name, version) VALUES (?, ?, ?, ?)",
    );
    const insertForward = this.#db.prepare(
      "INSERT OR REPLACE INTO base_forwards (namespace, partition, name, renamed_to) VALUES (?, ?, ?, ?)",
    );
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      base.begin(0);
      for (const entry of entries) {
        if (entry.namespace !== this.#namespace) {
          throw new Error(
            `A base entry of namespace ${entry.namespace} is not this copy's`,
          );
        }
        switch (entry.kind) {
          case "partition": {
            const known = this.#partitions.get(entry.partition);
            if (known !== undefined && known.seq !== entry.seq) {
              throw new Error(
                `Serve sent partition ${entry.partition} at seqs ${known.seq} and ${entry.seq} in one base`,
              );
            }
            this.#partitions.set(entry.partition, {
              seq: entry.seq,
              names: entry.names,
            });
            base.setCompactedSeq(entry.namespace, entry.partition, entry.seq);
            insertPartition.run(
              entry.partition,
              entry.seq,
              JSON.stringify(entry.names),
            );
            break;
          }
          case "record":
            base.putRecord(
              entry.namespace,
              entry.partition,
              entry.key,
              entry.record,
            );
            break;
          case "version":
            insertVersion.run(
              entry.namespace,
              entry.partition,
              entry.version.metadata.name,
              entry.version.version,
              JSON.stringify(entry.version.metadata),
            );
            break;
          case "catalog-row":
            insertCatalog.run(
              entry.namespace,
              entry.partition,
              entry.metadata.name,
              entry.metadata.version,
            );
            break;
          case "forward":
            insertForward.run(
              entry.namespace,
              entry.partition,
              entry.name,
              entry.to,
            );
            break;
          case "file":
            base.setFileOwnership(entry.namespace, entry.key, entry.ownership);
            break;
        }
      }
      // in the page's own transaction: a cut-off load resumes at a page boundary
      if (progress !== undefined) {
        this.#db.prepare(
          "INSERT OR REPLACE INTO staging_progress (id, namespace, serve, point, next, pages) " +
            "VALUES (1, ?, ?, ?, ?, ?)",
        ).run(
          this.#namespace,
          progress.serve,
          progress.point,
          progress.next,
          progress.pages,
        );
      }
      this.#db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  /**
   * Makes the staged base a store at compaction point `point`: heads,
   * snapshots, the commits' sequence and the file's own rows. Called by
   * {@link SqliteCommitStore.installObservedBase}, which then installs it.
   */
  finish(point: number, rows: ObservedBaseFileRows): void {
    this.#assertOpen();
    const db = this.#db;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("UPDATE compaction SET point = ? WHERE id = 1").run(point);
      db.prepare("DELETE FROM sqlite_sequence WHERE name = 'commits'").run();
      db.prepare(
        "INSERT INTO sqlite_sequence (name, seq) VALUES ('commits', ?)",
      ).run(point);
      db.prepare("UPDATE log_identity SET log_id = ? WHERE id = 1").run(
        rows.logId,
      );
      copyRows(db, "writer_fence", rows.fence);
      copyRows(db, "datastore_owner", rows.owner);
      const records = db.prepare(
        "SELECT record_key, sha256 FROM base_records WHERE namespace = ? AND partition = ? ORDER BY record_key",
      );
      const versions = db.prepare(
        "SELECT name, version FROM base_versions WHERE namespace = ? AND partition = ? ORDER BY name, version",
      );
      const upsertHead = db.prepare(
        "INSERT OR REPLACE INTO partition_heads (namespace, partition, seq, highest_fence) VALUES (?, ?, ?, NULL)",
      );
      const upsertSnapshot = db.prepare(
        "INSERT OR REPLACE INTO partition_snapshots (namespace, partition, seq, body) VALUES (?, ?, ?, ?)",
      );
      const upsertSource = db.prepare(
        "INSERT OR REPLACE INTO base_sources (namespace, partition, seq) VALUES (?, ?, ?)",
      );
      for (const [partition, { seq, names }] of this.#partitions) {
        const live = new Map<string, number[]>();
        for (
          const row of versions.all(this.#namespace, partition) as {
            name: string;
            version: number;
          }[]
        ) {
          const list = live.get(row.name) ?? [];
          list.push(row.version);
          live.set(row.name, list);
        }
        const marks = new Map(names.map((name) => [name.name, name]));
        const snapshotNames = [];
        for (const name of new Set([...marks.keys(), ...live.keys()])) {
          const versionsOf = live.get(name) ?? [];
          const mark = marks.get(name);
          const highWater = Math.max(
            mark?.highWater ?? 0,
            maxOf(versionsOf) ?? 0,
          );
          if (highWater < 1) continue;
          // Serve's marks are its partition's now: a version live at the
          // compacted seq may have been removed since, and a snapshot never
          // holds a version both live and removed.
          let removed = VersionRanges.of(mark?.removed ?? []);
          for (const version of versionsOf) removed = removed.delete(version);
          snapshotNames.push({
            name,
            live: versionsOf,
            highWater,
            ...(removed.isEmpty ? {} : { removed: removed.toJSON() }),
          });
        }
        const snapshot = {
          v: 1,
          partition,
          seq,
          records: (records.all(this.#namespace, partition) as {
            record_key: string;
            sha256: string;
          }[]).map((row) => [row.record_key, row.sha256]),
          names: snapshotNames,
        };
        upsertHead.run(this.#namespace, partition, seq);
        // serve's own base, row for row: a later difference may build on it
        upsertSource.run(this.#namespace, partition, seq);
        upsertSnapshot.run(
          this.#namespace,
          partition,
          seq,
          JSON.stringify(snapshot),
        );
      }
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("The base staging file is closed");
  }
}

/** where a staging file's load stopped: the next page of serve's base at `point` */
export interface StagingProgress {
  readonly point: number;
  readonly next: string;
  readonly pages: number;
}

// staging-only tables: an install copies the store's own tables, never these
const STAGING_PROGRESS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS staging_progress (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    namespace TEXT NOT NULL,
    serve TEXT NOT NULL,
    point INTEGER NOT NULL,
    next TEXT NOT NULL,
    pages INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS staging_partitions (
    partition TEXT PRIMARY KEY,
    seq INTEGER NOT NULL,
    names TEXT NOT NULL
  );
`;

/** Replaces every row of `table` with `rows`. */
function copyRows(
  db: DatabaseSync,
  table: "writer_fence" | "datastore_owner",
  rows: readonly Record<string, SQLInputValue>[],
): void {
  db.exec(`DELETE FROM ${table}`);
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${
        columns.map(quoteIdentifier).join(", ")
      }) VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => row[column]));
  }
}

/** Removes a SQLite database file and its journals, if there. */
function removeDatabaseFiles(path: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    try {
      Deno.removeSync(path + suffix);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
}

/** The page token {@link SqliteCompactedBase.readPage} hands out. */
function parsePageToken(
  token: string | undefined,
): { section: number; key: (string | number)[] | undefined } {
  if (token === undefined) return { section: 0, key: undefined };
  let value: { section?: unknown; key?: unknown } | null;
  try {
    value = JSON.parse(token);
  } catch {
    throw new InvalidBasePageTokenError(token);
  }
  if (typeof value !== "object" || value === null) {
    throw new InvalidBasePageTokenError(token);
  }
  const section = value.section;
  const key = value.key;
  if (
    typeof section !== "number" || !Number.isSafeInteger(section) ||
    section < 0 || section >= BASE_SECTIONS.length || !Array.isArray(key) ||
    key.length !== BASE_SECTIONS[section].keys.length ||
    !key.every((k) => typeof k === "string" || typeof k === "number")
  ) {
    throw new InvalidBasePageTokenError(token);
  }
  return { section, key: key as (string | number)[] };
}

function baseRecordOf(row: Record<string, unknown>): BaseRecord {
  const sha256 = row.sha256 as string;
  const access = readFileAccess(row.access ?? undefined);
  return {
    sha256,
    content: typeof row.blob === "string"
      ? { blob: BlobRef.fromJSON(JSON.parse(row.blob)) }
      : { inline: row.inline as string },
    ...(access === undefined ? {} : { access }),
  };
}

function parseMetadata(text: string): DataMetadata {
  return DataMetadataSchema.parse(JSON.parse(text));
}

function distinctChunks(blob: BlobRef | undefined): readonly string[] {
  return blob === undefined ? [] : [...new Set(blob.chunkHashes())];
}

/**
 * A team follower's copy cannot take a commit from its leader's feed in
 * order (swamp-club#4120): it holds another commit at that cursor, or the
 * partition is not at the commit's previous seq. The follower stops the
 * feed and restores from the published lineage.
 */
export class FeedDivergedError extends Error {
  constructor(detail: string) {
    super(`The commit feed diverged from this copy: ${detail}`);
    this.name = "FeedDivergedError";
  }
}

function parsedField(body: string, field: string): unknown {
  try {
    const value = JSON.parse(body);
    return typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)[field]
      : "unreadable";
  } catch {
    return "unreadable";
  }
}
