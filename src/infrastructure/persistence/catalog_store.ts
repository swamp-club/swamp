// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

/**
 * A single row in the catalog table, representing one version of a data
 * artifact. The `is_latest` flag is set on exactly one row per
 * (type_normalized, model_id, data_name) triple.
 */
export interface CatalogRow {
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

/**
 * Schema version. Bump this when the catalog table structure changes.
 * On startup, if the stored version differs, the catalog is dropped and
 * rebuilt via self-healing backfill.
 */
export const CATALOG_SCHEMA_VERSION = "3";

export class CatalogStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDirSync(dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA busy_timeout=5000");
    this.initializeWithRetry();
  }

  /**
   * Initializes WAL mode and schema with retry logic.
   * PRAGMA journal_mode=WAL requires an exclusive lock to switch modes.
   * When multiple processes open the database simultaneously, the SQLite
   * busy handler may not cover the mode switch reliably, so we retry at
   * the application level with exponential backoff.
   */
  private initializeWithRetry(): void {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.db.exec("PRAGMA journal_mode=WAL");

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
        PRIMARY KEY (type_normalized, model_id, data_name, version)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_model_name      ON catalog(model_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_spec_name       ON catalog(spec_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_data_type       ON catalog(data_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_created_at      ON catalog(created_at);
      CREATE INDEX IF NOT EXISTS idx_catalog_workflow_run_id ON catalog(workflow_run_id);
      CREATE INDEX IF NOT EXISTS idx_catalog_step_name       ON catalog(step_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_is_latest       ON catalog(type_normalized, model_id, data_name, is_latest);

      CREATE TABLE IF NOT EXISTS catalog_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Checks the stored schema version against {@link CATALOG_SCHEMA_VERSION}.
   * If they differ, drops the catalog table and clears the populated flag
   * so the next query triggers a full backfill with the new schema.
   */
  private migrateIfNeeded(): void {
    const stmt = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = 'schema_version'",
    );
    const row = stmt.get() as { value: string } | undefined;
    if (row?.value === CATALOG_SCHEMA_VERSION) return;

    this.db.exec("DROP TABLE IF EXISTS catalog");
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
   * same primary key (type_normalized, model_id, data_name, version).
   *
   * Writes `is_latest` exactly as supplied. Backfill uses this because it
   * knows the correct `is_latest` for every version up front. Runtime writes
   * from a single write path should use {@link upsertNewVersion} instead,
   * which atomically maintains the "exactly one latest per name" invariant.
   */
  upsert(row: CatalogRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO catalog (
        type_normalized, model_id, data_name, id, version, is_latest, model_name,
        spec_name, data_type, content_type, lifetime, owner_type,
        streaming, size, created_at, tags,
        owner_ref, workflow_run_id, workflow_name, job_name, step_name, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
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
   * `is_latest` on any prior rows for that triple. The `is_latest` field on
   * the supplied row is ignored — this method always writes `1`.
   *
   * Runs in an IMMEDIATE transaction so concurrent writers serialize
   * through SQLite's reserved lock rather than racing on the flag.
   */
  upsertNewVersion(row: CatalogRow): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `UPDATE catalog SET is_latest = 0
         WHERE type_normalized = ? AND model_id = ? AND data_name = ?
           AND is_latest = 1`,
      ).run(row.type_normalized, row.model_id, row.data_name);
      this.upsert({ ...row, is_latest: 1 });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * Replaces the entire catalog contents with the supplied rows in a single
   * transaction. Used by the backfill path to rebuild the catalog from disk
   * in one shot — avoids 10,000+ implicit-transaction fsyncs that would
   * otherwise leave the catalog in a half-populated state if the process
   * died mid-backfill.
   */
  bulkReplaceAll(rows: readonly CatalogRow[]): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM catalog");
      const stmt = this.db.prepare(`
        INSERT INTO catalog (
          type_normalized, model_id, data_name, id, version, is_latest, model_name,
          spec_name, data_type, content_type, lifetime, owner_type,
          streaming, size, created_at, tags,
          owner_ref, workflow_run_id, workflow_name, job_name, step_name, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        stmt.run(
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
   * Removes all rows for (type, model, name) regardless of version.
   * Used when an entire data item is deleted or tombstoned.
   */
  remove(typeNormalized: string, modelId: string, dataName: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM catalog WHERE type_normalized = ? AND model_id = ? AND data_name = ?",
    );
    stmt.run(typeNormalized, modelId, dataName);
  }

  /**
   * Removes a single version row from the catalog.
   *
   * Callers that delete the row which was `is_latest` must subsequently
   * upsert the new latest via {@link upsertNewVersion}; this method does
   * not promote a surviving row on its own.
   */
  removeVersion(
    typeNormalized: string,
    modelId: string,
    dataName: string,
    version: number,
  ): void {
    const stmt = this.db.prepare(
      `DELETE FROM catalog
       WHERE type_normalized = ? AND model_id = ? AND data_name = ? AND version = ?`,
    );
    stmt.run(typeNormalized, modelId, dataName, version);
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

  /**
   * Returns the number of rows in the catalog.
   */
  count(): number {
    const stmt = this.db.prepare("SELECT COUNT(*) as cnt FROM catalog");
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Returns true if the catalog has been fully populated (backfill complete).
   */
  isPopulated(): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM catalog_meta WHERE key = 'populated'",
    );
    const row = stmt.get() as { value: string } | undefined;
    return row?.value === "true";
  }

  /**
   * Marks the catalog as fully populated.
   */
  markPopulated(): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO catalog_meta (key, value) VALUES ('populated', 'true')",
    );
    stmt.run();
  }

  /**
   * Clears the populated flag so the next query triggers a full backfill.
   * Used after remote datastore sync to ensure the catalog reflects
   * freshly-pulled data.
   */
  invalidate(): void {
    const stmt = this.db.prepare(
      "DELETE FROM catalog_meta WHERE key = 'populated'",
    );
    stmt.run();
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
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }
}
