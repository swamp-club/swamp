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

import { DatabaseSync } from "node:sqlite";
import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { getLogger } from "@logtape/logtape";
import type { SharedDatastoreWriteTracker } from "./shared_datastore_write_tracker.ts";

const logger = getLogger(["swamp", "persistence", "catalog"]);

/**
 * A single row in the catalog table, representing one version of a data
 * artifact. The `is_latest` flag is set on exactly one row per
 * (namespace, type_normalized, model_id, data_name) triple.
 */
export interface CatalogRow {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  id: string;
  version: number;
  is_latest: number;
  model_name: string;
  spec_name: string;
  data_type: string;
  content_type: string;
  lifetime: string;
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
}

/**
 * A rename forward: the data item `data_name` was renamed to `renamed_to`
 * under the same (namespace, type_normalized, model_id). Projected from the
 * rename marker the repository writes on the old name, so data query can
 * follow it the way an unversioned repository read does.
 */
export interface RenameForwardRow {
  namespace: string;
  type_normalized: string;
  model_id: string;
  data_name: string;
  renamed_to: string;
}

/**
 * SQLite-backed metadata catalog for data query.
 *
 * Stores one row per version of each data artifact with all metadata fields
 * needed for CEL predicate evaluation. The `is_latest` column marks exactly
 * one row per (type, model, name) as the current latest. Content is NOT
 * stored — it remains on disk in the existing versioned file layout.
 *
 * The catalog is local-only and excluded from datastore sync. It self-heals
 * by triggering a backfill when missing or not yet populated.
 */
export const ITERATE_PAGE_SIZE = 1000;

/** Stats returned by {@link CatalogStore.checkpoint}. */
export interface CatalogCheckpointStats {
  /** Total WAL frames at the time of the checkpoint call. */
  walPagesTotal: number;
  /** Frames successfully written to the main database file. */
  walPagesCheckpointed: number;
}

/**
 * Schema version. Bump this when the catalog table structure changes.
 * On startup, if the stored version differs, the catalog is dropped and
 * rebuilt via self-healing backfill.
 */
export const CATALOG_SCHEMA_VERSION = "5";

/**
 * A value SQLite can round-trip when copying rows generically during
 * compaction. Mirrors node:sqlite's supported bind/output value union.
 */
type SqlValue = null | number | bigint | string | Uint8Array;

/** Options for {@link CatalogStore}. */
export interface CatalogStoreOptions {
  /**
   * Set when the datastore is a filesystem directory shared with other
   * repositories: their writes then invalidate this catalog
   * (swamp-club#2858).
   */
  writeTracker?: SharedDatastoreWriteTracker;
}

export class CatalogStore {
  private db: DatabaseSync;
  private readonly dbPath: string;
  private readonly writeTracker?: SharedDatastoreWriteTracker;
  private closed = false;

  constructor(dbPath: string, options: CatalogStoreOptions = {}) {
    this.dbPath = dbPath;
    this.writeTracker = options.writeTracker;
    this.db = this.openConnection(dbPath);
    this.initializeWithRetry();
  }

  /**
   * Opens a SQLite connection at `path` and applies the baseline pragma shared
   * by initial construction and the post-compaction reopen. WAL mode is
   * established separately — with retry by {@link initializeWithRetry} on the
   * constructor path, and explicitly on the reopen path in {@link vacuum} — so
   * this helper only sets `busy_timeout`.
   */
  private openConnection(path: string): DatabaseSync {
    ensureDirSync(dirname(path));
    const db = new DatabaseSync(path);
    db.exec("PRAGMA busy_timeout=5000");
    return db;
  }

