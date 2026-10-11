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
import { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitChange,
  type CommitStore,
  type CommitStoreAppendResult,
  CommitStoreCorruptError,
  type PartitionHead,
} from "../../domain/datastore_v3/commit_store.ts";
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
];

/** The schema version this store writes. */
export const COMMIT_STORE_SCHEMA_VERSION = MIGRATIONS.length;

/** How many rebuilt partitions a store keeps by default. */
export const DEFAULT_CACHED_PARTITIONS = 1024;

/** A partition's state is snapshotted every this many commits by default. */
export const DEFAULT_SNAPSHOT_INTERVAL = 1000;

/** Rows read per query while rebuilding a partition. */
const REBUILD_PAGE = 500;

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
    this.#selectTxnSeq = db.prepare(
      "SELECT seq FROM commits WHERE namespace = ? AND partition = ? AND txn_id = ?",
    );
    this.#selectTxnUpTo = db.prepare(
      "SELECT 1 AS found FROM commits WHERE namespace = ? AND partition = ? AND txn_id = ? AND seq <= ?",
    );
    this.#selectMaxSeq = db.prepare(
      "SELECT MAX(seq) AS seq FROM commits WHERE namespace = ? AND partition = ?",
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
      "INSERT OR IGNORE INTO chunk_refs (namespace, sha256) VALUES (?, ?)",
    );
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

  /** Restores a partition's latest snapshot and replays the commits after it. */
  async #rebuild(namespace: string, key: PartitionKey): Promise<Partition> {
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
  ): Promise<Set<string>> {
    if (this.#closed) return Promise.reject(closedError());
    const found = new Set<string>();
    for (let at = 0; at < hashes.length; at += REF_LOOKUP_PAGE) {
      const page = hashes.slice(at, at + REF_LOOKUP_PAGE);
      const rows = this.#db.prepare(
        `SELECT sha256 FROM chunk_refs WHERE namespace = ? AND sha256 IN (${
          page.map(() => "?").join(", ")
        })`,
      ).all(namespace, ...page) as unknown as { sha256: string }[];
      for (const row of rows) found.add(row.sha256);
    }
    return Promise.resolve(found);
  }

  async readPartition(
    namespace: string,
    partition: PartitionKey,
    fromSeq: number,
    limit: number,
  ): Promise<readonly Commit[]> {
    this.#assertOpen();
    requirePositive(fromSeq, "fromSeq");
    requirePositive(limit, "limit");
    const rows = this.#selectPartitionPage.all(
      namespace,
      partition.toString(),
      fromSeq,
      limit,
    ) as unknown as CommitRow[];
    const commits: Commit[] = [];
    for (const row of rows) commits.push(await parseRow(row));
    return commits;
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
    const rows = this.#selectChanges.all(
      cursor,
      limit,
    ) as unknown as CommitRow[];
    const changes: CommitChange[] = [];
    for (const row of rows) {
      changes.push({ cursor: row.cursor, commit: await parseRow(row) });
    }
    return changes;
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
