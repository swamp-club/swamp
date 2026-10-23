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
 * Where a v3 writer's Litestream sidecar keeps its state (swamp-club#3416),
 * and the files themselves.
 *
 * Every path derives from the canonical (`realPath`) `commits.db`, so two
 * spellings of one database, `/tmp/d` and `/private/tmp/d` or a symlinked
 * datastore, find the same sidecar.
 *
 * - Beside `commits.db`, in `.commits.db-replication/`, only non-secret
 *   shared files: `supervisor.lock` (held by the running supervisor for its
 *   whole life, the liveness signal), `presence.json` (the pidfile, written
 *   only by the lock holder), `replace-<pid>` marks, `use.lock` (shared by
 *   commands while they use the sidecar) and `lineage.json`; and, since
 *   swamp-club#3482, `copy.json` (which lineage and TXID the copy holds) and
 *   `restore.lock` (taken by a restore of the copy). The directory and the
 *   presence record are trusted only when this user owns them.
 * - In a per-user directory, `/tmp/swamp-<uid>/<hash>/`, created 0700 and
 *   checked before every use, what a process trusts for paths: the
 *   Litestream config and the control socket. Another user who can write a
 *   shared datastore can see that a sidecar runs, never redirect it.
 *
 * @module
 */

import { basename, dirname, join } from "@std/path";
import { markErrorPaths, UserError } from "../../../domain/errors.ts";
import {
  parseReplicationLineage,
  type ReplicationLineage,
} from "../../../domain/datastore_v3/replication_lineage.ts";
import {
  type LocalCopyState,
  parseLocalCopyState,
  serializeLineageRecord,
} from "../../../domain/datastore_v3/published_lineage.ts";
import {
  parseProcessIdentity,
  type ProcessIdentity,
} from "../../../domain/datastore_v3/process_liveness.ts";
import { atomicWriteTextFile } from "../../persistence/atomic_write.ts";
import type { V3ReplicaSetting } from "./replica_setting.ts";

/** The shared directory's name beside `commits.db`. */
export function replicationDirName(commitsDbFile: string): string {
  return `.${commitsDbFile}-replication`;
}

/** Litestream's own local state directory beside `commits.db`. */
export function litestreamStateDirName(commitsDbFile: string): string {
  return `.${commitsDbFile}-litestream`;
}

/** Where a database's sidecar state lives. */
export interface ReplicationPaths {
  /** The canonical `commits.db`. */
  readonly commitsDb: string;
  readonly sharedDir: string;
  readonly supervisorLock: string;
  readonly presence: string;
  readonly useLock: string;
  readonly lineage: string;
  /** Which lineage, up to which TXID, the copy holds (swamp-club#3482). */
  readonly copy: string;
  /** Serializes restores of the copy (swamp-club#3482). */
  readonly restoreLock: string;
  readonly privateDir: string;
  readonly config: string;
  readonly socket: string;
}

/** The AF_UNIX path limit, the trailing NUL included. */
function socketPathLimit(): number {
  return Deno.build.os === "linux" ? 108 : 104;
}

/** This user's private root, `/tmp/swamp-<uid>`. */
export function defaultPrivateRoot(): string {
  const uid = Deno.uid();
  if (uid === null) {
    throw new UserError(
      "Litestream replication needs a Unix user id; it is not available on " +
        "this platform yet.",
    );
  }
  // A short, fixed root keeps the socket under the AF_UNIX limit; TMPDIR on
  // macOS is long.
  return `/tmp/swamp-${uid}`;
}

/**
 * The replication paths of the `commits.db` at `commitsDbPath`, whose
 * directory must exist; the database itself may not yet (a copy about to
 * be restored). `privateRoot` defaults to {@link defaultPrivateRoot}.
 *
 * @throws UserError when the socket path would pass the AF_UNIX limit
 */
