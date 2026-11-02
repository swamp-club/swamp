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

import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { getLogger } from "@logtape/logtape";
import type { SharedDatastoreWriteTracker } from "./shared_datastore_write_tracker.ts";
import { RECORD_KIND_TAG } from "../../domain/data/data.ts";

const logger = getLogger(["swamp", "persistence", "catalog"]);

/**
 * is_latest marks the highest promoted version per group; is_step_latest marks
 * each step's latest and is always set on the is_latest row; is_pending is a
 * deferred write holding neither flag until promoted
 */
export interface CatalogRow {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  id: string;
  version: number;
  is_latest: number;
  is_step_latest: number;
  model_name: string;
  spec_name: string;
  data_type: string;
  content_type: string;
  lifetime: string;
  garbage_collection: string;
  /**
   * deleted for a deletion marker, active otherwise; empty when unknown, such
   * as a foreign row exported before the column existed
   */
  lifecycle: string;
  owner_type: string;
  streaming: number;
  size: number;
  created_at: string;
  tags: string;
  owner_ref: string;
  workflow_run_id: string;
  workflow_name: string;
  job_name: string;
  step_name: string;
  source: string;
  /**
   * 1 while a deferred write is not yet promoted, so recomputing the latest
   * flags can tell it apart from a superseded row (both hold neither flag).
   * Absent means 0.
   */
  is_pending?: number;
  /**
   * pid and host identity of the process that wrote a pending row, so GC can
   * tell a dead writer's row from one in flight; 0 and empty when not pending
   */
  pending_pid?: number;
  pending_host?: string;
}

export interface RenameForwardRow {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  renamed_to: string;
}

export interface CatalogVersionKey {
  type_normalized: string;
  model_id: string;
  data_name: string;
  version: number;
  is_latest: number;
  size: number;
  model_name: string;
}

export interface CatalogVersionKind {
  type_normalized: string;
  model_id: string;
  data_name: string;
  version: number;
  model_name: string;
  data_type: string;
  spec_name: string;
  lifecycle: string;
  record_kind: string;
}

export interface CatalogAgedRow {
  row_id: number;
  type_normalized: string;
  model_id: string;
  data_name: string;
  version: number;
  created_at: string;
  size: number;
}

/**
 * local-only and excluded from datastore sync; stores no content, which stays
 * on disk; self-heals by backfilling when missing or unpopulated
 */
export const ITERATE_PAGE_SIZE = 1000;

export interface CatalogCheckpointStats {
  walPagesTotal: number;
  walPagesCheckpointed: number;
}

/**
 * bump when the table structure changes; a differing stored version drops the
 * catalog and rebuilds it by backfill
 */
export const CATALOG_SCHEMA_VERSION = "9";

/**
 * a catalog missing any of these columns is rebuilt on open even when its
 * version matches, since processes on different schema versions racing on one
 * file can leave the current version over an older table
 */
export const CATALOG_COLUMNS: readonly (keyof CatalogRow)[] = [
  "namespace",
  "type_normalized",
  "model_id",
  "data_name",
  "id",
  "version",
  "is_latest",
  "is_step_latest",
  "model_name",
  "spec_name",
  "data_type",
  "content_type",
  "lifetime",
  "garbage_collection",
  "lifecycle",
  "owner_type",
  "streaming",
  "size",
  "created_at",
  "tags",
  "owner_ref",
  "workflow_run_id",
  "workflow_name",
  "job_name",
  "step_name",
  "source",
  "is_pending",
  "pending_pid",
  "pending_host",
];

type SqlValue = null | number | bigint | string | Uint8Array;

export interface CatalogStoreOptions {
  /**
   * set when the datastore is a filesystem directory shared with other
   * repositories, whose writes then invalidate this catalog
   */
  writeTracker?: SharedDatastoreWriteTracker;
}

function rowKey(row: {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  version: number;
}): string {
  return `${row.namespace}\0${row.type_normalized}\0${row.model_id}\0${row.data_name}\0${row.version}`;
}

export interface CatalogRowKey {
  readonly namespace: string;
  readonly type_normalized: string;
  readonly model_id: string;
  readonly data_name: string;
  readonly version?: number;
}

export const MAX_SORTED_PAGE_SIZE = 16 * ITERATE_PAGE_SIZE;

const CATALOG_IDENTITY_COLUMNS = [
  "namespace",
  "type_normalized",
  "model_id",
  "data_name",
  "version",
] as const;

export interface CatalogSortOrder {
  readonly tagKey: string | null;
  readonly direction: "asc" | "desc";
  readonly after?: {
    readonly key: string;
    readonly id: readonly [string, string, string, string, number];
  };
}

export interface SortedCatalogRow {
  row: CatalogRow;
  sortKey: string;
}

