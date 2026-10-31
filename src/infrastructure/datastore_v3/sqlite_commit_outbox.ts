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
  type OutboxEntryState,
  type OutboxKey,
  type OutboxListing,
  type OutboxPreparation,
  type SweepState,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  EMPTY_REBASE_CARRY,
  mergeRebaseCarry,
  type OfflineRebaseCarry,
  parseRebaseCarry,
} from "../../domain/datastore_v3/offline_rebase.ts";
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
  // 3 → 4 (swamp-club#3693): an entry's commit may hold puts with a file
  // access. No table changes; a swamp at schema 3 would reject the op
  // field and call the entry corrupt, so it must refuse the outbox as newer.
  `SELECT 1;`,
  // 4 → 5 (swamp-club#4121): the fenced model lease an entry was built
  // under, which its recovery names. A swamp at schema 4 refuses the outbox
  // as newer: it would resend the entry outside its lease.
  `
  ALTER TABLE outbox_entries ADD COLUMN lease_id TEXT;
  ALTER TABLE outbox_entries ADD COLUMN lease_fence INTEGER;
  `,
  // 5 → 6 (swamp-club#4195): what became of an entry that is not pending
  // (queued offline, rejected, quarantined) and why. A swamp at schema 5
  // refuses the outbox as newer: it would drop an offline entry as stale
  // or expired, or land a rejected one.
  `
  ALTER TABLE outbox_entries ADD COLUMN state TEXT;
  ALTER TABLE outbox_entries ADD COLUMN state_reason TEXT;
  ALTER TABLE outbox_entries ADD COLUMN sent_maybe_at INTEGER;
  CREATE TABLE outbox_versions (
    sequence INTEGER NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    PRIMARY KEY (sequence, name, version)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX outbox_versions_by_name ON outbox_versions (name, version);
  CREATE TABLE outbox_landed_offline (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    landed_at INTEGER NOT NULL,
    carry TEXT,
    PRIMARY KEY (namespace, partition, txn_id)
  ) STRICT, WITHOUT ROWID;
  INSERT OR IGNORE INTO outbox_versions (sequence, name, version)
    SELECT entry.sequence, json_extract(op.value, '$.metadata.name'),
      json_extract(op.value, '$.metadata.version')
    FROM outbox_entries AS entry, json_each(
      CASE WHEN json_valid(entry.body) THEN entry.body ELSE '{}' END,
      '$.ops'
    ) AS op
    WHERE json_extract(op.value, '$.kind') = 'data-version'
      AND json_type(op.value, '$.metadata.name') = 'text'
      AND json_type(op.value, '$.metadata.version') = 'integer';
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
  /**
   * Whether prepares made together share one transaction (swamp-club#3915);
   * true by default. Turned off only by tests and benchmarks.
   */
  readonly groupPrepares?: boolean;
}

/**
 * The most prepares one transaction writes (swamp-club#3915), as the commit
 * store's group commit caps its appends.
 */
export const GROUP_PREPARE_MAX = 64;

/** The savepoint each prepare of a group runs in. */
const PREPARE_SAVEPOINT = "group_prepare";

/** A prepare waiting for its group's transaction. */
interface PendingPrepare {
  readonly preparation: OutboxPreparation;
  readonly process: ProcessIdentity | undefined;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
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
  readonly lease_id: string | null;
  readonly lease_fence: number | null;
  readonly state: string | null;
  readonly state_reason: string | null;
  readonly sent_maybe_at: number | null;
}

const ENTRY_STATES: readonly OutboxEntryState[] = [
  "offline",
  "rejected",
  "quarantined",
];

function entryStateOf(raw: string | null): OutboxEntryState | undefined {
  if (raw === null) return undefined;
  if ((ENTRY_STATES as readonly string[]).includes(raw)) {
    return raw as OutboxEntryState;
  }
  throw new Error(`its state '${raw}' is unknown`);
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
  readonly #groupPrepares: boolean;
  #db: DatabaseSync | undefined;
  #closed = false;
  /** Prepares waiting for the next group transaction (swamp-club#3915). */
  #pending: PendingPrepare[] = [];
  #flushScheduled = false;

  constructor(path: string, options: SqliteCommitOutboxOptions = {}) {
    this.#path = path;
    this.#clock = options.clock ?? (() => new Date());
    this.#onWrite = options.onWrite;
    this.#writerProcess = options.writerProcess;
    this.#groupPrepares = options.groupPrepares ?? true;
  }

  /** The outbox file's path. */
  get path(): string {
    return this.#path;
  }

  /**
   * Prepares made together share one transaction, so a burst pays one fsync
   * (swamp-club#3915): a prepare waits for the end of the current microtask
   * turn, when every prepare made by then is written, each in a savepoint of
   * its own so a failing one fails alone. Every other read or write writes
   * the waiting prepares first, so the outbox sees its calls in the order
   * they were made. A prepare resolves once its entry is durable, as before.
   */
  async prepare(preparation: OutboxPreparation): Promise<void> {
    const process = await this.#writerProcess?.();
    if (!this.#groupPrepares) {
      return await this.#write((db) =>
        this.#insertEntry(db, preparation, process)
      );
    }
    return await new Promise<void>((resolve, reject) => {
      this.#pending.push({ preparation, process, resolve, reject });
      if (this.#pending.length >= GROUP_PREPARE_MAX) {
        this.#flushPrepares();
      } else if (!this.#flushScheduled) {
        this.#flushScheduled = true;
        queueMicrotask(() => {
          this.#flushScheduled = false;
          this.#flushPrepares();
        });
      }
    });
  }

  /**
   * Writes every waiting prepare, settling each one's promise: one alone as
   * a prepare was always written, more in transactions of up to
   * {@link GROUP_PREPARE_MAX}, settled once the transaction commits.
   */
  #flushPrepares(): void {
    while (this.#pending.length > 0) {
      const group = this.#pending.splice(0, GROUP_PREPARE_MAX);
      if (group.length === 1) {
        const [{ preparation, process, resolve, reject }] = group;
        try {
          this.#writeSync((db) => this.#insertEntry(db, preparation, process));
          resolve();
        } catch (error) {
          reject(error);
        }
        continue;
      }
      const failed = new Map<PendingPrepare, unknown>();
      try {
        this.#writeSync((db) => {
          for (const pending of group) {
            db.exec(`SAVEPOINT ${PREPARE_SAVEPOINT}`);
            try {
              this.#insertEntry(db, pending.preparation, pending.process);
              db.exec(`RELEASE ${PREPARE_SAVEPOINT}`);
            } catch (error) {
              db.exec(`ROLLBACK TO ${PREPARE_SAVEPOINT}`);
              db.exec(`RELEASE ${PREPARE_SAVEPOINT}`);
              failed.set(pending, error);
            }
          }
        });
      } catch (error) {
        for (const { reject } of group) reject(error);
        continue;
      }
      for (const pending of group) {
        if (failed.has(pending)) pending.reject(failed.get(pending));
        else pending.resolve();
      }
    }
  }

  /** Writes one prepared entry and the chunks it names. */
  #insertEntry(
    db: DatabaseSync,
    preparation: OutboxPreparation,
    process: ProcessIdentity | undefined,
  ): void {
    const { commit, unitId, base, lease, queuedOffline } = preparation;
    // A prepare again is a new preparation: no recovery left it since.
    const row = db.prepare(
      "INSERT INTO outbox_entries (namespace, partition, txn_id, unit_id, base_seq, base_txn_id, created_at, body, writer_process, lease_id, lease_fence, state) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, txn_id) DO UPDATE SET unit_id = excluded.unit_id, " +
        "base_seq = excluded.base_seq, base_txn_id = excluded.base_txn_id, body = excluded.body, " +
        "writer_process = excluded.writer_process, left_at_fence = NULL, abandoned_at = NULL, " +
        "lease_id = excluded.lease_id, lease_fence = excluded.lease_fence, " +
        // A prepare again never clears a state: an offline, rejected or
        // quarantined entry stays one (swamp-club#4195).
        "state = COALESCE(excluded.state, outbox_entries.state) " +
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
      lease?.leaseId ?? null,
      lease?.fence ?? null,
      queuedOffline === true ? "offline" : null,
    ) as { sequence: number };
    db.prepare("DELETE FROM outbox_chunks WHERE sequence = ?").run(
      row.sequence,
    );
    // The data versions it records, so a version allocation reads an index,
    // not every entry's body (swamp-club#4195).
    db.prepare("DELETE FROM outbox_versions WHERE sequence = ?").run(
      row.sequence,
    );
    const version = db.prepare(
      "INSERT OR IGNORE INTO outbox_versions (sequence, name, version) VALUES (?, ?, ?)",
    );
    for (const op of commit.ops) {
      if (op.kind === "data-version") {
        version.run(row.sequence, op.metadata.name, op.metadata.version);
      }
    }
    const insert = db.prepare(
      "INSERT OR IGNORE INTO outbox_chunks (sequence, namespace, sha256) VALUES (?, ?, ?)",
    );
    for (const sha256 of commit.chunkRefs()) {
      insert.run(row.sequence, commit.namespace, sha256);
    }
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
      const deleteVersions = db.prepare(
        "DELETE FROM outbox_versions WHERE sequence = ?",
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
        deleteVersions.run(row.sequence);
        deleteEntry.run(row.sequence);
      }
    }, { create: false, durable });
  }

  async entries(): Promise<OutboxListing> {
    const rows = this.#read((db) =>
      db.prepare(
        "SELECT sequence, namespace, partition, txn_id, unit_id, base_seq, base_txn_id, created_at, body, " +
          "writer_process, left_at_fence, abandoned_at, lease_id, lease_fence, state, state_reason, sent_maybe_at " +
          "FROM outbox_entries ORDER BY sequence",
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
        const state = entryStateOf(row.state);
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
          ...(row.lease_id !== null && row.lease_fence !== null
            ? { lease: { leaseId: row.lease_id, fence: row.lease_fence } }
            : {}),
          ...(state !== undefined ? { state } : {}),
          ...(row.state_reason !== null
            ? { stateReason: row.state_reason }
            : {}),
          ...(row.sent_maybe_at !== null
            ? { sentMaybeAt: row.sent_maybe_at }
            : {}),
        });
      } catch (error) {
        unreadable.push({
          key,
          detail: error instanceof Error ? error.message : String(error),
          ...(row.state !== null ? { state: row.state } : {}),
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

  /**
   * Whether any entry could still land: one pending or queued offline.
   * Rejected and quarantined entries are kept but never sent again
   * (swamp-club#4195), so they do not count.
   */
  // deno-lint-ignore require-await
  async hasUnsettledEntries(): Promise<boolean> {
    return this.#read((db) =>
      db.prepare(
        "SELECT 1 AS found FROM outbox_entries " +
          "WHERE state IS NULL OR state = 'offline' LIMIT 1",
      ).get() !== undefined
    ) ?? false;
  }

  /**
   * Empties the outbox as a new copy's would be, but for its rejected and
   * quarantined entries, which are never discarded (swamp-club#4195): the
   * fence chain and the sweep start over, every other entry and its chunk
   * references go. One transaction, so a crash leaves the outbox either
   * untouched or reset. Resolves with how many entries were kept; none when
   * the file does not exist.
   */
  resetKeepingKept(): Promise<number> {
    return this.#write((db) => {
      db.prepare(
        "DELETE FROM outbox_chunks WHERE sequence IN (" +
          "SELECT sequence FROM outbox_entries WHERE state IS NULL " +
          "OR state NOT IN ('rejected', 'quarantined'))",
      ).run();
      db.prepare(
        "DELETE FROM outbox_versions WHERE sequence IN (" +
          "SELECT sequence FROM outbox_entries WHERE state IS NULL " +
          "OR state NOT IN ('rejected', 'quarantined'))",
      ).run();
      db.prepare(
        "DELETE FROM outbox_entries WHERE state IS NULL " +
          "OR state NOT IN ('rejected', 'quarantined')",
      ).run();
      db.prepare("DELETE FROM outbox_chain").run();
      db.prepare("DELETE FROM outbox_landed_offline").run();
      db.prepare(
        "UPDATE outbox_sweep SET epoch = 0, instance = NULL, heartbeat_at = NULL",
      ).run();
      const row = db.prepare("SELECT COUNT(*) AS kept FROM outbox_entries")
        .get() as { kept: number };
      return row.kept;
    }, { create: false }).then((kept) => kept ?? 0);
  }

  /**
   * Records that the offline entry `key` landed, by a flush, at `at`
   * (swamp-club#4195): a later flush judges the versions it wrote as this
   * checkout's own, which its later offline work saw, and the partition's
   * entries still queued follow what it renumbered and rewrote (`carry`).
   * Records older than `retainMs` are dropped as one is added, except a
   * partition's while it still has an entry queued offline, which may
   * follow them.
   */
  recordLandedOffline(
    key: OutboxKey,
    at: number,
    retainMs: number,
    carry?: OfflineRebaseCarry,
  ): Promise<void> {
    // Fsynced: a later entry that misses it could remove another writer's
    // version that took the number this one landed away from.
    return this.#write((db) => {
      db.prepare(
        "INSERT OR REPLACE INTO outbox_landed_offline (namespace, partition, txn_id, landed_at, carry) VALUES (?, ?, ?, ?, ?)",
      ).run(
        key.namespace,
        key.partition,
        key.txnId,
        at,
        carry === undefined ? null : JSON.stringify(carry),
      );
      db.prepare(
        "DELETE FROM outbox_landed_offline WHERE landed_at < ? AND NOT EXISTS (" +
          "SELECT 1 FROM outbox_entries AS entry " +
          "WHERE entry.namespace = outbox_landed_offline.namespace " +
          "AND entry.partition = outbox_landed_offline.partition " +
          "AND entry.state = 'offline')",
      ).run(at - retainMs);
    }, { create: false });
  }

  /**
   * What `partition`'s offline entries that flushes landed renumbered and
   * rewrote (swamp-club#4195), merged: what its queued entries follow. A
   * record that does not parse adds nothing.
   */
  // deno-lint-ignore require-await
  async landedOfflineCarry(
    namespace: string,
    partition: string,
  ): Promise<OfflineRebaseCarry> {
    const rows = this.#read((db) =>
      db.prepare(
        "SELECT carry FROM outbox_landed_offline WHERE namespace = ? AND partition = ? AND carry IS NOT NULL ORDER BY landed_at, txn_id",
      ).all(namespace, partition) as { carry: string }[]
    ) ?? [];
    let merged = EMPTY_REBASE_CARRY;
    for (const row of rows) {
      const carry = parseRebaseCarry(row.carry);
      if (carry !== undefined) merged = mergeRebaseCarry(merged, carry);
    }
    return merged;
  }

  /** The txnIds of `partition`'s offline entries that flushes landed. */
  // deno-lint-ignore require-await
  async landedOfflineTxnIds(
    namespace: string,
    partition: string,
  ): Promise<ReadonlySet<string>> {
    const rows = this.#read((db) =>
      db.prepare(
        "SELECT txn_id FROM outbox_landed_offline WHERE namespace = ? AND partition = ?",
      ).all(namespace, partition) as { txn_id: string }[]
    ) ?? [];
    return new Set(rows.map((row) => row.txn_id));
  }

  markSentMaybe(key: OutboxKey, at: number): Promise<void> {
    // Fsynced: a resend after serve's txnId retention could land it twice.
    return this.#write((db) => {
      db.prepare(
        "UPDATE outbox_entries SET sent_maybe_at = ? " +
          "WHERE namespace = ? AND partition = ? AND txn_id = ? " +
          "AND sent_maybe_at IS NULL",
      ).run(at, key.namespace, key.partition, key.txnId);
    }, { create: false });
  }

  markState(
    keys: readonly OutboxKey[],
    state: OutboxEntryState,
    reason?: string,
  ): Promise<void> {
    if (keys.length === 0) return Promise.resolve();
    // The mark is what keeps the entry from every drop rule: fsynced.
    return this.#write((db) => {
      const mark = db.prepare(
        "UPDATE outbox_entries SET state = ?, state_reason = ? " +
          "WHERE namespace = ? AND partition = ? AND txn_id = ?",
      );
      for (const key of keys) {
        mark.run(
          state,
          reason ?? null,
          key.namespace,
          key.partition,
          key.txnId,
        );
      }
    }, { create: false });
  }

  // deno-lint-ignore require-await
  async queuedDataHighWater(
    namespace: string,
    partition: string,
    name: string,
  ): Promise<number> {
    // Read from the version index the prepare writes: no entry body is
    // parsed, so the cost does not grow with what the outbox holds.
    const row = this.#read((db) =>
      db.prepare(
        "SELECT MAX(version.version) AS high FROM outbox_versions AS version " +
          "JOIN outbox_entries AS entry ON entry.sequence = version.sequence " +
          "WHERE entry.namespace = ? AND entry.partition = ? " +
          "AND entry.state IS NOT NULL AND version.name = ?",
      ).get(namespace, partition, name) as { high: number | null } | undefined
    );
    return row?.high ?? 0;
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
    // Prepares made before the close are written, as they were before
    // grouping.
    if (!this.#closed) this.#flushPrepares();
    this.#closed = true;
    this.#db?.close();
    this.#db = undefined;
    return Promise.resolve();
  }

  /**
   * Runs `body` in a write transaction, creating the file unless told not
   * to. The waiting prepares are written first.
   */
  #write<T>(
    body: (db: DatabaseSync) => T,
    options: { readonly create?: boolean; readonly durable?: boolean } = {},
  ): Promise<T> {
    try {
      this.#flushPrepares();
      return Promise.resolve(this.#writeSync(body, options));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  /** {@link #write}'s transaction, synchronously; throws its error. */
  #writeSync<T>(
    body: (db: DatabaseSync) => T,
    options: { readonly create?: boolean; readonly durable?: boolean } = {},
  ): T {
    const db = this.#connection(options.create ?? true);
    if (db === undefined) return undefined as T;
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
        return result;
      } catch (error) {
        rollbackQuietly(db);
        throw error;
      }
    } finally {
      if (relaxed) db.exec("PRAGMA synchronous=FULL");
    }
  }

  /** Runs `body` in a read transaction; undefined while the file does not exist. */
  #read<T>(body: (db: DatabaseSync) => T): T | undefined {
    this.#flushPrepares();
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
/**
 * How many entries the outbox at `path` holds that recovery would still
 * land (not abandoned), read without opening the outbox: no migration, no
 * write, and 0 for a file that is absent or unreadable (swamp-club#4063).
 * A refused writer reports them, so its user knows a claim strands them.
 */
export function countPendingOutboxEntries(path: string): number {
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(path, { readOnly: true });
  } catch {
    return 0;
  }
  try {
    const row = db.prepare(
      "SELECT count(*) AS pending FROM outbox_entries WHERE abandoned_at IS NULL",
    ).get() as { pending: number } | undefined;
    return row?.pending ?? 0;
  } catch {
    return 0;
  } finally {
    db.close();
  }
}

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
