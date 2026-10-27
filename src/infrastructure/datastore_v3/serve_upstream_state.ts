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
 * The serve-mode state of a checkout whose v3 datastore's upstream is serve
 * (swamp-club#3985): the changes-feed cursor its copy has applied up to, the
 * head serve last reported for each partition, and a fingerprint of the
 * serve token the copy was built with (never the token). A file of its own beside
 * the checkout's copy of serve's commit log, so a solo checkout never opens
 * it and the commit store's schema is unchanged.
 *
 * A serve head can be above the copy's own: serve filters single commits a
 * caller may not read, so the copy's last commit of a partition is not
 * always serve's last. A commit is built on the higher of the two.
 *
 * @module
 */

import { dirname } from "@std/path";
import { ensureDirSync } from "@std/fs";
import { DatabaseSync } from "node:sqlite";
import { markErrorPaths, UserError } from "../../domain/errors.ts";

/** Error code for a serve-mode state file written by a newer swamp. */
export const SERVE_UPSTREAM_STATE_SCHEMA_NEWER_CODE =
  "datastore_v3_serve_state_schema_newer";

/** The file name, beside the checkout's `commits.db`. */
export const SERVE_UPSTREAM_STATE_FILE = "serve_upstream.db";

const MIGRATIONS: readonly string[] = [
  `CREATE TABLE feed (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     cursor INTEGER NOT NULL
   );
   CREATE TABLE serve_heads (
     namespace TEXT NOT NULL,
     partition TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (namespace, partition)
   );
   CREATE TABLE caller (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     fingerprint TEXT NOT NULL,
     resetting INTEGER NOT NULL DEFAULT 0
   );`,
];

/**
 * The caller a copy was built for: the fingerprint of its serve token, and
 * whether a reset to another caller started and has not finished.
 */
export interface ServeCopyCaller {
  readonly fingerprint: string;
  readonly resetting: boolean;
}

/** The schema version this swamp writes. */
export const SERVE_UPSTREAM_STATE_SCHEMA_VERSION = MIGRATIONS.length;

/** A checkout's serve-mode state: see the module doc. */
export class ServeUpstreamState {
  readonly path: string;
  readonly #db: DatabaseSync;
  #closed = false;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
  }

  /** Opens the file at `path`, creating it and its schema when absent. */
  static open(path: string): ServeUpstreamState {
    return new ServeUpstreamState(path, openStateDatabase(path));
  }

  /** The feed cursor the copy has applied up to; 0 before the first page. */
  feedCursor(): number {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT cursor FROM feed WHERE id = 1")
      .get() as { cursor: number } | undefined;
    return row?.cursor ?? 0;
  }

  /**
   * Whether the copy has read serve's feed at least once: a page was applied,
   * if only an empty one, since it was created or last reset.
   */
  hasReadFeed(): boolean {
    this.#assertOpen();
    return this.#db.prepare("SELECT 1 FROM feed WHERE id = 1").get() !==
      undefined;
  }

  /**
   * Records the feed cursor once the page it ends was applied. Never moves
   * it back: two processes catching up the same checkout both land.
   */
  advanceFeedCursor(cursor: number): void {
    this.#assertOpen();
    assertSeqLike(cursor, "feed cursor");
    this.#db.prepare(
      `INSERT INTO feed (id, cursor) VALUES (1, ?)
       ON CONFLICT (id) DO UPDATE SET cursor = MAX(cursor, excluded.cursor)`,
    ).run(cursor);
  }

  /** The head serve last reported for a partition; 0 when none was. */
  serveHead(namespace: string, partition: string): number {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT seq FROM serve_heads WHERE namespace = ? AND partition = ?",
    ).get(namespace, partition) as { seq: number } | undefined;
    return row?.seq ?? 0;
  }

  /** Records a head serve reported for a partition; never moves it back. */
  recordServeHead(namespace: string, partition: string, seq: number): void {
    this.#assertOpen();
    assertSeqLike(seq, "serve head");
    this.#db.prepare(
      `INSERT INTO serve_heads (namespace, partition, seq) VALUES (?, ?, ?)
       ON CONFLICT (namespace, partition)
       DO UPDATE SET seq = MAX(seq, excluded.seq)`,
    ).run(namespace, partition, seq);
  }

  /** The caller the copy was built for; undefined before the first stamp. */
  caller(): ServeCopyCaller | undefined {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT fingerprint, resetting FROM caller WHERE id = 1",
    ).get() as { fingerprint: string; resetting: number } | undefined;
    return row === undefined
      ? undefined
      : { fingerprint: row.fingerprint, resetting: row.resetting !== 0 };
  }

  /**
   * Records `fingerprint` as the copy's caller unless one is recorded
   * already, and returns the one recorded: two processes stamping a new
   * copy at once agree on the first.
   */
  stampCaller(fingerprint: string): ServeCopyCaller {
    this.#assertOpen();
    this.#db.prepare(
      "INSERT OR IGNORE INTO caller (id, fingerprint, resetting) VALUES (1, ?, 0)",
    ).run(fingerprint);
    return this.caller()!;
  }

  /**
   * Starts a reset to another caller: forgets the feed cursor and serve's
   * heads, which describe the old caller's view of serve, and marks the
   * reset unfinished, so a reset cut short is run again whatever the
   * fingerprint says. The recorded fingerprint stays the old caller's.
   */
  beginCallerReset(): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#db.exec("DELETE FROM feed; DELETE FROM serve_heads;");
      this.#db.prepare(
        `INSERT INTO caller (id, fingerprint, resetting) VALUES (1, '', 1)
         ON CONFLICT (id) DO UPDATE SET resetting = 1`,
      ).run();
    });
  }

  /** Ends a reset: the copy is now `fingerprint`'s. */
  finishCallerReset(fingerprint: string): void {
    this.#assertOpen();
    this.#db.prepare(
      `INSERT INTO caller (id, fingerprint, resetting) VALUES (1, ?, 0)
       ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint,
         resetting = 0`,
    ).run(fingerprint);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#db.close();
  }

  #transaction(body: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      body();
      this.#db.exec("COMMIT");
    } catch (error) {
      try {
        this.#db.exec("ROLLBACK");
      } catch {
        // Nothing open to roll back.
      }
      throw error;
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw markErrorPaths(
        new Error(`The serve-mode state at ${this.path} is closed`),
        [this.path],
      );
    }
  }
}

