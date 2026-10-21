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
 * A schema migration step for the v3 SQLite stores: SQL to run, or a
 * function for a step plain SQL cannot make idempotent.
 *
 * @module
 */

import type { DatabaseSync } from "node:sqlite";

/** One migration: SQL, or a function run on the migrating connection. */
export type SqliteMigration = string | ((db: DatabaseSync) => void);

/** Runs one migration on `db`. */
export function runMigration(db: DatabaseSync, migration: SqliteMigration) {
  if (typeof migration === "string") db.exec(migration);
  else migration(db);
}

/**
 * A migration adding nullable columns, each only where its table lacks it:
 * `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS`, and a file rolled
 * back to an older schema by hand may still hold the column, as the
 * `CREATE TABLE IF NOT EXISTS` migrations allow for their tables.
 */
export function addColumnsIfAbsent(
  columns: readonly {
    readonly table: string;
    readonly column: string;
    readonly type: string;
  }[],
): (db: DatabaseSync) => void {
  return (db) => {
    for (const { table, column, type } of columns) {
      const present = (db.prepare(`PRAGMA table_info(${table})`).all() as {
        name: string;
      }[]).some((row) => row.name === column);
      if (!present) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      }
    }
  };
}
