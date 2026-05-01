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
import { swampPath } from "./paths.ts";

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
  /**
   * sha-256 fingerprint over the entry point + transitive local imports.
   * Models loader uses this for freshness (issue #125 — mtime-only was
   * fragile under atomic-rename saves and mtime-preserving sync tools).
   * Optional while the sibling loaders (reports, drivers, datastores,
   * vaults) still use mtime; they can omit it on upsert and the store
   * coerces to "". Old catalog rows default to "" via the migration.
   */
  source_fingerprint?: string;
  /**
   * True when bundle+import succeeded but schema validation failed
   * (swamp-club#209). The fingerprint and bundle path are still stored
   * so freshness comparison terminates on a stable broken source —
   * registration paths filter on this flag to keep broken types out of
   * the registry. findByKind/findByType deliberately do NOT filter on
   * this column so freshness (findStaleFiles) can see broken rows.
   * Defaults to false on upsert; old catalog rows default to false via
   * the migration.
   */
  validation_failed?: boolean;
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
        this.createSchema();
        this.migrateSchema();
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
      CREATE TABLE IF NOT EXISTS bundle_types (
        source_path        TEXT NOT NULL PRIMARY KEY,
        type_normalized    TEXT NOT NULL,
        kind               TEXT NOT NULL DEFAULT 'model',
        bundle_path        TEXT NOT NULL,
        version            TEXT NOT NULL DEFAULT '',
        description        TEXT NOT NULL DEFAULT '',
        extends_type       TEXT NOT NULL DEFAULT '',
        source_mtime       TEXT NOT NULL DEFAULT '',
        source_fingerprint TEXT NOT NULL DEFAULT '',
        validation_failed  INTEGER NOT NULL DEFAULT 0
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
   * Adds columns introduced after the initial schema to existing DBs.
   * Probes via PRAGMA table_info before issuing ALTER TABLE so the
   * migration runs on SQLite versions without ADD COLUMN IF NOT EXISTS
   * support, and is idempotent across process restarts. Called from
   * initializeWithRetry so it inherits the lock-retry + backoff logic.
   */
  private migrateSchema(): void {
    const probe = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('bundle_types') WHERE name = ?",
    );
    const hasColumn = (name: string): boolean => {
      const row = probe.get(name) as { cnt: number } | undefined;
      return (row?.cnt ?? 0) > 0;
    };
    if (!hasColumn("source_fingerprint")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN source_fingerprint TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!hasColumn("validation_failed")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN validation_failed INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

  /**
   * Upserts a bundle type entry. Replaces any existing row with
   * the same source path (primary key).
   */
  upsert(row: ExtensionTypeRow): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO bundle_types (
        source_path, type_normalized, kind, bundle_path,
        version, description, extends_type, source_mtime,
        source_fingerprint, validation_failed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      row.source_fingerprint ?? "",
      row.validation_failed ? 1 : 0,
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
   * Coerces a raw SQLite row into a typed ExtensionTypeRow. Maps the
   * INTEGER 0/1 `validation_failed` column to a boolean — SQLite has no
   * native boolean type, so the column is stored as INTEGER but consumers
   * expect a boolean.
   *
   * findByKind and findByType deliberately do NOT filter on
   * validation_failed: findStaleFiles needs to see broken rows so the
   * fingerprint match terminates the rebundle loop (swamp-club#209).
   * Registration call sites filter on the coerced boolean instead.
   */
  private mapRow(raw: Record<string, unknown>): ExtensionTypeRow {
    return {
      source_path: raw.source_path as string,
      type_normalized: raw.type_normalized as string,
      kind: raw.kind as ExtensionKind,
      bundle_path: raw.bundle_path as string,
      version: raw.version as string,
      description: raw.description as string,
      extends_type: raw.extends_type as string,
      source_mtime: raw.source_mtime as string,
      source_fingerprint: raw.source_fingerprint as string,
      validation_failed: raw.validation_failed === 1,
    };
  }

  /**
   * Returns all entries for a given kind (e.g. all "model" entries).
   *
   * Includes validation-failed rows; consumers that should not register
   * broken types must filter on `row.validation_failed` themselves.
   * findStaleFiles relies on this inclusion to terminate the rebundle
   * loop on schema-invalid sources (swamp-club#209).
   */
  findByKind(kind: ExtensionKind): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE kind = ? ORDER BY type_normalized",
    );
    return (stmt.all(kind) as Record<string, unknown>[]).map((r) =>
      this.mapRow(r)
    );
  }

  /**
   * Returns the entry for a specific type and kind, or undefined.
   *
   * Validation-failed rows have empty `type_normalized` so they can
   * never match a real type lookup here — the protection against
   * surfacing broken types via this path is structural, not via a
   * filter clause.
   */
  findByType(
    typeNormalized: string,
    kind: ExtensionKind,
  ): ExtensionTypeRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE type_normalized = ? AND kind = ?",
    );
    const row = stmt.get(typeNormalized, kind) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  /**
   * Returns all extension entries that target a given base type.
   * Used by ensureTypeLoaded() to find extensions that add methods
   * to a base model type.
   *
   * Validation-failed rows have empty `extends_type` so they fall out
   * of this query naturally.
   */
  findExtensionsForType(baseType: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE extends_type = ? AND kind = 'extension' ORDER BY type_normalized",
    );
    return (stmt.all(baseType) as Record<string, unknown>[]).map((r) =>
      this.mapRow(r)
    );
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
   * Returns the stored bundle layout version, or undefined if not set.
   * Used to detect when the bundle path scheme has changed and a full
   * rescan is needed.
   */
  getLayoutVersion(): string | undefined {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = 'bundle_layout'",
    );
    const row = stmt.get() as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Stores the bundle layout version. Set after a successful rescan
   * so subsequent runs skip the migration check.
   */
  setLayoutVersion(version: string): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES ('bundle_layout', ?)",
    );
    stmt.run(version);
  }

  /**
   * Returns the stored datastore base path, or undefined if not set.
   * Used to detect when the datastore configuration has changed and a
   * full rescan is needed so bundle paths point to the new location.
   */
  getDatastoreBasePath(): string | undefined {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = 'datastore_base_path'",
    );
    const row = stmt.get() as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Stores the datastore base path. Set after a successful catalog
   * population so subsequent runs can detect datastore changes.
   */
  setDatastoreBasePath(basePath: string): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES ('datastore_base_path', ?)",
    );
    stmt.run(basePath);
  }

  /**
   * Returns the stored source directories fingerprint, or undefined if not set.
   * Used to detect when extension sources have been added or removed,
   * triggering a full rescan so new source entries are discovered.
   *
   * @param kind - Optional extension kind for per-kind fingerprints. When
   *   omitted, reads the legacy global key (backward-compatible with model
   *   loader calls that predate per-kind support).
   */
  getSourceDirsFingerprint(kind?: ExtensionKind): string | undefined {
    const key = kind
      ? `source_dirs_fingerprint:${kind}`
      : "source_dirs_fingerprint";
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Stores a fingerprint of the current source directories. Set after a
   * successful catalog population so subsequent runs can detect source changes.
   *
   * @param fingerprint - The fingerprint string to store.
   * @param kind - Optional extension kind for per-kind fingerprints. When
   *   omitted, writes the legacy global key.
   */
  setSourceDirsFingerprint(fingerprint: string, kind?: ExtensionKind): void {
    const key = kind
      ? `source_dirs_fingerprint:${kind}`
      : "source_dirs_fingerprint";
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, ?)",
    );
    stmt.run(key, fingerprint);
  }

  /**
   * Closes the database connection.
   */
  close(): void {
    this.db.close();
  }
}