export async function replicationPathsFor(
  commitsDbPath: string,
  privateRoot: string = defaultPrivateRoot(),
): Promise<ReplicationPaths> {
  const commitsDb = await canonicalDatabasePath(commitsDbPath);
  const sharedDir = join(
    dirname(commitsDb),
    replicationDirName(basename(commitsDb)),
  );
  const privateDir = join(privateRoot, await shortHash(commitsDb));
  const socket = join(privateDir, "ls.sock");
  if (new TextEncoder().encode(socket).length >= socketPathLimit()) {
    throw markErrorPaths(
      new UserError(
        `The Litestream control socket path ${socket} is longer than this ` +
          `platform allows (${socketPathLimit() - 1} bytes).`,
      ),
      [socket],
    );
  }
  return {
    commitsDb,
    sharedDir,
    supervisorLock: join(sharedDir, "supervisor.lock"),
    presence: join(sharedDir, "presence.json"),
    useLock: join(sharedDir, "use.lock"),
    lineage: join(sharedDir, "lineage.json"),
    copy: join(sharedDir, "copy.json"),
    restoreLock: join(sharedDir, "restore.lock"),
    privateDir,
    config: join(privateDir, "litestream.yml"),
    socket,
  };
}

/** The database's canonical path, through its directory when it is missing. */
async function canonicalDatabasePath(path: string): Promise<string> {
  try {
    return await Deno.realPath(path);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    return join(await Deno.realPath(dirname(path)), basename(path));
  }
}

async function shortHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Whether `info` is a real directory this user owns. */
function ownedDirectory(info: Deno.FileInfo): boolean {
  const uid = Deno.uid();
  return info.isDirectory && !info.isSymlink &&
    (uid === null || info.uid === uid);
}

/**
 * Creates the per-user directory and this database's subdirectory, 0700,
 * and refuses either when it is a symlink, another user's, or open to
 * others: the config and socket in it are trusted.
 *
 * @throws UserError
 */
export async function ensurePrivateDir(paths: ReplicationPaths): Promise<void> {
  for (const dir of [dirname(paths.privateDir), paths.privateDir]) {
    try {
      await Deno.mkdir(dir, { mode: 0o700 });
    } catch (error) {
      if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
    }
    const info = await Deno.lstat(dir);
    if (!ownedDirectory(info) || ((info.mode ?? 0) & 0o077) !== 0) {
      throw markErrorPaths(
        new UserError(
          `${dir} must be a directory only this user can use (mode 0700); ` +
            `remove it and run the command again.`,
        ),
        [dir],
      );
    }
  }
}

/**
 * Creates the shared directory beside `commits.db` when it is missing, and
 * says whether this user owns it and no one else can write it. Files in
 * any other directory are never trusted.
 */
export async function ensureSharedDir(
  paths: ReplicationPaths,
): Promise<"own" | "foreign"> {
  try {
    await Deno.mkdir(paths.sharedDir, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
  // Another user could plant marks or a lineage record in a directory open
  // to others: it is not trusted, like one they own.
  const info = await Deno.lstat(paths.sharedDir);
  return ownedDirectory(info) && ((info.mode ?? 0) & 0o022) === 0
    ? "own"
    : "foreign";
}

/** What `presence.json` records about the running sidecar. */
export interface PresenceRecord {
  readonly supervisorPid: number;
  /** Set once the supervisor has started Litestream. */
  readonly litestreamPid?: number;
  readonly uid: number | null;
  /** For display, and to judge a record without `process`. */
  readonly hostname: string;
  /**
   * The supervisor's process identity, by which its owner is judged
   * (swamp-club#3801). Undefined in a record from an older swamp.
   */
  readonly process?: ProcessIdentity;
  readonly lineageFence: number;
  readonly replicaPath: string;
}

/** A presence record as a reader found it. */
export type PresenceRead =
  | { readonly kind: "missing" }
  | { readonly kind: "foreign" }
  | { readonly kind: "found"; readonly record: PresenceRecord };

/** Reads `presence.json`, trusting it only when this user owns it. */
export async function readPresence(
  paths: ReplicationPaths,
): Promise<PresenceRead> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.lstat(paths.presence);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { kind: "missing" };
    throw error;
  }
  const uid = Deno.uid();
  if (!info.isFile || (uid !== null && info.uid !== uid)) {
    return { kind: "foreign" };
  }
  try {
    const record = parsePresence(
      JSON.parse(await Deno.readTextFile(paths.presence)),
    );
    return record === undefined
      ? { kind: "missing" }
      : { kind: "found", record };
  } catch {
    // Gone between the stat and the read, or torn: as good as missing.
    return { kind: "missing" };
  }
}

