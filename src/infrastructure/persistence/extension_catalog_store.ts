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
import { getLogger, type Logger } from "@logtape/logtape";
import { canonicalizePath, realCanonicalPath } from "./canonicalize_path.ts";
import { deriveExtensionIdentity } from "./derive_extension_identity.ts";
import { isPulledExtensionPath } from "../../domain/extensions/extension_precedence.ts";
import {
  CATALOG_FAILURE_STATES,
  MAX_SOURCE_MODULES,
} from "../../domain/extensions/bundle_freshness.ts";
import {
  type DeclarationKind,
  declaresExport,
  EXPORT_DECLARATION_PATTERNS,
} from "../../domain/extensions/export_declaration.ts";

const logger = getLogger(["swamp", "persistence", "extension-catalog"]);

/**
 * records that the per-extension-aggregate-v3 data migration ran, so later
 * opens skip the per-row updates; schema changes are idempotent via
 * pragma_table_info probes
 */
const PER_EXTENSION_AGGREGATE_V3_MIGRATION_KEY =
  "migration_applied:per-extension-aggregate-v3";

/**
 * primary signal that the drop-validation-failed migration ran; it also probes
 * pragma_table_info for the column in case the marker was deleted but the
 * column kept
 */
const VALIDATION_FAILED_DROPPED_MIGRATION_KEY =
  "migration_applied:validation-failed-dropped-v1";

/**
 * one-shot heal on catalog open: rows persisted with an empty extends_type are
 * never rewritten while their fingerprint is unchanged, so their methods would
 * stay dropped
 */
const EXTENDS_TYPE_BACKFILL_MIGRATION_KEY =
  "migration_applied:extension-extends-type-backfill-v1";

const DEDUP_NON_CANONICAL_MIGRATION_KEY =
  "migration_applied:dedup-non-canonical-source-paths-v1";

/**
 * fingerprint at which importing a source found no export of the kind; without
 * it the warm scan treats the source as stale and bundles and imports it on
 * every command
 */
const NO_EXPORT_KEY_PREFIX = "no-export:";

/**
 * records that the loader revalidated the kind's typeless Indexed rows; cleared
 * when a row claiming a type is deleted, since it may have been why another row
 * lost its type
 */
// v2 reruns the heal once on upgrade so a local override that an older binary
// indexed typeless behind a mounted row's type takes it back
const TYPELESS_ROW_HEAL_KEY_PREFIX = "migration_applied:typeless-row-heal-v2:";

/**
 * bumped whenever the on-disk bundle path scheme changes; loaders compare it
 * against the catalog and force a full rescan on mismatch; shared so all
 * loaders use one source of truth
 */
export const BUNDLE_LAYOUT_VERSION = "per-extension-aggregate-v4";

export type ExtensionKind =
  | "model"
  | "extension"
  | "vault"
  | "datastore"
  | "report"
  | "webhook";

export interface OriginConflict {
  readonly type: string;
  readonly kind: ExtensionKind;
  readonly pulledSourcePath: string;
  readonly localSourcePath: string;
}

export interface PulledTypeConflict {
  readonly winner: ExtensionTypeRow;
  readonly loser: ExtensionTypeRow;
  readonly winnerName?: string;
  readonly loserName?: string;
}

export interface MountedTypeConflict {
  readonly winner: ExtensionTypeRow;
  readonly loser: ExtensionTypeRow;
}

const reportedPulledTypeConflicts = new Set<string>();

/**
 * shared by the loader and the reconcile so both word it the same; each
 * conflict is reported once per process because a catalog rebuild settles it
 * twice
 */
export function warnPulledTypeConflicts(
  log: Logger,
  conflicts: readonly PulledTypeConflict[],
): void {
  for (const { winner, winnerName, loserName } of conflicts) {
    // Without both names there is no extension to tell the user to rm.
    if (winnerName && loserName && winnerName !== loserName) {
      const key =
        `${winner.kind}\0${winner.type_normalized}\0${winnerName}\0${loserName}`;
      if (reportedPulledTypeConflicts.has(key)) continue;
      reportedPulledTypeConflicts.add(key);
      log
        .warn`Extensions ${winnerName} and ${loserName} both provide ${winner.kind} type ${winner.type_normalized}; keeping ${winnerName}, which provided it first. To use ${loserName} instead, run 'swamp extension rm ${winnerName}'`;
    }
  }
}

export function resetPulledTypeConflictWarnings(): void {
  reportedPulledTypeConflicts.clear();
}

/**
 * a row the loader just inserted has no extension_name yet, so derive it from
 * the path, which gives the full name (@swamp/aws/cur) rather than just the
 * scope
 */
function pulledExtensionName(
  row: ExtensionTypeRow,
  canonicalRoot: string,
): string | undefined {
  return row.extension_name ||
    deriveExtensionIdentity(canonicalizePath(row.source_path), canonicalRoot)
      ?.name;
}

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
   * sha-256 over the entry point and transitive local imports, used for
   * freshness since mtime is fragile under atomic-rename saves and
   * mtime-preserving sync tools; optional, coerced to empty
   */
  source_fingerprint?: string;
  /**
   * optional on upsert: INSERT uses the column default Indexed, UPDATE
   * preserves the prior value, so callers wanting a state pass it. Readers
   * filter on this, not on validation_failed
   */
  state?: string;
  last_error?: string;
  /**
   * empty when no identity could be derived; the repository's empty-identity
   * fallback re-derives it or deletes the row as an orphan
   */
  extension_name?: string;
  /**
   * deliberately empty for pulled rows because the pulled tree encodes only the
   * name; the repository resolves it from the lockfile at read time
   */
  extension_version?: string;
}

