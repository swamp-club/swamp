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
 * paths derive from the canonical commits.db so two spellings find one sidecar;
 * the shared dir is trusted only when this user owns it; config and socket live
 * in a private 0700 per-user dir
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
import {
  parseReplicaVerification,
  type ReplicaVerification,
} from "../../../domain/datastore_v3/replica_verification.ts";
import { atomicWriteTextFile } from "../../persistence/atomic_write.ts";
import type { V3ReplicaSetting } from "./replica_setting.ts";

export function replicationDirName(commitsDbFile: string): string {
  return `.${commitsDbFile}-replication`;
}

export function litestreamStateDirName(commitsDbFile: string): string {
  return `.${commitsDbFile}-litestream`;
}

export interface ReplicationPaths {
  readonly commitsDb: string;
  readonly sharedDir: string;
  readonly supervisorLock: string;
  readonly presence: string;
  readonly useLock: string;
  readonly lineage: string;
  readonly copy: string;
  readonly restoreLock: string;
  readonly verify: string;
  readonly litestreamState: string;
  readonly privateDir: string;
  readonly config: string;
  readonly socket: string;
}

/** The AF_UNIX path limit, the trailing NUL included. */
function socketPathLimit(): number {
  return Deno.build.os === "linux" ? 108 : 104;
}

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
    verify: join(sharedDir, "replica-verify.json"),
    litestreamState: join(sharedDir, "litestream-state.json"),
    privateDir,
    config: join(privateDir, "litestream.yml"),
    socket,
  };
}

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

function ownedDirectory(info: Deno.FileInfo): boolean {
  const uid = Deno.uid();
  return info.isDirectory && !info.isSymlink &&
    (uid === null || info.uid === uid);
}

/**
 * refuses a symlink, another user's directory or one open to others, since the
 * config and socket in it are trusted
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
 * reports whether this user owns the dir and no one else can write it; files in
 * any other directory are never trusted
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

export interface PresenceRecord {
  readonly supervisorPid: number;
  readonly litestreamPid?: number;
  readonly uid: number | null;
  readonly hostname: string;
  readonly process?: ProcessIdentity;
  readonly lineageFence: number;
  readonly replicaPath: string;
}

export type PresenceRead =
  | { readonly kind: "missing" }
  | { readonly kind: "foreign" }
  | { readonly kind: "found"; readonly record: PresenceRecord };

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

export async function writePresence(
  paths: ReplicationPaths,
  record: PresenceRecord,
): Promise<void> {
  await atomicWriteTextFile(paths.presence, JSON.stringify(record));
}

export async function removeOwnPresence(
  paths: ReplicationPaths,
  supervisorPid: number,
): Promise<void> {
  const read = await readPresence(paths);
  if (read.kind === "found" && read.record.supervisorPid === supervisorPid) {
    await Deno.remove(paths.presence).catch(() => {});
  }
}

export function replaceMarkPath(paths: ReplicationPaths, pid: number): string {
  return join(paths.sharedDir, `replace-${pid}`);
}

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

export async function clearReplacementMarks(
  paths: ReplicationPaths,
): Promise<void> {
  for await (const entry of Deno.readDir(paths.sharedDir)) {
    if (entry.isFile && /^replace-\d+$/.test(entry.name)) {
      await Deno.remove(join(paths.sharedDir, entry.name)).catch(() => {});
    }
  }
}

const VERIFY_TEMP_PREFIX = "verify-";

export function verifyTempPath(
  paths: Pick<ReplicationPaths, "sharedDir">,
): string {
  return join(
    paths.sharedDir,
    `${VERIFY_TEMP_PREFIX}${crypto.randomUUID()}.db`,
  );
}

export function verifyTempFiles(temp: string): string[] {
  return [temp, `${temp}-wal`, `${temp}-shm`, `${temp}.tmp`];
}

const VERIFY_TEMP_NAME =
  /^verify-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.db(-wal|-shm|\.tmp)?$/;

/**
 * only a new supervisor calls it, under the supervisor lock, so no check is
 * running; the listing is read whole before anything is removed
 */
export async function clearVerifyLeftovers(
  paths: Pick<ReplicationPaths, "sharedDir">,
): Promise<void> {
  const leftovers: string[] = [];
  for await (const entry of Deno.readDir(paths.sharedDir)) {
    if (entry.isFile && VERIFY_TEMP_NAME.test(entry.name)) {
      leftovers.push(join(paths.sharedDir, entry.name));
    }
  }
  for (const file of leftovers) await Deno.remove(file).catch(() => {});
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

export async function writeLineage(
  paths: Pick<ReplicationPaths, "lineage">,
  lineage: ReplicationLineage,
): Promise<void> {
  await atomicWriteTextFile(paths.lineage, JSON.stringify(lineage));
}

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

export async function writeCopyState(
  paths: Pick<ReplicationPaths, "copy">,
  state: LocalCopyState,
): Promise<void> {
  await atomicWriteTextFile(paths.copy, serializeLineageRecord(state));
}

/**
 * Reads `replica-verify.json`; one that is missing or does not parse is no
 * verdict, never a broken lineage.
 */
export async function readReplicaVerification(
  paths: Pick<ReplicationPaths, "verify">,
): Promise<ReplicaVerification | undefined> {
  try {
    return parseReplicaVerification(
      JSON.parse(await Deno.readTextFile(paths.verify)),
    );
  } catch {
    return undefined;
  }
}

export async function writeReplicaVerification(
  paths: Pick<ReplicationPaths, "verify">,
  verification: ReplicaVerification,
): Promise<void> {
  await atomicWriteTextFile(paths.verify, JSON.stringify(verification));
}

/**
 * the lineage Litestream's local state belongs to, or undefined when no record
 * says (missing or unreadable)
 */
export async function readLitestreamStateOwner(
  paths: Pick<ReplicationPaths, "litestreamState">,
): Promise<number | undefined> {
  try {
    const record = JSON.parse(await Deno.readTextFile(paths.litestreamState));
    const fence = record?.lineageFence;
    return typeof fence === "number" && Number.isSafeInteger(fence) &&
        fence > 0
      ? fence
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLitestreamStateOwner(
  paths: Pick<ReplicationPaths, "litestreamState">,
  lineageFence: number,
): Promise<void> {
  await atomicWriteTextFile(
    paths.litestreamState,
    JSON.stringify({ lineageFence }),
  );
}

/**
 * strings are JSON-quoted, which YAML reads as they are; never holds
 * credentials (litestream reads its environment) nor sets a checkpoint option,
 * so commits.db keeps SQLite's default
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

export function litestreamReplicaPath(
  replica: V3ReplicaSetting,
  lineagePath: string,
): string {
  return replica.type === "file"
    ? lineagePath
    : lineagePath.replace(/^\/+/, "");
}
