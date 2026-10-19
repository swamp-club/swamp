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
 * The SQLite {@link CommitOutbox} (swamp-club#3490): a local file of its own
 * beside the commit store's, never a table in it. An unsent commit must not
 * count as a commit, Litestream replicates only the commit store's file, and
 * a restore replaces that file's content without touching this one, whose
 * entries the fence chain then judges. `v3_datastore.ts` decides the path.
 *
 * The file is created by the first write (a prepare, a fence or a sweep),
 * never when it is opened: a datastore nothing has written keeps only the
 * files setup made. Reads of a file that does not exist yet see it empty.
 *
 * @module
 */

import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { Commit } from "../../domain/datastore_v3/commit.ts";
import {
  type CommitOutbox,
  decideFenceChain,
  type FenceChain,
  OUTBOX_SWEEP_STALE_MS,
  type OutboxEntry,
  type OutboxKey,
  type OutboxListing,
  type OutboxPreparation,
  type SweepState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  parseProcessIdentity,
  type ProcessIdentity,
} from "../../domain/datastore_v3/process_liveness.ts";

/** Error code for an outbox file written by a newer swamp. */
export const COMMIT_OUTBOX_SCHEMA_NEWER_CODE =
  "datastore_v3_outbox_schema_newer";

/**
 * The schema migrations, in order; migration `i` takes the file from
 * `PRAGMA user_version` `i` to `i + 1`. Append, never edit one that shipped.
 */
const MIGRATIONS: readonly string[] = [
  // 0 → 1: entries, the chunks they name, the fence chain and the sweep.
  `
  CREATE TABLE outbox_entries (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    unit_id TEXT NOT NULL,
    base_seq INTEGER NOT NULL,
    base_txn_id TEXT,
    created_at INTEGER NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (namespace, partition, txn_id)
  ) STRICT;
  CREATE TABLE outbox_chunks (
    sequence INTEGER NOT NULL,
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    PRIMARY KEY (sequence, sha256)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX outbox_chunks_by_hash ON outbox_chunks (namespace, sha256);
  CREATE TABLE outbox_chain (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_fence INTEGER NOT NULL,
    chain_start INTEGER NOT NULL,
    floor INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE outbox_sweep (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    epoch INTEGER NOT NULL,
    instance TEXT,
    heartbeat_at INTEGER
  ) STRICT;
  INSERT INTO outbox_sweep (id, epoch) VALUES (1, 0);
  `,
  // 1 → 2 (swamp-club#3564): the preparing process's identity, by which a
  // recovery judges whether it still runs, and the fence of the recovery
  // that left an entry for its live writer, which the floor does not drop.
  // A swamp at schema 1 refuses the outbox as newer: it would judge entries
  // by hostname and drop left ones.
  `
  ALTER TABLE outbox_entries ADD COLUMN writer_process TEXT;
  ALTER TABLE outbox_entries ADD COLUMN left_at_fence INTEGER;
  `,
  // 2 → 3 (swamp-club#3586): when a unit gave an entry up, which recovery
  // honours whatever the writer's state, and the fence a writer noted as
  // taken before raising it, by which a lost chain record is told from
  // another copy's fence. A swamp at schema 2 refuses the outbox as newer:
  // it would land an abandoned entry.
  `
  ALTER TABLE outbox_entries ADD COLUMN abandoned_at INTEGER;
  ALTER TABLE outbox_chain ADD COLUMN pending_fence INTEGER;
  `,
];

/** The schema version this outbox writes. */
export const COMMIT_OUTBOX_SCHEMA_VERSION = MIGRATIONS.length;

/** Hashes looked up per query by `referencedChunks`. */
const REF_LOOKUP_PAGE = 500;

/** Options for {@link SqliteCommitOutbox}. */
export interface SqliteCommitOutboxOptions {
  /** When an entry is first prepared; the system clock by default. */
  readonly clock?: () => Date;
  /**
   * Called inside each write transaction with the connection's
   * `PRAGMA synchronous` value (2 is FULL, 1 NORMAL): tests observe which
   * writes are fsynced through it.
   */
  readonly onWrite?: (synchronous: number) => void;
  /**
   * This process's identity, recorded with each entry it prepares
   * (swamp-club#3564); none by default.
   */
  readonly writerProcess?: () => Promise<ProcessIdentity | undefined>;
}

interface EntryRow {
  readonly sequence: number;
  readonly namespace: string;
  readonly partition: string;
  readonly txn_id: string;
  readonly unit_id: string;
  readonly base_seq: number;
  readonly base_txn_id: string | null;
  readonly created_at: number;
  readonly body: string;
  readonly writer_process: string | null;
  readonly left_at_fence: number | null;
  readonly abandoned_at: number | null;
}

/**
 * The outbox at `path`. One connection per instance; every write is one
 * transaction with `synchronous=FULL`, so a prepared entry survives a power
 * cut as the commit store's appends do. A settle alone skips the fsync.
 */
export class SqliteCommitOutbox implements CommitOutbox {
  readonly #path: string;
  readonly #clock: () => Date;
  readonly #onWrite: ((synchronous: number) => void) | undefined;
  readonly #writerProcess:
    | (() => Promise<ProcessIdentity | undefined>)
    | undefined;
  #db: DatabaseSync | undefined;
  #closed = false;

  constructor(path: string, options: SqliteCommitOutboxOptions = {}) {
    this.#path = path;
    this.#clock = options.clock ?? (() => new Date());
    this.#onWrite = options.onWrite;
    this.#writerProcess = options.writerProcess;
  }

  /** The outbox file's path. */
  get path(): string {
    return this.#path;
  }

  async prepare(preparation: OutboxPreparation): Promise<void> {
    const process = await this.#writerProcess?.();
    return await this.#write((db) => {
      const { commit, unitId, base } = preparation;
      // A prepare again is a new preparation: no recovery left it since.
      const row = db.prepare(
        "INSERT INTO outbox_entries (namespace, partition, txn_id, unit_id, base_seq, base_txn_id, created_at, body, writer_process) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) " +
          "ON CONFLICT (namespace, partition, txn_id) DO UPDATE SET unit_id = excluded.unit_id, " +
          "base_seq = excluded.base_seq, base_txn_id = excluded.base_txn_id, body = excluded.body, " +
          "writer_process = excluded.writer_process, left_at_fence = NULL, abandoned_at = NULL " +
          "RETURNING sequence",
      ).get(
        commit.namespace,
        commit.partition.toString(),
        commit.txnId,
        unitId,
        base.seq,
        base.txnId ?? null,
        this.#clock().getTime(),
        JSON.stringify(commit.toJSON()),
        process !== undefined ? JSON.stringify(process) : null,
      ) as { sequence: number };
      db.prepare("DELETE FROM outbox_chunks WHERE sequence = ?").run(
        row.sequence,
      );
      const insert = db.prepare(
        "INSERT OR IGNORE INTO outbox_chunks (sequence, namespace, sha256) VALUES (?, ?, ?)",
      );
      for (const sha256 of commit.chunkRefs()) {
        insert.run(row.sequence, commit.namespace, sha256);
      }
    });
  }

  settle(keys: readonly OutboxKey[]): Promise<void> {
    // A settle lost to a power cut costs one more settle at the next
    // recovery, which finds the commit landed: no fsync of its own.
    return this.#remove(keys, false);
  }

  discard(keys: readonly OutboxKey[]): Promise<void> {
    // A discarded entry's outcome was reported; back after a power cut, the
    // next recovery could land it. So a discard is fsynced.
    return this.#remove(keys, true);
  }

  abandon(keys: readonly OutboxKey[]): Promise<void> {
    if (keys.length === 0) return Promise.resolve();
    // The mark is what keeps a reported failure from landing: fsynced.
    const at = this.#clock().getTime();
    return this.#write((db) => {
      const mark = db.prepare(
        "UPDATE outbox_entries SET abandoned_at = ? " +
          "WHERE namespace = ? AND partition = ? AND txn_id = ? AND abandoned_at IS NULL",
      );
      for (const key of keys) {
        mark.run(at, key.namespace, key.partition, key.txnId);
      }
    }, { create: false });
  }

  #remove(keys: readonly OutboxKey[], durable: boolean): Promise<void> {
    if (keys.length === 0) return Promise.resolve();
    return this.#write((db) => {
      const select = db.prepare(
        "SELECT sequence FROM outbox_entries WHERE namespace = ? AND partition = ? AND txn_id = ?",
      );
      const deleteChunks = db.prepare(
        "DELETE FROM outbox_chunks WHERE sequence = ?",
      );
      const deleteEntry = db.prepare(
        "DELETE FROM outbox_entries WHERE sequence = ?",
      );
      for (const key of keys) {
        const row = select.get(key.namespace, key.partition, key.txnId) as
          | { sequence: number }
          | undefined;
        if (row === undefined) continue;
        deleteChunks.run(row.sequence);
        deleteEntry.run(row.sequence);
      }
    }, { create: false, durable });
  }

  async entries(): Promise<OutboxListing> {
    const rows = this.#read((db) =>
      db.prepare(
        "SELECT sequence, namespace, partition, txn_id, unit_id, base_seq, base_txn_id, created_at, body, " +
          "writer_process, left_at_fence, abandoned_at FROM outbox_entries ORDER BY sequence",
      ).all() as unknown as EntryRow[]
    ) ?? [];
    const entries: OutboxEntry[] = [];
    const unreadable: { key: OutboxKey; detail: string }[] = [];
    for (const row of rows) {
      const key = {
        namespace: row.namespace,
        partition: row.partition,
        txnId: row.txn_id,
      };
      try {
        const commit = await Commit.fromJSON(JSON.parse(row.body));
        if (
          commit.namespace !== row.namespace ||
          commit.partition.toString() !== row.partition ||
          commit.txnId !== row.txn_id
        ) {
          throw new Error("its body is another commit's");
        }
        const writerProcess = readWriterProcess(row.writer_process);
        entries.push({
          sequence: row.sequence,
          createdAt: row.created_at,
          commit,
          unitId: row.unit_id,
          base: { seq: row.base_seq, txnId: row.base_txn_id ?? undefined },
          ...(writerProcess !== undefined ? { writerProcess } : {}),
          ...(row.left_at_fence !== null
            ? { leftAtFence: row.left_at_fence }
            : {}),
          ...(row.abandoned_at !== null
            ? { abandonedAt: row.abandoned_at }
            : {}),
        });
      } catch (error) {
        unreadable.push({
          key,
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return { entries, unreadable };
  }

  // deno-lint-ignore require-await
  async hasEntries(): Promise<boolean> {
    return this.#read((db) =>
      db.prepare("SELECT 1 AS found FROM outbox_entries LIMIT 1").get() !==
        undefined
    ) ?? false;
  }

  notePendingFence(fence: number): Promise<void> {
    return this.#write((db) => {
      // A note one above the last fence, or the first note of a chain that
      // holds no fence yet, is a fence this copy took whose record was
      // lost: the chain takes it before this note replaces it.
      db.prepare(
        "UPDATE outbox_chain SET last_fence = pending_fence, " +
          "chain_start = CASE WHEN last_fence = 0 THEN pending_fence ELSE chain_start END " +
          "WHERE id = 1 AND pending_fence IS NOT NULL " +
          "AND (pending_fence = last_fence + 1 OR last_fence = 0)",
      ).run();
      // Before any chain, an empty one (fence 0) holds the note, so even the
      // copy's first fence is recognised when its record is lost.
      db.prepare(
        "INSERT INTO outbox_chain (id, last_fence, chain_start, floor, pending_fence) VALUES (1, 0, 0, 0, ?) " +
          "ON CONFLICT (id) DO UPDATE SET pending_fence = MAX(COALESCE(pending_fence, 0), excluded.pending_fence)",
      ).run(fence);
    });
  }

  recordFence(
    fence: number,
    options: { readonly replicated?: boolean } = {},
  ): Promise<FenceChain> {
    return this.#write((db) => {
      const pending = db.prepare(
        "SELECT pending_fence FROM outbox_chain WHERE id = 1",
      ).get() as { pending_fence: number | null } | undefined;
      const next = decideFenceChain(readChain(db), fence, {
        ...(pending !== undefined && pending.pending_fence !== null
          ? { pendingFence: pending.pending_fence }
          : {}),
        ...(options.replicated !== undefined
          ? { replicated: options.replicated }
          : {}),
      });
      // A recorded fence needs no note: clearing it keeps a stale one from
      // outliving a restart of the lease's records and being taken later for
      // a fence another copy held.
      db.prepare(
        "INSERT INTO outbox_chain (id, last_fence, chain_start, floor) VALUES (1, ?, ?, ?) " +
          "ON CONFLICT (id) DO UPDATE SET last_fence = excluded.last_fence, " +
          "chain_start = excluded.chain_start, floor = excluded.floor, pending_fence = NULL",
      ).run(next.lastFence, next.chainStart, next.floor);
      return next;
    });
  }

  // deno-lint-ignore require-await
  async chain(): Promise<FenceChain | undefined> {
    return this.#read(readChain);
  }

  raiseFloor(fence: number): Promise<void> {
    return this.#write((db) => {
      db.prepare(
        "UPDATE outbox_chain SET floor = ? WHERE id = 1 AND floor < ? AND last_fence >= ?",
      ).run(fence, fence, fence);
    }, { create: false });
  }

  markLeft(keys: readonly OutboxKey[], fence: number): Promise<void> {
    if (keys.length === 0) return Promise.resolve();
    return this.#write((db) => {
      const mark = db.prepare(
        "UPDATE outbox_entries SET left_at_fence = ? " +
          "WHERE namespace = ? AND partition = ? AND txn_id = ? AND left_at_fence IS NULL",
      );
      for (const key of keys) {
        mark.run(fence, key.namespace, key.partition, key.txnId);
      }
    }, { create: false });
  }

  // deno-lint-ignore require-await
  async referencedChunks(
    namespace: string,
    hashes: readonly string[],
  ): Promise<Set<string>> {
    const found = new Set<string>();
    if (hashes.length === 0) return found;
    this.#read((db) => {
      for (let at = 0; at < hashes.length; at += REF_LOOKUP_PAGE) {
        const page = hashes.slice(at, at + REF_LOOKUP_PAGE);
        const rows = db.prepare(
          `SELECT DISTINCT sha256 FROM outbox_chunks WHERE namespace = ? AND sha256 IN (${
            page.map(() => "?").join(", ")
          })`,
        ).all(namespace, ...page) as { sha256: string }[];
        for (const row of rows) found.add(row.sha256);
      }
    });
    return found;
  }

  // deno-lint-ignore require-await
  async sweepState(now: number): Promise<SweepState> {
    const row = this.#read((db) =>
      db.prepare(
        "SELECT epoch, instance, heartbeat_at FROM outbox_sweep WHERE id = 1",
      ).get() as
        | {
          epoch: number;
          instance: string | null;
          heartbeat_at: number | null;
        }
        | undefined
    );
    if (row === undefined) return { epoch: 0, active: false };
    return {
      epoch: row.epoch,
      active: row.instance !== null && row.heartbeat_at !== null &&
        now - row.heartbeat_at < OUTBOX_SWEEP_STALE_MS,
    };
  }

  beginSweep(instance: string, now: number): Promise<void> {
    return this.#write((db) => {
      db.prepare(
        "UPDATE outbox_sweep SET epoch = epoch + 1, instance = ?, heartbeat_at = ? WHERE id = 1",
      ).run(instance, now);
    });
  }

  heartbeatSweep(instance: string, now: number): Promise<void> {
    return this.#write((db) => {
      db.prepare(
        "UPDATE outbox_sweep SET heartbeat_at = ? WHERE id = 1 AND instance = ?",
      ).run(now, instance);
    });
  }

  endSweep(instance: string): Promise<void> {
    return this.#write((db) => {
      db.prepare(
        "UPDATE outbox_sweep SET epoch = epoch + 1, instance = NULL, heartbeat_at = NULL " +
          "WHERE id = 1 AND instance = ?",
      ).run(instance);
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
    return Promise.resolve();
  }

  /** Runs `body` in a write transaction, creating the file unless told not to. */
  #write<T>(
    body: (db: DatabaseSync) => T,
    options: { readonly create?: boolean; readonly durable?: boolean } = {},
  ): Promise<T> {
    try {
      const db = this.#connection(options.create ?? true);
      if (db === undefined) return Promise.resolve(undefined as T);
      // A write that need not survive a power cut skips the fsync.
      const relaxed = options.durable === false;
      if (relaxed) db.exec("PRAGMA synchronous=NORMAL");
      try {
        db.exec("BEGIN IMMEDIATE");
        try {
          if (this.#onWrite !== undefined) {
            const row = db.prepare("PRAGMA synchronous").get() as
              | { synchronous: number }
              | undefined;
            this.#onWrite(row?.synchronous ?? -1);
          }
          const result = body(db);
          db.exec("COMMIT");
          return Promise.resolve(result);
        } catch (error) {
          rollbackQuietly(db);
          throw error;
        }
      } finally {
        if (relaxed) db.exec("PRAGMA synchronous=FULL");
      }
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** Runs `body` in a read transaction; undefined while the file does not exist. */
  #read<T>(body: (db: DatabaseSync) => T): T | undefined {
    const db = this.#connection(false);
    if (db === undefined) return undefined;
    db.exec("BEGIN");
    try {
      const result = body(db);
      db.exec("COMMIT");
      return result;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
  }

  #connection(create: boolean): DatabaseSync | undefined {
    if (this.#closed) throw new Error("The commit outbox is closed");
    if (this.#db !== undefined) return this.#db;
    if (!create && !exists(this.#path)) return undefined;
    this.#db = openOutboxDatabase(this.#path);
    return this.#db;
  }
}

/**
 * Opens the outbox file at `path`, creating it and its schema when absent:
 * WAL, `synchronous=FULL` and a busy timeout, as the commit store does.
 * Refuses a file written by a newer schema.
 */
function openOutboxDatabase(path: string): DatabaseSync {
  ensureDirSync(dirname(path));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const mode = db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (mode?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    migrate(db, path);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync, path: string): void {
  const read = () =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  const check = (version: number) => {
    if (version > COMMIT_OUTBOX_SCHEMA_VERSION) {
      throw markErrorPaths(
        new UserError(
          `The v3 commit outbox at ${path} is at schema version ${version}, newer ` +
            `than this swamp's ${COMMIT_OUTBOX_SCHEMA_VERSION}: upgrade swamp.`,
          COMMIT_OUTBOX_SCHEMA_NEWER_CODE,
        ),
        [path],
      );
    }
  };
  check(read());
  if (read() === COMMIT_OUTBOX_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = read();
    check(version);
    for (let next = version; next < COMMIT_OUTBOX_SCHEMA_VERSION; next++) {
      db.exec(MIGRATIONS[next]);
    }
    db.exec(`PRAGMA user_version=${COMMIT_OUTBOX_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

function readChain(db: DatabaseSync): FenceChain | undefined {
  const row = db.prepare(
    "SELECT last_fence, chain_start, floor FROM outbox_chain WHERE id = 1",
  ).get() as
    | { last_fence: number; chain_start: number; floor: number }
    | undefined;
  // A chain at fence 0 only holds a note: no fence was recorded yet.
  return row === undefined || row.last_fence === 0 ? undefined : {
    lastFence: row.last_fence,
    chainStart: row.chain_start,
    floor: row.floor,
  };
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The caller rethrows the original error.
  }
}

/** An entry's recorded identity, or undefined when it has none it can read. */
function readWriterProcess(
  text: string | null,
): ProcessIdentity | undefined {
  if (text === null) return undefined;
  try {
    return parseProcessIdentity(JSON.parse(text));
  } catch {
    return undefined;
  }
}