export class ExtensionCatalogStore {
  private handle: DatabaseSync | undefined;
  private closed = false;
  private readonly dbPath: string;

  /**
   * with openOnFirstUse nothing is opened or written until first use, so an
   * unused catalog leaves the repository untouched; any method may then throw
   * what an eager open would have
   */
  constructor(dbPath: string, options: { openOnFirstUse?: boolean } = {}) {
    this.dbPath = dbPath;
    if (!options.openOnFirstUse) this.open();
  }

  private get db(): DatabaseSync {
    if (this.handle) return this.handle;
    // Opening after close would create a catalog nothing closes.
    if (this.closed) throw new Error("The extension catalog is closed");
    return this.open();
  }

  private open(): DatabaseSync {
    const dbPath = this.dbPath;
    ensureDirSync(dirname(dbPath));
    // initializeWithRetry reads `this.db`, so the handle is assigned first.
    this.handle = new DatabaseSync(dbPath);
    this.handle.exec("PRAGMA busy_timeout=5000");
    try {
      try {
        this.initializeWithRetry();
      } catch (error: unknown) {
        if (!isReadOnlyError(error)) throw error;
        logger
          .warn`Catalog DB is read-only during schema migration; recreating from scratch`;
        this.handle.close();
        this.handle = undefined;
        removeCatalogFiles(dbPath);
        this.handle = new DatabaseSync(dbPath);
        this.handle.exec("PRAGMA busy_timeout=5000");
        this.initializeWithRetry();
      }
    } catch (error: unknown) {
      // A failed open leaves no handle, so the next use retries it rather
      // than reading a database with no schema.
      this.handle?.close();
      this.handle = undefined;
      throw error;
    }
    return this.handle;
  }

  /**
   * switching to WAL needs an exclusive lock that contends under concurrent
   * opens; WAL persists on disk, so read the journal mode first (shared lock)
   * and switch only when it is not WAL
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
        state              TEXT NOT NULL DEFAULT 'Indexed',
        extension_name     TEXT NOT NULL DEFAULT '',
        extension_version  TEXT NOT NULL DEFAULT '',
        last_error         TEXT NOT NULL DEFAULT ''
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

      CREATE TABLE IF NOT EXISTS source_modules (
        source_path   TEXT NOT NULL PRIMARY KEY,
        modules       TEXT NOT NULL,
        graph_pending INTEGER NOT NULL DEFAULT 0
      );
    `);
  }

  /**
   * the data migration runs in one transaction; if its post-condition fails it
   * rolls back and rebuilds cold, since loaders repopulate from disk; a marker
   * key skips it on later opens
   */
  private migrateSchema(): void {
    this.addNewColumnsIfMissing();
    if (!this.isDataMigrationApplied()) {
      this.runDataMigrationTransaction();
    }
    // runs after the data migration so every row has state; gated on its own
    // marker and a pragma_table_info probe
    this.dropValidationFailedColumn();
    // heals extension rows with an empty extends_type; runs last so state and
    // extends_type exist; gated on its own marker
    this.backfillExtensionExtendsType();
    // heals ghost rows with non-canonical Windows paths from an older warm-path
    // loader; gated on its own marker
    this.deduplicateNonCanonicalPaths();
    // drops conflicting type claims read out of string fixtures; runs on every
    // open but reads no source unless the catalog already holds a duplicate
    // claim
    this.pruneUndeclaredTypeClaims();
  }

