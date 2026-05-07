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
 * Marker key in bundle_meta recording that the W1b drop-validation-failed
 * migration has run successfully on this catalog. Set after the SQLite
 * recreate-table transaction commits; the migration probes both this
 * marker AND `pragma_table_info('bundle_types')` for `validation_failed`
 * (defence in depth — the marker is the primary signal, the pragma probe
 * handles a hypothetical delete-marker-but-keep-column corruption).
 */
const VALIDATION_FAILED_DROPPED_MIGRATION_KEY =
  "migration_applied:validation-failed-dropped-v1";

/**
 * Bundle layout version stored in `bundle_meta`. Bumped whenever the
 * on-disk bundle path scheme changes; loaders compare this against the
 * catalog's current value via {@link ExtensionRepository.invalidationGuards}
 * and force a full rescan on mismatch. Hoisted from the model loader
 * (where the constant historically lived) to a shared location in W1b
 * so all 5 loaders reference the same source of truth (closing the
 * audit's "model has 3 guards, siblings have 1" coverage gap).
 */
export const BUNDLE_LAYOUT_VERSION = "per-extension-aggregate-v4";

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
  /**
   * Owning extension's logical name. Backfilled by the W1a migration
   * (`@local/<repo-name>` for locals, `@scope/foo` parsed from
   * pulled-extensions paths). Empty when the W1a heuristic couldn't
   * derive an identity — the W1b ExtensionRepository's empty-identity
   * fallback handles those rows by re-deriving via
   * {@link deriveExtensionIdentity} or DELETing as orphans.
   */
  extension_name?: string;
  /**
   * Owning extension's CalVer string. Backfilled by W1a; deliberately
   * empty for pulled rows because the on-disk pulled-extensions tree
   * encodes only the name. The W1b ExtensionRepository consults the
   * lockfile (`upstream_extensions.json`) at read time and writes back
   * the resolved version.
   */
  extension_version?: string;
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
    // W1b: fresh catalogs no longer carry the vestigial validation_failed
    // column — the W1a-era #1286 sentinel folded into the state TEXT
    // discriminant. Old catalogs that still have the column get it
    // dropped by `dropValidationFailedColumn()` during migrateSchema.
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
    if (!this.isDataMigrationApplied()) {
      this.runDataMigrationTransaction();
    }
    // W1b: drop the vestigial validation_failed column. Runs AFTER the
    // data-migration phase so all rows already have `state` populated;
    // gated on its own bundle_meta marker AND a pragma_table_info probe
    // for defence in depth.
    this.dropValidationFailedColumn();
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
    // validation_failed: NOT added here. W1a's #1286 column landed before
    // W1b; fresh catalogs no longer carry it (createSchema omits it), and
    // old catalogs that still have it get it dropped by
    // dropValidationFailedColumn() later in migrateSchema.
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
   * Returns true if {@link dropValidationFailedColumn} has already
   * succeeded on this catalog.
   */
  private isValidationFailedDropped(): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(VALIDATION_FAILED_DROPPED_MIGRATION_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  private markValidationFailedDropped(): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    );
    stmt.run(VALIDATION_FAILED_DROPPED_MIGRATION_KEY);
  }

  /**
   * Phase 3: drop the vestigial `validation_failed` column via the
   * SQLite recreate-table pattern (architect-required: NOT raw
   * `ALTER TABLE DROP COLUMN`, which is unsupported on older SQLite
   * versions Deno's `node:sqlite` runtime may bundle).
   *
   * Idempotent via two checks:
   *   1. The bundle_meta marker key
   *      `migration_applied:validation-failed-dropped-v1`. Set after
   *      successful commit; subsequent calls return immediately.
   *   2. `pragma_table_info('bundle_types')` probe for the
   *      `validation_failed` column. Defence in depth — if the marker
   *      is somehow set but the column survives (corrupt state), the
   *      probe still triggers a drop. If the column is already absent
   *      (fresh catalog from `createSchema`), we mark and return.
   *
   * The dance, inside one transaction with ROLLBACK on any step's
   * failure:
   *   1. CREATE TABLE bundle_types_new (all columns EXCEPT
   *      validation_failed)
   *   2. INSERT INTO bundle_types_new (explicit column list, no
   *      SELECT *) SELECT (explicit column list) FROM bundle_types
   *   3. DROP TABLE bundle_types
   *   4. ALTER TABLE bundle_types_new RENAME TO bundle_types
   *   5. CREATE INDEX idx_bundle_types_kind / _extends / _type
   *      explicitly recreated; verify via sqlite_master post-condition.
   *
   * bundle_meta is a separate table; the recreate-table dance does NOT
   * touch it; the W1a marker survives across the W1b drop.
   *
   * Forward-only on revert: post-PR, downgrade requires deleting
   * `_extension_catalog.db` (cold-start rebuilds). This is documented
   * in the PR description.
   */
  private dropValidationFailedColumn(): void {
    if (this.isValidationFailedDropped()) {
      return;
    }
    const probe = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('bundle_types') WHERE name = 'validation_failed'",
    );
    const row = probe.get() as { cnt: number } | undefined;
    if ((row?.cnt ?? 0) === 0) {
      // Column already absent (fresh catalog from createSchema, or a
      // hypothetical previously-completed drop without the marker).
      // Set the marker so subsequent runs short-circuit on check #1.
      this.markValidationFailedDropped();
      return;
    }

    this.db.exec("BEGIN");
    try {
      this.db.exec(`
        CREATE TABLE bundle_types_new (
          source_path        TEXT NOT NULL PRIMARY KEY,
          type_normalized    TEXT NOT NULL,
          kind               TEXT NOT NULL DEFAULT 'model',
          bundle_path        TEXT NOT NULL,
          version            TEXT NOT NULL DEFAULT '',
          description        TEXT NOT NULL DEFAULT '',
          extends_type       TEXT NOT NULL DEFAULT '',
          source_mtime       TEXT NOT NULL DEFAULT '',
          source_fingerprint TEXT NOT NULL DEFAULT '',
          state              TEXT NOT NULL DEFAULT 'Indexed',
          extension_name     TEXT NOT NULL DEFAULT '',
          extension_version  TEXT NOT NULL DEFAULT ''
        );
      `);
      this.db.exec(`
        INSERT INTO bundle_types_new (
          source_path, type_normalized, kind, bundle_path,
          version, description, extends_type, source_mtime,
          source_fingerprint, state, extension_name, extension_version
        ) SELECT
          source_path, type_normalized, kind, bundle_path,
          version, description, extends_type, source_mtime,
          source_fingerprint, state, extension_name, extension_version
        FROM bundle_types;
      `);
      this.db.exec("DROP TABLE bundle_types;");
      this.db.exec("ALTER TABLE bundle_types_new RENAME TO bundle_types;");
      // Recreate all 3 indexes explicitly — DROP TABLE drops them too.
      this.db.exec(
        "CREATE INDEX idx_bundle_types_kind ON bundle_types(kind);",
      );
      this.db.exec(
        "CREATE INDEX idx_bundle_types_extends ON bundle_types(extends_type);",
      );
      this.db.exec(
        "CREATE INDEX idx_bundle_types_type ON bundle_types(type_normalized, kind);",
      );
      this.markValidationFailedDropped();
      this.db.exec("COMMIT");
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort: a failed ROLLBACK shouldn't shadow the original error.
      }
      logger
        .error`W1b drop-validation_failed migration failed (${error}); the column survives until the next migrateSchema run retries`;
      throw error;
    }
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
      // The validation_failed → state backfill only runs against
      // catalogs that still have the column. Fresh W1b catalogs
      // (createSchema omits the column) and post-W1b-drop catalogs
      // skip this step — their state column already carries the
      // discriminant value directly.
      if (this.hasValidationFailedColumn()) {
        this.db.exec(
          "UPDATE bundle_types SET state = 'ValidationFailed' WHERE validation_failed = 1",
        );
      }
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

  private hasValidationFailedColumn(): boolean {
    const probe = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('bundle_types') WHERE name = 'validation_failed'",
    );
    const row = probe.get() as { cnt: number } | undefined;
    return (row?.cnt ?? 0) > 0;
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
   * Returns the entry for a specific source path (PK lookup), or undefined.
   */
  findBySourcePath(sourcePath: string): ExtensionTypeRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE source_path = ?",
    );
    const row = stmt.get(sourcePath) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : undefined;
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
      state: typeof stateRaw === "string" && stateRaw.length > 0
        ? stateRaw
        : "Indexed",
      extension_name: typeof raw.extension_name === "string"
        ? raw.extension_name
        : "",
      extension_version: typeof raw.extension_version === "string"
        ? raw.extension_version
        : "",
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

  getManifestIdentity(): string | undefined {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = 'manifest_identity'",
    );
    const row = stmt.get() as { value: string } | undefined;
    return row?.value;
  }

  setManifestIdentity(identity: string | null): void {
    if (identity === null) {
      const stmt = this.db.prepare(
        "DELETE FROM bundle_meta WHERE key = 'manifest_identity'",
      );
      stmt.run();
    } else {
      const stmt = this.db.prepare(
        "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES ('manifest_identity', ?)",
      );
      stmt.run(identity);
    }
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
   *
   * @param kind - Optional extension kind for per-kind base paths (W1b
   *   parity: each kind tracks its own base path so the 5 loaders don't
   *   overwrite each other's value). When omitted, reads the legacy
   *   global key (backward-compatible with model-loader catalogs that
   *   predate per-kind support).
   */
  getDatastoreBasePath(kind?: ExtensionKind): string | undefined {
    const key = kind ? `datastore_base_path:${kind}` : "datastore_base_path";
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  /**
   * Stores the datastore base path. Set after a successful catalog
   * population so subsequent runs can detect datastore changes.
   *
   * @param basePath - The base path to store.
   * @param kind - Optional extension kind for per-kind base paths. When
   *   omitted, writes the legacy global key.
   */
  setDatastoreBasePath(basePath: string, kind?: ExtensionKind): void {
    const key = kind ? `datastore_base_path:${kind}` : "datastore_base_path";
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, ?)",
    );
    stmt.run(key, basePath);
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

  // ---- methods added for ExtensionRepository (W1b) ----

  /**
   * Upserts a row with explicit extension identity (extension_name +
   * extension_version) — the aggregate-shaped write path used by
   * ExtensionRepository.saveAll. Differs from {@link upsert} only in
   * that it writes the identity columns AND updates them on conflict
   * (loader-shaped upsert deliberately preserves the migration-backfilled
   * identity; aggregate-shaped saves are authoritative for it).
   */
  upsertWithIdentity(
    row: ExtensionTypeRow & {
      extension_name: string;
      extension_version: string;
    },
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO bundle_types (
        source_path, type_normalized, kind, bundle_path,
        version, description, extends_type, source_mtime,
        source_fingerprint, state, extension_name, extension_version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        type_normalized    = excluded.type_normalized,
        kind               = excluded.kind,
        bundle_path        = excluded.bundle_path,
        version            = excluded.version,
        description        = excluded.description,
        extends_type       = excluded.extends_type,
        source_mtime       = excluded.source_mtime,
        source_fingerprint = excluded.source_fingerprint,
        state              = excluded.state,
        extension_name     = excluded.extension_name,
        extension_version  = excluded.extension_version
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
      row.extension_name,
      row.extension_version,
    );
  }

  /**
   * Returns every row in `bundle_types`, ordered by source_path so the
   * output is stable across runs. Used by ExtensionRepository.loadAll
   * (which groups by extension identity) and by I-Repo-1 verification
   * (which scans the post-save state for cross-aggregate (kind, type)
   * collisions).
   */
  findAll(): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types ORDER BY source_path",
    );
    return (stmt.all() as Record<string, unknown>[]).map((r) => this.mapRow(r));
  }

  /**
   * Returns rows owned by a specific (extension_name, extension_version)
   * tuple. Used by ExtensionRepository.loadByName to materialise a single
   * Extension aggregate without scanning the full catalog.
   *
   * Empty-identity rows (extension_name="" or extension_version="") never
   * match this query; callers needing those must go through findAll and
   * the repository's empty-identity fallback.
   */
  findByExtension(name: string, version: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE extension_name = ? AND extension_version = ? ORDER BY source_path",
    );
    return (stmt.all(name, version) as Record<string, unknown>[]).map((r) =>
      this.mapRow(r)
    );
  }

  /**
   * Updates a row's extension_name and extension_version. Used by the
   * repository's empty-identity fallback to write back lockfile-resolved
   * versions onto pulled rows that were left empty by W1a's deliberate
   * "version unknown at migration time" choice.
   *
   * Idempotent — running twice with the same values is a no-op for the
   * end state.
   */
  updateExtensionIdentity(
    sourcePath: string,
    name: string,
    version: string,
  ): void {
    const stmt = this.db.prepare(
      "UPDATE bundle_types SET extension_name = ?, extension_version = ? WHERE source_path = ?",
    );
    stmt.run(name, version, sourcePath);
  }

  /**
   * Runs `fn` inside an explicit `BEGIN` / `COMMIT`. If `fn` throws, runs
   * `ROLLBACK` and re-throws the original error. Used by
   * ExtensionRepository.saveAll to make diff-based persistence + I-Repo-1
   * verification atomic against the bundle_types table.
   *
   * The `node:sqlite` driver auto-commits each statement by default, so
   * an explicit transaction is required around the multi-statement diff.
   */
  runInTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort: a failed ROLLBACK shouldn't shadow the original error.
      }
      throw error;
    }
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

// W1b: the standalone `forceCatalogRescan` helper that previously lived
// here was DELETED — its behaviour now lives on
// `ExtensionRepository.invalidateAll()`. Callers (open.ts,
// doctor_extensions.ts) construct a temporary repository, invalidate,
// then close.

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