function parsePresence(value: unknown): PresenceRecord | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const r = value as Record<string, unknown>;
  const pid = (v: unknown) =>
    typeof v === "number" && Number.isSafeInteger(v) && v > 0;
  if (
    !pid(r.supervisorPid) ||
    (r.litestreamPid !== undefined && !pid(r.litestreamPid)) ||
    !(r.uid === null || typeof r.uid === "number") ||
    typeof r.hostname !== "string" || !pid(r.lineageFence) ||
    typeof r.replicaPath !== "string"
  ) {
    return undefined;
  }
  const process = parseProcessIdentity(r.process);
  return {
    supervisorPid: r.supervisorPid as number,
    ...(r.litestreamPid !== undefined
      ? { litestreamPid: r.litestreamPid as number }
      : {}),
    uid: r.uid as number | null,
    hostname: r.hostname,
    ...(process !== undefined ? { process } : {}),
    lineageFence: r.lineageFence as number,
    replicaPath: r.replicaPath,
  };
}

/** Writes `presence.json` by temp file and rename. Only the lock holder calls it. */
export async function writePresence(
  paths: ReplicationPaths,
  record: PresenceRecord,
): Promise<void> {
  await atomicWriteTextFile(paths.presence, JSON.stringify(record));
}

/** Removes `presence.json` when it still names `supervisorPid`. */
export async function removeOwnPresence(
  paths: ReplicationPaths,
  supervisorPid: number,
): Promise<void> {
  const read = await readPresence(paths);
  if (read.kind === "found" && read.record.supervisorPid === supervisorPid) {
    await Deno.remove(paths.presence).catch(() => {});
  }
}

/** The replacement mark that condemns supervisor `pid`. */
export function replaceMarkPath(paths: ReplicationPaths, pid: number): string {
  return join(paths.sharedDir, `replace-${pid}`);
}

/**
 * Marks supervisor `pid` for replacement after a definite sync failure, so
 * the next command replaces it instead of reusing a sidecar that cannot
 * upload.
 */
export async function markForReplacement(
  paths: ReplicationPaths,
  pid: number,
): Promise<void> {
  try {
    await Deno.writeTextFile(replaceMarkPath(paths, pid), "", {
      createNew: true,
    });
  } catch (error) {
    if (!(error instanceof Deno.errors.AlreadyExists)) throw error;
  }
}

