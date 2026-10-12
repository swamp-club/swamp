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
 * - **Checkpoints.** SQLite's default auto-checkpoint is left alone and no
 *   checkpoint is ever forced: Litestream replicates the WAL, and forcing a
 *   `TRUNCATE` checkpoint made its replica 11 times larger
 *   (`design/enablers/datastore-litestream.md`).
 *
 * @module
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import type { LiveDataVersion } from "../../domain/datastore_v3/catalog_projection.ts";
import type { CatalogNameState } from "../../domain/datastore_v3/catalog_state.ts";
import { DEFAULT_CHUNK_GRACE_MS } from "../../domain/datastore_v3/chunk_collector.ts";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
  type CommitStoreAppendResult,
  CommitStoreCorruptError,
  type CompactedBaseEntry,
  type CompactedBasePage,
  type CompactHistoryOptions,
  type CompactionReport,
  type PartitionHead,
} from "../../domain/datastore_v3/commit_store.ts";
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
import {
  type DataMetadata,
  DataMetadataSchema,
} from "../../domain/data/data_metadata.ts";
import { MATERIALISED_SUBDIRS } from "./record_path_guard.ts";
import {
  CommitRejectedError,
  Partition,
} from "../../domain/datastore_v3/partition.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";

/**
 * The schema migrations, in order. Migration `i` takes a database at
 * `PRAGMA user_version` `i` to `i + 1`, so the schema version is this list's
 * length. Add a migration by appending to the list; never edit one that has
 * shipped.
 */
const MIGRATIONS: readonly string[] = [
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
];

/** The schema version this store writes. */
export const COMMIT_STORE_SCHEMA_VERSION = MIGRATIONS.length;

/** How many rebuilt partitions a store keeps by default. */
export const DEFAULT_CACHED_PARTITIONS = 1024;

/** A partition's state is snapshotted every this many commits by default. */
export const DEFAULT_SNAPSHOT_INTERVAL = 1000;

/** Rows read per query while rebuilding a partition. */
const REBUILD_PAGE = 500;

/**
 * Commits folded per compaction transaction by default. The fold runs
 * synchronously inside the transaction, like an append's fsync.
 */
export const COMPACTION_BATCH = 250;

/** Hashes looked up per query by `referencedChunks`. */
const REF_LOOKUP_PAGE = 500;

/** Options for {@link SqliteCommitStore.open}. */
export interface SqliteCommitStoreOptions {
  /** How many rebuilt partitions to keep; {@link DEFAULT_CACHED_PARTITIONS}. */
  readonly cachedPartitions?: number;
  /**
   * Snapshot a partition every this many commits;
   * {@link DEFAULT_SNAPSHOT_INTERVAL}.
   */
  readonly snapshotInterval?: number;
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
 * that the solo writer lock prevents. Appends are serialized in the process,
 * and their asynchronous parts (rebuilding a partition) never run inside a
 * transaction.
 *
 * An append is synchronous between `BEGIN IMMEDIATE` and `COMMIT`, so it
 * blocks the event loop for its `fsync` (`synchronous=FULL`).
 */
export class SqliteCommitStore implements CommitStore {
  readonly #db: DatabaseSync;
  readonly #cachedPartitions: number;
  readonly #snapshotInterval: number;
  /** Rebuilt partitions, least recently used first. */
  readonly #cache = new Map<string, Partition>();
  #queue: Promise<unknown> = Promise.resolve();
  #closed = false;

