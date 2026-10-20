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
 * index, each data name's live versions and which put each materialised file
 * shows. All of it is rebuilt from the
 * commits, so {@link ReadModelState.reset} can always start over. It also
 * keeps the records whose content could not be read, and the checkout files
 * moved aside into `at-risk/` (swamp-club#3617); a reset keeps the latter,
 * which are files rather than a cache of the commits.
 *
 * A commit's index and version changes land with its applied seq and the
 * cursor in one transaction, so the index is never ahead of, or behind, the
 * cursor. The cursor and every applied seq only move forward. A batch
 * (swamp-club#3337) holds a page of such transactions, each a savepoint, and
 * makes them durable together: the read model commits it only once the
 * page's files are durable.
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
import type { CatalogNameState } from "../../domain/datastore_v3/catalog_state.ts";
import type { CompactedBaseEntry } from "../../domain/datastore_v3/commit_store.ts";
import type { FileOwnership } from "../../domain/datastore_v3/materialisation.ts";
import type {
  AtRiskCopy,
  LiveRecord,
  UnreadableRecord,
} from "../../domain/datastore_v3/read_model.ts";
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
  // 1 → 2: which partition's put each materialised file shows
  // (swamp-club#3256). Files applied under schema 1 have no ownership, so
  // clearing meta drops the catalog generation and the next catch-up resets
  // the state and replays every commit.
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
  // 2 → 3: loading the compacted base (swamp-club#3258). A load stages the
  // base here, then swaps it in with one transaction. The touched tables
  // name the files and catalog names an unfinished load may have written;
  // only a finished load clears them, so a retry against a newer base still
  // reconciles them. IF NOT EXISTS: a file rolled back to an older schema
  // by hand may still hold them.
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
  // 3 → 4: the files a catch-up wrote or removed without syncing them, and
  // the boot they were written in (swamp-club#3337). They are checked on
  // the first open in a later boot. IF NOT EXISTS, as in 2 → 3.
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
  // 4 → 5 (swamp-club#3617): records whose content a missing or damaged
  // chunk kept from being materialised, checkout files moved aside because
  // they held the only copy of chunks the storage refused, and the files the
  // read model wrote with their blob and how they looked just after, so the
  // checkout-copy guard need not hash a file still as written. IF NOT
  // EXISTS, as in 2 → 3.
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
];

export type { FileOwnership };

/**
 * A file a catch-up wrote or removed without syncing it, and what the state
 * says it holds: the bytes' SHA-256 when present, null when absent. A file
 * the state says is present but has no live record for is `unknown`.
 */
export type UnsyncedFile =
  & { readonly namespace: string; readonly record_key: string }
  & (
    | {
      readonly expect: "present";
      readonly sha256: string;
      /** Which put the file shows: its partition and feed position. */
      readonly owner: string;
      readonly mark: number;
      /** The put's blob; undefined for inline content. */
      readonly blob?: BlobRef;
    }
    | { readonly expect: "absent" | "unknown" }
  );

/**
 * An unreadable record as the state keeps it (swamp-club#3617): with the
 * size and modification time (epoch ms) its chunk had when it was last
 * tried, both undefined when the chunk was absent or cannot be stat'ed, so
 * a retry runs only once the chunk changed.
 */
export interface StoredUnreadableRecord extends UnreadableRecord {
  readonly chunkSize?: number;
  readonly chunkMtime?: number;
}

/**
 * A checkout file the read model wrote (swamp-club#3617): the blob it
 * wrote there, and the file's inode, device, size, and modification and
 * change times (epoch ms) as a stat showed them just after, when the inode
 * at the path was still the one it wrote. A file whose stat still shows all
 * of them is taken to hold the blob's content.
 */
export interface WrittenFile {
  readonly namespace: string;
  readonly recordKey: string;
  readonly blob: BlobRef;
  readonly size: number;
  readonly ino: number;
  readonly dev: number;
  readonly mtime: number;
  /** Undefined where the platform reports no change time. */
  readonly ctime?: number;
}

/** A materialised key a load writes or removes. */
export interface LoadKey {
  readonly namespace: string;
  readonly record_key: string;
}

/** A data name whose catalog rows a load replaces. */
export interface LoadName {
  readonly namespace: string;
  readonly partition: string;
  readonly name: string;
}

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
   * The store-wide cursor to advance to, when applied by a catch-up; absent
   * when applied by a partition catch-up, which leaves the cursor alone.
   * The commit's feed position is known either way: see {@link files}.
   */
  readonly cursor?: number;
  /** Each key the commit touched: present with its content, or null when removed. */
  readonly records: ReadonlyMap<string, AppliedRecord | null>;
  /** Each data name the commit changed, with its live versions after it. */
  readonly live: ReadonlyMap<string, readonly LiveDataVersion[]>;
  /** The new ownership of each file the commit wrote or removed; none when absent. */
  readonly files?: ReadonlyMap<string, FileOwnership>;
  /**
   * The keys whose files the commit wrote or removed without a sync, and
   * the boot it ran in (swamp-club#3337): recorded in the same transaction
   * as the commit, so a commit is never applied without them.
   */
  readonly unsynced?: {
    readonly keys: ReadonlySet<string>;
    readonly boot: string;
  };
  /**
   * Every key the commit decided to write or remove (swamp-club#3617): an
   * unreadable record of such a key is forgotten, unless `unreadable`
   * records it again. A key the commit left alone keeps its row.
   */
  readonly decided?: ReadonlySet<string>;
  /** The keys whose content could not be read, by key. */
  readonly unreadable?: ReadonlyMap<string, StoredUnreadableRecord>;
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
  readonly #selectOwnership: StatementSync;
  readonly #upsertOwnership: StatementSync;
  readonly #insertUnsynced: StatementSync;
  readonly #upsertUnsyncedBoot: StatementSync;
  readonly #deleteUnreadable: StatementSync;
  readonly #upsertUnreadable: StatementSync;
  #closed = false;
  #batchOpen = false;

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
      "INSERT OR REPLACE INTO unreadable_records (namespace, record_key, partition, seq, position, blob, chunk, chunk_size, chunk_mtime, reason, last_attempt) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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

  /**
   * Records that a catch-up reached the end of the change feed. The removal
   * candidates a reset kept, and any names an unfinished load touched, are
   * forgotten: the feed is applied, so no load is left to use them.
   */
  markComplete(): void {
    this.#transaction(() => {
      this.#upsertMeta.run("complete", 1);
      this.#db.exec(
        "DELETE FROM load_touched_keys; DELETE FROM load_touched_names;",
      );
    });
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

  /** Which put a materialised file shows; undefined when none was applied. */
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
   * versions, its files' ownership, the partition's applied seq and, from a
   * catch-up, the cursor. A
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
        for (const [key, file] of commit.files ?? []) {
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
  }

  /** Moves the cursor past a change applied earlier by a partition catch-up. */
  recordSkipped(cursor: number): void {
    this.#transaction(() => this.#advanceCursor(cursor));
  }

  /**
   * Clears every table back to cursor 0, and the complete mark, and records
   * the catalog generation the replay that follows builds against. The
   * at-risk copies stay: they are files, not a cache of the commits.
   *
   * The files the state shows present are kept as removal candidates
   * (swamp-club#3617): a compacted-base load that follows removes the ones
   * the base does not show, so a removal a crash undid is redone even when
   * the commit that removed it was compacted away. With `keepUnsynced`
   * (the list was written in another boot, or the current one cannot be
   * named) the unsynced keys are candidates too; within one boot the list
   * names this boot's removals, which stay done.
   */
  reset(catalogGeneration: number, keepUnsynced = false): void {
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
    });
  }

  /**
   * Starts loading the compacted base (swamp-club#3258): clears what an
   * earlier attempt staged. The touched files and names stay.
   */
  beginLoad(): void {
    this.#transaction(() =>
      this.#db.exec(
        "DELETE FROM load_records; DELETE FROM load_versions; DELETE FROM load_catalog; " +
          "DELETE FROM load_forwards; DELETE FROM load_files; DELETE FROM load_progress;",
      )
    );
  }

  /** Stages one page of the compacted base. */
  stageBase(entries: readonly CompactedBaseEntry[]): void {
    this.#transaction(() => {
      for (const entry of entries) {
        switch (entry.kind) {
          case "partition":
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_progress (namespace, partition, seq) VALUES (?, ?, ?)",
            ).run(entry.namespace, entry.partition, entry.seq);
            break;
          case "record": {
            const content = entry.record.content;
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_records (namespace, partition, record_key, sha256, inline, blob) VALUES (?, ?, ?, ?, ?, ?)",
            ).run(
              entry.namespace,
              entry.partition,
              entry.key,
              entry.record.sha256,
              "inline" in content ? content.inline : null,
              "blob" in content ? JSON.stringify(content.blob.toJSON()) : null,
            );
            break;
          }
          case "version":
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_versions (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
            ).run(
              entry.namespace,
              entry.partition,
              entry.version.metadata.name,
              entry.version.version,
              JSON.stringify(entry.version.metadata),
            );
            break;
          case "catalog-row":
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_catalog (namespace, partition, name, version, metadata) VALUES (?, ?, ?, ?, ?)",
            ).run(
              entry.namespace,
              entry.partition,
              entry.metadata.name,
              entry.metadata.version,
              JSON.stringify(entry.metadata),
            );
            break;
          case "forward":
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_forwards (namespace, partition, name, renamed_to) VALUES (?, ?, ?, ?)",
            ).run(entry.namespace, entry.partition, entry.name, entry.to);
            break;
          case "file":
            this.#db.prepare(
              "INSERT OR REPLACE INTO load_files (namespace, record_key, owner, mark, present) VALUES (?, ?, ?, ?, ?)",
            ).run(
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

  /** The staged content of the record a staged file shows. */
  loadContent(
    namespace: string,
    recordKey: string,
  ): { readonly blob: BlobRef } | { readonly inline: string } | undefined {
    this.#requireOpen();
    const row = this.#db.prepare(
      "SELECT r.inline, r.blob FROM load_files AS f JOIN load_records AS r " +
        "ON r.namespace = f.namespace AND r.partition = f.owner AND r.record_key = f.record_key " +
        "WHERE f.namespace = ? AND f.record_key = ?",
    ).get(namespace, recordKey) as
      | { inline: string | null; blob: string | null }
      | undefined;
    if (row === undefined) return undefined;
    if (row.blob !== null) {
      return { blob: BlobRef.fromJSON(JSON.parse(row.blob)) };
    }
    return row.inline === null ? undefined : { inline: row.inline };
  }

  /** The staged ownership of a file a load writes. */
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

  /**
   * The data names whose catalog rows a load replaces: every name the state
   * or the staged base knows, and every name an earlier attempt touched.
   */
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

  /** Records catalog names a load is about to replace, durably, first. */
  touchNames(names: readonly LoadName[]): void {
    this.#transaction(() => {
      const insert = this.#db.prepare(
        "INSERT OR IGNORE INTO load_touched_names (namespace, partition, name) VALUES (?, ?, ?)",
      );
      for (const n of names) insert.run(n.namespace, n.partition, n.name);
    });
  }

  /** A data name's staged catalog rows and forward. */
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
   * Swaps the staged base in, in one transaction: the index, live versions,
   * file ownership and partition progress become the base's, the cursor
   * moves to the compaction point, the index is marked incomplete until a
   * catch-up reaches the end of the feed, and the staging and touched
   * tables are cleared. Unreadable records whose key the base no longer
   * shows at their put are forgotten, and `unreadable`, the base records
   * the load could not read, recorded (swamp-club#3617).
   */
  finishLoad(
    point: number,
    unreadable: readonly StoredUnreadableRecord[] = [],
  ): void {
    this.#transaction(() => {
      this.#db.exec(`
        DELETE FROM live_records;
        INSERT INTO live_records (namespace, partition, record_key, sha256, blob)
          SELECT namespace, partition, record_key, sha256, blob FROM load_records;
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
      this.#upsertMeta.run("cursor", point);
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

  /** Makes the open batch's changes durable. */
  commitBatch(): void {
    this.#requireOpen();
    this.#db.exec("COMMIT");
    this.#batchOpen = false;
  }

  /** Drops the open batch's changes; does nothing when none is open. */
  rollbackBatch(): void {
    if (!this.#batchOpen) return;
    this.#batchOpen = false;
    rollbackQuietly(this.#db);
  }

  /** The boot the unsynced files were written in; undefined when none are. */
  unsyncedBoot(): string | undefined {
    this.#requireOpen();
    const row = this.#db.prepare("SELECT boot FROM unsynced_boot").get() as
      | { boot: string }
      | undefined;
    return row?.boot;
  }

  /**
   * Every unsynced file, with what the state says it holds. The file of an
   * unreadable record is absent (swamp-club#3617).
   */
  unsyncedFiles(): UnsyncedFile[] {
    return this.#snapshot(() => {
      const rows = this.#db.prepare(`
        SELECT u.namespace, u.record_key, m.present, m.owner, m.mark,
          r.sha256, r.blob, x.record_key AS unreadable
        FROM unsynced_keys u
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
        };
      });
    });
  }

  /** The unreadable record at a key, if any (swamp-club#3617). */
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
   * The unreadable records of `namespace` whose key is under the directory
   * `keyPrefix` (`<keyPrefix>/...`), in key order (swamp-club#3617): one
   * range scan of the primary key. `/` sorts just before `0`, so the keys
   * under it are those from `<keyPrefix>/` up to `<keyPrefix>0`.
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

  /** Up to `limit` unreadable records, least recently tried first. */
  unreadableDue(limit: number): StoredUnreadableRecord[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT * FROM unreadable_records ORDER BY last_attempt, namespace, record_key LIMIT ?",
    ).all(limit) as unknown as UnreadableRow[]).map(unreadableOf);
  }

  /**
   * Records another failed try of each of `records`, unreadable records:
   * when, and what its chunk looked like then; one transaction for all.
   */
  noteUnreadableAttempts(records: readonly StoredUnreadableRecord[]): void {
    if (records.length === 0) return;
    this.#transaction(() => {
      for (const record of records) this.#insertUnreadable(record);
    });
  }

  /**
   * Forgets an unreadable record whose key's file no longer shows its put,
   * without listing the key as written.
   */
  forgetUnreadable(namespace: string, recordKey: string): void {
    this.#transaction(() => this.#deleteUnreadable.run(namespace, recordKey));
  }

  /**
   * Forgets an unreadable record whose file a retry wrote, and lists the
   * key as written unsynced in `boot`, in one transaction.
   */
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

  /**
   * Records a checkout file moved aside (swamp-club#3617); a copy already
   * recorded under the same namespace and SHA-256 keeps its row.
   */
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

  /** Whether a copy is recorded under a namespace and SHA-256. */
  hasAtRiskCopy(namespace: string, sha256: string): boolean {
    this.#requireOpen();
    return this.#db.prepare(
      "SELECT 1 FROM at_risk_copies WHERE namespace = ? AND sha256 = ?",
    ).get(namespace, sha256) !== undefined;
  }

  /**
   * Up to `limit` at-risk copies last tried at or before `triedBy` (epoch
   * ms), least recently tried first.
   */
  atRiskDue(limit: number, triedBy: number): StoredAtRiskCopy[] {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT * FROM at_risk_copies WHERE last_attempt <= ? ORDER BY last_attempt, namespace, sha256 LIMIT ?",
    ).all(triedBy, limit) as unknown as AtRiskRow[]).map(atRiskOf);
  }

  /** The bytes every recorded at-risk copy holds. */
  atRiskBytes(): number {
    this.#requireOpen();
    return (this.#db.prepare(
      "SELECT coalesce(sum(size), 0) AS n FROM at_risk_copies",
    ).get() as { n: number }).n;
  }

  /** Records another failed try of an at-risk copy, at `at` (epoch ms). */
  noteAtRiskAttempt(namespace: string, sha256: string, at: number): void {
    this.#transaction(() => {
      this.#db.prepare(
        "UPDATE at_risk_copies SET last_attempt = ? WHERE namespace = ? AND sha256 = ?",
      ).run(at, namespace, sha256);
    });
  }

  /** Forgets an at-risk copy: its file was deleted, or is gone. */
  deleteAtRiskCopy(namespace: string, sha256: string): void {
    this.#transaction(() => {
      this.#db.prepare(
        "DELETE FROM at_risk_copies WHERE namespace = ? AND sha256 = ?",
      ).run(namespace, sha256);
    });
  }

  /** Up to `limit` unsynced keys, in key order. */
  unsyncedKeys(limit: number): { namespace: string; record_key: string }[] {
    return this.#snapshot(() =>
      this.#db.prepare(
        "SELECT namespace, record_key FROM unsynced_keys ORDER BY namespace, record_key LIMIT ?",
      ).all(limit) as unknown as { namespace: string; record_key: string }[]
    );
  }

  /**
   * Forgets `keys` as unsynced: they are known to be on disk. The boot they
   * were written in is forgotten once no unsynced key is left.
   */
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

  /** Forgets the unsynced files: they are known to be on disk. */
  clearUnsynced(): void {
    this.#transaction(() =>
      this.#db.exec("DELETE FROM unsynced_keys; DELETE FROM unsynced_boot;")
    );
  }

  /** Records a file the read model wrote ({@link WrittenFile}). */
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

  /** The file the read model last wrote at a key, if it recorded one. */
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

  /** Forgets the file the read model wrote at a key, once it is removed. */
  forgetWrittenFile(namespace: string, recordKey: string): void {
    this.#transaction(() =>
      this.#db.prepare(
        "DELETE FROM written_files WHERE namespace = ? AND record_key = ?",
      ).run(namespace, recordKey)
    );
  }

  /** Closes the connection. Closing again does nothing. */
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

/** An at-risk copy as the state keeps it, with its content's reference. */
export interface StoredAtRiskCopy extends AtRiskCopy {
  /** The file's reference as the chunk store cuts it; undefined when unknown. */
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
  };
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

function rollbackQuietly(db: DatabaseSync): void {
  if (!db.isTransaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The caller rethrows the original error.
  }
}