/**
 * Stable fingerprint of a set of directories.
 * Used by loaders to detect when extension source directories have been
 * added or removed between runs, triggering a catalog invalidation.
 */
export function sourceDirsFingerprint(
  primaryDir: string,
  additionalDirs?: string[],
): string {
  const dirs = [primaryDir, ...(additionalDirs ?? [])];
  return dirs.sort().join("\n");
}

/**
 * Invalidates every kind in the bundle catalog so the next
 * `ensureLoaded()` runs the full discovery + validation pass instead
 * of taking the lazy short-circuit. Used by commands that need a
 * deterministic re-load regardless of prior catalog state — e.g.
 * `swamp open` (after a repo switch) and `swamp doctor extensions`
 * (so the diagnostic always re-validates).
 *
 * Invalidates only the five registry kinds that own a `populated:`
 * flag in `bundle_meta` (model, vault, driver, datastore, report).
 * The `extension` ExtensionKind is recorded on individual catalog
 * rows but never gets its own populated flag — it is always
 * re-discovered through the model populate path. See
 * {@link ExtensionCatalogStore.markPopulated} for the canonical
 * list of flag-owning kinds.
 *
 * Best-effort: a failure to open the database is swallowed so the
 * caller's flow continues. The next loader pass will bootstrap a
 * fresh catalog if the file is missing or corrupt.
 */
export function forceCatalogRescan(repoDir: string): void {
  try {
    const dbPath = swampPath(repoDir, "_extension_catalog.db");
    const catalog = new ExtensionCatalogStore(dbPath);
    try {
      catalog.invalidate("model");
      catalog.invalidate("vault");
      catalog.invalidate("driver");
      catalog.invalidate("datastore");
      catalog.invalidate("report");
    } finally {
      catalog.close();
    }
  } catch {
    // Best-effort — the loader will bootstrap a fresh catalog if this fails.
  }
}