  private isExtendsTypeBackfilled(): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(EXTENDS_TYPE_BACKFILL_MIGRATION_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  /**
   * backfills extends_type from type_normalized, which findExtensionsForType
   * needs to match; idempotent and marker-gated, and extension rows are exempt
   * from the uniqueness check
   */
  private backfillExtensionExtendsType(): void {
    if (this.isExtendsTypeBackfilled()) return;
    this.db
      .prepare(
        `UPDATE bundle_types
           SET extends_type = type_normalized
         WHERE kind = 'extension'
           AND extends_type = ''
           AND type_normalized <> ''
           AND state = 'Indexed'`,
      )
      .run();
    this.db
      .prepare(
        "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
      )
      .run(EXTENDS_TYPE_BACKFILL_MIGRATION_KEY);
  }

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
    if (!hasColumn("last_error")) {
      this.db.exec(
        "ALTER TABLE bundle_types ADD COLUMN last_error TEXT NOT NULL DEFAULT ''",
      );
    }
    // a catalog written by an earlier binary has source_modules without the
    // graph_pending column
    // #3385 binary has without this column.
    const sourceModulesProbe = this.db.prepare(
      "SELECT COUNT(*) AS cnt FROM pragma_table_info('source_modules') WHERE name = ?",
    );
    const graphPending = sourceModulesProbe.get("graph_pending") as
      | { cnt: number }
      | undefined;
    if ((graphPending?.cnt ?? 0) === 0) {
      this.db.exec(
        "ALTER TABLE source_modules ADD COLUMN graph_pending INTEGER NOT NULL DEFAULT 0",
      );
    }
  }

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
   * recreates the table instead of DROP COLUMN, unsupported on older SQLite;
   * guarded by a marker plus a pragma probe, in one transaction rolled back on
   * failure
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
      // column already absent: set the marker so later runs short-circuit
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
          extension_version  TEXT NOT NULL DEFAULT '',
          last_error         TEXT NOT NULL DEFAULT ''
        );
      `);
      this.db.exec(`
        INSERT INTO bundle_types_new (
          source_path, type_normalized, kind, bundle_path,
          version, description, extends_type, source_mtime,
          source_fingerprint, state, extension_name, extension_version,
          last_error
        ) SELECT
          source_path, type_normalized, kind, bundle_path,
          version, description, extends_type, source_mtime,
          source_fingerprint, state, extension_name, extension_version,
          last_error
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
   * on a non-lock failure roll back and rebuild cold (drop rows, clear
   * populated keys, mark applied) rather than propagate, since loaders
   * repopulate from disk; lock errors roll back and retry with backoff
   */
  private runDataMigrationTransaction(): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.isDataMigrationApplied()) {
        this.db.exec("ROLLBACK");
        return;
      }
      this.canonicalizeAllSourcePaths();
      // the validation_failed to state backfill runs only on catalogs that
      // still have the column; others already carry state directly
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
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Best-effort: a failed ROLLBACK shouldn't shadow the original error.
      }
      const isLock = error instanceof Error &&
        /database is (locked|busy)/i.test(error.message);
      if (isLock) throw error;
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
   * SQLite has no canonicalizePath, so rows are updated one at a time; if two
   * rows canonicalize to the same path (mixed-case Windows) the duplicate is
   * deleted with a warning instead of aborting
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
   * only rows with an empty extension_name are updated; pulled rows keep an
   * empty version for the lockfile fallback; unrecognized layouts keep defaults
   * and are deleted afterwards
   */
  private backfillExtensionIdentity(): void {
    // Canonicalize both sides: inferRepoRootFromDbPath returns the native
    // dbPath form but deriveExtensionIdentity needs canonical inputs.
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
   * every row must have a non-empty extension_name; extension_version is not
   * checked because pulled rows leave it empty for the lockfile fallback; a
   * throw rolls back and triggers the cold-start rebuild
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
   * drops all rows and populated flags so loaders rebuild from disk, and marks
   * the migration applied so restarts skip it; own transaction, and a failure
   * is retried on the next construction
   */
  private runColdStartRebuild(): void {
    this.db.exec("BEGIN");
    try {
      this.db.exec("DELETE FROM bundle_types");
      this.db.exec("DELETE FROM source_modules");
      this.db.exec("DELETE FROM bundle_meta WHERE key LIKE 'populated:%'");
      this.db.exec(
        `DELETE FROM bundle_meta WHERE key LIKE '${TYPELESS_ROW_HEAL_KEY_PREFIX}%'`,
      );
      this.db.exec(
        `DELETE FROM bundle_meta WHERE key LIKE '${NO_EXPORT_KEY_PREFIX}%'`,
      );
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
   * UPDATE leaves extension_name and extension_version untouched, since
   * resetting them to defaults would undo the migration backfill on a loader
   * rescan; state is written because the loader owns it
   */
  upsert(row: ExtensionTypeRow): void {
    const updateClauses = [
      "type_normalized    = excluded.type_normalized",
      "kind               = excluded.kind",
      "bundle_path        = excluded.bundle_path",
      "version            = excluded.version",
      "description        = excluded.description",
      "extends_type       = excluded.extends_type",
      "source_mtime       = excluded.source_mtime",
      "source_fingerprint = excluded.source_fingerprint",
    ];
    if (row.state !== undefined) {
      updateClauses.push("state              = excluded.state");
      updateClauses.push("last_error         = excluded.last_error");
    }

    const sql = `
      INSERT INTO bundle_types (
        source_path, type_normalized, kind, bundle_path,
        version, description, extends_type, source_mtime,
        source_fingerprint, state, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_path) DO UPDATE SET
        ${updateClauses.join(",\n        ")}
    `;
    const params = [
      canonicalizePath(row.source_path),
      row.type_normalized,
      row.kind,
      row.bundle_path,
      row.version,
      row.description,
      row.extends_type,
      row.source_mtime,
      row.source_fingerprint ?? "",
      row.state ?? "Indexed",
      row.last_error ?? "",
    ];

    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        this.resetTypelessHealOnRetype(params[0], row.type_normalized);
        const stmt = this.db.prepare(sql);
        stmt.run(...params);
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

  findBySourcePath(sourcePath: string): ExtensionTypeRow | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE source_path = ?",
    );
    const row = stmt.get(canonicalizePath(sourcePath)) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : undefined;
  }

  removeBySourcePath(sourcePath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE source_path = ? RETURNING kind, type_normalized",
    );
    this.resetTypelessHealFor(stmt.all(canonicalizePath(sourcePath)));
  }

  /**
   * removes by the stored primary key without re-canonicalizing, for rows
   * another OS wrote (e.g. WSL mixed-case paths that Windows canonicalizePath
   * lowercases)
   */
  removeByRawSourcePath(rawSourcePath: string): void {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE source_path = ? RETURNING kind, type_normalized",
    );
    this.resetTypelessHealFor(stmt.all(rawSourcePath));
  }

  findBySourcePathPrefix(sourcePrefix: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE source_path LIKE ? ESCAPE '\\' ORDER BY source_path",
    );
    return (stmt.all(likePrefixPattern(sourcePrefix)) as Record<
      string,
      unknown
    >[]).map((r) => this.mapRow(r));
  }

  removeBySourcePrefix(sourcePrefix: string): number {
    const stmt = this.db.prepare(
      "DELETE FROM bundle_types WHERE source_path LIKE ? ESCAPE '\\' RETURNING kind, type_normalized",
    );
    const deleted = stmt.all(likePrefixPattern(sourcePrefix));
    this.resetTypelessHealFor(deleted);
    return deleted.length;
  }

  /**
   * a deleted row that claimed a type may have been why another row of its kind
   * lost its type, so clear the kind's heal marker
   */
  private resetTypelessHealFor(deleted: Record<string, unknown>[]): void {
    const kinds = new Set<string>();
    for (const row of deleted) {
      if (String(row.type_normalized ?? "").length > 0) {
        kinds.add(String(row.kind));
      }
    }
    if (kinds.size === 0) return;
    const stmt = this.db.prepare("DELETE FROM bundle_meta WHERE key = ?");
    for (const kind of kinds) {
      stmt.run(`${TYPELESS_ROW_HEAL_KEY_PREFIX}${kind}`);
    }
  }

  /**
   * clears the heal marker when an upsert changes the type a row claims, since
   * the type it gives up may be one another row lost to it, as with a delete
   */
  private resetTypelessHealOnRetype(
    sourcePath: string,
    newType: string,
  ): void {
    const previous = this.db.prepare(
      "SELECT kind, type_normalized FROM bundle_types WHERE source_path = ?",
    ).get(sourcePath) as Record<string, unknown> | undefined;
    if (previous && previous.type_normalized !== newType) {
      this.resetTypelessHealFor([previous]);
    }
  }

  isTypelessHealDone(kind: ExtensionKind): boolean {
    const row = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    ).get(`${TYPELESS_ROW_HEAL_KEY_PREFIX}${kind}`) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  markTypelessHealDone(kind: ExtensionKind): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    ).run(`${TYPELESS_ROW_HEAL_KEY_PREFIX}${kind}`);
  }

  /**
   * findByKind and findByType do not filter on state: findStaleFiles needs
   * broken rows so the fingerprint match ends the rebundle loop; registration
   * sites filter on state instead
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
      last_error: typeof raw.last_error === "string" ? raw.last_error : "",
    };
  }

  /**
   * includes validation-failed rows: findStaleFiles relies on them to end the
   * rebundle loop on schema-invalid sources; consumers that must not register
   * broken types filter themselves
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
   * validation-failed rows have empty type_normalized, so they never match a
   * type lookup; this protection is structural, not a filter
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

  findAllByType(
    typeNormalized: string,
    kind: ExtensionKind,
  ): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE type_normalized = ? AND kind = ? ORDER BY source_path",
    );
    return (stmt.all(typeNormalized, kind) as Record<string, unknown>[]).map((
      r,
    ) => this.mapRow(r));
  }

  findExtensionsForType(baseType: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE extends_type = ? AND kind = 'extension' ORDER BY type_normalized",
    );
    return (stmt.all(baseType) as Record<string, unknown>[]).map((r) =>
      this.mapRow(r)
    );
  }

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

  isPopulated(kind: ExtensionKind): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(`populated:${kind}`) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  markPopulated(kind: ExtensionKind): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    );
    stmt.run(`populated:${kind}`);
  }

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

  getLayoutVersion(): string | undefined {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = 'bundle_layout'",
    );
    const row = stmt.get() as { value: string } | undefined;
    return row?.value;
  }

  setLayoutVersion(version: string): void {
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES ('bundle_layout', ?)",
    );
    stmt.run(version);
  }

  /**
   * per-kind keys keep loaders from overwriting each other's value; without a
   * kind it reads the legacy global key
   */
  getDatastoreBasePath(kind?: ExtensionKind): string | undefined {
    const key = kind ? `datastore_base_path:${kind}` : "datastore_base_path";
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(key) as { value: string } | undefined;
    return row?.value;
  }

  setDatastoreBasePath(basePath: string, kind?: ExtensionKind): void {
    const key = kind ? `datastore_base_path:${kind}` : "datastore_base_path";
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, ?)",
    );
    stmt.run(key, basePath);
  }

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

  setSourceDirsFingerprint(fingerprint: string, kind?: ExtensionKind): void {
    const key = kind
      ? `source_dirs_fingerprint:${kind}`
      : "source_dirs_fingerprint";
    const stmt = this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, ?)",
    );
    stmt.run(key, fingerprint);
  }

  updateSourceFingerprint(sourcePath: string, fingerprint: string): void {
    this.db.prepare(
      "UPDATE bundle_types SET source_fingerprint = ? WHERE source_path = ?",
    ).run(fingerprint, sourcePath);
  }

  close(): void {
    this.closed = true;
    this.handle?.close();
  }

  /**
   * writes the identity columns and updates them on conflict, since aggregate
   * saves are authoritative for identity; the loader-shaped upsert deliberately
   * preserves the backfilled identity
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
        source_fingerprint, state, extension_name, extension_version,
        last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        extension_version  = excluded.extension_version,
        last_error         = excluded.last_error
    `);
    const sourcePath = canonicalizePath(row.source_path);
    this.resetTypelessHealOnRetype(sourcePath, row.type_normalized);
    stmt.run(
      sourcePath,
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
      row.last_error ?? "",
    );
  }

  /**
   * removes ghost rows with non-canonical paths: deleted if a canonical row
   * exists for the file, else rewritten to canonical form; marker-gated to run
   * once
   */
  deduplicateNonCanonicalPaths(): number {
    if (this.isDeduplicateNonCanonicalApplied()) return 0;
    const rows = this.findAll();
    let removed = 0;
    for (const row of rows) {
      const canonical = canonicalizePath(row.source_path);
      if (canonical === row.source_path) continue;
      const existingCanonical = this.findBySourcePath(canonical);
      if (existingCanonical) {
        this.db.prepare(
          "DELETE FROM bundle_types WHERE source_path = ?",
        ).run(row.source_path);
      } else {
        this.db.prepare(
          "UPDATE bundle_types SET source_path = ? WHERE source_path = ?",
        ).run(canonical, row.source_path);
      }
      removed++;
    }
    this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, 'true')",
    ).run(DEDUP_NON_CANONICAL_MIGRATION_KEY);
    return removed;
  }

  /**
   * deletes only broken rows (Indexed, no identity, claiming a type another
   * live row claims) whose source declares no export in code; unreadable
   * sources keep their row
   */
  pruneUndeclaredTypeClaims(): number {
    const candidates = this.db.prepare(
      `SELECT * FROM bundle_types
        WHERE state = 'Indexed'
          AND extension_name = ''
          AND kind <> 'extension'
          AND type_normalized <> ''
          AND (kind, type_normalized) IN (
            SELECT kind, type_normalized FROM bundle_types
             WHERE state <> 'Tombstoned' AND type_normalized <> ''
             GROUP BY kind, type_normalized
            HAVING COUNT(*) > 1
          )`,
    ).all() as Record<string, unknown>[];
    if (candidates.length === 0) return 0;

    const repoRoot = canonicalizePath(inferRepoRootFromDbPath(this.dbPath));
    const undeclared: string[] = [];
    for (const row of candidates.map((r) => this.mapRow(r))) {
      if (isPulledExtensionPath(canonicalizePath(row.source_path), repoRoot)) {
        continue;
      }
      const pattern = EXPORT_DECLARATION_PATTERNS[row.kind as DeclarationKind];
      if (!pattern) continue;
      let source: string;
      try {
        source = Deno.readTextFileSync(row.source_path);
      } catch {
        continue;
      }
      if (!declaresExport(source, pattern)) undeclared.push(row.source_path);
    }
    if (undeclared.length === 0) return 0;

    this.db.exec("BEGIN");
    try {
      for (const sourcePath of undeclared) {
        this.removeByRawSourcePath(sourcePath);
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    logger
      .info`Removed ${undeclared.length} extension catalog ${
      undeclared.length === 1 ? "entry" : "entries"
    } for types named only in strings or comments`;
    return undeclared.length;
  }

  isKnownNoExport(
    kind: string,
    sourcePath: string,
    fingerprint: string,
  ): boolean {
    if (fingerprint === "") return false;
    const row = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    ).get(noExportKey(kind, sourcePath)) as { value: string } | undefined;
    return row?.value === fingerprint;
  }

  recordNoExport(kind: string, sourcePath: string, fingerprint: string): void {
    if (fingerprint === "") return;
    this.db.prepare(
      "INSERT OR REPLACE INTO bundle_meta (key, value) VALUES (?, ?)",
    ).run(noExportKey(kind, sourcePath), fingerprint);
  }

  findSourceModules(sourcePath: string): readonly string[] | undefined {
    const row = this.db.prepare(
      "SELECT modules FROM source_modules WHERE source_path = ?",
    ).get(canonicalizePath(sourcePath)) as { modules: string } | undefined;
    if (!row) return undefined;
    let modules: unknown;
    try {
      modules = JSON.parse(row.modules);
    } catch {
      return undefined;
    }
    if (
      !Array.isArray(modules) || modules.length > MAX_SOURCE_MODULES ||
      !modules.every((m) => typeof m === "string")
    ) {
      return undefined;
    }
    return modules;
  }

  /**
   * graphPending marks a fallback walk recorded because the module graph was
   * unreadable, retried once by the warm scan; throws RangeError over
   * MAX_SOURCE_MODULES, which findSourceModules would not read back
   */
  recordSourceModules(
    sourcePath: string,
    modules: readonly string[],
    options?: { graphPending?: boolean },
  ): void {
    if (modules.length > MAX_SOURCE_MODULES) {
      throw new RangeError(
        `${modules.length} modules exceed the ${MAX_SOURCE_MODULES} recorded for one source`,
      );
    }
    this.db.prepare(
      "INSERT OR REPLACE INTO source_modules (source_path, modules, graph_pending) VALUES (?, ?, ?)",
    ).run(
      canonicalizePath(sourcePath),
      JSON.stringify(modules),
      options?.graphPending ? 1 : 0,
    );
  }

  isSourceGraphPending(sourcePath: string): boolean {
    const row = this.db.prepare(
      "SELECT graph_pending FROM source_modules WHERE source_path = ?",
    ).get(canonicalizePath(sourcePath)) as
      | { graph_pending: number }
      | undefined;
    return (row?.graph_pending ?? 0) !== 0;
  }

  /**
   * returns whether the mark was set, using up the one retry; writes only when
   * set, so a warm rebundle of an unmarked source takes no write lock
   */
  takeSourceGraphPending(sourcePath: string): boolean {
    if (!this.isSourceGraphPending(sourcePath)) return false;
    // The update's row count, not the read above, decides who takes the
    // retry when two processes race.
    const result = this.db.prepare(
      "UPDATE source_modules SET graph_pending = 0 WHERE source_path = ? AND graph_pending != 0",
    ).run(canonicalizePath(sourcePath));
    return Number(result.changes) > 0;
  }

  deleteSourceModules(sourcePath: string): void {
    this.db.prepare("DELETE FROM source_modules WHERE source_path = ?").run(
      canonicalizePath(sourcePath),
    );
  }

  private isDeduplicateNonCanonicalApplied(): boolean {
    const stmt = this.db.prepare(
      "SELECT value FROM bundle_meta WHERE key = ?",
    );
    const row = stmt.get(DEDUP_NON_CANONICAL_MIGRATION_KEY) as
      | { value: string }
      | undefined;
    return row?.value === "true";
  }

  /**
   * keeps rows of sources mounted from outside the repo whose file exists;
   * keeping every out-of-root row would let a copied repo's rows for the
   * original location survive and be treated as local
   */
  pruneUnreachableSources(
    canonicalRepoRoot: string,
    protectedPaths?: ReadonlySet<string>,
    mounted?: {
      dirs: readonly string[];
      sourceExists: (sourcePath: string) => boolean;
    },
  ): string[] {
    const prefix = withTrailingSlash(canonicalRepoRoot);
    const mountPrefixes = (mounted?.dirs ?? []).map(withTrailingSlash);
    const rows = this.findAll();
    const pruned: string[] = [];
    for (const row of rows) {
      if ((row.state ?? "Indexed") === "Tombstoned") continue;
      const canonical = canonicalizePath(row.source_path);
      if (protectedPaths?.has(canonical)) continue;
      if (
        mounted !== undefined &&
        mountPrefixes.some((m) => canonical.startsWith(m)) &&
        mounted.sourceExists(row.source_path)
      ) {
        continue;
      }
      if (!canonical.startsWith(prefix)) {
        this.removeBySourcePath(row.source_path);
        pruned.push(row.source_path);
      }
    }
    return pruned;
  }

  /**
   * enforces local > source-mounted > pulled: when rows of different origins
   * claim a (kind, type), the pulled row's type is cleared; same exclusions as
   * assertIRepo1 but resolves instead of throwing
   */
  resolveOriginConflicts(repoRoot: string): OriginConflict[] {
    const canonical = canonicalizePath(repoRoot);

    const rows = this.findAll();

    const isPulledPath = (p: string): boolean =>
      isPulledExtensionPath(canonicalizePath(p), canonical);

    let hasPulled = false;
    for (const row of rows) {
      if (isPulledPath(row.source_path)) {
        hasPulled = true;
        break;
      }
    }
    if (!hasPulled) return [];

    const conflicts: OriginConflict[] = [];
    const occupants = new Map<
      string,
      { sourcePath: string; isPulled: boolean }
    >();

    for (const row of rows) {
      if ((row.state ?? "Indexed") === "Tombstoned") continue;
      if (row.type_normalized.length === 0) continue;
      if (row.kind === "extension") continue;

      const key = `${row.kind}::${row.type_normalized}`;
      const isPulled = isPulledPath(row.source_path);
      const prior = occupants.get(key);

      if (prior) {
        if (prior.isPulled && !isPulled) {
          conflicts.push({
            type: row.type_normalized,
            kind: row.kind,
            pulledSourcePath: prior.sourcePath,
            localSourcePath: row.source_path,
          });
          this.clearTypeNormalized(prior.sourcePath);
          occupants.set(key, { sourcePath: row.source_path, isPulled });
        } else if (!prior.isPulled && isPulled) {
          conflicts.push({
            type: row.type_normalized,
            kind: row.kind,
            pulledSourcePath: row.source_path,
            localSourcePath: prior.sourcePath,
          });
          this.clearTypeNormalized(row.source_path);
        }
      } else {
        occupants.set(key, { sourcePath: row.source_path, isPulled });
      }
    }

    return conflicts;
  }

  /**
   * a local row beats a mounted one, an earlier mount beats a later one, then
   * the smaller canonical path, matching loader registration order; each losing
   * mounted row has its type cleared
   */
  settleMountedTypeConflicts(
    canonicalRepoRoot: string,
    mountedDirs: readonly string[],
  ): MountedTypeConflict[] {
    if (mountedDirs.length === 0) return [];

    const groups = new Map<string, ExtensionTypeRow[]>();
    for (const row of this.findAll()) {
      if ((row.state ?? "Indexed") === "Tombstoned") continue;
      if (row.type_normalized.length === 0) continue;
      if (row.kind === "extension") continue;
      const key = `${row.kind}::${row.type_normalized}`;
      let group = groups.get(key);
      if (!group) {
        group = [];
        groups.set(key, group);
      }
      group.push(row);
    }

    // match both spellings (stored and symlink-resolved) of path and roots,
    // since walked and configured rows can disagree (/tmp vs /private/tmp on
    // macOS); resolved only for conflicting rows
    const spellings = (p: string): string[] => {
      const real = realCanonicalPath(p);
      return real === p ? [p] : [p, real];
    };
    const rootPrefixes = spellings(canonicalRepoRoot).map(withTrailingSlash);
    const mountPrefixes = mountedDirs.map((d) =>
      spellings(d).map(withTrailingSlash)
    );
    // -1 for a local row, the mount's index for a mounted row, undefined for a
    // pulled row or one outside both; pulled is checked first, as the loader's
    // contributorFor does
    const rankOf = (canonical: string): number | undefined => {
      const forms = spellings(canonical);
      const pulled = spellings(canonicalRepoRoot).some((root) =>
        forms.some((f) => isPulledExtensionPath(f, root))
      );
      if (pulled) return undefined;
      const mount = mountPrefixes.findIndex((prefixes) =>
        prefixes.some((m) => forms.some((f) => f.startsWith(m)))
      );
      if (mount >= 0) return mount;
      const inRoot = rootPrefixes.some((r) =>
        forms.some((f) => f.startsWith(r))
      );
      return inRoot ? -1 : undefined;
    };

    const conflicts: MountedTypeConflict[] = [];
    for (const rows of groups.values()) {
      if (rows.length < 2) continue;
      const ranked: {
        row: ExtensionTypeRow;
        canonical: string;
        rank: number;
      }[] = [];
      for (const row of rows) {
        const canonical = canonicalizePath(row.source_path);
        const rank = rankOf(canonical);
        if (rank !== undefined) ranked.push({ row, canonical, rank });
      }
      if (ranked.length < 2 || ranked.every((g) => g.rank === -1)) continue;
      const winner = ranked.reduce((best, g) =>
        g.rank < best.rank ||
          (g.rank === best.rank && g.canonical < best.canonical)
          ? g
          : best
      );
      for (const g of ranked) {
        if (g === winner || g.rank === -1) continue;
        this.clearTypeNormalized(g.row.source_path);
        conflicts.push({ winner: winner.row, loser: g.row });
      }
    }
    return conflicts;
  }

  private clearTypeNormalized(sourcePath: string): void {
    const stmt = this.db.prepare(
      "UPDATE bundle_types SET type_normalized = '' WHERE source_path = ?",
    );
    stmt.run(sourcePath);
  }

  hasRowWithBundlePath(bundlePath: string): boolean {
    return this.db.prepare(
      "SELECT 1 FROM bundle_types WHERE bundle_path = ? LIMIT 1",
    ).get(bundlePath) !== undefined;
  }

  /**
   * writes type_normalized only, leaving the fingerprint and every other column
   * untouched, as the loader's typeless-row heal requires
   */
  setTypeNormalized(rawSourcePath: string, typeNormalized: string): void {
    this.db.prepare(
      "UPDATE bundle_types SET type_normalized = ? WHERE source_path = ?",
    ).run(typeNormalized, rawSourcePath);
  }

  /**
   * deletes rows whose claimed source is missing, or under the inactive pulled
   * root (a managedConfig migration copies rather than moves); protected,
   * Tombstoned, failure-state and datastore rows are kept
   */
  pruneStaleSources(args: {
    canonicalRepoRoot: string;
    activePulledRoot?: string;
    protectedPaths?: ReadonlySet<string>;
    sourceExists: (sourcePath: string) => boolean;
  }): ExtensionTypeRow[] {
    const sep = args.canonicalRepoRoot.endsWith("/") ? "" : "/";
    const legacyRoot =
      `${args.canonicalRepoRoot}${sep}.swamp/pulled-extensions/`;
    const managedRoot =
      `${args.canonicalRepoRoot}${sep}.swamp/config/pulled-extensions/`;
    let inactiveRoot: string | undefined;
    if (args.activePulledRoot !== undefined) {
      const active = canonicalizePath(args.activePulledRoot);
      const activeWithSep = active.endsWith("/") ? active : `${active}/`;
      // An active root spelled unlike either one names no inactive root,
      // so rule (b) is skipped rather than aimed at the wrong root.
      if (activeWithSep === managedRoot) inactiveRoot = legacyRoot;
      else if (activeWithSep === legacyRoot) inactiveRoot = managedRoot;
    }

    const pruned: ExtensionTypeRow[] = [];
    for (const row of this.findAll()) {
      const state = row.state ?? "Indexed";
      if (state === "Tombstoned" || CATALOG_FAILURE_STATES.has(state)) {
        continue;
      }
      const canonical = canonicalizePath(row.source_path);
      if (args.protectedPaths?.has(canonical)) continue;

      const inactive = inactiveRoot !== undefined &&
        row.kind !== "datastore" && canonical.startsWith(inactiveRoot);
      const claimsType = row.kind === "extension"
        ? row.extends_type.length > 0
        : row.type_normalized.length > 0;
      if (inactive || (claimsType && !args.sourceExists(row.source_path))) {
        this.removeByRawSourcePath(row.source_path);
        pruned.push(row);
      }
    }
    return pruned;
  }

  /**
   * among pulled rows sharing a (kind, type) the earliest-inserted keeps the
   * type, as an older binary's findByType returned, so upgrading never moves a
   * type to a later-pulled extension; upsert keeps the rowid
   */
  settlePulledTypeConflicts(repoRoot: string): PulledTypeConflict[] {
    const canonicalRoot = canonicalizePath(repoRoot);
    const groups = new Map<string, ExtensionTypeRow[]>();
    const rows = this.db.prepare(
      "SELECT * FROM bundle_types ORDER BY rowid",
    ).all() as Record<string, unknown>[];
    for (const row of rows.map((r) => this.mapRow(r))) {
      if ((row.state ?? "Indexed") === "Tombstoned") continue;
      if (row.type_normalized.length === 0) continue;
      if (row.kind === "extension") continue;
      if (
        !isPulledExtensionPath(canonicalizePath(row.source_path), canonicalRoot)
      ) continue;
      const key = `${row.kind}::${row.type_normalized}`;
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }

    const cleared: PulledTypeConflict[] = [];
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const [winner, ...losers] = group;
      for (const loser of losers) {
        this.clearTypeNormalized(loser.source_path);
        cleared.push({
          winner,
          loser,
          winnerName: pulledExtensionName(winner, canonicalRoot),
          loserName: pulledExtensionName(loser, canonicalRoot),
        });
      }
    }
    return cleared;
  }

  getFailedLocalSourcePaths(): string[] {
    const stmt = this.db.prepare(
      "SELECT source_path FROM bundle_types WHERE state IN ('BundleBuildFailed', 'ValidationFailed') AND extension_name LIKE '@local/%'",
    );
    return (stmt.all() as { source_path: string }[]).map((r) => r.source_path);
  }

  findAll(): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types ORDER BY source_path",
    );
    return (stmt.all() as Record<string, unknown>[]).map((r) => this.mapRow(r));
  }

  /**
   * rows with an empty extension_name or version never match; callers needing
   * them go through findAll and the repository's empty-identity fallback
   */
  findByExtension(name: string, version: string): ExtensionTypeRow[] {
    const stmt = this.db.prepare(
      "SELECT * FROM bundle_types WHERE extension_name = ? AND extension_version = ? ORDER BY source_path",
    );
    return (stmt.all(name, version) as Record<string, unknown>[]).map((r) =>
      this.mapRow(r)
    );
  }

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
   * the driver auto-commits each statement, so the multi-statement diff needs
   * an explicit transaction; retries with backoff on cross-process 'database is
   * locked'
   */
  runInTransaction<T>(fn: () => T): T {
    const MAX_RETRIES = 5;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
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
    throw new Error("runInTransaction: unreachable");
  }
}