export interface CatalogWriter {
  upsertNewVersion(row: CatalogRow): void;
  removeVersion(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    version: number,
    computeFlags: (rows: CatalogRow[]) => void,
  ): void;
  remove(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void;
  recordRename(row: RenameForwardRow): void;
  removeRename(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void;
}

/**
 * created on open like every other index, so a catalog written before it gains
 * it without a rebuild
 */
const GROUP_STEP_INDEX = "idx_catalog_group_step_version";

function groupWhere(alias: string): string {
  return `${alias}.namespace = ? AND ${alias}.type_normalized = ? AND ${alias}.model_id = ? AND ${alias}.data_name = ? AND ${alias}.is_pending = 0`;
}

/**
 * is_latest goes on the highest version; a model-method row (empty step_name)
 * is step-latest only as the highest; a step row is step-latest as its step's
 * highest unless a model-method version is higher
 */
const RECOMPUTE_GROUP_FLAGS_SQL = `
  WITH top AS (
    SELECT
      (SELECT MAX(version) FROM catalog g WHERE ${groupWhere("g")}) AS overall,
      (SELECT MAX(version) FROM catalog g WHERE ${
  groupWhere("g")
} AND g.step_name = '') AS method
  ),
  flags AS (
    SELECT c.rowid AS id,
      CASE WHEN c.version = top.overall THEN 1 ELSE 0 END AS latest,
      CASE
        WHEN c.step_name = '' THEN CASE WHEN c.version = top.overall THEN 1 ELSE 0 END
        WHEN top.method IS NOT NULL AND c.version < top.method THEN 0
        WHEN c.version = (
          SELECT MAX(s.version) FROM catalog s
          WHERE s.namespace = c.namespace AND s.type_normalized = c.type_normalized
            AND s.model_id = c.model_id AND s.data_name = c.data_name
            AND s.step_name = c.step_name AND s.is_pending = 0
        ) THEN 1
        ELSE 0
      END AS step
    FROM catalog c, top WHERE ${groupWhere("c")}
  )
  UPDATE catalog SET is_latest = flags.latest, is_step_latest = flags.step
  FROM flags
  WHERE catalog.rowid = flags.id
    AND (catalog.is_latest IS NOT flags.latest OR catalog.is_step_latest IS NOT flags.step)
`;

export class CatalogStore {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly writeTracker?: SharedDatastoreWriteTracker;
  private closed = false;
  // statements of the current connection only: one prepared on a closed
  // connection throws when run
  #statements = new Map<string, StatementSync>();

  constructor(dbPath: string, options: CatalogStoreOptions = {}) {
    this.dbPath = dbPath;
    this.writeTracker = options.writeTracker;
    this.db = this.openConnection(dbPath);
    this.initializeWithRetry();
  }

  /**
   * WAL mode is set elsewhere (with retry on construction, explicitly on the
   * reopen in vacuum), so this only sets busy_timeout
   */
  private openConnection(path: string): DatabaseSync {
    ensureDirSync(dirname(path));
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }

  // only for statements run with run() or get(): reusing one resets it, which
  // would cut short a live iterate()
  #prepareCached(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (stmt === undefined) {
      stmt = this.db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  /**
   * switching to WAL needs an exclusive lock and WAL persists on disk, so skip
   * the switch when already in WAL to avoid serializing concurrent process
   * startups
   */
  private initializeWithRetry(): void {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const modeRow = this.db.prepare("PRAGMA journal_mode").get() as
          | { journal_mode: string }
          | undefined;
        if (modeRow?.journal_mode !== "wal") {
          this.db.exec("PRAGMA journal_mode=WAL");
        }

        // Ensure catalog_meta exists so migrateIfNeeded() can read schema_version.
        // Must run before createSchema() because v2-only indexes fail on a v1 table.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS catalog_meta (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
          );
        `);
        this.migrateIfNeeded();
        this.createSchema();
        return;
      } catch (error: unknown) {
        const isLock = error instanceof Error &&
          /database is (locked|busy)/i.test(error.message);
        if (isLock && attempt < MAX_RETRIES) {
          const delay = 100 * Math.pow(2, attempt) +
            Math.floor(Math.random() * 50);
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(4)),
            0,
            0,
            delay,
          );
          continue;
        }
        throw error;
      }
    }
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (
        namespace       TEXT NOT NULL DEFAULT '',
        type_normalized TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        data_name       TEXT NOT NULL,
        id              TEXT NOT NULL,
        version         INTEGER NOT NULL,
        is_latest       INTEGER NOT NULL DEFAULT 1,
        is_step_latest  INTEGER NOT NULL DEFAULT 1,
        model_name      TEXT NOT NULL,
        spec_name       TEXT NOT NULL DEFAULT '',
        data_type       TEXT NOT NULL DEFAULT '',
        content_type    TEXT NOT NULL DEFAULT '',
        lifetime        TEXT NOT NULL DEFAULT '',
        garbage_collection TEXT NOT NULL DEFAULT '',
        lifecycle       TEXT NOT NULL DEFAULT '',
        owner_type      TEXT NOT NULL DEFAULT '',
        streaming       INTEGER NOT NULL DEFAULT 0,
        size            INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        tags            TEXT NOT NULL DEFAULT '{}',
        owner_ref       TEXT NOT NULL DEFAULT '',
        workflow_run_id TEXT NOT NULL DEFAULT '',
        workflow_name   TEXT NOT NULL DEFAULT '',
        job_name        TEXT NOT NULL DEFAULT '',
        step_name       TEXT NOT NULL DEFAULT '',
        source          TEXT NOT NULL DEFAULT '',
        is_pending      INTEGER NOT NULL DEFAULT 0,
        pending_pid     INTEGER NOT NULL DEFAULT 0,
        pending_host    TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (namespace, type_normalized, model_id, data_name, version)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_model_name      ON catalog(model_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_spec_name       ON catalog(spec_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_data_type       ON catalog(data_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_created_at      ON catalog(created_at);
      CREATE INDEX IF NOT EXISTS idx_catalog_workflow_run_id ON catalog(workflow_run_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_step_name       ON catalog(step_name);
      CREATE INDEX IF NOT EXISTS idx_namespace               ON catalog(namespace);
      CREATE INDEX IF NOT EXISTS idx_catalog_is_latest       ON catalog(namespace, type_normalized, model_id, data_name, is_latest);
      CREATE INDEX IF NOT EXISTS ${GROUP_STEP_INDEX} ON catalog(namespace, type_normalized, model_id, data_name, step_name, version);
      CREATE INDEX IF NOT EXISTS idx_catalog_latest_lookup ON catalog(model_name, data_name, is_latest, namespace);

      CREATE TABLE IF NOT EXISTS catalog_renames (
        namespace       TEXT NOT NULL DEFAULT '',
        type_normalized TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        data_name       TEXT NOT NULL,
        renamed_to      TEXT NOT NULL,
        PRIMARY KEY (namespace, type_normalized, model_id, data_name)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_renames_name ON catalog_renames(data_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_step_latest   ON catalog(model_name, is_step_latest);

      CREATE TABLE IF NOT EXISTS catalog_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * a stale catalog is dropped and generation advanced so an older backfill
   * can't mark the rebuild populated; rechecked in an IMMEDIATE transaction so
   * concurrent openers rebuild once
   */
  private migrateIfNeeded(): void {
    if (this.catalogStaleness() === undefined) return;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      // re-check under the lock: another opener may have rebuilt already, and
      // rebuilding again would advance the generation twice; only SQLite
      // locking covers this branch in tests
      const staleness = this.catalogStaleness();
      if (staleness !== undefined) {
        if (staleness.kind === "missing-table") {
          logger
            .warn`Rebuilding the data catalog: schema version ${CATALOG_SCHEMA_VERSION} is recorded but the table is missing`;
        } else if (staleness.kind === "missing-columns") {
          logger
            .warn`Rebuilding the data catalog: schema version ${CATALOG_SCHEMA_VERSION} is recorded but the table lacks columns ${staleness.columns}`;
        }
        this.db.exec("DROP TABLE IF EXISTS catalog");
        this.db.exec("DROP TABLE IF EXISTS catalog_renames");
        this.createSchema();
        this.writeMeta("schema_version", CATALOG_SCHEMA_VERSION);
        this.db.prepare(
          "DELETE FROM catalog_meta WHERE key = 'populated'",
        ).run();
        this.writeMeta("generation", String(this.generation() + 1));
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Why the catalog must be rebuilt, or `undefined` when it is current. A
   * missing table under the current version is stale too: the populated flag
   * may still claim rows that are gone.
   */
  private catalogStaleness():
    | { kind: "version" }
    | { kind: "missing-table" }
    | { kind: "missing-columns"; columns: string[] }
    | undefined {
    if (this.readMeta("schema_version") !== CATALOG_SCHEMA_VERSION) {
      return { kind: "version" };
    }
    const present = new Set(
      (this.db.prepare("PRAGMA table_info(catalog)").all() as {
        name: string;
      }[]).map((c) => c.name),
    );
    if (present.size === 0) return { kind: "missing-table" };
    const columns = CATALOG_COLUMNS.filter((c) => !present.has(c));
    return columns.length > 0
      ? { kind: "missing-columns", columns }
      : undefined;
  }

  /**
   * writes is_latest as supplied, for backfill, which knows it up front;
   * runtime writes should use upsertNewVersion, which maintains the
   * one-latest-per-name invariant atomically
   */
  upsert(row: CatalogRow): void {
    const stmt = this.#prepareCached(`
      INSERT OR REPLACE INTO catalog (
        namespace, type_normalized, model_id, data_name, id, version, is_latest, is_step_latest, model_name,
        spec_name, data_type, content_type, lifetime, garbage_collection, lifecycle, owner_type,
        streaming, size, created_at, tags,
        owner_ref, workflow_run_id, workflow_name, job_name, step_name, source,
        is_pending, pending_pid, pending_host
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
      row.id,
      row.version,
      row.is_latest,
      row.is_step_latest,
      row.model_name,
      row.spec_name,
      row.data_type,
      row.content_type,
      row.lifetime,
      row.garbage_collection,
      row.lifecycle,
      row.owner_type,
      row.streaming,
      row.size,
      row.created_at,
      row.tags,
      row.owner_ref,
      row.workflow_run_id,
      row.workflow_name,
      row.job_name,
      row.step_name,
      row.source,
      row.is_pending ?? 0,
      row.pending_pid ?? 0,
      row.pending_host ?? "",
    );
  }

  /**
   * version order, not arrival order, decides the flags, so out-of-order
   * promotes converge with computeLatestFlags; runs in an IMMEDIATE transaction
   * so concurrent writers serialize
   */
  upsertNewVersion(row: CatalogRow): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#upsertNewVersionRows(row);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #upsertNewVersionRows(row: CatalogRow): void {
    const group = [
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
    ];
    const groupWhere =
      "namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?";
    const stepScope = "(step_name = ? OR ? = '' OR step_name = '')";
    const scope = [row.step_name, row.step_name];
    const higherFlagged = this.#prepareCached(
      `SELECT 1 FROM catalog
       WHERE ${groupWhere} AND version > ?
         AND (is_latest = 1 OR is_step_latest = 1)
       LIMIT 1`,
    ).get(...group, row.version);
    // not filtered on flags: a superseded model-method row holds neither flag
    // yet outranks lower step rows, as in computeLatestFlags; a pending row
    // counts too, and flags agree once it is promoted or rolled back
    const higherInScope = this.#prepareCached(
      `SELECT 1 FROM catalog
       WHERE ${groupWhere} AND version > ? AND ${stepScope}
       LIMIT 1`,
    ).get(...group, row.version, ...scope);
    const isLatest = higherFlagged ? 0 : 1;
    const isStepLatest = isLatest || !higherInScope ? 1 : 0;
    this.#prepareCached(
      `UPDATE catalog SET is_latest = 0
       WHERE ${groupWhere} AND version < ? AND is_latest = 1`,
    ).run(...group, row.version);
    this.#prepareCached(
      `UPDATE catalog SET is_step_latest = 0
       WHERE ${groupWhere} AND version < ? AND ${stepScope}
         AND is_step_latest = 1`,
    ).run(...group, row.version, ...scope);
    // A new latest version makes the name active again, so any rename
    // forward from it ends here.
    if (isLatest) {
      this.removeRename(
        row.namespace,
        row.type_normalized,
        row.model_id,
        row.data_name,
      );
    }
    this.upsert({
      ...row,
      is_latest: isLatest,
      is_step_latest: isStepLatest,
      is_pending: 0,
      pending_pid: 0,
      pending_host: "",
    });
  }

  /**
   * updates present rows and leaves absent ones, so data the walk can't see
   * (lazy hydration) survives; a pending row is never overwritten, so backfill
   * can't promote it; flags are derived in the same transaction
   */
  bulkUpsert(
    rows: readonly CatalogRow[],
    computeFlags?: (rows: CatalogRow[]) => void,
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const pending = new Set(
        (this.db.prepare(
          `SELECT namespace, type_normalized, model_id, data_name, version
           FROM catalog WHERE is_pending = 1`,
        ).all() as {
          namespace: string;
          type_normalized: string;
          model_id: string;
          data_name: string;
          version: number;
        }[]).map(rowKey),
      );
      const toWrite = rows.filter((row) => !pending.has(rowKey(row)));
      computeFlags?.(toWrite);
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO catalog (
          namespace, type_normalized, model_id, data_name, id, version, is_latest, is_step_latest, model_name,
          spec_name, data_type, content_type, lifetime, garbage_collection, lifecycle, owner_type,
          streaming, size, created_at, tags,
          owner_ref, workflow_run_id, workflow_name, job_name, step_name, source,
          is_pending, pending_pid, pending_host
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of toWrite) {
        stmt.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.id,
          row.version,
          row.is_latest,
          row.is_step_latest,
          row.model_name,
          row.spec_name,
          row.data_type,
          row.content_type,
          row.lifetime,
          row.garbage_collection,
          row.lifecycle,
          row.owner_type,
          row.streaming,
          row.size,
          row.created_at,
          row.tags,
          row.owner_ref,
          row.workflow_run_id,
          row.workflow_name,
          row.job_name,
          row.step_name,
          row.source,
          row.is_pending ?? 0,
          row.pending_pid ?? 0,
          row.pending_host ?? "",
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * namespace must be non-empty and every row must belong to it, since an
   * export speaks only for its own namespace and another's rows would replace
   * the reader's own; throws before writing
   */
  bulkUpsertForeign(
    namespace: string,
    rows: readonly CatalogRow[],
  ): void {
    if (namespace.length === 0) {
      throw new Error(
        "Foreign catalog rows need a namespace to be stored under",
      );
    }
    const stray = rows.find((row) => row.namespace !== namespace);
    if (stray) {
      throw new Error(
        `Foreign catalog rows pulled from namespace ${
          JSON.stringify(namespace)
        } include one for namespace ${JSON.stringify(stray.namespace)}`,
      );
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO catalog (
          namespace, type_normalized, model_id, data_name, id, version, is_latest, is_step_latest, model_name,
          spec_name, data_type, content_type, lifetime, garbage_collection, lifecycle, owner_type,
          streaming, size, created_at, tags,
          owner_ref, workflow_run_id, workflow_name, job_name, step_name, source,
          is_pending, pending_pid, pending_host
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        stmt.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.id,
          row.version,
          row.is_latest,
          row.is_step_latest,
          row.model_name,
          row.spec_name,
          row.data_type,
          row.content_type,
          row.lifetime,
          row.garbage_collection,
          row.lifecycle,
          row.owner_type,
          row.streaming,
          row.size,
          row.created_at,
          row.tags,
          row.owner_ref,
          row.workflow_run_id,
          row.workflow_name,
          row.job_name,
          row.step_name,
          row.source,
          row.is_pending ?? 0,
          row.pending_pid ?? 0,
          row.pending_host ?? "",
        );
      }
      const meta = this.db.prepare(
        "INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)",
      );
      meta.run(
        `foreign_synced:${namespace}`,
        new Date().toISOString(),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  foreignSyncedAt(namespace: string): string | null {
    const stmt = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = ?",
    );
    const row = stmt.get(`foreign_synced:${namespace}`) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  remove(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void {
    const stmt = this.#prepareCached(
      "DELETE FROM catalog WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
    );
    stmt.run(namespace, typeNormalized, modelId, dataName);
  }

  recordRename(row: RenameForwardRow): void {
    this.#prepareCached(
      `INSERT OR REPLACE INTO catalog_renames (
         namespace, type_normalized, model_id, data_name, renamed_to
       ) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
      row.renamed_to,
    );
  }

  removeRename(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void {
    this.#prepareCached(
      "DELETE FROM catalog_renames WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
    ).run(namespace, typeNormalized, modelId, dataName);
  }

  /**
   * backfill merges forwards like catalog rows, since a walk with gaps (lazy
   * hydration) must not drop one it couldn't see; data query confirms each hop
   * against the on-disk marker, so ended forwards are not followed
   */
  mergeRenames(rows: readonly RenameForwardRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(
        `INSERT OR REPLACE INTO catalog_renames (
           namespace, type_normalized, model_id, data_name, renamed_to
         ) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        stmt.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.renamed_to,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  findRenamesFrom(dataName: string): RenameForwardRow[] {
    return this.db.prepare(
      "SELECT * FROM catalog_renames WHERE data_name = ?",
    ).all(dataName) as unknown as RenameForwardRow[];
  }

  findRenameTarget(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): string | null {
    const row = this.db.prepare(
      "SELECT renamed_to FROM catalog_renames WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
    ).get(namespace, typeNormalized, modelId, dataName) as
      | { renamed_to: string }
      | undefined;
    return row?.renamed_to ?? null;
  }

  removeVersion(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    version: number,
    computeFlags: (rows: CatalogRow[]) => void,
  ): void {
    this.bulkRemoveVersions(
      namespace,
      typeNormalized,
      modelId,
      dataName,
      [version],
      computeFlags,
    );
  }

  pendingVersions(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): Set<number> {
    const rows = this.db.prepare(
      `SELECT version FROM catalog
       WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?
         AND is_pending = 1`,
    ).all(namespace, typeNormalized, modelId, dataName) as {
      version: number;
    }[];
    return new Set(rows.map((r) => r.version));
  }

  /**
   * published (not pending) versions with latest flag, size and model name;
   * rows of other namespaces are never read; used by doctor datastores and the
   * read warning's published check
   */
  versionKeys(
    namespace: string,
    group?: { typeNormalized: string; modelId: string; dataName: string },
  ): CatalogVersionKey[] {
    const clauses = ["namespace = ?", "is_pending = 0"];
    const params: string[] = [namespace];
    if (group !== undefined) {
      clauses.push("type_normalized = ?", "model_id = ?", "data_name = ?");
      params.push(group.typeNormalized, group.modelId, group.dataName);
    }
    return this.db.prepare(
      `SELECT type_normalized, model_id, data_name, version, is_latest, size,
              model_name
       FROM catalog WHERE ${clauses.join(" AND ")}
       ORDER BY type_normalized, model_id, data_name, version`,
    ).all(...params) as unknown as CatalogVersionKey[];
  }

  /** published versions with the tags that name their kind, for doctor datastores */
  versionKinds(namespace: string): CatalogVersionKind[] {
    return this.db.prepare(
      `SELECT type_normalized, model_id, data_name, version, model_name,
              data_type, spec_name, lifecycle,
              COALESCE(json_extract(tags, ?), '') AS record_kind
       FROM catalog WHERE namespace = ? AND is_pending = 0
       ORDER BY type_normalized, model_id, data_name, version`,
    ).all(
      `$."${RECORD_KIND_TAG}"`,
      namespace,
    ) as unknown as CatalogVersionKind[];
  }

  rowsCreatedBefore(
    namespace: string,
    cutoffIso: string,
    limit: number,
    after?: { createdAt: string; rowId: number },
    excludeTypes: readonly string[] = [],
  ): CatalogAgedRow[] {
    const clauses = ["created_at < ?", "namespace = ?", "is_pending = 0"];
    const params: (string | number)[] = [cutoffIso, namespace];
    if (after) {
      clauses.push("(created_at > ? OR (created_at = ? AND rowid > ?))");
      params.push(after.createdAt, after.createdAt, after.rowId);
    }
    if (excludeTypes.length > 0) {
      clauses.push(
        `type_normalized NOT IN (${excludeTypes.map(() => "?").join(", ")})`,
      );
      for (const type of excludeTypes) params.push(type);
    }
    params.push(limit);
    return this.db.prepare(
      `SELECT rowid AS row_id, type_normalized, model_id, data_name, version,
              created_at, size
       FROM catalog INDEXED BY idx_catalog_created_at
       WHERE ${clauses.join(" AND ")}
       ORDER BY created_at, rowid
       LIMIT ?`,
    ).all(...params) as unknown as CatalogAgedRow[];
  }

  /**
   * clears the pending mark and writer identity (flags stay 0 until the caller
   * promotes the row), or removes the row when keep is false
   */
  settlePending(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    version: number,
    keep: boolean,
  ): void {
    const where =
      "namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ? AND is_pending = 1";
    this.db.prepare(
      keep
        ? `UPDATE catalog SET is_pending = 0, pending_pid = 0, pending_host = '' WHERE ${where}`
        : `DELETE FROM catalog WHERE ${where}`,
    ).run(namespace, typeNormalized, modelId, dataName, version);
  }

  pendingRows(
    namespace: string,
    typeNormalized: string,
    modelId: string,
  ): CatalogRow[] {
    return [
      ...this.iterateFiltered(
        "namespace = ? AND type_normalized = ? AND model_id = ? AND is_pending = 1",
        [namespace, typeNormalized, modelId],
      ),
    ];
  }

  *iterate(): IterableIterator<CatalogRow> {
    const stmt = this.db.prepare(
      "SELECT * FROM catalog ORDER BY rowid LIMIT ? OFFSET ?",
    );
    let offset = 0;
    while (true) {
      const rows = stmt.all(
        ITERATE_PAGE_SIZE,
        offset,
      ) as unknown as CatalogRow[];
      if (rows.length === 0) break;
      yield* rows;
      if (rows.length < ITERATE_PAGE_SIZE) break;
      offset += ITERATE_PAGE_SIZE;
    }
  }

  *iterateFiltered(
    whereClause: string,
    params: readonly (string | number)[],
  ): IterableIterator<CatalogRow> {
    let offset = 0;
    while (true) {
      const stmt = this.db.prepare(
        `SELECT * FROM catalog WHERE ${whereClause} ORDER BY rowid LIMIT ? OFFSET ?`,
      );
      const rows = stmt.all(
        ...params,
        ITERATE_PAGE_SIZE,
        offset,
      ) as unknown as CatalogRow[];
      if (rows.length === 0) break;
      yield* rows;
      if (rows.length < ITERATE_PAGE_SIZE) break;
      offset += ITERATE_PAGE_SIZE;
    }
  }

  /**
   * total order by sort value then row identity; pages start after the previous
   * last row, not an offset; a tag sort has no index, so pages double in size
   * up to MAX_SORTED_PAGE_SIZE to keep scans logarithmic
   */
  *iterateSorted(
    whereClause: string,
    params: readonly (string | number)[],
    order: CatalogSortOrder,
  ): IterableIterator<SortedCatalogRow> {
    if (order.tagKey !== null && /["\\]/.test(order.tagKey)) {
      throw new Error(`Invalid sort tag key: ${order.tagKey}`);
    }
    const sortExpr = order.tagKey === null
      ? "created_at"
      : "COALESCE(CASE WHEN json_valid(tags) THEN CAST(json_extract(tags, ?) AS TEXT) END, '')";
    const sortParams = order.tagKey === null ? [] : [`$."${order.tagKey}"`];
    const dir = order.direction === "desc" ? "DESC" : "ASC";
    const cmp = order.direction === "desc" ? "<" : ">";
    const orderBy = [
      "sort_key",
      ...CATALOG_IDENTITY_COLUMNS,
    ].map((column) => `${column} ${dir}`).join(", ");
    const inner = `SELECT *, ${sortExpr} AS sort_key FROM catalog WHERE ${
      whereClause || "1"
    }`;
    const firstPage = this.db.prepare(
      `SELECT * FROM (${inner}) ORDER BY ${orderBy} LIMIT ?`,
    );
    const nextPage = this.db.prepare(
      `SELECT * FROM (${inner}) WHERE (sort_key, ${
        CATALOG_IDENTITY_COLUMNS.join(", ")
      }) ${cmp} (?, ?, ?, ?, ?, ?) ORDER BY ${orderBy} LIMIT ?`,
    );
    let after = order.after;
    let pageSize = ITERATE_PAGE_SIZE;
    while (true) {
      const raw = (after
        ? nextPage.all(
          ...sortParams,
          ...params,
          after.key,
          ...after.id,
          pageSize,
        )
        : firstPage.all(
          ...sortParams,
          ...params,
          pageSize,
        )) as unknown as (CatalogRow & { sort_key: string })[];
      for (const { sort_key: sortKey, ...row } of raw) {
        yield { row, sortKey };
      }
      if (raw.length < pageSize) break;
      pageSize = Math.min(pageSize * 2, MAX_SORTED_PAGE_SIZE);
      const last = raw[raw.length - 1];
      after = {
        key: last.sort_key,
        id: [
          last.namespace,
          last.type_normalized,
          last.model_id,
          last.data_name,
          last.version,
        ],
      };
    }
  }

  *iterateNamespace(namespace: string): IterableIterator<CatalogRow> {
    const stmt = this.db.prepare(
      "SELECT * FROM catalog WHERE namespace = ? ORDER BY rowid LIMIT ? OFFSET ?",
    );
    let offset = 0;
    while (true) {
      const rows = stmt.all(
        namespace,
        ITERATE_PAGE_SIZE,
        offset,
      ) as unknown as CatalogRow[];
      if (rows.length === 0) break;
      yield* rows;
      if (rows.length < ITERATE_PAGE_SIZE) break;
      offset += ITERATE_PAGE_SIZE;
    }
  }

  findLatestRow(
    modelName: string,
    dataName: string,
    namespace?: string,
    excludeModelTypes: readonly string[] = [],
  ): CatalogRow | null {
    const clauses = ["model_name = ?", "data_name = ?", "is_latest = 1"];
    const params: string[] = [modelName, dataName];
    if (namespace !== undefined) {
      clauses.push("namespace = ?");
      params.push(namespace);
    }
    if (excludeModelTypes.length > 0) {
      clauses.push(
        `type_normalized NOT IN (${
          excludeModelTypes.map(() => "?").join(", ")
        })`,
      );
      for (const type of excludeModelTypes) params.push(type);
    }
    const stmt = this.db.prepare(
      `SELECT * FROM catalog WHERE ${
        clauses.join(" AND ")
      } ORDER BY rowid DESC LIMIT 1`,
    );
    return (stmt.get(...params) as unknown as CatalogRow) ?? null;
  }

  findLatestRowsBySpecName(
    modelName: string,
    specName: string,
    namespace?: string,
  ): CatalogRow[] {
    if (namespace !== undefined) {
      const stmt = this.db.prepare(
        `SELECT * FROM catalog
         WHERE model_name = ? AND spec_name = ? AND is_latest = 1 AND namespace = ?`,
      );
      return stmt.all(
        modelName,
        specName,
        namespace,
      ) as unknown as CatalogRow[];
    }
    const stmt = this.db.prepare(
      `SELECT * FROM catalog
       WHERE model_name = ? AND spec_name = ? AND is_latest = 1`,
    );
    return stmt.all(modelName, specName) as unknown as CatalogRow[];
  }

  count(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM catalog");
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * exists so doctor datastores can compare the index with the on-disk walk
   * without DataQueryService, whose query would trigger the very backfill being
   * diagnosed and repair or damage the state first
   */
  latestRowCountsByType(namespace?: string): Map<string, number> {
    const stmt = namespace !== undefined
      ? this.db.prepare(
        `SELECT type_normalized, COUNT(*) as cnt FROM catalog
           WHERE is_latest = 1 AND namespace = ?
           GROUP BY type_normalized`,
      )
      : this.db.prepare(
        `SELECT type_normalized, COUNT(*) as cnt FROM catalog
           WHERE is_latest = 1
           GROUP BY type_normalized`,
      );
    const rows =
      (namespace !== undefined
        ? stmt.all(namespace)
        : stmt.all()) as unknown as Array<
          { type_normalized: string; cnt: number }
        >;
    return new Map(rows.map((r) => [r.type_normalized, r.cnt]));
  }

  isPopulated(): boolean {
    this.invalidateOnForeignWrites();
    return this.readMeta("populated") === "true";
  }

  /**
   * with ifGeneration, does nothing when the catalog was invalidated since: a
   * backfill that walked the disk before the invalidation must not mark it
   * fresh
   */
  markPopulated(ifGeneration?: number): void {
    if (ifGeneration === undefined) {
      this.writeMeta("populated", "true");
      return;
    }
    // One statement, so an invalidation or rebuild committed by another
    // connection cannot land between the generation check and the write.
    this.db.prepare(
      `INSERT OR REPLACE INTO catalog_meta (key, value)
       SELECT 'populated', 'true'
       WHERE CAST(COALESCE(
         (SELECT value FROM catalog_meta WHERE key = 'generation'), '0'
       ) AS INTEGER) = ?`,
    ).run(ifGeneration);
  }

  invalidate(): void {
    // Advance the generation first: a markPopulated holding the old
    // generation that lands after it is rejected, and one that lands before
    // it is undone by the delete below.
    this.writeMeta("generation", String(this.generation() + 1));
    const stmt = this.db.prepare(
      "DELETE FROM catalog_meta WHERE key = 'populated'",
    );
    stmt.run();
  }

  /**
   * keeps the populated mark and advances generation, so a reader never sees an
   * unpopulated catalog and backfills from disk while the caller rebuilds it; a
   * rename row is offered without a version
   */
  clearRows(clears: (row: CatalogRowKey) => boolean): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db.prepare(
        "SELECT namespace, type_normalized, model_id, data_name, version FROM catalog",
      ).all() as unknown as Required<CatalogRowKey>[];
      const deleteRow = this.db.prepare(
        "DELETE FROM catalog WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?",
      );
      for (const row of rows) {
        if (!clears(row)) continue;
        deleteRow.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.version,
        );
      }
      const renames = this.db.prepare(
        "SELECT namespace, type_normalized, model_id, data_name FROM catalog_renames",
      ).all() as unknown as CatalogRowKey[];
      const deleteRename = this.db.prepare(
        "DELETE FROM catalog_renames WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
      );
      for (const row of renames) {
        if (!clears(row)) continue;
        deleteRename.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
        );
      }
      const generation = this.generation() + 1;
      this.writeMeta("generation", String(generation));
      this.db.exec("COMMIT");
      return generation;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  generation(): number {
    return Number(this.readMeta("generation") ?? "0");
  }

  /**
   * no-op without a tracker; best effort since the data is already committed:
   * an unwritable token only delays other repositories noticing, and must not
   * fail the write
   */
  recordLocalWrite(): void {
    if (!this.writeTracker) return;
    try {
      this.writeTracker.recordWrite(this.writerId());
    } catch (error) {
      logger
        .warn`Could not record a write for catalogs sharing this datastore: ${error}`;
    }
  }

  private invalidateOnForeignWrites(): void {
    if (!this.writeTracker) return;
    let seen: string;
    try {
      seen = this.writeTracker.foreignTokens(this.writerId());
    } catch (error) {
      // Unable to tell whether another repository wrote: treat the catalog
      // as stale rather than failing the read.
      logger
        .warn`Could not read writes by catalogs sharing this datastore: ${error}`;
      this.invalidate();
      return;
    }
    if (seen === (this.readMeta("foreign_writers") ?? "{}")) return;
    this.invalidate();
    this.writeMeta("foreign_writers", seen);
  }

  /**
   * A random id for this catalog's token. Not derived from the path, so two
   * machines with the same repository path never share one.
   */
  private writerId(): string {
    let id = this.readMeta("writer_id");
    if (!id) {
      id = crypto.randomUUID();
      this.writeMeta("writer_id", id);
    }
    return id;
  }

  private readMeta(key: string): string | undefined {
    const row = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = ?",
    ).get(key) as { value: string } | undefined;
    return row?.value;
  }

  private writeMeta(key: string, value: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO catalog_meta (key, value) VALUES (?, ?)",
    ).run(key, value);
  }

  distinctValues(
    column:
      | "id"
      | "data_name"
      | "version"
      | "created_at"
      | "model_name"
      | "type_normalized"
      | "spec_name"
      | "data_type"
      | "content_type"
      | "lifetime"
      | "owner_type"
      | "size"
      | "owner_ref"
      | "workflow_run_id"
      | "workflow_name"
      | "job_name"
      | "step_name"
      | "source",
  ): string[] {
    const ALLOWED = new Set([
      "id",
      "data_name",
      "version",
      "created_at",
      "model_name",
      "type_normalized",
      "spec_name",
      "data_type",
      "content_type",
      "lifetime",
      "owner_type",
      "size",
      "owner_ref",
      "workflow_run_id",
      "workflow_name",
      "job_name",
      "step_name",
      "source",
    ]);
    if (!ALLOWED.has(column)) return [];
    const stmt = this.db.prepare(
      `SELECT DISTINCT ${column} FROM catalog WHERE ${column} != '' ORDER BY ${column}`,
    );
    return (stmt.all() as Record<string, unknown>[]).map((row) =>
      String(row[column])
    );
  }

  distinctTagKeys(): string[] {
    const keys = new Set<string>();
    for (const row of this.iterate()) {
      try {
        const tags = JSON.parse(row.tags) as Record<string, string>;
        for (const key of Object.keys(tags)) {
          keys.add(key);
        }
      } catch {
        // Skip invalid JSON
      }
    }
    return [...keys].sort();
  }

  distinctTagValues(tagKey: string): string[] {
    const values = new Set<string>();
    for (const row of this.iterate()) {
      try {
        const tags = JSON.parse(row.tags) as Record<string, string>;
        if (tagKey in tags) {
          values.add(tags[tagKey]);
        }
      } catch {
        // Skip invalid JSON
      }
    }
    return [...values].sort();
  }

  checkpoint(): CatalogCheckpointStats {
    const row = this.db.prepare(
      "PRAGMA wal_checkpoint(TRUNCATE)",
    ).get() as { busy: number; log: number; checkpointed: number };
    return {
      walPagesTotal: row.log,
      walPagesCheckpointed: row.checkpointed,
    };
  }

  /**
   * recomputes latest flags in SQL by computeLatestFlags rules, so computeFlags
   * is unused; restores is_step_latest for a step whose latest was removed;
   * pending rows are left out; rolled back on failure
   */
  bulkRemoveVersions(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    versions: readonly number[],
    computeFlags: (rows: CatalogRow[]) => void,
  ): void {
    if (versions.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.#removeVersionRows(
        namespace,
        typeNormalized,
        modelId,
        dataName,
        versions,
        computeFlags,
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * writer methods make the same changes as the store's without their own
   * transaction; commits once apply returns, rolls back and rethrows on a
   * throw, instead of one transaction per action
   */
  applyInTransaction(apply: (writer: CatalogWriter) => void): void {
    const writer: CatalogWriter = {
      upsertNewVersion: (row) => this.#upsertNewVersionRows(row),
      removeVersion: (
        namespace,
        typeNormalized,
        modelId,
        dataName,
        version,
        computeFlags,
      ) =>
        this.#removeVersionRows(
          namespace,
          typeNormalized,
          modelId,
          dataName,
          [version],
          computeFlags,
        ),
      remove: (namespace, typeNormalized, modelId, dataName) =>
        this.remove(namespace, typeNormalized, modelId, dataName),
      recordRename: (row) => this.recordRename(row),
      removeRename: (namespace, typeNormalized, modelId, dataName) =>
        this.removeRename(namespace, typeNormalized, modelId, dataName),
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      apply(writer);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  #removeVersionRows(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    versions: readonly number[],
    computeFlags: (rows: CatalogRow[]) => void,
  ): void {
    const stmt = this.#prepareCached(
      `DELETE FROM catalog
       WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?`,
    );
    for (const version of versions) {
      stmt.run(namespace, typeNormalized, modelId, dataName, version);
    }
    this.recomputeGroupFlags(
      namespace,
      typeNormalized,
      modelId,
      dataName,
      computeFlags,
    );
  }

  /**
   * native VACUUM needs ATTACH, which the node:sqlite binding rejects, so
   * rebuild via a second connection and swap; no other writer allowed; false on
   * failure, throws only if no catalog can be restored
   */
  vacuum(): boolean {
    const tmpPath = `${this.dbPath}.compact`;
    try {
      this.rebuildInto(tmpPath);
    } catch (error) {
      logger.warn`VACUUM skipped: ${error}`;
      this.removeDbFiles(tmpPath);
      return false;
    }

    // Swap the rebuilt file into place. Close first so Windows releases the
    // handle, then drop the stale WAL/SHM sidecars of the old file before the
    // rename so they cannot shadow the new database.
    this.db.close();
    this.#statements.clear();
    this.removeDbFiles(this.dbPath, { keepMain: true });
    let swapError: unknown;
    try {
      this.replaceWith(tmpPath);
    } catch (error) {
      swapError = error;
    }
    if (swapError !== undefined && !this.fileExists(this.dbPath)) {
      // The old file is gone but the rebuilt one never moved in: it is the
      // only copy, so retry the rename rather than reopen an empty catalog.
      try {
        Deno.renameSync(tmpPath, this.dbPath);
        swapError = undefined;
      } catch {
        // Surface the real failure: with the connection already closed, a
        // later close() would otherwise throw "database is not open" instead.
        this.closed = true;
        throw swapError;
      }
    }

    // Reopen so the store stays valid for the caller, restoring WAL mode. No
    // other process can be opening concurrently (compact holds the global
    // lock), so WAL can be set eagerly without the constructor's retry.
    try {
      this.db = this.openConnection(this.dbPath);
      this.db.exec("PRAGMA journal_mode=WAL");
    } catch (error) {
      this.closed = true;
      throw error;
    }
    if (swapError !== undefined) {
      // the original catalog is intact and open again; only the space the
      // rebuild would have reclaimed is lost
      logger.warn`VACUUM skipped: rebuilt catalog not swapped in: ${swapError}`;
      this.removeDbFiles(tmpPath);
      return false;
    }
    return true;
  }

  /**
   * POSIX replaces the destination atomically; Windows rejects a rename onto an
   * existing file, so the old file is removed first; throws if the rename
   * fails, such as another connection holding it open
   */
  private replaceWith(tmpPath: string): void {
    try {
      Deno.renameSync(tmpPath, this.dbPath);
    } catch {
      try {
        Deno.removeSync(this.dbPath);
      } catch {
        // Already gone, or held open — the rename below reports it.
      }
      Deno.renameSync(tmpPath, this.dbPath);
    }
  }

  private fileExists(path: string): boolean {
    try {
      Deno.statSync(path);
      return true;
    } catch {
      return false;
    }
  }

  private rebuildInto(targetPath: string): void {
    this.removeDbFiles(targetPath);

    // Default rollback-journal mode keeps the rebuilt DB to a single file (no
    // -wal/-shm to orphan), which the swap then moves atomically.
    const dst = new DatabaseSync(targetPath);
    try {
      const ddl = this.db.prepare(
        `SELECT sql FROM sqlite_master
         WHERE sql IS NOT NULL AND type IN ('table', 'index', 'trigger', 'view')
         ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END`,
      ).all() as { sql: string }[];
      for (const { sql } of ddl) dst.exec(sql);

      const tables = this.db.prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
      ).all() as { name: string }[];

      dst.exec("BEGIN IMMEDIATE");
      try {
        for (const { name } of tables) {
          this.copyTableRows(dst, name);
        }
        dst.exec("COMMIT");
      } catch (error) {
        dst.exec("ROLLBACK");
        throw error;
      }
    } finally {
      dst.close();
    }
  }

  /**
   * assumes a rowid table, as catalog and catalog_meta are; a WITHOUT ROWID
   * table would break the rowid-paging cursor
   */
  private copyTableRows(dst: DatabaseSync, table: string): void {
    const columns = (this.db.prepare(`PRAGMA table_info("${table}")`)
      .all() as { name: string }[]).map((c) => c.name);
    const colList = columns.map((c) => `"${c}"`).join(", ");
    const placeholders = columns.map(() => "?").join(", ");
    const insert = dst.prepare(
      `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
    );
    const page = this.db.prepare(
      `SELECT rowid AS __rowid, ${colList} FROM "${table}"
       WHERE rowid > ? ORDER BY rowid LIMIT ?`,
    );

    let lastRowid = 0;
    for (;;) {
      const rows = page.all(lastRowid, ITERATE_PAGE_SIZE) as Record<
        string,
        SqlValue
      >[];
      if (rows.length === 0) break;
      for (const row of rows) {
        insert.run(...columns.map((c) => row[c]));
        lastRowid = Number(row.__rowid);
      }
      if (rows.length < ITERATE_PAGE_SIZE) break;
    }
  }

  private removeDbFiles(path: string, opts: { keepMain?: boolean } = {}): void {
    const targets = opts.keepMain ? [] : [path];
    targets.push(`${path}-wal`, `${path}-shm`);
    for (const target of targets) {
      try {
        Deno.removeSync(target);
      } catch {
        // Missing file — nothing to remove.
      }
    }
  }

  countDuplicateLatest(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM (
         SELECT namespace, type_normalized, model_id, data_name
         FROM catalog
         WHERE is_latest = 1
         GROUP BY namespace, type_normalized, model_id, data_name
         HAVING COUNT(*) > 1
         UNION
         SELECT namespace, type_normalized, model_id, data_name
         FROM catalog
         WHERE is_step_latest = 1
         GROUP BY namespace, type_normalized, model_id, data_name, step_name
         HAVING COUNT(*) > 1
       )`,
    );
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * only flagged rows take part, so a pending write is never promoted; one
   * IMMEDIATE transaction; closes the race where a save() during the walk
   * demotes a row bulkUpsert re-promotes from stale state
   */
  enforceUniqueLatest(
    computeFlags: (rows: CatalogRow[]) => void,
  ): number {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const changed = this.writeRecomputedFlags(
        [
          ...this.iterateFiltered("(is_latest = ? OR is_step_latest = ?)", [
            1,
            1,
          ]),
        ],
        computeFlags,
      );
      this.db.exec("COMMIT");
      return changed;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * runs in SQL from the primary key and GROUP_STEP_INDEX, so no row is read
   * into JS, as reading the whole group per removal made replays slow; a test
   * holds it to computeLatestFlags
   */
  private recomputeGroupFlags(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    _computeFlags: (rows: CatalogRow[]) => void,
  ): void {
    const group = [namespace, typeNormalized, modelId, dataName];
    this.#prepareCached(RECOMPUTE_GROUP_FLAGS_SQL).run(
      ...group,
      ...group,
      ...group,
    );
  }

  private writeRecomputedFlags(
    rows: CatalogRow[],
    computeFlags: (rows: CatalogRow[]) => void,
  ): number {
    const before = new Map(
      rows.map((r) => [r, `${r.is_latest}:${r.is_step_latest}`]),
    );
    computeFlags(rows);
    const changed = rows.filter((r) =>
      before.get(r) !== `${r.is_latest}:${r.is_step_latest}`
    );
    if (changed.length > 0) {
      const stmt = this.db.prepare(
        `UPDATE catalog SET is_latest = ?, is_step_latest = ?
         WHERE namespace = ? AND type_normalized = ? AND model_id = ?
           AND data_name = ? AND version = ?`,
      );
      for (const row of changed) {
        stmt.run(
          row.is_latest,
          row.is_step_latest,
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.version,
        );
      }
    }
    return changed.length;
  }

  /**
   * idempotent, so a finally close() cannot mask an earlier reopen failure,
   * since node:sqlite throws on double-close
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.#statements.clear();
    this.db.close();
  }
}