  /**
   * Initializes WAL mode and schema with retry logic.
   *
   * `PRAGMA journal_mode=WAL` requires an **exclusive** lock to switch
   * modes. WAL mode persists on disk, so we skip the mode switch when
   * the database is already in WAL mode — avoiding the exclusive lock
   * that serializes concurrent process startups.
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
        model_name      TEXT NOT NULL,
        spec_name       TEXT NOT NULL DEFAULT '',
        data_type       TEXT NOT NULL DEFAULT '',
        content_type    TEXT NOT NULL DEFAULT '',
        lifetime        TEXT NOT NULL DEFAULT '',
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

      CREATE TABLE IF NOT EXISTS catalog_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Checks the stored schema version against {@link CATALOG_SCHEMA_VERSION}.
   * If they differ, drops the catalog and rename tables and clears the
   * populated flag
   * so the next query triggers a full backfill with the new schema.
   */
  private migrateIfNeeded(): void {
    const stmt = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = 'schema_version'",
    );
    const row = stmt.get() as { value: string } | undefined;
    if (row?.value === CATALOG_SCHEMA_VERSION) return;

    this.db.exec("DROP TABLE IF EXISTS catalog");
    this.db.exec("DROP TABLE IF EXISTS catalog_renames");
    this.createSchema();
    this.db.prepare(
      "INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('schema_version', ?)",
    ).run(CATALOG_SCHEMA_VERSION);
    this.db.prepare(
      "DELETE FROM catalog_meta WHERE key = 'populated'",
    ).run();
  }

  /**
   * Upserts a row into the catalog. Replaces any existing row with the
   * same primary key (namespace, type_normalized, model_id, data_name, version).
   *
   * Writes `is_latest` exactly as supplied. Backfill uses this because it
   * knows the correct `is_latest` for every version up front. Runtime writes
   * from a single write path should use {@link upsertNewVersion} instead,
   * which atomically maintains the "exactly one latest per name" invariant.
   */
  upsert(row: CatalogRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO catalog (
        namespace, type_normalized, model_id, data_name, id, version, is_latest, model_name,
        spec_name, data_type, content_type, lifetime, owner_type,
        streaming, size, created_at, tags,
        owner_ref, workflow_run_id, workflow_name, job_name, step_name, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.namespace,
      row.type_normalized,
      row.model_id,
      row.data_name,
      row.id,
      row.version,
      row.is_latest,
      row.model_name,
      row.spec_name,
      row.data_type,
      row.content_type,
      row.lifetime,
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
    );
  }

  /**
   * Inserts a row as the new latest version for (type, model, name), clearing
   * `is_latest` on prior rows. The `is_latest` field on the supplied row is
   * ignored — this method always writes `1`.
   *
   * Demotion scope depends on the incoming step_name:
   * - Model-method writes (step_name = "") demote ALL prior latest rows
   *   regardless of their step_name.
   * - Workflow-step writes (step_name != "") demote rows with the same
   *   step_name AND rows with step_name = "" (model-method rows), but
   *   leave other steps' latest rows untouched so different workflow
   *   steps maintain independent version chains.
   *
   * Runs in an IMMEDIATE transaction so concurrent writers serialize
   * through SQLite's reserved lock rather than racing on the flag.
   *
   * A new version makes the name active again, so any rename forward from
   * it ends here: the on-disk latest marker no longer names the rename
   * marker.
   */
  upsertNewVersion(row: CatalogRow): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `UPDATE catalog SET is_latest = 0
         WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?
           AND (step_name = ? OR ? = '' OR step_name = '')
           AND is_latest = 1`,
      ).run(
        row.namespace,
        row.type_normalized,
        row.model_id,
        row.data_name,
        row.step_name,
        row.step_name,
      );
      this.removeRename(
        row.namespace,
        row.type_normalized,
        row.model_id,
        row.data_name,
      );
      this.upsert({ ...row, is_latest: 1 });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Upserts catalog rows without deleting anything first. Rows already
   * present (by primary key) are updated; rows absent from the batch
   * are left untouched. Used by backfill so data the on-disk walk
   * cannot see — e.g. under lazy hydration — is preserved rather than
   * deleted.
   */
  bulkUpsert(rows: readonly CatalogRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO catalog (
          namespace, type_normalized, model_id, data_name, id, version, is_latest, model_name,
          spec_name, data_type, content_type, lifetime, owner_type,
          streaming, size, created_at, tags,
          owner_ref, workflow_run_id, workflow_name, job_name, step_name, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          row.model_name,
          row.spec_name,
          row.data_type,
          row.content_type,
          row.lifetime,
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
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Upserts foreign catalog rows from a catalog export. Uses INSERT OR
   * REPLACE so existing foreign rows are updated in place. Records the
   * sync timestamp in catalog_meta as `foreign_synced:{namespace}`.
   * Does NOT touch the global "populated" flag.
   */
  bulkUpsertForeign(
    namespace: string,
    rows: readonly CatalogRow[],
  ): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(`
        INSERT OR REPLACE INTO catalog (
          namespace, type_normalized, model_id, data_name, id, version, is_latest, model_name,
          spec_name, data_type, content_type, lifetime, owner_type,
          streaming, size, created_at, tags,
          owner_ref, workflow_run_id, workflow_name, job_name, step_name, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          row.model_name,
          row.spec_name,
          row.data_type,
          row.content_type,
          row.lifetime,
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

  /**
   * Returns the last sync timestamp for a foreign namespace's catalog,
   * or null if never synced.
   */
  foreignSyncedAt(namespace: string): string | null {
    const stmt = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = ?",
    );
    const row = stmt.get(`foreign_synced:${namespace}`) as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  }

  /**
   * Removes all rows for (namespace, type, model, name) regardless of version.
   * Used when an entire data item is deleted or tombstoned.
   */
  remove(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void {
    const stmt = this.db.prepare(
      "DELETE FROM catalog WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
    );
    stmt.run(namespace, typeNormalized, modelId, dataName);
  }

  /**
   * Records that `data_name` now forwards to `renamed_to`, replacing any
   * forward already recorded for the same name.
   */
  recordRename(row: RenameForwardRow): void {
    this.db.prepare(
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

  /** Removes the rename forward from (namespace, type, model, name), if any. */
  removeRename(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): void {
    this.db.prepare(
      "DELETE FROM catalog_renames WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ?",
    ).run(namespace, typeNormalized, modelId, dataName);
  }

  /**
   * Records `rows` as rename forwards in one transaction, replacing a forward
   * already recorded for the same name and leaving every other forward in
   * place. Backfill merges what its walk found this way, as it does catalog
   * rows: a walk with gaps (lazy hydration) must not drop a forward it could
   * not see. A forward made stale by a later write is ignored at query time,
   * since its old name has a latest row again.
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

  /** Every rename forward whose old name is `dataName`, in any model. */
  findRenamesFrom(dataName: string): RenameForwardRow[] {
    return this.db.prepare(
      "SELECT * FROM catalog_renames WHERE data_name = ?",
    ).all(dataName) as unknown as RenameForwardRow[];
  }

  /** The name `dataName` forwards to under one model, or null. */
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

  /** Whether (namespace, type, model, name) has a latest row. */
  hasLatestRow(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
  ): boolean {
    const row = this.db.prepare(
      "SELECT 1 FROM catalog WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND is_latest = 1 LIMIT 1",
    ).get(namespace, typeNormalized, modelId, dataName);
    return row !== undefined;
  }

  /**
   * Removes a single version row from the catalog.
   *
   * Callers that delete the row which was `is_latest` must subsequently
   * upsert the new latest via {@link upsertNewVersion}; this method does
   * not promote a surviving row on its own.
   */
  removeVersion(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    const stmt = this.db.prepare(
      `DELETE FROM catalog
       WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?`,
    );
    stmt.run(namespace, typeNormalized, modelId, dataName, version);
  }

  /**
   * Iterates over all catalog rows using paged queries.
   * Fetches rows in batches of {@link ITERATE_PAGE_SIZE} to bound memory.
   */
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

  /**
   * Direct indexed lookup for a single latest row by model name, data name,
   * and optional namespace. Uses the idx_catalog_latest_lookup composite
   * index instead of a full table scan.
   */
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

  /**
   * Returns all latest rows sharing a spec_name under a model, optionally
   * scoped to a namespace.  Used by the ambiguity check in data.latest() —
   * if more than one row shares the spec_name the lookup is ambiguous.
   */
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

  /**
   * Returns the number of rows in the catalog.
   */
  count(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM catalog");
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Counts latest-version rows grouped by normalized model type, optionally
   * scoped to a namespace.
   *
   * Exists so `swamp doctor datastores` can compare the index against what the
   * on-disk walk sees without going through {@link DataQueryService} — a query
   * triggers the very backfill being diagnosed, which would repair (or, on a
   * broken walk, further damage) the state before it could be reported.
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

  /**
   * Returns true if the catalog has been fully populated (backfill complete).
   *
   * On a shared filesystem datastore, another repository's write since the
   * last check invalidates the catalog first.
   */
  isPopulated(): boolean {
    this.invalidateOnForeignWrites();
    return this.readMeta("populated") === "true";
  }

  /**
   * Marks the catalog as fully populated.
   *
   * With `ifGeneration`, does nothing when the catalog was invalidated since
   * that generation was read: a backfill that walked the disk before the
   * invalidation must not mark the catalog fresh.
   */
  markPopulated(ifGeneration?: number): void {
    if (ifGeneration !== undefined && ifGeneration !== this.generation()) {
      return;
    }
    this.writeMeta("populated", "true");
  }

  /**
   * Clears the populated flag so the next query triggers a full backfill.
   * Used after remote datastore sync to ensure the catalog reflects
   * freshly-pulled data. Advances {@link generation}.
   */
  invalidate(): void {
    const stmt = this.db.prepare(
      "DELETE FROM catalog_meta WHERE key = 'populated'",
    );
    stmt.run();
    this.writeMeta("generation", String(this.generation() + 1));
  }

  /** Counts invalidations; see {@link markPopulated}. */
  generation(): number {
    return Number(this.readMeta("generation") ?? "0");
  }

  /**
   * Tells catalogs sharing this filesystem datastore that this repository
   * changed data on disk. Call after the write; a no-op without a tracker.
   *
   * Best-effort: the data is already committed, so a token that cannot be
   * written only delays other repositories noticing it, and must not fail
   * the write.
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

  /**
   * Returns distinct non-empty values for a catalog column.
   * Used for autocomplete in the interactive query TUI.
   */
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

  /**
   * Returns distinct tag keys across all catalog rows.
   * Parses the JSON `tags` column from each row.
   */
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

  /**
   * Returns distinct tag values for a given tag key.
   */
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

  /**
   * Checkpoints the WAL file using TRUNCATE mode, which writes all WAL frames
   * to the main database file and physically truncates the WAL to zero bytes.
   *
   * If active readers are still using WAL pages, SQLite returns fewer
   * checkpointed frames than total frames (partial checkpoint). The caller
   * should surface this discrepancy rather than treating it as an error — the
   * next checkpoint will catch the remaining frames.
   */
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
   * Removes multiple versions for a single (type, model, name) triple in a
   * single BEGIN IMMEDIATE transaction, replacing N individual removeVersion()
   * calls with one fsync.
   *
   * If the transaction fails, it is rolled back and the catalog remains
   * consistent. Falls back gracefully — callers may catch and retry with
   * individual removeVersion() calls if needed.
   */
  bulkRemoveVersions(
    namespace: string,
    typeNormalized: string,
    modelId: string,
    dataName: string,
    versions: readonly number[],
  ): void {
    if (versions.length === 0) return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(
        `DELETE FROM catalog
         WHERE namespace = ? AND type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?`,
      );
      for (const version of versions) {
        stmt.run(namespace, typeNormalized, modelId, dataName, version);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Rebuilds the database file to reclaim freed pages — a manual VACUUM.
   *
   * SQLite's native `VACUUM` (and `VACUUM INTO`) cannot run under Deno's
   * node:sqlite binding: both ATTACH a temporary database internally, but the
   * binding hardcodes `SQLITE_LIMIT_ATTACHED` to 0, so the attach is rejected
   * with "too many attached databases - max 0". Instead we rebuild manually:
   * copy the schema and stream every row into a fresh single-file database via
   * a second connection (no ATTACH), then atomically swap it into place.
   *
   * The rows are paged by rowid in {@link ITERATE_PAGE_SIZE} batches so a large
   * catalog is never loaded into memory at once. The rebuild transiently needs
   * roughly twice the catalog size in free disk (old file plus the temp file)
   * — the same requirement as native VACUUM.
   *
   * Must be called outside any open transaction and only when no other
   * connection is writing the catalog — the compact command holds the
   * datastore-global lock for this reason. Returns `true` on success, or
   * `false` (after logging a warning) if the rebuild failed, preserving the
   * graceful-degradation contract: the WAL checkpoint already reclaimed space.
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
    this.removeDbFiles(this.dbPath, { keepMain: true });
    try {
      // POSIX renameSync atomically replaces the destination.
      Deno.renameSync(tmpPath, this.dbPath);
    } catch {
      // Windows rejects rename onto an existing file — remove then rename.
      try {
        Deno.removeSync(this.dbPath);
      } catch {
        // Already gone — nothing to remove.
      }
      Deno.renameSync(tmpPath, this.dbPath);
    }

    // Reopen so the store stays valid for the caller, restoring WAL mode. No
    // other process can be opening concurrently (compact holds the global
    // lock), so WAL can be set eagerly without the constructor's retry.
    this.db = this.openConnection(this.dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    return true;
  }

  /**
   * Rebuilds the catalog into a fresh database at `targetPath`. Copies all DDL
   * (tables before indexes/triggers/views) then streams every row of every
   * user table inside a single transaction. Throws on any failure; the caller
   * cleans up `targetPath`.
   */
  private rebuildInto(targetPath: string): void {
    // Clear any stale temp artifacts from a previous interrupted run.
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
   * Streams every row of `table` from this database into `dst`, paging by
   * rowid in {@link ITERATE_PAGE_SIZE} batches so the full table is never
   * materialized in memory. Assumes a rowid table — both `catalog` and
   * `catalog_meta` are ordinary rowid tables; a WITHOUT ROWID table would
   * break this cursor.
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

  /**
   * Removes a SQLite database file and its WAL/SHM sidecars, ignoring any that
   * are already absent. Pass `keepMain` to drop only the sidecars.
   */
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

  /**
   * Returns the number of (namespace, type, model, name) groups that have
   * more than one `is_latest=1` row. Zero means the catalog is consistent.
   */
  countDuplicateLatest(): number {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM (
         SELECT namespace, type_normalized, model_id, data_name
         FROM catalog
         WHERE is_latest = 1
         GROUP BY namespace, type_normalized, model_id, data_name, step_name
         HAVING COUNT(*) > 1
       )`,
    );
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Scans all `is_latest=1` rows, recomputes the flag via
   * {@link computeLatestFlags}, and updates any rows whose flag changed.
   * Returns the number of rows demoted.
   *
   * Called after {@link bulkUpsert} in the backfill path to close the
   * race between the async disk walk and concurrent writes: a `save()`
   * that interleaves during the walk may demote a row that `bulkUpsert`
   * then re-promotes from stale in-memory state.
   */
  enforceUniqueLatest(
    computeFlags: (rows: CatalogRow[]) => void,
  ): number {
    const latestRows: CatalogRow[] = [
      ...this.iterateFiltered("is_latest = ?", [1]),
    ];
    if (latestRows.length === 0) return 0;

    computeFlags(latestRows);

    const demoted = latestRows.filter((r) => r.is_latest === 0);
    if (demoted.length === 0) return 0;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stmt = this.db.prepare(
        `UPDATE catalog SET is_latest = 0
         WHERE namespace = ? AND type_normalized = ? AND model_id = ?
           AND data_name = ? AND version = ?`,
      );
      for (const row of demoted) {
        stmt.run(
          row.namespace,
          row.type_normalized,
          row.model_id,
          row.data_name,
          row.version,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return demoted.length;
  }

  /**
   * Closes the database connection. Idempotent — a second call is a no-op, so
   * a `finally { close() }` cannot mask an earlier reopen failure (node:sqlite
   * throws "database is not open" on double-close).
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