export function sourceDirsFingerprint(
  primaryDir: string,
  additionalDirs?: string[],
): string {
  const dirs = [primaryDir, ...(additionalDirs ?? [])];
  return dirs.sort().join("\n");
}

/**
 * the catalog lives at <repoRoot>/.swamp/_extension_catalog.db, so two dirnames
 * give the repo root; this must change if that hard-coded layout does
 */
function noExportKey(kind: string, sourcePath: string): string {
  return `${NO_EXPORT_KEY_PREFIX}${kind}:${canonicalizePath(sourcePath)}`;
}

function inferRepoRootFromDbPath(dbPath: string): string {
  return dirname(dirname(dbPath));
}

function withTrailingSlash(dir: string): string {
  return dir.endsWith("/") ? dir : `${dir}/`;
}

/**
 * escapes LIKE wildcards so _ in an extension name (@acme/aws_ec2) cannot match
 * a sibling such as @acme/aws-ec2
 */
function likePrefixPattern(prefix: string): string {
  return `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

function isReadOnlyError(error: unknown): boolean {
  return error instanceof Error &&
    /attempt to write a readonly database/i.test(error.message);
}

function removeCatalogFiles(dbPath: string): void {
  const sidecars = [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
  try {
    Deno.removeSync(dbPath);
  } catch { /* file may already be gone */ }
  for (const sidecar of sidecars) {
    try {
      Deno.removeSync(sidecar);
    } catch { /* ok */ }
  }
}
