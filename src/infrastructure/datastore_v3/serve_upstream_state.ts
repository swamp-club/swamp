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
 * (swamp-club#3985): the changes-feed cursor its copy has applied up to and
 * the commit it ended at (swamp-club#4049), the head serve last reported
 * for each partition, a fingerprint of the serve token the copy was built
 * with (never the token), and the fingerprints of the caller's read access
 * serve sent (swamp-club#4089). A file of its own beside the checkout's
 * copy of serve's commit log, so a solo checkout never opens it and the
 * commit store's schema is unchanged.
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

/** Error code for {@link ServeCopyReplacedError}. */
export const SERVE_COPY_REPLACED_CODE = "datastore_v3_serve_copy_replaced";

/**
 * Thrown when a command records its catch-up into a copy another command
 * has since reset (swamp-club#4089): what it read went into the copy that
 * was replaced, so recording it would leave the new copy missing commits.
 */
export class ServeCopyReplacedError extends UserError {
  constructor(readonly statePath: string) {
    super(
      `Another command rebuilt this checkout's copy of the datastore at ` +
        `serve while this command was reading it, after your access to it ` +
        `changed or its serve token did. Nothing this command read was ` +
        `kept. Run the command again.`,
      SERVE_COPY_REPLACED_CODE,
    );
    this.name = "ServeCopyReplacedError";
  }
}

/** The copy id a handle opened during a reset holds: never a real one. */
const RESETTING_COPY = "";

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
  // The feed anchor (swamp-club#4049): the last commit of the last page
  // applied, which serve must still hold for the cursor to mean anything.
  // And the copy's id, random per copy: a copy moved aside and started
  // afresh at the same root is another view of serve; and the id of the
  // commit log serve served it, which every later reply must name.
  `ALTER TABLE feed ADD COLUMN anchor_namespace TEXT;
   ALTER TABLE feed ADD COLUMN anchor_partition TEXT;
   ALTER TABLE feed ADD COLUMN anchor_seq INTEGER;
   ALTER TABLE feed ADD COLUMN anchor_txn_id TEXT;
   CREATE TABLE copy (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     copy_id TEXT NOT NULL,
     log_id TEXT
   );
   INSERT INTO copy (id, copy_id) VALUES (1, lower(hex(randomblob(16))));`,
  // The compaction point of the base the copy loaded (swamp-club#4006); 0
  // when it loaded none. A partition compacted past the copy's head reads
  // on from its compacted seq only when this base covers serve's point.
  `ALTER TABLE copy ADD COLUMN base_point INTEGER NOT NULL DEFAULT 0;`,
  // The caller's read access (swamp-club#4089): the fingerprint serve sent
  // when the copy was first read after it was made or reset, the last one
  // serve sent, and when (epoch ms) the copy was last reset because they
  // differed.
  `ALTER TABLE copy ADD COLUMN access_built TEXT;
   ALTER TABLE copy ADD COLUMN access_seen TEXT;
   ALTER TABLE copy ADD COLUMN access_reset_at INTEGER;`,
  // The last contact with serve (swamp-club#4195): when, and serve's clock
  // against this one then, which offline work judges a lease's expiry and
  // corrects its times by.
  `CREATE TABLE contact (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     at TEXT NOT NULL,
     clock_offset_ms INTEGER
   );`,
];

/**
 * A commit of serve's feed the copy has passed: its identity, which serve
 * must still answer with at that partition and seq.
 */
export interface ServeFeedAnchor {
  readonly namespace: string;
  readonly partition: string;
  readonly seq: number;
  readonly txnId: string;
}

/**
 * The caller a copy was built for: the fingerprint of its serve token, and
 * whether a reset to another caller started and has not finished.
 */
export interface ServeCopyCaller {
  readonly fingerprint: string;
  readonly resetting: boolean;
}

/**
 * The caller's read access as serve reported it (swamp-club#4089): the
 * fingerprint the copy was built under, the last one serve sent, and when
 * the copy was last reset because they differed. Each is undefined until
 * known: a serve too old to send the fingerprint leaves both undefined.
 */
export interface ServeCopyAccess {
  readonly built?: string;
  readonly seen?: string;
  readonly resetAt?: number;
}

/**
 * How long after a reset for a change of read access another change only
 * warns (swamp-club#4089): serve replicas whose access data disagree send
 * a caller two fingerprints in turn, which must not reset the copy on
 * every command.
 */
export const ACCESS_RESET_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * What a copy whose caller is current does about its read access at `now`
 * (epoch ms): `"current"` when serve last sent the access the copy was
 * built under (or a serve too old to send one sent none), `"reset"` when it
 * sent another, and `"cooling"` when it sent another within
 * {@link ACCESS_RESET_COOLDOWN_MS} of the last reset for access. A reset in
 * the future (the clock moved back) does not hold one off.
 */
export function accessResetDue(
  access: ServeCopyAccess,
  now: number,
): "current" | "reset" | "cooling" {
  if (
    access.built === undefined || access.seen === undefined ||
    access.built === access.seen
  ) {
    return "current";
  }
  const since = access.resetAt === undefined ? undefined : now - access.resetAt;
  return since !== undefined && since >= 0 &&
      since < ACCESS_RESET_COOLDOWN_MS
    ? "cooling"
    : "reset";
}

/** The schema version this swamp writes. */
export const SERVE_UPSTREAM_STATE_SCHEMA_VERSION = MIGRATIONS.length;

/** A checkout's serve-mode state: see the module doc. */
export class ServeUpstreamState {
  readonly path: string;
  readonly #db: DatabaseSync;
  /**
   * The copy's id when this handle opened: a reset by another handle gives
   * the copy another, and this handle's catch-up writes are then refused
   * ({@link ServeCopyReplacedError}). Opened during a reset, none: every
   * catch-up write is refused. A handle is opened before the copy's
   * `commits.db` (`openV3Datastore`), so the files it reads are never a
   * newer copy's than this id.
   */
  #copyId: string;
  #closed = false;

  private constructor(path: string, db: DatabaseSync) {
    this.path = path;
    this.#db = db;
    // A handle opened while another resets the copy may already hold files
    // that reset removes, or create ones it then removes: it records
    // nothing.
    this.#copyId = this.caller()?.resetting === true
      ? RESETTING_COPY
      : this.#currentCopyId();
  }

  #currentCopyId(): string {
    return (this.#db.prepare("SELECT copy_id FROM copy WHERE id = 1").get() as {
      copy_id: string;
    }).copy_id;
  }

  /**
   * Refuses a write for a copy this handle did not open: another handle
   * reset it since. Run inside the write's transaction.
   */
  #assertSameCopy(): void {
    if (this.#currentCopyId() !== this.#copyId) {
      throw markErrorPaths(new ServeCopyReplacedError(this.path), [this.path]);
    }
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
   * Records the feed cursor once the page it ends was applied, with the
   * page's last commit as the anchor; a page without commits keeps the
   * anchor recorded. Never moves either back: two processes catching up the
   * same checkout both land, and the anchor stays the recorded cursor's.
   * With `basePoint`, the base point the page was read under: when another
   * process loaded a base since, nothing moves and it answers false.
   */
  advanceFeedCursor(
    cursor: number,
    anchor?: ServeFeedAnchor,
    basePoint?: number,
  ): boolean {
    this.#assertOpen();
    assertSeqLike(cursor, "feed cursor");
    if (anchor !== undefined) assertSeqLike(anchor.seq, "anchor seq");
    let advanced = true;
    this.#transaction(() => {
      this.#assertSameCopy();
      // A page applied to a copy another process has since replaced with a
      // base is not in the copy: the cursor stays the base's.
      if (basePoint !== undefined && this.basePoint() !== basePoint) {
        advanced = false;
        return;
      }
      this.#advance(cursor, anchor);
    });
    return advanced;
  }

  #advance(cursor: number, anchor: ServeFeedAnchor | undefined): void {
    this.#db.prepare(
      `INSERT INTO feed (id, cursor, anchor_namespace, anchor_partition,
         anchor_seq, anchor_txn_id) VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         anchor_namespace = CASE
           WHEN excluded.cursor >= cursor AND excluded.anchor_seq IS NOT NULL
           THEN excluded.anchor_namespace ELSE anchor_namespace END,
         anchor_partition = CASE
           WHEN excluded.cursor >= cursor AND excluded.anchor_seq IS NOT NULL
           THEN excluded.anchor_partition ELSE anchor_partition END,
         anchor_seq = CASE
           WHEN excluded.cursor >= cursor AND excluded.anchor_seq IS NOT NULL
           THEN excluded.anchor_seq ELSE anchor_seq END,
         anchor_txn_id = CASE
           WHEN excluded.cursor >= cursor AND excluded.anchor_seq IS NOT NULL
           THEN excluded.anchor_txn_id ELSE anchor_txn_id END,
         cursor = MAX(cursor, excluded.cursor)`,
    ).run(
      cursor,
      anchor?.namespace ?? null,
      anchor?.partition ?? null,
      anchor?.seq ?? null,
      anchor?.txnId ?? null,
    );
  }

  /** The feed anchor; undefined before a page with a commit was applied. */
  feedAnchor(): ServeFeedAnchor | undefined {
    this.#assertOpen();
    const row = this.#db.prepare(
      `SELECT anchor_namespace, anchor_partition, anchor_seq, anchor_txn_id
       FROM feed WHERE id = 1`,
    ).get() as {
      anchor_namespace: string | null;
      anchor_partition: string | null;
      anchor_seq: number | null;
      anchor_txn_id: string | null;
    } | undefined;
    if (
      row === undefined || row.anchor_namespace === null ||
      row.anchor_partition === null || row.anchor_seq === null ||
      row.anchor_txn_id === null
    ) {
      return undefined;
    }
    return {
      namespace: row.anchor_namespace,
      partition: row.anchor_partition,
      seq: row.anchor_seq,
      txnId: row.anchor_txn_id,
    };
  }

  /**
   * Records that the copy loaded serve's compacted base at `point`
   * (swamp-club#4006), in one transaction: the feed reads on from exactly
   * the point (the install replaced every commit the copy held), the anchor
   * is forgotten (a compacted commit cannot be asked for), the base's point
   * is recorded, and each partition's compacted seq is a head serve
   * reported.
   */
  recordBaseLoaded(
    point: number,
    heads: readonly {
      readonly namespace: string;
      readonly partition: string;
      readonly seq: number;
    }[],
  ): void {
    this.#assertOpen();
    assertSeqLike(point, "compaction point");
    for (const head of heads) assertSeqLike(head.seq, "serve head");
    this.#transaction(() => {
      this.#assertSameCopy();
      this.#db.prepare(
        `INSERT OR REPLACE INTO feed (id, cursor, anchor_namespace,
           anchor_partition, anchor_seq, anchor_txn_id)
         VALUES (1, ?, NULL, NULL, NULL, NULL)`,
      ).run(point);
      this.#db.prepare("UPDATE copy SET base_point = ? WHERE id = 1").run(
        point,
      );
      const upsert = this.#db.prepare(
        `INSERT INTO serve_heads (namespace, partition, seq) VALUES (?, ?, ?)
         ON CONFLICT (namespace, partition)
         DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      );
      for (const head of heads) {
        upsert.run(head.namespace, head.partition, head.seq);
      }
    });
  }

  /** The compaction point of the base the copy loaded; 0 when none. */
  basePoint(): number {
    this.#assertOpen();
    return (this.#db.prepare("SELECT base_point FROM copy WHERE id = 1")
      .get() as { base_point: number } | undefined)?.base_point ?? 0;
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
    this.#transaction(() => {
      this.#assertSameCopy();
      this.#db.prepare(
        `INSERT INTO serve_heads (namespace, partition, seq) VALUES (?, ?, ?)
         ON CONFLICT (namespace, partition)
         DO UPDATE SET seq = MAX(seq, excluded.seq)`,
      ).run(namespace, partition, seq);
    });
  }

  /**
   * The checkout's last contact with serve (swamp-club#4195): when, by the
   * local clock, and serve's clock minus the local one then, if measured.
   */
  lastContact():
    | { readonly at: string; readonly clockOffsetMs?: number }
    | undefined {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT at, clock_offset_ms FROM contact WHERE id = 1",
    ).get() as { at: string; clock_offset_ms: number | null } | undefined;
    if (row === undefined) return undefined;
    return {
      at: row.at,
      ...(row.clock_offset_ms !== null
        ? { clockOffsetMs: row.clock_offset_ms }
        : {}),
    };
  }

  /** Records a contact with serve; see {@link lastContact}. */
  recordContact(at: Date, clockOffsetMs: number | undefined): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#db.prepare(
        `INSERT INTO contact (id, at, clock_offset_ms) VALUES (1, ?, ?)
         ON CONFLICT (id) DO UPDATE SET at = excluded.at,
           clock_offset_ms = COALESCE(excluded.clock_offset_ms, clock_offset_ms)`,
      ).run(
        at.toISOString(),
        clockOffsetMs === undefined ? null : Math.round(clockOffsetMs),
      );
    });
  }

  /**
   * The copy's id: random, made with the file, so a fresh copy at the same
   * root has another (swamp-club#4049).
   */
  copyId(): string {
    this.#assertOpen();
    return (this.#db.prepare("SELECT copy_id FROM copy WHERE id = 1").get() as {
      copy_id: string;
    }).copy_id;
  }

  /** The id of the commit log the copy follows; undefined before serve named one. */
  serveLogId(): string | undefined {
    this.#assertOpen();
    const row = this.#db.prepare("SELECT log_id FROM copy WHERE id = 1")
      .get() as { log_id: string | null } | undefined;
    return row?.log_id ?? undefined;
  }

  /**
   * Records `logId` as the log the copy follows unless one is recorded
   * already, and returns the one recorded: two processes recording at once
   * agree on the first.
   */
  recordServeLogId(logId: string): string {
    this.#assertOpen();
    this.#transaction(() => {
      this.#assertSameCopy();
      this.#db.prepare(
        "UPDATE copy SET log_id = ? WHERE id = 1 AND log_id IS NULL",
      ).run(logId);
    });
    return this.serveLogId()!;
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

  /** The caller's read access as serve reported it. */
  access(): ServeCopyAccess {
    this.#assertOpen();
    const row = this.#db.prepare(
      "SELECT access_built, access_seen, access_reset_at FROM copy WHERE id = 1",
    ).get() as {
      access_built: string | null;
      access_seen: string | null;
      access_reset_at: number | null;
    } | undefined;
    return {
      ...(row?.access_built != null ? { built: row.access_built } : {}),
      ...(row?.access_seen != null ? { seen: row.access_seen } : {}),
      ...(row?.access_reset_at != null ? { resetAt: row.access_reset_at } : {}),
    };
  }

  /**
   * Records `fingerprint` as read access serve sent, and as the access the
   * copy was built under when none is recorded: the first fingerprint a
   * copy sees is the one it was read under. A fingerprint other than the
   * built one sticks until the copy is reset: the copy took that reply, so
   * a later reply under the built access, as serve replicas that disagree
   * send, does not make it current again. Returns the access recorded.
   */
  recordAccessSeen(fingerprint: string): ServeCopyAccess {
    this.#assertOpen();
    this.#transaction(() => {
      this.#assertSameCopy();
      // A copy that read the feed before any access was recorded (one made
      // by an older swamp, or through a serve too old to send it) was built
      // under access nobody knows: it is recorded as none, so the access
      // serve sends differs and the copy is rebuilt once.
      this.#db.prepare(
        `UPDATE copy SET
           access_seen = CASE
             WHEN access_seen IS NULL OR access_seen = access_built THEN ?
             ELSE access_seen END,
           access_built = COALESCE(
             access_built,
             CASE WHEN EXISTS (SELECT 1 FROM feed) THEN '' ELSE ? END
           ) WHERE id = 1`,
      ).run(fingerprint, fingerprint);
    });
    return this.access();
  }

  /**
   * Starts a reset to another caller, or to the same caller's changed read
   * access: forgets the feed cursor, its anchor, serve's heads, the log the
   * copy follows and the access serve reported, which describe the old
   * view of serve, gives the copy a new id, so the checkout's projection is
   * rebuilt from the new copy (swamp-club#4089), and marks the reset
   * unfinished, so a reset cut short is run again whatever the fingerprint
   * says. The recorded fingerprint stays the old caller's.
   */
  beginCallerReset(): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#db.exec(
        "DELETE FROM feed; DELETE FROM serve_heads; " +
          "UPDATE copy SET log_id = NULL, base_point = 0, " +
          "copy_id = lower(hex(randomblob(16))), " +
          "access_built = NULL, access_seen = NULL;",
      );
      this.#db.prepare(
        `INSERT INTO caller (id, fingerprint, resetting) VALUES (1, '', 1)
         ON CONFLICT (id) DO UPDATE SET resetting = 1`,
      ).run();
    });
    this.#copyId = this.#currentCopyId();
  }

  /**
   * Ends a reset: the copy is now `fingerprint`'s. With `accessResetAt`,
   * the reset was for a change of read access, made at that time (epoch
   * ms).
   */
  finishCallerReset(fingerprint: string, accessResetAt?: number): void {
    this.#assertOpen();
    this.#transaction(() => {
      this.#db.prepare(
        `INSERT INTO caller (id, fingerprint, resetting) VALUES (1, ?, 0)
         ON CONFLICT (id) DO UPDATE SET fingerprint = excluded.fingerprint,
           resetting = 0`,
      ).run(fingerprint);
      if (accessResetAt !== undefined) {
        this.#db.prepare("UPDATE copy SET access_reset_at = ? WHERE id = 1")
          .run(accessResetAt);
      }
    });
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
