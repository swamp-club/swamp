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
 * all state is rebuilt from the commits, so reset can start over, except
 * at-risk checkout files, which are files, not a cache; a commit's index,
 * versions, applied seq and cursor land in one transaction
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import {
  BlobRef,
  type BlobRefJSON,
} from "../../domain/datastore_v3/blob_ref.ts";
import type { LiveDataVersion } from "../../domain/datastore_v3/catalog_projection.ts";
import type { CatalogNameState } from "../../domain/datastore_v3/catalog_state.ts";
import type { CompactedBaseEntry } from "../../domain/datastore_v3/commit_store.ts";
import {
  type FileAccess,
  readFileAccess,
} from "../../domain/datastore_v3/file_access.ts";
import type { FileOwnership } from "../../domain/datastore_v3/materialisation.ts";
import { foldSpelling } from "./spelling_folding.ts";
import type {
  AtRiskCopy,
  LiveRecord,
  UnreadableRecord,
} from "../../domain/datastore_v3/read_model.ts";
import type { PutExpect } from "../../domain/datastore_v3/op.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";
import {
  addColumnsIfAbsent,
  runMigration,
  type SqliteMigration,
} from "./sqlite_migration.ts";
import { useWalJournal } from "./sqlite_wal.ts";

/**
 * migration i takes user_version i to i + 1; append new ones and never edit one
 * that has shipped
 */
const MIGRATIONS: readonly SqliteMigration[] = [
  `
  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE partition_progress (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    applied_seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE live_records (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    record_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    blob TEXT,
    PRIMARY KEY (namespace, partition, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX live_records_blobs ON live_records (namespace) WHERE blob IS NOT NULL;
  CREATE TABLE data_versions (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name, version)
  ) STRICT, WITHOUT ROWID;
  `,
  // files applied under schema 1 have no ownership, so clearing meta drops the
  // catalog generation and the next catch-up resets the state and replays every
  // commit
  `
  CREATE TABLE materialised_keys (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    mark INTEGER NOT NULL,
    present INTEGER NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  DELETE FROM meta;
  `,
  // a load stages the base here, then swaps it in in one transaction; only a
  // finished load clears the touched tables, so a retry against a newer base
  // reconciles them. IF NOT EXISTS: a rolled-back file may hold them
  `
  CREATE TABLE IF NOT EXISTS load_records (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    record_key TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    inline TEXT,
    blob TEXT,
    PRIMARY KEY (namespace, partition, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_versions (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name, version)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_catalog (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL,
    metadata TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name, version)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_forwards (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    renamed_to TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_files (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    owner TEXT NOT NULL,
    mark INTEGER NOT NULL,
    present INTEGER NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_progress (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    PRIMARY KEY (namespace, partition)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_touched_keys (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS load_touched_names (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    name TEXT NOT NULL,
    PRIMARY KEY (namespace, partition, name)
  ) STRICT, WITHOUT ROWID;
  `,
  `
  CREATE TABLE IF NOT EXISTS unsynced_keys (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS unsynced_boot (
    only INTEGER PRIMARY KEY CHECK (only = 0),
    boot TEXT NOT NULL
  ) STRICT;
  `,
  // records whose chunk was missing or damaged, checkout files moved aside as
  // the only copy of refused chunks, and written-file stats so the copy guard
  // need not hash a file still as written
  `
  CREATE TABLE IF NOT EXISTS unreadable_records (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    partition TEXT NOT NULL,
    seq INTEGER NOT NULL,
    position INTEGER NOT NULL,
    blob TEXT,
    chunk TEXT,
    chunk_size INTEGER,
    chunk_mtime INTEGER,
    reason TEXT NOT NULL,
    last_attempt INTEGER NOT NULL,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS at_risk_copies (
    namespace TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    record_key TEXT NOT NULL,
    blob TEXT,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_attempt INTEGER NOT NULL,
    PRIMARY KEY (namespace, sha256)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS written_files (
    namespace TEXT NOT NULL,
    record_key TEXT NOT NULL,
    blob TEXT NOT NULL,
    size INTEGER NOT NULL,
    ino INTEGER NOT NULL,
    dev INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    ctime INTEGER,
    PRIMARY KEY (namespace, record_key)
  ) STRICT, WITHOUT ROWID;
  `,
  // the filter inputs the projection was built with, in their own table never
  // cleared by a reset, so a changed filter is refused rather than silently
  // re-projected
  `
  CREATE TABLE IF NOT EXISTS checkout_filter (
    only INTEGER PRIMARY KEY CHECK (only = 0),
    inputs TEXT NOT NULL
  ) STRICT;
  `,
  // file access of each put, so a file written from state alone is executable
  // or private as its put says; NULL is a plain file
  addColumnsIfAbsent([
    { table: "live_records", column: "access", type: "TEXT" },
    { table: "load_records", column: "access", type: "TEXT" },
    { table: "unreadable_records", column: "access", type: "TEXT" },
  ]),
  // who wrote each live record: the forwarded commit's principal, or empty for
  // commits with none. NULL is unknown; serve trusts an evaluated file only
  // when its writer is known to be empty
  addColumnsIfAbsent([
    { table: "live_records", column: "writer", type: "TEXT" },
  ]),
  // the version of a managed-config record held before another writer's commit
  // replaced it, which a user's edit expects; NULL is none held. Never cleared
  // by a reset: it is what the user saw, not derived state
  `
  CREATE TABLE IF NOT EXISTS config_edit_bases (
    namespace TEXT NOT NULL,
    partition TEXT NOT NULL,
    record_key TEXT NOT NULL,
    sha256 TEXT,
    PRIMARY KEY (namespace, partition, record_key)
  ) STRICT, WITHOUT ROWID;
  `,
];

export type { FileOwnership };

export type UnsyncedFile =
  & { readonly namespace: string; readonly record_key: string }
  & (
    | {
      readonly expect: "present";
      readonly sha256: string;
      readonly owner: string;
      readonly mark: number;
      readonly blob?: BlobRef;
      readonly access?: FileAccess;
    }
    | { readonly expect: "absent" | "unknown" }
  );

/**
 * size and mtime of the chunk when last tried, undefined when absent or not
 * stat-able, so a retry runs only once the chunk changed
 */
export interface StoredUnreadableRecord extends UnreadableRecord {
  readonly chunkSize?: number;
  readonly chunkMtime?: number;
  readonly access?: FileAccess;
}

/**
 * the blob written and the stat taken just after, while the inode was still the
 * one written; a file whose stat still matches all of it is taken to hold the
 * blob
 */