  readonly #selectHead: StatementSync;
  readonly #selectTxnSeq: StatementSync;
  readonly #selectTxnUpTo: StatementSync;
  readonly #selectMaxSeq: StatementSync;
  readonly #insertCommit: StatementSync;
  readonly #upsertHead: StatementSync;
  readonly #selectPartitionPage: StatementSync;
  readonly #selectChanges: StatementSync;
  readonly #selectSnapshot: StatementSync;
  readonly #upsertSnapshot: StatementSync;
  readonly #insertChunkRef: StatementSync;
  /** `referencedChunks` for a full page of {@link REF_LOOKUP_PAGE} hashes. */
  readonly #selectRefPage: StatementSync;
  readonly #selectPoint: StatementSync;
  readonly #selectCompactedSeq: StatementSync;
  /** The compacted base's tables (swamp-club#3258). */
  readonly #base: SqliteCompactedBase;

  private constructor(
    db: DatabaseSync,
    cachedPartitions: number,
    snapshotInterval: number,
  ) {
    this.#db = db;
    this.#cachedPartitions = cachedPartitions;
    this.#snapshotInterval = snapshotInterval;
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
    this.#upsertHead = db.prepare(
      "INSERT INTO partition_heads (namespace, partition, seq, highest_fence) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET seq = excluded.seq, highest_fence = excluded.highest_fence",
    );
    this.#selectPartitionPage = db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
        "WHERE namespace = ? AND partition = ? AND seq >= ? ORDER BY seq LIMIT ?",
    );
    this.#selectChanges = db.prepare(
      "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits WHERE cursor > ? ORDER BY cursor LIMIT ?",
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
    this.#selectRefPage = db.prepare(selectRefsSql(REF_LOOKUP_PAGE));
    this.#selectPoint = db.prepare(
      "SELECT point FROM compaction WHERE id = 1",
    );
    this.#selectCompactedSeq = db.prepare(
      "SELECT seq FROM compacted_partitions WHERE namespace = ? AND partition = ?",
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
    return new SqliteCommitStore(
      openCommitsDatabase(path),
      cachedPartitions,
      snapshotInterval,
    );
  }

  /** How many rebuilt partitions the store holds; for tests and diagnostics. */
  get cachedPartitionCount(): number {
    return this.#cache.size;
  }

  append(commit: Commit): Promise<CommitStoreAppendResult> {
    if (this.#closed) return Promise.reject(closedError());
    const run = this.#queue.then(() => this.#append(commit, false));
    this.#queue = run.catch(() => {});
    return run;
  }

  async #append(
    commit: Commit,
    retried: boolean,
  ): Promise<CommitStoreAppendResult> {
    const namespace = commit.namespace;
    const partitionKey = commit.partition.toString();
    const cacheKey = cacheKeyOf(namespace, partitionKey);
    const partition = await this.#partition(namespace, commit.partition);

    // Synchronous from BEGIN to COMMIT: nothing else runs in between.
    this.#db.exec("BEGIN IMMEDIATE");
    let outcome: CommitStoreAppendResult | "stale";
    try {
      outcome = this.#applyInTransaction(commit, partition, retried);
      if (outcome !== "stale" && outcome.kind === "appended") {
        this.#db.exec("COMMIT");
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

    if (outcome !== "stale") return outcome;
    // Another connection wrote this partition: rebuild it from the file.
    this.#cache.delete(cacheKey);
    if (retried) {
      throw new Error(
        `Partition ${partitionKey} changed in commits.db while appending: another process is writing the store`,
      );
    }
    return await this.#append(commit, true);
  }

  #applyInTransaction(
    commit: Commit,
    partition: Partition,
    retried: boolean,
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

    const applied = partition.append(commit);
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
    this.#insertCommit.run(
      namespace,
      partitionKey,
      commit.seq,
      commit.txnId,
      commit.fence ?? null,
      commit.at,
      JSON.stringify(commit.toJSON()),
    );
    // In the commit's own transaction, so a refused or rolled-back append
    // leaves no reference behind.
    for (const sha256 of commit.chunkRefs()) {
      this.#insertChunkRef.run(namespace, sha256);
    }
    // A lease op can raise the fence too, so take it from the partition.
    this.#upsertHead.run(
      namespace,
      partitionKey,
      partition.seq,
      partition.highestFence ?? null,
    );
    if (partition.seq % this.#snapshotInterval === 0) {
      this.#upsertSnapshot.run(
        namespace,
        partitionKey,
        partition.seq,
        JSON.stringify(partition.snapshot()),
      );
    }
    return applied;
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
    const snapshot = this.#selectSnapshot.get(namespace, key.toString()) as
      | { seq: number; body: string }
      | undefined;
    let partition: Partition;
    if (snapshot === undefined) {
      partition = Partition.empty(key);
    } else {
      try {
        // The snapshot leaves out txnIds; those it covers are looked up in
        // the commits table, only up to its seq, so the commits replayed
        // after it are not taken for retries of themselves. The lookup uses
        // this store's connection, so a restored partition must not outlive
        // the store: close() clears the cache.
        const upTo = snapshot.seq;
        partition = Partition.restore(
          key,
          JSON.parse(snapshot.body),
          (txnId) =>
            this.#selectTxnUpTo.get(namespace, key.toString(), txnId, upTo) !==
              undefined,
        );
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
    while (true) {
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
          applied = partition.append(commit);
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
    const rows = this.#readTransaction(() => {
      const point = this.#point();
      if (cursor < point) {
        throw new CommitsCompactedError(
          point,
          `The change feed from cursor ${cursor} cannot be read`,
        );
      }
      return this.#selectChanges.all(cursor, limit) as unknown as CommitRow[];
    });
    const changes: CommitChange[] = [];
    for (const row of rows) {
      changes.push({ cursor: row.cursor, commit: await parseRow(row) });
    }
    return changes;
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
    const run = this.#queue.then(() => this.#compact(through, options));
    this.#queue = run.catch(() => {});
    return run;
  }

  /**
   * Compacts batch by batch. Each batch's rows are read and parsed, and the
   * snapshots it needs rebuilt, before its transaction starts; inside it the
   * point is checked again, the commits are folded in feed order, base
   * references are added before the commits' are dropped (so a present
   * chunk's count never reaches zero), and the rows are deleted.
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
    const clock = options.clock ?? (() => new Date());
    const retention = options.releasedRetentionMs ?? DEFAULT_CHUNK_GRACE_MS;
    if (!Number.isSafeInteger(retention) || retention < 0) {
      throw new Error(
        `releasedRetentionMs must be a non-negative integer: ${retention}`,
      );
    }
    // Never past the last cursor assigned: a point above it would cover
    // commits not yet written.
    const last = (this.#db.prepare("SELECT MAX(cursor) AS cursor FROM commits")
      .get() as { cursor: number | null }).cursor ?? 0;
    const target = Math.min(through, last);
    let compacted = 0;
    let batches = 0;
    let released = 0;
    for (;;) {
      options.signal?.throwIfAborted();
      const point = this.#point();
      if (point >= target) break;
      const rows = this.#db.prepare(
        "SELECT cursor, namespace, partition, seq, txn_id, body FROM commits " +
          "WHERE cursor > ? AND cursor <= ? ORDER BY cursor LIMIT ?",
      ).all(point, target, batchSize) as unknown as CommitRow[];
      if (rows.length === 0) break;
      const commits: Commit[] = [];
      for (const row of rows) commits.push(await parseRow(row));

      // Each partition's last seq in the batch becomes its compacted seq. A
      // rebuild must never need a deleted commit, so a partition whose latest
      // snapshot is older gets one at that seq.
      const lastSeq = new Map<string, Commit>();
      for (const commit of commits) {
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

      const now = clock().getTime();
      this.#db.exec("BEGIN IMMEDIATE");
      try {
        if (this.#point() !== point) {
          throw new Error(
            "The compaction point moved during compaction: another process is writing the store",
          );
        }
        this.#base.begin(now);
        rows.forEach((row, i) => {
          foldCommit(this.#base, commits[i], row.cursor, MATERIALISED_SUBDIRS);
        });
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i];
          this.#base.compactCommit(row, commits[i].chunkRefs());
        }
        for (const snapshot of snapshots) {
          this.#upsertSnapshot.run(
            snapshot.namespace,
            snapshot.partition,
            snapshot.seq,
            snapshot.body,
          );
        }
        this.#base.setPoint(rows[rows.length - 1].cursor);
        released += this.#base.finish(now - retention);
        options.beforeCommit?.();
        this.#db.exec("COMMIT");
      } catch (error) {
        rollbackQuietly(this.#db);
        // Cached partitions are unaffected by a rolled-back batch, but drop
        // them anyway so nothing rebuilt around it is trusted.
        this.#cache.clear();
        throw error;
      }
      compacted += rows.length;
      batches++;
    }
    return { point: this.#point(), compacted, batches, released };
  }

  readCompactedBase(
    after: string | undefined,
    limit: number,
  ): Promise<CompactedBasePage> {
    if (this.#closed) return Promise.reject(closedError());
    requirePositive(limit, "limit");
    return Promise.resolve(this.#readTransaction(() => {
      const page = this.#base.readPage(after, limit);
      return { point: this.#point(), ...page };
    }));
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

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#queue;
    this.#cache.clear();
    this.#db.close();
  }

  #assertOpen(): void {
    if (this.#closed) throw closedError();
  }
}

/**
 * Opens `commits.db` at `path` the way the store uses it, creating the file
 * and its schema when absent: WAL, `synchronous=FULL` so a commit is durable
 * when append returns, a busy timeout, and SQLite's default auto-checkpoint.
 * Exported for tests, which check these settings on the store's own
 * connection.
 */
