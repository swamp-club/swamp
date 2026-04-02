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
 * The kind of bundle entry — which registry type it belongs to.
 * Designed to support all registries from day one even though
 * only "model" and "extension" are wired up initially.
 */
export type ExtensionKind =
  | "model"
  | "extension"
  | "vault"
  | "driver"
  | "datastore"
  | "report";

/**
 * A single row in the bundle_types table.
 */
export interface ExtensionTypeRow {
  type_normalized: string;
  kind: ExtensionKind;
  bundle_path: string;
  source_path: string;
  version: string;
  description: string;
  extends_type: string;
  source_mtime: string;
}

/**
 * SQLite-backed metadata catalog for extension bundle types.
 *
 * Stores one row per bundle type with metadata needed for lazy loading:
 * type name, bundle path, source mtime, and extension target. This allows
 * the model registry to know what types exist without importing any bundles.
 *
 * Completely independent of {@link CatalogStore} (data queries). Uses a
 * separate database file at `.swamp/_extension_catalog.db`.
 *
 * Self-heals by triggering a full import when the DB is missing or the
 * populated flag is not set.
 */
export class ExtensionCatalogStore {
  private readonly db: DatabaseSync;

  constructor(dbPath: string) {
    ensureDirSync(dirname(dbPath));
    this.db = new DatabaseSync(dbPath);
    // busy_timeout must be set BEFORE journal_mode=WAL so SQLite retries
    // instead of failing immediately when another process holds the lock.
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA journal_mode=WAL");
    this.createSchema();
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bundle_types (
        source_path     TEXT NOT NULL PRIMARY KEY,
        type_normalized TEXT NOT NULL,
        kind            TEXT NOT NULL DEFAULT 'model',
        bundle_path     TEXT NOT NULL,
        version         TEXT NOT NULL DEFAULT '',
        description     TEXT NOT NULL DEFAULT '',
        extends_type    TEXT NOT NULL DEFAULT '',
        source_mtime    TEXT NOT NULL DEFAULT ''
      );

      CREATE INDEX IF NOT EXISTS idx_bundle_types_kind
        ON bundle_types(kind);
      CREATE INDEX IF NOT EXISTS idx_bundle_types_extends
        ON bundle_types(extends_type);
      CREATE INDEX IF NOT EXISTS idx_bundle_types_type
        ON bundle_types(type_normalized, kind);

      CREATE TABLE IF NOT EXISTS bundle_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
  }

  /**
   * Upserts a bundle type entry. Replaces any existing row with
   * the same source path (primary key).
   */
  upsert(row: ExtensionTypeRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bundle_types (
        source_path, type_normalized, kind, bundle_path,
        version, description, extends_type, source_mtime
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      row.source_path,
      row.type_normalized,
      row.kind,
      row.bundle_path,
      row.version,
      row.description,
      row.extends_type,
      row.source_mtime,
    );
  }

  /**
   * Removes a bundle type entry by source path.
   */
  removeBySourcePath(sourcePath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE source_path = ?",
    );
    stmt.run(sourcePath);
  }

  /**
   * Removes all entries for a given source path prefix.
   * Used when an extension is removed — deletes all types that came from
   * source files under that directory.
   */
  removeBySourcePrefix(sourcePrefix: string): number {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE source_path LIKE ?",
    );
    const result = stmt.run(`${sourcePrefix}%`);
    return Number(result.changes);
  }

  /**
   * Returns all entries for a given kind (e.g. all "model" entries).
   */
  findByKind(kind: ExtensionKind): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE kind = ? ORDER BY type_normalized",
    );
    return stmt.all(kind) as unknown as ExtensionTypeRow[];
  }

  /**
   * Returns the entry for a specific type and kind, or undefined.
   */
  findByType(
    typeNormalized: string,
    kind: ExtensionKind,
  ): ExtensionTypeRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE type_normalized = ? AND kind = ?",
    );
    return stmt.get(typeNormalized, kind) as unknown as
      | ExtensionTypeRow
      | undefined;
  }

  /**
   * Returns all extension entries that target a given base type.
   * Used by ensureTypeLoaded() to find extensions that add methods
   * to a base model type.
   */
  findExtensionsForType(baseType: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE extends_type = ? AND kind = 'extension' ORDER BY type_normalized",
    );
    return stmt.all(baseType) as unknown as ExtensionTypeRow[];
  }

  /**
   * Returns the total number of entries.
   */
  count(kind?: ExtensionKind): number {
    if (kind) {
      const stmt = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM bundle_types WHERE kind = ?",
      );
      const row = stmt.get(kind) as { cnt: number };
      return row.cnt;
    }
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM bundle_types",
    );
    const row = stmt.get() as { cnt: number };
    return row.cnt;
  }

  /**
   * Returns true if the catalog has been fully populated for a given kind.
   */
  isPopulated(kind: ExtensionKind): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(`populated:${kind}`) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  /**
   * Marks the catalog as fully populated for a given kind.
   */
  markPopulated(kind: ExtensionKind): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    );
    stmt.run(`populated:${kind}`);
  }

  /**
   * Clears the populated flag for a given kind so the next access
   * triggers a full rescan.
   */
  invalidate(kind: ExtensionKind): void {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_meta WHERE key = ?",
    );
    stmt.run(`populated:${kind}`);
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }
}