export interface WrittenFile {
  readonly namespace: string;
  readonly recordKey: string;
  readonly blob: BlobRef;
  readonly size: number;
  readonly ino: number;
  readonly dev: number;
  readonly mtime: number;
  readonly ctime?: number;
}

export interface LoadKey {
  readonly namespace: string;
  readonly record_key: string;
}

export interface StagedFile extends LoadKey {
  readonly owner: string;
  readonly mark: number;
  readonly present: boolean;
}

export interface LoadName {
  readonly namespace: string;
  readonly partition: string;
  readonly name: string;
}

export const READ_MODEL_STATE_SCHEMA_VERSION = MIGRATIONS.length;

export interface AppliedRecord {
  readonly sha256: string;
  readonly blob?: BlobRef;
  readonly access?: FileAccess;
  /**
   * principal of the forwarded commit that put it, or empty for a commit with
   * none; absent is unknown, as for a row from before the column
   */
  readonly writer?: string;
}

export interface LiveRecordWriter {
  readonly sha256: string;
  readonly blob?: BlobRef;
  readonly writer: string | null;
}

export interface AppliedCommit {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  /**
   * The store-wide cursor to advance to, when applied by a catch-up; absent
   * when applied by a partition catch-up, which leaves the cursor alone.
   * The commit's feed position is known either way: see {@link files}.
   */
  readonly cursor?: number;
  readonly records: ReadonlyMap<string, AppliedRecord | null>;
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
  readonly files?: ReadonlyMap<string, FileOwnership>;
  /**
   * keys whose files were written or removed without a sync, and the boot;
   * recorded in the commit's transaction, so a commit is never applied without
   * them
   */
  readonly unsynced?: {
    readonly keys: ReadonlySet<string>;
    readonly boot: string;
  };
  /**
   * every key the commit decided to write or remove: its unreadable record is
   * forgotten unless `unreadable` records it again; a key left alone keeps its
   * row
   */
  readonly decided?: ReadonlySet<string>;
  readonly unreadable?: ReadonlyMap<string, StoredUnreadableRecord>;
}

export class ReadModelState {
  readonly #db: DatabaseSync;
  readonly #pid: number;
  readonly #selectMeta: StatementSync;
  readonly #upsertMeta: StatementSync;
  readonly #selectApplied: StatementSync;
  readonly #upsertApplied: StatementSync;
  readonly #upsertRecord: StatementSync;
  readonly #deleteRecord: StatementSync;
  readonly #selectRecords: StatementSync;
  readonly #selectRecord: StatementSync;
  readonly #selectAnyRecordIn: StatementSync;
  readonly #selectBlobs: StatementSync;
  readonly #selectVersions: StatementSync;
  readonly #deleteVersions: StatementSync;
  readonly #insertVersion: StatementSync;
  readonly #selectOwnership: StatementSync;
  readonly #upsertOwnership: StatementSync;
  readonly #insertUnsynced: StatementSync;
  readonly #upsertUnsyncedBoot: StatementSync;
  readonly #deleteUnreadable: StatementSync;
  readonly #upsertUnreadable: StatementSync;
  readonly #stageProgress: StatementSync;
  readonly #stageRecord: StatementSync;
  readonly #stageVersion: StatementSync;
  readonly #stageCatalogRow: StatementSync;
  readonly #stageForward: StatementSync;
  readonly #stageFile: StatementSync;
  #closed = false;
  #batchOpen = false;
  /**
   * keys with a present file by folded spelling, built from materialised_keys
   * on first use; recordApplied keeps it in step, anything else that rewrites
   * the table or rolls back drops it
   */
  #foldedKeys: Map<string, Set<string>> | undefined;