export function openCommitsDatabase(path: string): DatabaseSync {
  ensureDirSync(dirname(path));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    // Switching to WAL takes an exclusive lock, and WAL persists in the
    // file, so switch only a database that is not in WAL yet.
    const mode = db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (mode?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    migrate(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
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
      throw new Error(
        `commits.db is at schema version ${version}, newer than this swamp's ${COMMIT_STORE_SCHEMA_VERSION}: upgrade swamp`,
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
      db.exec(MIGRATIONS[next]);
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

function closedError(): Error {
  return new Error("The commit store is closed");
}

function cacheKeyOf(namespace: string, partition: string): string {
  return JSON.stringify([namespace, partition]);
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

function requirePositive(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer: ${value}`);
  }
}

/** Test hooks for {@link SqliteCommitStore.compactHistory}. */
interface CompactionTestHooks {
  /**
   * Called inside each batch's transaction just before it commits. Tests
   * use it to fail or stop a batch there.
   */
  readonly beforeCommit?: () => void;
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
  readonly #selectVersions: StatementSync;
  readonly #deleteVersions: StatementSync;
  readonly #insertVersion: StatementSync;
  readonly #selectCatalog: StatementSync;
  readonly #deleteCatalog: StatementSync;
  readonly #insertCatalog: StatementSync;
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
  readonly #upsertReleased: StatementSync;
  readonly #pruneReleased: StatementSync;
  readonly #insertCompactedTxn: StatementSync;
  readonly #deleteCommit: StatementSync;
  readonly #updatePoint: StatementSync;
  /** The batch's time, for released chunks. */
  #now = 0;
  /**
   * Live versions and catalog state read or written in the batch, by name:
   * a batch folds many commits of a few names, and parsing every live
   * version's metadata again for each commit would dominate it.
   */
  readonly #versions = new Map<string, readonly LiveDataVersion[]>();
  readonly #catalog = new Map<string, CatalogNameState>();
  /** Chunks released in the batch so far. */
  #released = 0;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.#selectRecordBlob = db.prepare(
      "SELECT blob FROM base_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#upsertRecord = db.prepare(
      "INSERT INTO base_records (namespace, partition, record_key, sha256, inline, blob) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, record_key) DO UPDATE SET sha256 = excluded.sha256, inline = excluded.inline, blob = excluded.blob",
    );
    this.#deleteRecord = db.prepare(
      "DELETE FROM base_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#selectVersions = db.prepare(
      "SELECT metadata FROM base_versions WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version",
    );
    this.#deleteVersions = db.prepare(
      "DELETE FROM base_versions WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#insertVersion = db.prepare(
      "INSERT INTO base_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
    );
    this.#selectCatalog = db.prepare(
      "SELECT c.version, v.metadata FROM base_catalog AS c LEFT JOIN base_versions AS v " +
        "USING (namespace, partition, name, version) " +
        "WHERE c.namespace = ? AND c.partition = ? AND c.name = ? ORDER BY c.version",
    );
    this.#deleteCatalog = db.prepare(
      "DELETE FROM base_catalog WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#insertCatalog = db.prepare(
      "INSERT INTO base_catalog (namespace, partition, name, version) VALUES (?, ?, ?, ?)",
    );
    this.#selectForward = db.prepare(
      "SELECT renamed_to FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#upsertForward = db.prepare(
      "INSERT INTO base_forwards (namespace, partition, name, renamed_to) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, name) DO UPDATE SET renamed_to = excluded.renamed_to",
    );
    this.#deleteForward = db.prepare(
      "DELETE FROM base_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#selectFile = db.prepare(
      "SELECT owner, mark, present FROM base_files WHERE namespace = ? AND record_key = ?",
    );
    this.#upsertFile = db.prepare(
      "INSERT INTO base_files (namespace, record_key, owner, mark, present) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, record_key) DO UPDATE SET owner = excluded.owner, mark = excluded.mark, present = excluded.present",
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
    this.#deleteCommit = db.prepare("DELETE FROM commits WHERE cursor = ?");
    this.#updatePoint = db.prepare(
      "UPDATE compaction SET point = ? WHERE id = 1",
    );
  }

  /** Starts a batch at time `now` (epoch milliseconds). */
  begin(now: number): void {
    this.#now = now;
    this.#released = 0;
    this.#versions.clear();
    this.#catalog.clear();
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
    }
    this.#upsertRecord.run(
      namespace,
      partition,
      key,
      record.sha256,
      "inline" in record.content ? record.content.inline : null,
      blob === undefined ? null : JSON.stringify(blob.toJSON()),
    );
    for (const sha256 of before) this.#release(namespace, sha256);
  }

  deleteRecord(namespace: string, partition: string, key: string): void {
    const before = this.#recordChunks(namespace, partition, key);
    this.#deleteRecord.run(namespace, partition, key);
    for (const sha256 of before) this.#release(namespace, sha256);
  }

  liveVersions(
    namespace: string,
    partition: string,
    name: string,
  ): readonly LiveDataVersion[] {
    const key = nameKey(namespace, partition, name);
    const cached = this.#versions.get(key);
    if (cached !== undefined) return cached;
    const versions = (this.#selectVersions.all(namespace, partition, name) as {
      metadata: string;
    }[]).map((row) => {
      const metadata = parseMetadata(row.metadata);
      return { version: metadata.version, metadata };
    });
    this.#versions.set(key, versions);
    return versions;
  }

  setLiveVersions(
    namespace: string,
    partition: string,
    name: string,
    versions: readonly LiveDataVersion[],
  ): void {
    this.#versions.set(nameKey(namespace, partition, name), versions);
    this.#deleteVersions.run(namespace, partition, name);
    for (const { version, metadata } of versions) {
      this.#insertVersion.run(
        namespace,
        partition,
        name,
        version,
        JSON.stringify(metadata),
      );
    }
  }

  catalogName(
    namespace: string,
    partition: string,
    name: string,
  ): CatalogNameState {
    const key = nameKey(namespace, partition, name);
    const cached = this.#catalog.get(key);
    if (cached !== undefined) return cached;
    const rows = (this.#selectCatalog.all(namespace, partition, name) as {
      version: number;
      metadata: string | null;
    }[]).map((row) => {
      if (row.metadata === null) {
        throw new Error(
          `The compacted base has a catalog row for ${name}@${row.version} that is not a live version`,
        );
      }
      return parseMetadata(row.metadata);
    });
    const forward = this.#selectForward.get(namespace, partition, name) as
      | { renamed_to: string }
      | undefined;
    const state = { rows, forward: forward?.renamed_to };
    this.#catalog.set(key, state);
    return state;
  }

  setCatalogName(
    namespace: string,
    partition: string,
    name: string,
    state: CatalogNameState,
  ): void {
    // Rows are versions of base_versions and share their metadata. The
    // fold sets a name's live versions before its catalog state, so a row
    // that is not the live version is a broken invariant: refuse it rather
    // than let the row vanish or change.
    const live = new Map(
      this.liveVersions(namespace, partition, name).map((v) => [
        v.version,
        v.metadata,
      ]),
    );
    for (const metadata of state.rows) {
      const shown = live.get(metadata.version);
      if (
        shown === undefined ||
        JSON.stringify(shown) !== JSON.stringify(metadata)
      ) {
        throw new Error(
          `A catalog row of ${name}@${metadata.version} is not the live version's metadata`,
        );
      }
    }
    this.#catalog.set(nameKey(namespace, partition, name), state);
    this.#deleteCatalog.run(namespace, partition, name);
    for (const metadata of state.rows) {
      this.#insertCatalog.run(namespace, partition, name, metadata.version);
    }
    if (state.forward === undefined) {
      this.#deleteForward.run(namespace, partition, name);
    } else {
      this.#upsertForward.run(namespace, partition, name, state.forward);
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
  compactCommit(row: CommitRow, chunkRefs: readonly string[]): void {
    this.#insertCompactedTxn.run(
      row.namespace,
      row.partition,
      row.txn_id,
      row.seq,
    );
    for (const sha256 of chunkRefs) this.#release(row.namespace, sha256);
    this.#deleteCommit.run(row.cursor);
  }

  /** Moves the compaction point. */
  setPoint(cursor: number): void {
    this.#updatePoint.run(cursor);
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

  /** Drops one reference; at zero the chunk is released. */
  #release(namespace: string, sha256: string): void {
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

/** The page token {@link SqliteCompactedBase.readPage} hands out. */
function parsePageToken(
  token: string | undefined,
): { section: number; key: (string | number)[] | undefined } {
  if (token === undefined) return { section: 0, key: undefined };
  const value = JSON.parse(token) as { section?: unknown; key?: unknown };
  const section = value.section;
  const key = value.key;
  if (
    typeof section !== "number" || !Number.isSafeInteger(section) ||
    section < 0 || section >= BASE_SECTIONS.length || !Array.isArray(key) ||
    key.length !== BASE_SECTIONS[section].keys.length ||
    !key.every((k) => typeof k === "string" || typeof k === "number")
  ) {
    throw new Error(`Invalid compacted base page token: ${token}`);
  }
  return { section, key: key as (string | number)[] };
}

function baseRecordOf(row: Record<string, unknown>): BaseRecord {
  const sha256 = row.sha256 as string;
  return typeof row.blob === "string"
    ? { sha256, content: { blob: BlobRef.fromJSON(JSON.parse(row.blob)) } }
    : { sha256, content: { inline: row.inline as string } };
}

function parseMetadata(text: string): DataMetadata {
  return DataMetadataSchema.parse(JSON.parse(text));
}

function nameKey(namespace: string, partition: string, name: string): string {
  return JSON.stringify([namespace, partition, name]);
}

function distinctChunks(blob: BlobRef | undefined): readonly string[] {
  return blob === undefined ? [] : [...new Set(blob.chunkHashes())];
}
