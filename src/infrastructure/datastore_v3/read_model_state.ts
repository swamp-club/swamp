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
 * The v3 read model's own state (swamp-club#3239), in `_read_model_v3.db`:
 * the store-wide cursor, each partition's last applied seq, the live-record
 * index and each data name's live versions. All of it is rebuilt from the
 * commits, so {@link ReadModelState.reset} can always start over.
 *
 * A commit's index and version changes land with its applied seq and the
 * cursor in one transaction, so the index is never ahead of, or behind, the
 * cursor. The cursor and every applied seq only move forward.
 *
 * Opened like `commits.db`: WAL, `synchronous=FULL`, a busy timeout, schema
 * migrations in `PRAGMA user_version`, and SQLite's default auto-checkpoint.
 *
 * @module
 */

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import {
  BlobRef,
  type BlobRefJSON,
} from "../../domain/datastore_v3/blob_ref.ts";
import type { LiveDataVersion } from "../../domain/datastore_v3/catalog_projection.ts";
import type { LiveRecord } from "../../domain/datastore_v3/read_model.ts";
import { RecordKey } from "../../domain/datastore_v3/record_key.ts";
import { DataMetadataSchema } from "../../domain/data/data_metadata.ts";

/**
 * The schema migrations, in order: migration `i` takes `PRAGMA user_version`
 * `i` to `i + 1`. Append new ones; never edit one that has shipped.
 */
const MIGRATIONS: readonly string[] = [
  // 0 → 1: cursor, partition progress, live records and live data versions.
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
];

/** The schema version this state store writes. */
export const READ_MODEL_STATE_SCHEMA_VERSION = MIGRATIONS.length;

/** A record a commit leaves present: its digest, and its blob when not inline. */
export interface AppliedRecord {
  readonly sha256: string;
  readonly blob?: BlobRef;
}

/** What one applied commit changes in the state. */
export interface AppliedCommit {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  /**
   * The store-wide cursor of the change, when applied by a catch-up; absent
   * when applied by a partition catch-up, which leaves the cursor alone.
   */
  readonly cursor?: number;
  /** Each key the commit touched: present with its content, or null when removed. */
  readonly records: ReadonlyMap<string, AppliedRecord | null>;
  /** Each data name the commit changed, with its live versions after it. */
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
}

/** The read model's state database. One connection per instance. */
export class ReadModelState {
  readonly #db: DatabaseSync;
  readonly #selectMeta: StatementSync;
  readonly #upsertMeta: StatementSync;
  readonly #selectApplied: StatementSync;
  readonly #upsertApplied: StatementSync;
  readonly #upsertRecord: StatementSync;
  readonly #deleteRecord: StatementSync;
  readonly #selectRecords: StatementSync;
  readonly #selectBlobs: StatementSync;
  readonly #selectVersions: StatementSync;
  readonly #deleteVersions: StatementSync;
  readonly #insertVersion: StatementSync;
  #closed = false;

  private constructor(db: DatabaseSync) {
    this.#db = db;
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
      "INSERT INTO live_records (namespace, partition, record_key, sha256, blob) VALUES (?, ?, ?, ?, ?) " +
        "ON CONFLICT (namespace, partition, record_key) DO UPDATE SET sha256 = excluded.sha256, blob = excluded.blob",
    );
    this.#deleteRecord = db.prepare(
      "DELETE FROM live_records WHERE namespace = ? AND partition = ? AND record_key = ?",
    );
    this.#selectRecords = db.prepare(
      "SELECT record_key, sha256, blob FROM live_records WHERE namespace = ? AND partition = ? ORDER BY record_key",
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
  }

  /**
   * Opens the state at `path`, creating the file and its schema when absent.
   * Refuses a database written by a newer schema.
   */
  static open(path: string): ReadModelState {
    ensureDirSync(dirname(path));
    const db = new DatabaseSync(path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      const mode = db.prepare("PRAGMA journal_mode").get() as
        | { journal_mode: string }
        | undefined;
      if (mode?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
      db.exec("PRAGMA synchronous=FULL");
      migrate(db);
      return new ReadModelState(db);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** The store-wide cursor: the last change applied or skipped; 0 at first. */
  cursor(): number {
    return this.#meta("cursor") ?? 0;
  }

  /**
   * True once a catch-up has reached the end of the change feed since the
   * last reset, so the index holds every live record up to the cursor.
   */
  isComplete(): boolean {
    return this.#meta("complete") === 1;
  }

  /** Records that a catch-up reached the end of the change feed. */
  markComplete(): void {
    this.#transaction(() => this.#upsertMeta.run("complete", 1));
  }

  /** The catalog generation the state was built against, if any. */
  catalogGeneration(): number | undefined {
    return this.#meta("catalog_generation");
  }

  /** The last seq of a partition this read model applied; 0 for none. */
  appliedSeq(namespace: string, partition: string): number {
    this.#requireOpen();
    const row = this.#selectApplied.get(namespace, partition) as
      | { applied_seq: number }
      | undefined;
    return row?.applied_seq ?? 0;
  }

  /** A data name's live versions, in ascending order. */
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

  /** The records present in a partition, by key. */
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

  /** Every chunk a live blob names in a namespace, parts expanded. */
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

  /** {@link chunksInUse}, or undefined when the index is not complete; one snapshot. */
  chunksInUseIfComplete(namespace: string): Set<string> | undefined {
    return this.#snapshot(() =>
      this.isComplete() ? this.chunksInUse(namespace) : undefined
    );
  }

  /**
   * Records an applied commit in one transaction: its records, its live data
   * versions, the partition's applied seq and, from a catch-up, the cursor. A
   * commit at or below the partition's applied seq changes nothing but the
   * cursor; neither the cursor nor the applied seq moves back.
   */
  recordApplied(commit: AppliedCommit): void {
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
        this.#upsertApplied.run(commit.namespace, commit.partition, commit.seq);
      }
      if (commit.cursor !== undefined) this.#advanceCursor(commit.cursor);
    });
  }

  /** Moves the cursor past a change applied earlier by a partition catch-up. */
  recordSkipped(cursor: number): void {
    this.#transaction(() => this.#advanceCursor(cursor));
  }

  /**
   * Clears every table back to cursor 0, and the complete mark, and records
   * the catalog generation the replay that follows builds against.
   */
  reset(catalogGeneration: number): void {
    this.#transaction(() => {
      this.#db.exec(
        "DELETE FROM partition_progress; DELETE FROM live_records; DELETE FROM data_versions; DELETE FROM meta;",
      );
      this.#upsertMeta.run("catalog_generation", catalogGeneration);
    });
  }

  /** Closes the connection. Closing again does nothing. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
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

/**
 * Brings the schema to {@link READ_MODEL_STATE_SCHEMA_VERSION} in one
 * transaction, refusing a database from a newer schema.
 */
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
      db.exec(MIGRATIONS[next]);
    }
    db.exec(`PRAGMA user_version=${READ_MODEL_STATE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    rollbackQuietly(db);
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