  private constructor(db: DatabaseSync, pid: number) {
    this.#db = db;
    this.#pid = pid;
    this.#selectMeta = db.prepare("SELECT value FROM meta WHERE key = ?");
    this.#upsertMeta = db.prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    );
    this.#selectApplied = db.prepare(
      "SELECT applied_seq FROM partition_progress WHERE namespace = ? AND partition = ?",
    );
    this.#upsertApplied = db.prepare(
      "INSERT INTO partition_progress (namespace, partition, applied_seq) VALUES (?, ?, ?) " +
        "ON CONFLICT (namespace, partition) DO UPDATE SET applied_seq = excluded.applied_seq",
    );
    this.#upsertRecord = db.prepare(
      "INSERT INTO live_records (namespace, partition, record_key, sha256, blob, access, writer) VALUES (?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, record_key) DO UPDATE SET sha256 = excluded.sha256, blob = excluded.blob, access = excluded.access, writer = excluded.writer",
    );
    this.#deleteRecord = db.prepare(
      "DELETE FROM live_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#selectRecords = db.prepare(
      "SELECT record_key, sha256, blob FROM live_records WHERE namespace = ? AND partition = ? ORDER BY record_key",
    );
    this.#selectRecord = db.prepare(
      "SELECT sha256, blob, writer FROM live_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#selectAnyRecordIn = db.prepare(
      "SELECT 1 FROM live_records WHERE namespace = ? AND partition >= ? AND partition < ? LIMIT 1",
    );
    this.#selectBlobs = db.prepare(
      "SELECT blob FROM live_records WHERE namespace = ? AND blob IS NOT NULL",
    );
    this.#selectVersions = db.prepare(
      "SELECT metadata FROM data_versions WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version",
    );
    this.#deleteVersions = db.prepare(
      "DELETE FROM data_versions WHERE namespace = ? AND partition = ? AND name = ?",
    );
    this.#insertVersion = db.prepare(
      "INSERT INTO data_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
    );
    this.#selectOwnership = db.prepare(
      "SELECT owner, mark, present FROM materialised_keys WHERE namespace = ? AND record_key = ?",
    );
    this.#upsertOwnership = db.prepare(
      "INSERT INTO materialised_keys (namespace, record_key, owner, mark, present) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, record_key) DO UPDATE SET owner = excluded.owner, mark = excluded.mark, present = excluded.present",
    );
    this.#insertUnsynced = db.prepare(
      "INSERT OR IGNORE INTO unsynced_keys (namespace, record_key) VALUES (?, ?)",
    );
    this.#upsertUnsyncedBoot = db.prepare(
      "INSERT INTO unsynced_boot (only, boot) VALUES (0, ?) ON CONFLICT (only) DO UPDATE SET boot = excluded.boot",
    );
    this.#deleteUnreadable = db.prepare(
      "DELETE FROM unreadable_records WHERE namespace = ? AND record_key = ?",
    );
    this.#upsertUnreadable = db.prepare(
      "INSERT OR REPLACE INTO unreadable_records (namespace, record_key, partition, seq, position, blob, chunk, chunk_size, chunk_mtime, reason, last_attempt, access) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stageProgress = db.prepare(
      "INSERT OR REPLACE INTO load_progress (namespace, partition, seq) VALUES (?, ?, ?)",
    );
    this.#stageRecord = db.prepare(
      "INSERT OR REPLACE INTO load_records (namespace, partition, record_key, sha256, inline, blob, access) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    this.#stageVersion = db.prepare(
      "INSERT OR REPLACE INTO load_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stageCatalogRow = db.prepare(
      "INSERT OR REPLACE INTO load_catalog (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
    );
    this.#stageForward = db.prepare(
      "INSERT OR REPLACE INTO load_forwards (namespace, partition, name, renamed_to) VALUES (?, ?, ?, ?)",
    );
    this.#stageFile = db.prepare(
      "INSERT OR REPLACE INTO load_files (namespace, record_key, owner, mark, present) VALUES (?, ?, ?, ?, ?)",
    );
  }

  /** `pid` is recorded when this connection clears the complete mark */
  static open(
    path: string,
    options: { readonly pid?: number } = {},
  ): ReadModelState {
    ensureDirSync(dirname(path));
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      useWalJournal(db);
      db.exec("PRAGMA synchronous=FULL");
      migrate(db);
      return new ReadModelState(db, options.pid ?? Deno.pid);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  cursor(): number {
    return this.#meta("cursor") ?? 0;
  }

  isComplete(): boolean {
    return this.#meta("complete") === 1;
  }

  /** undefined once complete, or when an older swamp cleared the mark */
  incompletePid(): number | undefined {
    if (this.isComplete()) return undefined;
    return this.#meta("incomplete_pid");
  }

  /**
   * Records that a catch-up reached the end of the change feed. The removal
   * candidates a reset kept, and any names an unfinished load touched, are
   * forgotten: the feed is applied, so no load is left to use them.
   */
  markComplete(): void {
    this.#transaction(() => {
      this.#upsertMeta.run("complete", 1);
      this.#db.exec("DELETE FROM meta WHERE key = 'incomplete_pid';");
      this.#db.exec(
        "DELETE FROM load_touched_keys; DELETE FROM load_touched_names;",
      );
    });
  }

  /**
   * set once a recovery has cleared the catalog and reset the state, until its
   * replay and sweep finish, so a recovery stopped part way resumes from the
   * cursor rather than clearing again
   */
  markRebuildStarted(): void {
    this.#upsertMeta.run("recovery_rebuild", 1);
  }

  rebuildInProgress(): boolean {
    return this.#meta("recovery_rebuild") === 1;
  }

  clearRebuild(): void {
    this.#db.exec("DELETE FROM meta WHERE key = 'recovery_rebuild';");
  }

  presentKeys(namespace: string): string[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT record_key FROM materialised_keys WHERE namespace = ? AND present = 1 ORDER BY record_key",
    ).all(namespace) as { record_key: string }[]).map((row) => row.record_key);
  }

  filterInputs(): string | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT inputs FROM checkout_filter WHERE only = 0",
    ).get() as { inputs: string } | undefined;
    return row?.inputs;
  }

  /**
   * records `inputs` when none are recorded and returns the recorded ones; a
   * reset never clears them
   */
  stampFilterInputs(inputs: string): string {
    let stored = inputs;
    this.#transaction(() => {
      this.#db.prepare(
        "INSERT OR IGNORE INTO checkout_filter (only, inputs) VALUES (0, ?)",
      ).run(inputs);
      stored = this.filterInputs() ?? inputs;
    });
    return stored;
  }

  catalogGeneration(): number | undefined {
    return this.#meta("catalog_generation");
  }

  /** the next lock section resets and replays every commit as the read model's own reset */
  markReplayPending(): void {
    this.#requireOpen();
    this.#upsertMeta.run("catalog_generation", REPLAY_PENDING);
  }

  appliedSeq(namespace: string, partition: string): number {
    this.#requireOpen();
    const row = this.#selectApplied.get(namespace, partition) as
      | { applied_seq: number }
      | undefined;
    return row?.applied_seq ?? 0;
  }

  liveVersions(
    namespace: string,
    partition: string,
    name: string,
  ): LiveDataVersion[] {
    this.#requireOpen();
    return (this.#selectVersions.all(namespace, partition, name) as {
      metadata: string;
    }[]).map((row) => {
      const metadata = DataMetadataSchema.parse(JSON.parse(row.metadata));
      return { version: metadata.version, metadata };
    });
  }

  fileOwnership(
    namespace: string,
    recordKey: string,
  ): FileOwnership | undefined {
    this.#requireOpen();
    const row = this.#selectOwnership.get(namespace, recordKey) as
      | { owner: string; mark: number; present: number }
      | undefined;
    return row === undefined
      ? undefined
      : { owner: row.owner, mark: row.mark, present: row.present === 1 };
  }

  liveRecords(namespace: string, partition: string): LiveRecord[] {
    this.#requireOpen();
    return (this.#selectRecords.all(namespace, partition) as {
      record_key: string;
      sha256: string;
      blob: string | null;
    }[]).map((row) => ({
      key: RecordKey.create(row.record_key),
      sha256: row.sha256,
      content: row.blob === null ? { kind: "inline" as const } : {
        kind: "blob" as const,
        blob: BlobRef.fromJSON(JSON.parse(row.blob)),
      },
    }));
  }

  /**
   * notes the digest `prior` a user's edit of `key` expects once another
   * writer's commit replaced it; an existing base is kept, since the user saw
   * neither later version
   */
  recordConfigBase(
    namespace: string,
    partition: string,
    key: string,
    prior: string | undefined,
  ): void {
    this.#requireOpen();
    this.#db.prepare(
      "INSERT OR IGNORE INTO config_edit_bases (namespace, partition, record_key, sha256) VALUES (?, ?, ?, ?)",
    ).run(namespace, partition, key, prior ?? null);
  }

  configBase(
    namespace: string,
    partition: string,
    key: string,
  ): PutExpect | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT sha256 FROM config_edit_bases WHERE namespace = ? AND partition = ? AND record_key = ?",
    ).get(namespace, partition, key) as { sha256: string | null } | undefined;
    if (row === undefined) return undefined;
    return row.sha256 === null ? "absent" : { sha256: row.sha256 };
  }

  configBases(
    namespace: string,
    partition: string,
  ): { readonly key: string; readonly base: PutExpect }[] {
    this.#requireOpen();
    const rows = this.#db.prepare(
      "SELECT record_key, sha256 FROM config_edit_bases WHERE namespace = ? AND partition = ? ORDER BY record_key",
    ).all(namespace, partition) as {
      record_key: string;
      sha256: string | null;
    }[];
    return rows.map((row) => ({
      key: row.record_key,
      base: row.sha256 === null ? "absent" : { sha256: row.sha256 },
    }));
  }

  clearConfigBases(namespace: string, partition: string, key?: string): void {
    this.#requireOpen();
    if (key === undefined) {
      this.#db.prepare(
        "DELETE FROM config_edit_bases WHERE namespace = ? AND partition = ?",
      ).run(namespace, partition);
    } else {
      this.#db.prepare(
        "DELETE FROM config_edit_bases WHERE namespace = ? AND partition = ? AND record_key = ?",
      ).run(namespace, partition, key);
    }
  }

  liveRecord(
    namespace: string,
    partition: string,
    key: string,
  ): LiveRecordWriter | undefined {
    this.#requireOpen();
    const row = this.#selectRecord.get(namespace, partition, key) as
      | { sha256: string; blob: string | null; writer: string | null }
      | undefined;
    if (row === undefined) return undefined;
    return {
      sha256: row.sha256,
      writer: row.writer,
      ...(row.blob === null
        ? {}
        : { blob: BlobRef.fromJSON(JSON.parse(row.blob)) }),
    };
  }

  /**
   * Whether any partition whose key starts with `prefix` holds a live
   * record: a range over the primary key, so it reads no more than one row.
   * A whole partition key is a prefix of itself.
   */
  holdsRecordsUnder(namespace: string, prefix: string): boolean {
    this.#requireOpen();
    // U+10FFFF sorts after every character a key can hold.
    return this.#selectAnyRecordIn.get(
      namespace,
      prefix,
      `${prefix}\u{10FFFF}`,
    ) !== undefined;
  }

  chunksInUse(namespace: string): Set<string> {
    this.#requireOpen();
    const chunks = new Set<string>();
    for (
      const row of this.#selectBlobs.all(namespace) as { blob: string }[]
    ) {
      const blob = JSON.parse(row.blob) as BlobRefJSON;
      if (blob.parts === undefined) chunks.add(blob.sha256);
      else for (const part of blob.parts) chunks.add(part.sha256);
    }
    return chunks;
  }

  /**
   * {@link liveRecords}, or undefined when the index is not complete. The
   * check and the read share one snapshot, so a reset another process commits
   * in between cannot hand back a partial index.
   */
  liveRecordsIfComplete(
    namespace: string,
    partition: string,
  ): LiveRecord[] | undefined {
    return this.#snapshot(() =>
      this.isComplete() ? this.liveRecords(namespace, partition) : undefined
    );
  }

  chunksInUseIfComplete(namespace: string): Set<string> | undefined {
    return this.#snapshot(() =>
      this.isComplete() ? this.chunksInUse(namespace) : undefined
    );
  }

  /**
   * one transaction; a commit at or below the partition's applied seq changes
   * nothing but the cursor, and neither the cursor nor the applied seq moves
   * back
   */
  recordApplied(commit: AppliedCommit): void {
    let ownershipChanged = false;
    this.#transaction(() => {
      const applied = this.appliedSeq(commit.namespace, commit.partition);
      if (commit.seq > applied) {
        for (const [key, record] of commit.records) {
          if (record === null) {
            this.#deleteRecord.run(commit.namespace, commit.partition, key);
          } else {
            this.#upsertRecord.run(
              commit.namespace,
              commit.partition,
              key,
              record.sha256,
              record.blob === undefined
                ? null
                : JSON.stringify(record.blob.toJSON()),
              record.access ?? null,
              record.writer ?? null,
            );
          }
        }
        for (const [name, versions] of commit.live) {
          this.#deleteVersions.run(commit.namespace, commit.partition, name);
          for (const { version, metadata } of versions) {
            this.#insertVersion.run(
              commit.namespace,
              commit.partition,
              name,
              version,
              JSON.stringify(metadata),
            );
          }
        }
        for (const [key, file] of commit.files ?? []) {
          ownershipChanged = true;
          this.#upsertOwnership.run(
            commit.namespace,
            key,
            file.owner,
            file.mark,
            file.present ? 1 : 0,
          );
        }
        for (const key of commit.decided ?? []) {
          this.#deleteUnreadable.run(commit.namespace, key);
        }
        for (const record of commit.unreadable?.values() ?? []) {
          this.#insertUnreadable(record);
        }
        this.#upsertApplied.run(commit.namespace, commit.partition, commit.seq);
        if (commit.unsynced !== undefined && commit.unsynced.keys.size > 0) {
          this.#markUnsynced(
            commit.namespace,
            commit.unsynced.keys,
            commit.unsynced.boot,
          );
        }
      }
      if (commit.cursor !== undefined) this.#advanceCursor(commit.cursor);
    });
    const folded = this.#foldedKeys;
    if (!ownershipChanged || folded === undefined) return;
    for (const [key, file] of commit.files ?? []) {
      const id = foldedId(commit.namespace, foldSpelling(key));
      const keys = folded.get(id) ?? new Set<string>();
      if (file.present) keys.add(key);
      else keys.delete(key);
      if (keys.size === 0) folded.delete(id);
      else folded.set(id, keys);
    }
  }

  presentKeysFoldedTo(namespace: string, folded: string): ReadonlySet<string> {
    this.#requireOpen();
    if (this.#foldedKeys === undefined) {
      const index = new Map<string, Set<string>>();
      const rows = this.#db.prepare(
        "SELECT namespace, record_key FROM materialised_keys WHERE present = 1",
      ).all() as { namespace: string; record_key: string }[];
      for (const row of rows) {
        const id = foldedId(row.namespace, foldSpelling(row.record_key));
        const keys = index.get(id) ?? new Set<string>();
        keys.add(row.record_key);
        index.set(id, keys);
      }
      this.#foldedKeys = index;
    }
    return this.#foldedKeys.get(foldedId(namespace, folded)) ?? NO_KEYS;
  }

  /**
   * Drops the index {@link presentKeysFoldedTo} reads, for a caller that
   * cannot tell whether another process changed the table since.
   */
  forgetFoldedKeys(): void {
    this.#foldedKeys = undefined;
  }

  recordSkipped(cursor: number): void {
    this.#transaction(() => this.#advanceCursor(cursor));
  }

  /**
   * clears every table but the at-risk copies; files shown present stay as
   * removal candidates so a later base load redoes a removal a crash undid.
   * Unsynced keys are candidates too with keepUnsynced
   */
  reset(catalogGeneration: number, keepUnsynced = false): void {
    this.#foldedKeys = undefined;
    this.#transaction(() => {
      this.#db.exec(
        "INSERT OR IGNORE INTO load_touched_keys (namespace, record_key) " +
          "SELECT namespace, record_key FROM materialised_keys WHERE present = 1;",
      );
      if (keepUnsynced) {
        this.#db.exec(
          "INSERT OR IGNORE INTO load_touched_keys (namespace, record_key) " +
            "SELECT namespace, record_key FROM unsynced_keys;",
        );
      }
      this.#db.exec(
        "DELETE FROM partition_progress; DELETE FROM live_records; DELETE FROM data_versions; DELETE FROM materialised_keys; DELETE FROM meta; DELETE FROM unsynced_keys; DELETE FROM unsynced_boot; DELETE FROM unreadable_records; DELETE FROM written_files;",
      );
      this.#upsertMeta.run("catalog_generation", catalogGeneration);
      this.#upsertMeta.run("incomplete_pid", this.#pid);
    });
  }

  /**
   * starts loading the compacted base: clears what an earlier attempt staged;
   * the touched files and names stay
   */
  beginLoad(): void {
    this.#transaction(() =>
      this.#db.exec(
        "DELETE FROM load_records; DELETE FROM load_versions; DELETE FROM load_catalog; " +
          "DELETE FROM load_forwards; DELETE FROM load_files; DELETE FROM load_progress;",
      )
    );
  }

  stageBase(entries: readonly CompactedBaseEntry[]): void {
    this.#transaction(() => {
      for (const entry of entries) {
        switch (entry.kind) {
          case "partition":
            this.#stageProgress.run(
              entry.namespace,
              entry.partition,
              entry.seq,
            );
            break;
          case "record": {
            const content = entry.record.content;
            this.#stageRecord.run(
              entry.namespace,
              entry.partition,
              entry.key,
              entry.record.sha256,
              "inline" in content ? content.inline : null,
              "blob" in content ? JSON.stringify(content.blob.toJSON()) : null,
              entry.record.access ?? null,
            );
            break;
          }
          case "version":
            this.#stageVersion.run(
              entry.namespace,
              entry.partition,
              entry.version.metadata.name,
              entry.version.version,
              JSON.stringify(entry.version.metadata),
            );
            break;
          case "catalog-row":
            this.#stageCatalogRow.run(
              entry.namespace,
              entry.partition,
              entry.metadata.name,
              entry.metadata.version,
              JSON.stringify(entry.metadata),
            );
            break;
          case "forward":
            this.#stageForward.run(
              entry.namespace,
              entry.partition,
              entry.name,
              entry.to,
            );
            break;
          case "file":
            this.#stageFile.run(
              entry.namespace,
              entry.key,
              entry.ownership.owner,
              entry.ownership.mark,
              entry.ownership.present ? 1 : 0,
            );
            break;
        }
      }
    });
  }

  /**
   * The files a load removes: those the state shows present, or an earlier
   * attempt touched, that the staged base does not show present.
   */
  loadRemovals(): LoadKey[] {
    this.#requireOpen();
    return this.#db.prepare(
      "SELECT namespace, record_key FROM materialised_keys WHERE present = 1 " +
        "UNION SELECT namespace, record_key FROM load_touched_keys " +
        "EXCEPT SELECT namespace, record_key FROM load_files WHERE present = 1 " +
        "ORDER BY 1, 2",
    ).all() as unknown as LoadKey[];
  }

  /**
   * The files a load writes: those the staged base shows present, unless
   * the state already shows the same put there and no earlier attempt
   * touched them.
   */
  loadWrites(): LoadKey[] {
    this.#requireOpen();
    return this.#db.prepare(
      "SELECT f.namespace, f.record_key FROM load_files AS f WHERE f.present = 1 AND (" +
        "NOT EXISTS (SELECT 1 FROM materialised_keys AS m WHERE m.namespace = f.namespace " +
        "AND m.record_key = f.record_key AND m.present = 1 AND m.owner = f.owner AND m.mark = f.mark) " +
        "OR EXISTS (SELECT 1 FROM load_touched_keys AS t WHERE t.namespace = f.namespace " +
        "AND t.record_key = f.record_key)) ORDER BY 1, 2",
    ).all() as unknown as LoadKey[];
  }

  loadContent(
    namespace: string,
    recordKey: string,
  ): RecordContent | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT r.inline, r.blob, r.access FROM load_files AS f JOIN load_records AS r " +
        "ON r.namespace = f.namespace AND r.partition = f.owner AND r.record_key = f.record_key " +
        "WHERE f.namespace = ? AND f.record_key = ?",
    ).get(namespace, recordKey) as
      | { inline: string | null; blob: string | null; access: string | null }
      | undefined;
    if (row === undefined) return undefined;
    const access = accessOf(row.access);
    if (row.blob !== null) {
      return { blob: BlobRef.fromJSON(JSON.parse(row.blob)), ...access };
    }
    return row.inline === null ? undefined : { inline: row.inline, ...access };
  }

  stagedFiles(): StagedFile[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT namespace, record_key, owner, mark, present FROM load_files ORDER BY 1, 2",
    ).all() as {
      namespace: string;
      record_key: string;
      owner: string;
      mark: number;
      present: number;
    }[]).map((row) => ({ ...row, present: row.present === 1 }));
  }

  loadFile(namespace: string, recordKey: string): FileOwnership | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT owner, mark, present FROM load_files WHERE namespace = ? AND record_key = ?",
    ).get(namespace, recordKey) as
      | { owner: string; mark: number; present: number }
      | undefined;
    return row === undefined
      ? undefined
      : { owner: row.owner, mark: row.mark, present: row.present === 1 };
  }

  /**
   * Forgets the staged ownership of a file the load left alone because its
   * path is refused, as a replay records none for it.
   */
  dropLoadFile(namespace: string, recordKey: string): void {
    this.#transaction(() => {
      this.#db.prepare(
        "DELETE FROM load_files WHERE namespace = ? AND record_key = ?",
      ).run(namespace, recordKey);
    });
  }

  /** Records files a load is about to write or remove, durably, first. */
  touchKeys(keys: readonly LoadKey[]): void {
    this.#transaction(() => {
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO load_touched_keys (namespace, record_key) VALUES (?, ?)",
      );
      for (const key of keys) insert.run(key.namespace, key.record_key);
    });
  }

  loadCatalogNames(): LoadName[] {
    this.#requireOpen();
    return this.#db.prepare(
      "SELECT namespace, partition, name FROM data_versions " +
        "UNION SELECT namespace, partition, name FROM load_versions " +
        "UNION SELECT namespace, partition, name FROM load_catalog " +
        "UNION SELECT namespace, partition, name FROM load_forwards " +
        "UNION SELECT namespace, partition, name FROM load_touched_names " +
        "ORDER BY 1, 2, 3",
    ).all() as unknown as LoadName[];
  }

  touchNames(names: readonly LoadName[]): void {
    this.#transaction(() => {
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO load_touched_names (namespace, partition, name) VALUES (?, ?, ?)",
      );
      for (const n of names) insert.run(n.namespace, n.partition, n.name);
    });
  }

  loadCatalogName(name: LoadName): CatalogNameState {
    this.#requireOpen();
    const rows = (this.#db.prepare(
      "SELECT metadata FROM load_catalog WHERE namespace = ? AND partition = ? AND name = ? ORDER BY version",
    ).all(name.namespace, name.partition, name.name) as {
      metadata: string;
    }[]).map((row) => DataMetadataSchema.parse(JSON.parse(row.metadata)));
    const forward = this.#db.prepare(
      "SELECT renamed_to FROM load_forwards WHERE namespace = ? AND partition = ? AND name = ?",
    ).get(name.namespace, name.partition, name.name) as
      | { renamed_to: string }
      | undefined;
    return { rows, forward: forward?.renamed_to };
  }

  /**
   * swaps the staged base in one transaction and marks the index incomplete
   * until a catch-up reaches the feed end; unsynced keys are listed with the
   * boot, as a commit's are, so a later boot checks them
   */
  finishLoad(
    point: number,
    unreadable: readonly StoredUnreadableRecord[] = [],
    unsynced?: {
      readonly keys: readonly {
        readonly namespace: string;
        readonly record_key: string;
      }[];
      readonly boot: string;
    },
  ): void {
    this.#foldedKeys = undefined;
    this.#transaction(() => {
      this.#db.exec(`
        DELETE FROM live_records;
        INSERT INTO live_records (namespace, partition, record_key, sha256, blob, access)
          SELECT namespace, partition, record_key, sha256, blob, access FROM load_records;
        DELETE FROM data_versions;
        INSERT INTO data_versions (namespace, partition, name, version, metadata)
          SELECT namespace, partition, name, version, metadata FROM load_versions;
        DELETE FROM materialised_keys;
        INSERT INTO materialised_keys (namespace, record_key, owner, mark, present)
          SELECT namespace, record_key, owner, mark, present FROM load_files;
        DELETE FROM partition_progress;
        INSERT INTO partition_progress (namespace, partition, applied_seq)
          SELECT namespace, partition, seq FROM load_progress;
        DELETE FROM meta WHERE key = 'complete';
        DELETE FROM load_records; DELETE FROM load_versions; DELETE FROM load_catalog;
        DELETE FROM load_forwards; DELETE FROM load_files; DELETE FROM load_progress;
        DELETE FROM load_touched_keys; DELETE FROM load_touched_names;
        DELETE FROM unreadable_records WHERE NOT EXISTS (
          SELECT 1 FROM materialised_keys AS m
          WHERE m.namespace = unreadable_records.namespace
          AND m.record_key = unreadable_records.record_key
          AND m.owner = unreadable_records.partition
          AND m.mark = unreadable_records.position AND m.present = 1);
      `);
      for (const record of unreadable) this.#insertUnreadable(record);
      if (unsynced !== undefined && unsynced.keys.length > 0) {
        for (const { namespace, record_key } of unsynced.keys) {
          this.#insertUnsynced.run(namespace, record_key);
        }
        this.#upsertUnsyncedBoot.run(unsynced.boot);
      }
      this.#upsertMeta.run("cursor", point);
      this.#upsertMeta.run("incomplete_pid", this.#pid);
    });
  }

  /**
   * Opens a batch: until {@link commitBatch}, every change is a savepoint in
   * one transaction, visible to this connection and durable to no one.
   */
  beginBatch(): void {
    this.#requireOpen();
    if (this.#batchOpen) throw new Error("A read model state batch is open");
    this.#db.exec("BEGIN IMMEDIATE");
    this.#batchOpen = true;
  }

  commitBatch(): void {
    this.#requireOpen();
    this.#db.exec("COMMIT");
    this.#batchOpen = false;
  }

  rollbackBatch(): void {
    if (!this.#batchOpen) return;
    this.#batchOpen = false;
    this.#foldedKeys = undefined;
    rollbackQuietly(this.#db);
  }

  unsyncedBoot(): string | undefined {
    this.#requireOpen();
    const row = this.#db.prepare("SELECT boot FROM unsynced_boot").get() as
      | { boot: string }
      | undefined;
    return row?.boot;
  }

  unsyncedFiles(): UnsyncedFile[] {
    return this.#snapshot(() => this.#expectedFilesOf("unsynced_keys"));
  }

  /** what each key's file should hold, judged as unsyncedFiles judges them */
  expectedFiles(
    keys: readonly {
      readonly namespace: string;
      readonly record_key: string;
    }[],
  ): UnsyncedFile[] {
    return this.#snapshot(() => {
      this.#db.exec(
        "CREATE TEMP TABLE IF NOT EXISTS checked_keys (namespace TEXT NOT NULL, record_key TEXT NOT NULL, PRIMARY KEY (namespace, record_key)) WITHOUT ROWID; DELETE FROM checked_keys;",
      );
      try {
        const insert = this.#db.prepare(
          "INSERT OR IGNORE INTO checked_keys (namespace, record_key) VALUES (?, ?)",
        );
        for (const key of keys) insert.run(key.namespace, key.record_key);
        return this.#expectedFilesOf("temp.checked_keys");
      } finally {
        this.#db.exec("DELETE FROM checked_keys;");
      }
    });
  }

  #expectedFilesOf(table: string): UnsyncedFile[] {
    const rows = this.#db.prepare(`
        SELECT u.namespace, u.record_key, m.present, m.owner, m.mark,
          r.sha256, r.blob, r.access, x.record_key AS unreadable
        FROM ${table} u
        LEFT JOIN materialised_keys m
          ON m.namespace = u.namespace AND m.record_key = u.record_key
        LEFT JOIN live_records r
          ON r.namespace = u.namespace AND r.partition = m.owner
          AND r.record_key = u.record_key
        LEFT JOIN unreadable_records x
          ON x.namespace = u.namespace AND x.record_key = u.record_key
        ORDER BY u.namespace, u.record_key
      `).all() as unknown as {
      namespace: string;
      record_key: string;
      present: number | null;
      owner: string | null;
      mark: number | null;
      sha256: string | null;
      blob: string | null;
      access: string | null;
      unreadable: string | null;
    }[];
    return rows.map((row): UnsyncedFile => {
      const { namespace, record_key } = row;
      if (row.present !== 1 || row.unreadable !== null) {
        return { namespace, record_key, expect: "absent" };
      }
      if (row.sha256 === null) {
        return { namespace, record_key, expect: "unknown" };
      }
      return {
        namespace,
        record_key,
        expect: "present",
        sha256: row.sha256,
        owner: row.owner!,
        mark: row.mark!,
        ...(row.blob === null
          ? {}
          : { blob: BlobRef.fromJSON(JSON.parse(row.blob)) }),
        ...accessOf(row.access),
      };
    });
  }

  unreadableRecord(
    namespace: string,
    recordKey: string,
  ): StoredUnreadableRecord | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT * FROM unreadable_records WHERE namespace = ? AND record_key = ?",
    ).get(namespace, recordKey) as UnreadableRow | undefined;
    return row === undefined ? undefined : unreadableOf(row);
  }

  /**
   * unreadable records of namespace whose key is under keyPrefix, in key order:
   * one range scan of the primary key; / sorts just before 0, so keys run from
   * <keyPrefix>/ up to <keyPrefix>0
   */
  unreadableRecordsUnder(
    namespace: string,
    keyPrefix: string,
  ): StoredUnreadableRecord[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT * FROM unreadable_records WHERE namespace = ? AND record_key >= ? AND record_key < ? ORDER BY record_key",
    ).all(
      namespace,
      `${keyPrefix}/`,
      `${keyPrefix}0`,
    ) as unknown as UnreadableRow[]).map(unreadableOf);
  }

  unreadableDue(limit: number): StoredUnreadableRecord[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT * FROM unreadable_records ORDER BY last_attempt, namespace, record_key LIMIT ?",
    ).all(limit) as unknown as UnreadableRow[]).map(unreadableOf);
  }

  noteUnreadableAttempts(records: readonly StoredUnreadableRecord[]): void {
    if (records.length === 0) return;
    this.#transaction(() => {
      for (const record of records) this.#insertUnreadable(record);
    });
  }

  forgetUnreadable(namespace: string, recordKey: string): void {
    this.#transaction(() => this.#deleteUnreadable.run(namespace, recordKey));
  }

  clearUnreadable(
    namespace: string,
    recordKey: string,
    boot: string | undefined,
  ): void {
    this.#transaction(() => {
      this.#deleteUnreadable.run(namespace, recordKey);
      if (boot !== undefined) this.#markUnsynced(namespace, [recordKey], boot);
    });
  }

  recordAtRiskCopy(copy: StoredAtRiskCopy): void {
    this.#transaction(() => {
      this.#db.prepare(
        "INSERT OR IGNORE INTO at_risk_copies (namespace, sha256, record_key, blob, size, created_at, last_attempt) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        copy.namespace,
        copy.sha256,
        copy.recordKey,
        copy.blob === undefined ? null : JSON.stringify(copy.blob.toJSON()),
        copy.size,
        copy.createdAt.getTime(),
        copy.lastAttempt.getTime(),
      );
    });
  }

  hasAtRiskCopy(namespace: string, sha256: string): boolean {
    this.#requireOpen();
    return this.#db.prepare(
      "SELECT 1 FROM at_risk_copies WHERE namespace = ? AND sha256 = ?",
    ).get(namespace, sha256) !== undefined;
  }

  atRiskDue(limit: number, triedBy: number): StoredAtRiskCopy[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT * FROM at_risk_copies WHERE last_attempt <= ? ORDER BY last_attempt, namespace, sha256 LIMIT ?",
    ).all(triedBy, limit) as unknown as AtRiskRow[]).map(atRiskOf);
  }

  atRiskBytes(): number {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT coalesce(sum(size), 0) AS n FROM at_risk_copies",
    ).get() as { n: number }).n;
  }

  noteAtRiskAttempt(namespace: string, sha256: string, at: number): void {
    this.#transaction(() => {
      this.#db.prepare(
        "UPDATE at_risk_copies SET last_attempt = ? WHERE namespace = ? AND sha256 = ?",
      ).run(at, namespace, sha256);
    });
  }

  deleteAtRiskCopy(namespace: string, sha256: string): void {
    this.#transaction(() => {
      this.#db.prepare(
        "DELETE FROM at_risk_copies WHERE namespace = ? AND sha256 = ?",
      ).run(namespace, sha256);
    });
  }

  unsyncedKeys(limit: number): { namespace: string; record_key: string }[] {
    return this.#snapshot(() =>
      this.#db.prepare(
        "SELECT namespace, record_key FROM unsynced_keys ORDER BY namespace, record_key LIMIT ?",
      ).all(limit) as unknown as { namespace: string; record_key: string }[]
    );
  }

  forgetUnsynced(
    keys: readonly { namespace: string; record_key: string }[],
  ): void {
    this.#transaction(() => {
      const remove = this.#db.prepare(
        "DELETE FROM unsynced_keys WHERE namespace = ? AND record_key = ?",
      );
      for (const key of keys) remove.run(key.namespace, key.record_key);
      const left = this.#db.prepare("SELECT count(*) AS n FROM unsynced_keys")
        .get() as { n: number };
      if (left.n === 0) this.#db.exec("DELETE FROM unsynced_boot;");
    });
  }

  clearUnsynced(): void {
    this.#transaction(() =>
      this.#db.exec("DELETE FROM unsynced_keys; DELETE FROM unsynced_boot;")
    );
  }

  recordWrittenFile(file: WrittenFile): void {
    this.#transaction(() =>
      this.#db.prepare(
        "INSERT OR REPLACE INTO written_files (namespace, record_key, blob, size, ino, dev, mtime, ctime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        file.namespace,
        file.recordKey,
        JSON.stringify(file.blob.toJSON()),
        file.size,
        file.ino,
        file.dev,
        file.mtime,
        file.ctime ?? null,
      )
    );
  }

  writtenFile(namespace: string, recordKey: string): WrittenFile | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT blob, size, ino, dev, mtime, ctime FROM written_files WHERE namespace = ? AND record_key = ?",
    ).get(namespace, recordKey) as
      | {
        blob: string;
        size: number;
        ino: number;
        dev: number;
        mtime: number;
        ctime: number | null;
      }
      | undefined;
    if (row === undefined) return undefined;
    return {
      namespace,
      recordKey,
      blob: BlobRef.fromJSON(JSON.parse(row.blob)),
      size: row.size,
      ino: row.ino,
      dev: row.dev,
      mtime: row.mtime,
      ...(row.ctime === null ? {} : { ctime: row.ctime }),
    };
  }

  forgetWrittenFile(namespace: string, recordKey: string): void {
    this.#transaction(() =>
      this.#db.prepare(
        "DELETE FROM written_files WHERE namespace = ? AND record_key = ?",
      ).run(namespace, recordKey)
    );
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  /**
   * Records keys whose files were written or removed without a sync, in
   * `boot`, inside the caller's transaction. One boot is kept: the read
   * model checks and clears the list before it writes in a new boot.
   */
  #markUnsynced(
    namespace: string,
    keys: Iterable<string>,
    boot: string,
  ): void {
    for (const key of keys) this.#insertUnsynced.run(namespace, key);
    this.#upsertUnsyncedBoot.run(boot);
  }

  #insertUnreadable(record: StoredUnreadableRecord): void {
    this.#upsertUnreadable.run(
      record.namespace,
      record.recordKey,
      record.partition,
      record.seq,
      record.position,
      record.blob === undefined ? null : JSON.stringify(record.blob.toJSON()),
      record.chunk ?? null,
      record.chunkSize ?? null,
      record.chunkMtime ?? null,
      record.reason,
      record.lastAttempt.getTime(),
      record.access ?? null,
    );
  }

  #advanceCursor(cursor: number): void {
    if (cursor > this.cursor()) this.#upsertMeta.run("cursor", cursor);
  }

  #meta(key: string): number | undefined {
    this.#requireOpen();
    const row = this.#selectMeta.get(key) as { value: number } | undefined;
    return row?.value;
  }

  /**
   * Runs reads in one read transaction. A deferred `BEGIN` in WAL takes its
   * snapshot at the first read, and every later read sees the same one.
   */
  #snapshot<T>(body: () => T): T {
    this.#requireOpen();
    // In a batch every read already sees one state: the batch's own.
    if (this.#batchOpen) return body();
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

  #transaction(body: () => void): void {
    this.#requireOpen();
    if (this.#batchOpen) {
      this.#db.exec("SAVEPOINT state_change");
      try {
        body();
        this.#db.exec("RELEASE state_change");
      } catch (error) {
        try {
          this.#db.exec("ROLLBACK TO state_change");
          this.#db.exec("RELEASE state_change");
        } catch {
          this.#foldedKeys = undefined;
          // SQLite rolled the whole transaction back itself (a full disk,
          // an I/O error), or the savepoint cannot be undone. Roll back
          // everything, so the batch cannot commit half of this change:
          // its commitBatch then fails, and the cause is still `error`.
          rollbackQuietly(this.#db);
        }
        throw error;
      }
      return;
    }
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      body();
      this.#db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(this.#db);
      throw error;
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new Error("The read model state is closed");
  }
}

/** never a catalog's generation, which starts at 0 and only grows */
export const REPLAY_PENDING = -1;

function migrate(db: DatabaseSync): void {
  const read = () =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  const check = (version: number) => {
    if (version > READ_MODEL_STATE_SCHEMA_VERSION) {
      throw new Error(
        `_read_model_v3.db is at schema version ${version}, newer than this swamp's ${READ_MODEL_STATE_SCHEMA_VERSION}: upgrade swamp`,
      );
    }
  };
  check(read());
  if (read() === READ_MODEL_STATE_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = read();
    check(version);
    for (let next = version; next < READ_MODEL_STATE_SCHEMA_VERSION; next++) {
      runMigration(db, MIGRATIONS[next]);
    }
    db.exec(`PRAGMA user_version=${READ_MODEL_STATE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  }
}

export interface StoredAtRiskCopy extends AtRiskCopy {
  readonly blob?: BlobRef;
}

interface UnreadableRow {
  namespace: string;
  record_key: string;
  partition: string;
  seq: number;
  position: number;
  blob: string | null;
  chunk: string | null;
  chunk_size: number | null;
  chunk_mtime: number | null;
  reason: string;
  last_attempt: number;
  access: string | null;
}

function unreadableOf(row: UnreadableRow): StoredUnreadableRecord {
  return {
    namespace: row.namespace,
    recordKey: row.record_key,
    partition: row.partition,
    seq: row.seq,
    position: row.position,
    ...(row.blob === null
      ? {}
      : { blob: BlobRef.fromJSON(JSON.parse(row.blob)) }),
    ...(row.chunk === null ? {} : { chunk: row.chunk }),
    ...(row.chunk_size === null ? {} : { chunkSize: row.chunk_size }),
    ...(row.chunk_mtime === null ? {} : { chunkMtime: row.chunk_mtime }),
    reason: row.reason === "damaged" ? "damaged" : "missing",
    lastAttempt: new Date(row.last_attempt),
    ...accessOf(row.access),
  };
}

export type RecordContent =
  & ({ readonly blob: BlobRef } | { readonly inline: string })
  & { readonly access?: FileAccess };

function accessOf(
  column: string | null,
): { readonly access?: FileAccess } {
  const access = readFileAccess(column ?? undefined);
  return access === undefined ? {} : { access };
}

interface AtRiskRow {
  namespace: string;
  sha256: string;
  record_key: string;
  blob: string | null;
  size: number;
  created_at: number;
  last_attempt: number;
}

function atRiskOf(row: AtRiskRow): StoredAtRiskCopy {
  return {
    namespace: row.namespace,
    sha256: row.sha256,
    recordKey: row.record_key,
    ...(row.blob === null
      ? {}
      : { blob: BlobRef.fromJSON(JSON.parse(row.blob)) }),
    size: row.size,
    createdAt: new Date(row.created_at),
    lastAttempt: new Date(row.last_attempt),
  };
}

const NO_KEYS: ReadonlySet<string> = new Set();

function foldedId(namespace: string, folded: string): string {
  return `${namespace}\0${folded}`;
}

function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The caller rethrows the original error.
  }
}
