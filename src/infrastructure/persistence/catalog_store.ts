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
 * A single row in the catalog table, representing the latest version
 * of a data artifact.
 */
export interface CatalogRow {
  type_normalized: string;
  model_id: string;
  data_name: string;
  id: string;
  version: number;
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
}

/**
 * SQLite-backed metadata catalog for data query.
 *
 * Stores one row per data artifact (latest version only) with all metadata
 * fields needed for CEL predicate evaluation. Content is NOT stored — it
 * remains on disk in the existing versioned file layout.
 *
 * The catalog is local-only and excluded from datastore sync. It self-heals
 * by triggering a backfill when missing or not yet populated.
 */
export const ITERATE_PAGE_SIZE = 1000;

export class CatalogStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDirSync(dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS catalog (
        type_normalized TEXT NOT NULL,
        model_id        TEXT NOT NULL,
        data_name       TEXT NOT NULL,
        id              TEXT NOT NULL,
        version         INTEGER NOT NULL,
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
        PRIMARY KEY (type_normalized, model_id, data_name)
      );

      CREATE INDEX IF NOT EXISTS idx_catalog_model_name ON catalog(model_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_spec_name  ON catalog(spec_name);
      CREATE INDEX IF NOT EXISTS idx_catalog_data_type  ON catalog(data_type);
      CREATE INDEX IF NOT EXISTS idx_catalog_created_at ON catalog(created_at);

      CREATE TABLE IF NOT EXISTS catalog_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Upserts a row into the catalog. Replaces any existing row with the
   * same primary key (type_normalized, model_id, data_name).
   */
  upsert(row: CatalogRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO catalog (
        type_normalized, model_id, data_name, id, version, model_name,
        spec_name, data_type, content_type, lifetime, owner_type,
        streaming, size, created_at, tags
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.type_normalized,
      row.model_id,
      row.data_name,
      row.id,
      row.version,
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
    );
  }

  /**
   * Removes a row from the catalog by its primary key.
   */
  remove(typeNormalized: string, modelId: string, dataName: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM catalog WHERE type_normalized = ? AND model_id = ? AND data_name = ?",
    );
    stmt.run(typeNormalized, modelId, dataName);
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
      | "size",
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