function assertSeqLike(value: number, what: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`A ${what} must be a non-negative integer: ${value}`);
  }
}

function openStateDatabase(path: string): DatabaseSync {
  ensureDirSync(dirname(path));
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout=5000");
    const mode = db.prepare("PRAGMA journal_mode").get() as
      | { journal_mode: string }
      | undefined;
    if (mode?.journal_mode !== "wal") db.exec("PRAGMA journal_mode=WAL");
    db.exec("PRAGMA synchronous=FULL");
    migrate(db, path);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function migrate(db: DatabaseSync, path: string): void {
  const read = () =>
    (db.prepare("PRAGMA user_version").get() as { user_version: number })
      .user_version;
  const check = (version: number) => {
    if (version > SERVE_UPSTREAM_STATE_SCHEMA_VERSION) {
      throw markErrorPaths(
        new UserError(
          `The serve-mode state at ${path} is at schema version ${version}, ` +
            `newer than this swamp's ${SERVE_UPSTREAM_STATE_SCHEMA_VERSION}: ` +
            `upgrade swamp.`,
          SERVE_UPSTREAM_STATE_SCHEMA_NEWER_CODE,
        ),
        [path],
      );
    }
  };
  check(read());
  if (read() === SERVE_UPSTREAM_STATE_SCHEMA_VERSION) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const version = read();
    check(version);
    for (
      let next = version;
      next < SERVE_UPSTREAM_STATE_SCHEMA_VERSION;
      next++
    ) {
      db.exec(MIGRATIONS[next]);
    }
    db.exec(`PRAGMA user_version=${SERVE_UPSTREAM_STATE_SCHEMA_VERSION}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Nothing open to roll back.
    }
    throw error;
  }
}
