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
import { getLogger } from "@logtape/logtape";
import { canonicalizePath } from "./canonicalize_path.ts";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";
import { swampPath } from "./paths.ts";

const logger = getLogger(["swamp", "persistence", "extension-catalog"]);

/**
 * Marker key in bundle_meta recording that the per-extension-aggregate-v3
 * data migration has run successfully (or recovered via cold-start rebuild)
 * on this catalog. Set after the data-migration transaction commits;
 * checked at the top of the data-migration phase to skip the per-row
 * UPDATEs after the first successful run. Schema-level changes (ADD COLUMN)
 * are independently idempotent via pragma_table_info probes.
 */
const PER_EXTENSION_AGGREGATE_V3_MIGRATION_KEY =
  "migration_applied:per-extension-aggregate-v3";

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
   * (swamp-club#209). Vestigial after W1a — preserved on the row by the
   * ON CONFLICT DO UPDATE SET in {@link ExtensionCatalogStore.upsert}
   * (the column is intentionally not in the SET list) but no production
   * code reads or writes it. W1b drops the column entirely via the
   * SQLite recreate-table pattern. Until then, mapRow continues to
   * surface the value so legacy tests that introspect it can compile.
   */
  validation_failed?: boolean;
  /**
   * RowState tag (issue swamp-club#211, W1). One of `'Indexed'`,
   * `'Bundled'`, `'BundleBuildFailed'`, `'ValidationFailed'`,
   * `'EntryPointUnreadable'`, `'OrphanedBundleOnly'`, `'Tombstoned'`.
   * Optional on upsert: callers that omit it land at the column DEFAULT
   * `'Indexed'` on INSERT and preserve the prior value on UPDATE
   * (per-extension-aggregate-v3 schema). markCatalogValidationFailed is
   * the only writer that sets this to `'ValidationFailed'`; loader
   * populate paths leave it implicit so newly-bundled rows settle as
   * `'Indexed'`.
   *
   * Reader contract: every row registration site filters on this value
   * (`if (entry.state === 'ValidationFailed') continue;`). The
   * `validation_failed` column above is no longer a reader signal —
   * during the W1a → W1b release window it's a vestigial 0 for every
   * row.
   */
  state?: string;
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
  private readonly dbPath: string;

  constructor(dbPath: string) {
    ensureDirSync(dirname(dbPath));
    this.dbPath = dbPath;
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
        validation_failed  INTEGER NOT NULL DEFAULT 0,
        state              TEXT NOT NULL DEFAULT 'Indexed',
        extension_name     TEXT NOT NULL DEFAULT '',
        extension_version  TEXT NOT NULL DEFAULT ''
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
   * Adds columns introduced after the initial schema to existing DBs and
   * runs the data-migration backfill for the per-extension-aggregate-v3
   * layout (issue swamp-club#211, W1).
   *
   * Schema changes (ADD COLUMN) are idempotent via pragma_table_info
   * probes, applied outside any transaction since SQLite ALTER TABLE has
   * its own atomicity. The data-migration phase (canonicalize source_path,
   * backfill state from validation_failed, backfill extension_name via
   * the path heuristic, drop unmatched rows, post-condition verify)
   * runs inside ONE transaction with explicit ROLLBACK on any failure;
   * a marker key in bundle_meta records first-success so subsequent
   * process restarts skip the per-row UPDATEs.
   *
   * On post-condition failure (heuristic gap that the unit tests didn't
   * catch — typically a legacy on-disk path layout we don't recognize)
   * the data-migration transaction rolls back, then a separate cold-
   * start rebuild transaction drops every bundle_types row and clears
   * the bundle_meta `populated:*` keys so the next loader pass
   * reconstructs from disk. The loaders are the source of truth for
   * everything except identity columns; rebuild is non-destructive in
   * the meaningful sense (the disk state is preserved). Running this
   * function inherits the lock-retry + backoff logic from
   * initializeWithRetry.
   */
  private migrateSchema(): void {
    this.addNewColumnsIfMissing();
    if (this.isDataMigrationApplied()) {
      return;
    }
    this.runDataMigrationTransaction();
  }

  /**
   * Phase 1: idempotent ADD COLUMN via pragma_table_info probes. Includes
   * the columns added by previous migrations (source_fingerprint from #125,
   * validation_failed from #1286) plus the per-extension-aggregate-v3
   * columns (state, extension_name, extension_version). Order matches the
   * order columns landed historically so probes against existing DBs
   * produce stable results across migration generations.
   */
  private addNewColumnsIfMissing(): void {
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
    if (!hasColumn("state")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN state TEXT NOT NULL DEFAULT 'Indexed'",
      );
    }
    if (!hasColumn("extension_name")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN extension_name TEXT NOT NULL DEFAULT ''",
      );
    }
    if (!hasColumn("extension_version")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN extension_version TEXT NOT NULL DEFAULT ''",
      );
    }
  }

  /**
   * Returns true if {@link runDataMigrationTransaction} has already
   * succeeded (or recovered via cold-start rebuild) on this catalog.
   */
  private isDataMigrationApplied(): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(PER_EXTENSION_AGGREGATE_V3_MIGRATION_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  private markDataMigrationApplied(): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    );
    stmt.run(PER_EXTENSION_AGGREGATE_V3_MIGRATION_KEY);
  }

  /**
   * Phase 2: data-migration transaction. Inside one BEGIN/COMMIT:
   * canonicalize source_path, backfill state from validation_failed,
   * backfill extension_name via deriveExtensionIdentity (also writing
   * extension_version for local rows; pulled rows leave version empty
   * for W1b's lockfile-backed fallback to populate at read time), drop
   * unmatched rows, verify the post-condition (extension_name non-empty
   * for every remaining row).
   *
   * On any throw inside the transaction we ROLLBACK and recover via
   * a separate cold-start rebuild — drop every row, clear
   * `populated:*` keys, mark the migration as applied so subsequent
   * process restarts don't loop. The rebuild path is the only line
   * of defense against a bad backfill heuristic; we deliberately do
   * not propagate the throw because the loaders will repopulate the
   * catalog from disk on the next access.
   */
  private runDataMigrationTransaction(): void {
    this.db.exec("BEGIN");
    try {
      this.canonicalizeAllSourcePaths();
      this.db.exec(
        "UPDATE bundle_types SET state = 'ValidationFailed' WHERE validation_failed = 1",
      );
      this.backfillExtensionIdentity();
      this.db.exec(
        "DELETE FROM bundle_types WHERE extension_name = ''",
      );
      this.verifyPostMigrationInvariant();
      this.markDataMigrationApplied();
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      logger
        .warn`Catalog migration to per-extension-aggregate-v3 failed (${error}); falling back to cold-start rebuild`;
      this.runColdStartRebuild();
    }
  }

  /**
   * TS-driven per-row UPDATE. SQLite has no canonicalizePath function;
   * we iterate, compute canonical form in TypeScript, and UPDATE one
   * row at a time. Inside the data-migration transaction so the writes
   * roll back together on any failure. Skips rows whose source_path is
   * already canonical (the common case on POSIX where canonicalizePath
   * is the identity).
   *
   * If two rows canonicalize to the same string (only possible with
   * mixed-case access on Windows), the second UPDATE hits a UNIQUE
   * constraint failure on source_path. We DELETE the duplicate and log
   * a structured warning rather than aborting the migration.
   */
  private canonicalizeAllSourcePaths(): void {
    const rows = this.db
      .prepare("SELECT rowid AS rid, source_path FROM bundle_types")
      .all() as { rid: number; source_path: string }[];
    const updateStmt = this.db.prepare(
      "UPDATE bundle_types SET source_path = ? WHERE rowid = ?",
    );
    const deleteStmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE rowid = ?",
    );
    for (const row of rows) {
      const canonical = canonicalizePath(row.source_path);
      if (canonical === row.source_path) continue;
      try {
        updateStmt.run(canonical, row.rid);
      } catch (error) {
        const isUniqueViolation = error instanceof Error &&
          /UNIQUE constraint failed/i.test(error.message);
        if (!isUniqueViolation) throw error;
        logger
          .warn`Migration: dropping duplicate row at ${row.source_path} (canonical form already exists)`;
        deleteStmt.run(row.rid);
      }
    }
  }

  /**
   * TS-driven per-row UPDATE that calls deriveExtensionIdentity on each
   * row's canonical source_path. Backfills extension_name for both
   * pulled and local rows; backfills extension_version only for local
   * rows (pulled rows leave extension_version empty for W1b's
   * lockfile-backed fallback to populate at read time — see Option A
   * note in plan v6 step 2 sub-step 6 and the helper's docstring).
   * Rows where the helper returns null (unrecognized path layout) keep
   * their column DEFAULTs (extension_name='') and are dropped by the
   * subsequent DELETE in {@link runDataMigrationTransaction}.
   *
   * Only updates rows whose extension_name is currently empty — once a
   * row has an identity, repeat migration runs are a no-op for that
   * row.
   */
  private backfillExtensionIdentity(): void {
    // canonicalizePath both sides — sub-step 4 already canonicalized
    // every row's source_path, but inferRepoRootFromDbPath returns the
    // raw dbPath form which is native (backslashes, mixed case) on
    // Windows. deriveExtensionIdentity's docstring requires both inputs
    // pre-canonicalized so prefix matching is stable across mixed-case
    // filesystems; running canonicalizePath here makes the contract hold.
    const repoRoot = canonicalizePath(inferRepoRootFromDbPath(this.dbPath));
    const rows = this.db
      .prepare(
        "SELECT rowid AS rid, source_path FROM bundle_types WHERE extension_name = ''",
      )
      .all() as { rid: number; source_path: string }[];
    const updateStmt = this.db.prepare(
      "UPDATE bundle_types SET extension_name = ?, extension_version = ? WHERE rowid = ?",
    );
    for (const row of rows) {
      const identity = deriveExtensionIdentity(row.source_path, repoRoot);
      if (identity === null) continue;
      updateStmt.run(identity.name, identity.version, row.rid);
    }
  }

  /**
   * Post-condition for the data-migration transaction: every row must
   * have a non-empty extension_name. extension_version is intentionally
   * NOT checked because pulled rows leave it empty for W1b's lockfile
   * fallback (see plan v6 step 2 sub-step 8 — the architect-pinned
   * post-condition was narrowed when we discovered the issue body's
   * "encodes name and version in path" assumption was incorrect).
   *
   * If verification fails the throw bubbles up to
   * {@link runDataMigrationTransaction}'s catch, which runs ROLLBACK
   * and falls back to cold-start rebuild.
   */
  private verifyPostMigrationInvariant(): void {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM bundle_types WHERE extension_name = ''",
    );
    const row = stmt.get() as { cnt: number };
    if (row.cnt > 0) {
      throw new Error(
        `Post-migration invariant violated: ${row.cnt} row(s) with empty extension_name remain`,
      );
    }
  }

  /**
   * Recovery path when the data-migration transaction rolls back. Drops
   * every bundle_types row and clears the bundle_meta `populated:*`
   * flags so the next loader pass reconstructs the catalog from disk.
   * Marks the migration as applied even though rows are gone — the
   * marker says "schema is at v3 and we've recovered," not "all rows
   * have been backfilled." Subsequent restarts skip the data-migration
   * phase; the loaders' populate paths fill the empty catalog.
   *
   * Wrapped in its own transaction so rebuild itself is atomic. If
   * this fails too the catalog is left in whatever state ROLLBACK
   * produced; downstream code re-enters migrateSchema on the next
   * construction, which will retry the whole sequence.
   */
  private runColdStartRebuild(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM bundle_types");
      this.db.exec("DELETE FROM bundle_meta WHERE key LIKE 'populated:%'");
      this.markDataMigrationApplied();
      this.db.exec("COMMIT");
      logger
        .warn`Catalog cold-start rebuild complete; loaders will repopulate from disk on next access`;
    } catch (error) {
      this.db.exec("ROLLBACK");
      logger
        .error`Catalog cold-start rebuild failed (${error}); next migrateSchema run will retry`;
    }
  }

  /**
   * Upserts a bundle type entry. INSERT path writes every payload
   * column plus the W1a `state` column; UPDATE path (when a row with
   * the same source_path already exists) writes the legacy columns +
   * `state` but DELIBERATELY leaves `extension_name`, `extension_version`,
   * and the vestigial `validation_failed` untouched.
   *
   * The intentional-not-in-SET list resolves ADV-V3-1: under the previous
   * `INSERT OR REPLACE` pattern, omitted columns reset to DEFAULT on
   * every UPDATE, which silently undid the migration's
   * extension_name/extension_version backfill the first time a model-
   * loader rescan upserted a row. ON CONFLICT DO UPDATE SET preserves
   * the unwritten columns.
   *
   * `state` IS in the SET list because the loader is the source of
   * truth for state — it transitions a row from `'ValidationFailed'`
   * back to `'Indexed'` when validation later succeeds, and from
   * `'Indexed'` to `'ValidationFailed'` via markCatalogValidationFailed.
   * Callers that don't pass `row.state` get the column DEFAULT
   * `'Indexed'` on INSERT and `'Indexed'` on UPDATE (since the bind
   * defaults to `'Indexed'`).
   */
  upsert(row: ExtensionTypeRow): void {
    const stmt = this.db.prepare(`
      INSERT INTO bundle_types (
        source_path, type_normalized, kind, bundle_path,
        version, description, extends_type, source_mtime,
        source_fingerprint, state
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        type_normalized    = excluded.type_normalized,
        kind               = excluded.kind,
        bundle_path        = excluded.bundle_path,
        version            = excluded.version,
        description        = excluded.description,
        extends_type       = excluded.extends_type,
        source_mtime       = excluded.source_mtime,
        source_fingerprint = excluded.source_fingerprint,
        state              = excluded.state
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
      row.state ?? "Indexed",
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
   * INTEGER 0/1 `validation_failed` column to a boolean (SQLite has no
   * native boolean type) and surfaces the W1a `state` column as a
   * string with `'Indexed'` as defensive default.
   *
   * findByKind and findByType deliberately do NOT filter on `state` or
   * `validation_failed`: findStaleFiles needs to see broken rows so the
   * fingerprint match terminates the rebundle loop (swamp-club#209).
   * Registration call sites filter on `state === 'ValidationFailed'`
   * instead. The legacy `validation_failed` boolean is preserved on
   * the row through the W1a → W1b release window for backwards
   * compatibility with tests; W1b drops the column entirely.
   */
  private mapRow(raw: Record<string, unknown>): ExtensionTypeRow {
    const stateRaw = raw.state;
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
      state: typeof stateRaw === "string" && stateRaw.length > 0
        ? stateRaw
        : "Indexed",
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

/**
 * Recovers the repository root from the catalog's database path.
 * The catalog opens at `<repoRoot>/.swamp/_extension_catalog.db`, so
 * `dirname(dirname(dbPath))` gives the repository root. Used by the
 * data-migration backfill to resolve `<repoRoot>/extensions/<kind>/`
 * and `<repoRoot>/.swamp/pulled-extensions/` prefixes against catalog
 * row source_paths without needing a separate constructor parameter.
 *
 * The catalog's dbPath is a hard-coded layout assumption (see
 * `swampPath(repoDir, "_extension_catalog.db")`); if that layout ever
 * changes, this helper has to change with it.
 */
function inferRepoRootFromDbPath(dbPath: string): string {
  return dirname(dirname(dbPath));
}
