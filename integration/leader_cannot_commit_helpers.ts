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
import { join } from "@std/path";
import type { OutboxCommitSink } from "../src/infrastructure/datastore_v3/outbox_commit_sink.ts";

export function sqliteFull(): Error {
  return sqliteExecFull();
}

/** the shape a COMMIT run through exec() throws: no errcode, node:sqlite's code */
function sqliteExecFull(): Error {
  const dir = Deno.makeTempDirSync();
  const db = new DatabaseSync(join(dir, "full.db"));
  try {
    db.exec("PRAGMA page_size=4096; CREATE TABLE t(v BLOB);");
    db.exec("PRAGMA max_page_count=4");
    for (let i = 0; i < 100; i++) {
      db.exec("INSERT INTO t VALUES (zeroblob(4000))");
    }
  } catch (error) {
    return error as Error;
  } finally {
    db.close();
    Deno.removeSync(dir, { recursive: true });
  }
  throw new Error("the capped database never filled");
}

/** every append fails as a full disk makes SQLite fail, while full() says so */
export function fullWhen(
  full: () => boolean,
): (sink: OutboxCommitSink) => OutboxCommitSink {
  return (sink) =>
    new Proxy(sink, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property === "beginBatch") {
          return (...args: unknown[]) =>
            full() ? Promise.resolve(undefined) : value.apply(target, args);
        }
        if (property !== "append") return value.bind(target);
        return (...args: unknown[]) =>
          full() ? Promise.reject(sqliteFull()) : value.apply(target, args);
      },
    });
}
