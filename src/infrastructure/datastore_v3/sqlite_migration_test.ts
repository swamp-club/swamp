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

import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { addColumnsIfAbsent, runMigration } from "./sqlite_migration.ts";

function columnsOf(db: DatabaseSync, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[]).map((row) => row.name);
}

Deno.test("addColumnsIfAbsent: adds each missing column, and a second run changes nothing", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE t (a TEXT) STRICT; CREATE TABLE u (b TEXT, c TEXT) STRICT",
    );
    const migration = addColumnsIfAbsent([
      { table: "t", column: "access", type: "TEXT" },
      { table: "u", column: "c", type: "TEXT" },
    ]);
    runMigration(db, migration);
    assertEquals(columnsOf(db, "t"), ["a", "access"]);
    assertEquals(columnsOf(db, "u"), ["b", "c"]);
    runMigration(db, migration);
    assertEquals(columnsOf(db, "t"), ["a", "access"]);
  } finally {
    db.close();
  }
});

Deno.test("runMigration: runs SQL as given", () => {
  const db = new DatabaseSync(":memory:");
  try {
    runMigration(db, "CREATE TABLE t (a TEXT) STRICT");
    assertEquals(columnsOf(db, "t"), ["a"]);
  } finally {
    db.close();
  }
});