/** Whether a replacement mark names supervisor `pid`. */
export async function isMarkedForReplacement(
  paths: ReplicationPaths,
  pid: number,
): Promise<boolean> {
  try {
    await Deno.lstat(replaceMarkPath(paths, pid));
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/** Removes every replacement mark: a new supervisor starts clean. */
export async function clearReplacementMarks(
  paths: ReplicationPaths,
): Promise<void> {
  for await (const entry of Deno.readDir(paths.sharedDir)) {
    if (entry.isFile && /^replace-\d+$/.test(entry.name)) {
      await Deno.remove(join(paths.sharedDir, entry.name)).catch(() => {});
    }
  }
}

/** Reads `lineage.json`; an unreadable record restarts the lineage. */
export async function readLineage(
  paths: Pick<ReplicationPaths, "lineage">,
): Promise<ReplicationLineage | undefined> {
  try {
    return parseReplicationLineage(
      JSON.parse(await Deno.readTextFile(paths.lineage)),
    );
  } catch {
    return undefined;
  }
}

/** Writes `lineage.json` by temp file and rename. */
export async function writeLineage(
  paths: Pick<ReplicationPaths, "lineage">,
  lineage: ReplicationLineage,
): Promise<void> {
  await atomicWriteTextFile(paths.lineage, JSON.stringify(lineage));
}

/** Removes `lineage.json`, so the next lease restarts the lineage. */
export async function removeLineage(
  paths: Pick<ReplicationPaths, "lineage">,
): Promise<void> {
  try {
    await Deno.remove(paths.lineage);
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
}

/** Reads `copy.json`; an unreadable record means the copy's state is unknown. */
export async function readCopyState(
  paths: Pick<ReplicationPaths, "copy">,
): Promise<LocalCopyState | undefined> {
  try {
    return parseLocalCopyState(
      JSON.parse(await Deno.readTextFile(paths.copy)),
    );
  } catch {
    return undefined;
  }
}

/** Writes `copy.json` by temp file and rename. */
export async function writeCopyState(
  paths: Pick<ReplicationPaths, "copy">,
  state: LocalCopyState,
): Promise<void> {
  await atomicWriteTextFile(paths.copy, serializeLineageRecord(state));
}

/**
 * Litestream's config for one database: its control socket and one replica
 * at `replicaPath`. Strings are JSON-quoted, which YAML reads as they are.
 * It never holds credentials, which Litestream reads from its environment,
 * and never sets a checkpoint option: `commits.db` keeps SQLite's default.
 */
export function renderLitestreamConfig(
  paths: Pick<ReplicationPaths, "commitsDb" | "socket">,
  replica: V3ReplicaSetting,
  replicaPath: string,
): string {
  const q = (value: string) => JSON.stringify(value);
  return [
    "socket:",
    "  enabled: true",
    `  path: ${q(paths.socket)}`,
    ...databaseConfigLines(paths.commitsDb, replica, replicaPath),
  ].join("\n") + "\n";
}

/**
 * Litestream's config for restoring one database from `replicaPath`
 * (swamp-club#3482): the replica alone, no control socket.
 */
export function renderLitestreamRestoreConfig(
  commitsDb: string,
  replica: V3ReplicaSetting,
  replicaPath: string,
): string {
  return databaseConfigLines(commitsDb, replica, replicaPath).join("\n") +
    "\n";
}

function databaseConfigLines(
  commitsDb: string,
  replica: V3ReplicaSetting,
  replicaPath: string,
): string[] {
  const q = (value: string) => JSON.stringify(value);
  const lines = [
    "logging:",
    "  level: warn",
    "dbs:",
    `  - path: ${q(commitsDb)}`,
    "    replica:",
    // Litestream names its GCS replica type "gs".
    `      type: ${replica.type === "gcs" ? "gs" : replica.type}`,
    `      path: ${q(replicaPath)}`,
  ];
  if (replica.type === "gcs") {
    lines.push(`      bucket: ${q(replica.bucket)}`);
  }
  if (replica.type === "s3") {
    lines.push(`      bucket: ${q(replica.bucket)}`);
    if (replica.region !== undefined) {
      lines.push(`      region: ${q(replica.region)}`);
    }
    if (replica.endpoint !== undefined) {
      lines.push(`      endpoint: ${q(replica.endpoint)}`);
    }
    // Litestream turns path style on for any endpoint unless told
    // otherwise, so an explicit false must be written out.
    if (replica.forcePathStyle !== undefined) {
      lines.push(`      force-path-style: ${replica.forcePathStyle}`);
    } else if (replica.endpoint !== undefined) {
      lines.push("      force-path-style: true");
    }
  }
  return lines;
}

/** The path Litestream replicates to, for the lineage at `lineagePath`. */
export function litestreamReplicaPath(
  replica: V3ReplicaSetting,
  lineagePath: string,
): string {
  return replica.type === "file"
    ? lineagePath
    : lineagePath.replace(/^\/+/, "");
}
