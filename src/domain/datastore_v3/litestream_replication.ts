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
 * The rules a v3 writer's Litestream sidecar follows (swamp-club#3416, Phase
 * 4 D1): when a forced sync has replicated a command's commits, when an idle
 * sidecar may exit, and what a command does with the sidecar it finds.
 *
 * Pure rules, no I/O, with time passed in. The sidecar itself lives in
 * `src/infrastructure/datastore_v3/litestream/`. See "Knowing a commit is
 * replicated", "The idle sidecar" and "What changes for Phase 4D and 4E" in
 * `design/enablers/datastore-litestream.md`.
 *
 * @module
 */

import { UserError } from "../errors.ts";

/** Error code for a write command whose commits a sync did not confirm. */
export const V3_REPLICATION_UNCONFIRMED_CODE =
  "datastore_v3_replication_unconfirmed";

/** Error code for a chunk collection a replicated copy defers. */
export const V3_CHUNK_COLLECTION_DEFERRED_CODE =
  "datastore_v3_chunk_collection_deferred";

/**
 * Thrown when chunk garbage collection may not run against a replicated
 * copy yet (swamp-club#3491): another copy may still restore a lineage
 * whose commits name chunks this copy does not. Nothing was deleted, and a
 * later collection runs once only the current lineage is restorable.
 */
export class V3ChunkCollectionDeferredError extends UserError {
  constructor(
    datastorePath: string,
    reason: string,
    /** When collection runs instead; the lineage rule's by default. */
    until: string =
      "once the current replication lineage is the only one that can be restored",
  ) {
    super(
      `Chunks of the v3 datastore at ${datastorePath} are not collected ` +
        `yet: ${reason}. Nothing was deleted; collection runs ${until}.`,
      V3_CHUNK_COLLECTION_DEFERRED_CODE,
    );
    this.name = "V3ChunkCollectionDeferredError";
  }
}

/**
 * Thrown when a write command cannot confirm that its commits reached the
 * replica. They are kept in `commits.db` and replicate when this checkout
 * writes next; another checkout's write first replaces them
 * (swamp-club#3565).
 */
export class V3ReplicationError extends UserError {
  /** Why the commits were not confirmed, as the message embeds it. */
  readonly detail: string;

  constructor(detail: string, options: { readonly cause?: unknown } = {}) {
    super(
      `This command's changes are saved locally, but swamp could not confirm ` +
        `that they reached the datastore's replica: ${detail}. They are ` +
        `kept in commits.db and replicate when the next write command runs ` +
        `in this checkout; if another checkout writes to the datastore ` +
        `first, they are lost.`,
      V3_REPLICATION_UNCONFIRMED_CODE,
    );
    this.detail = detail;
    this.name = "V3ReplicationError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Error code for a write command that cannot use the replication sidecar. */
export const V3_REPLICATION_UNAVAILABLE_CODE =
  "datastore_v3_replication_unavailable";

/**
 * Thrown when a write command cannot start or reuse the datastore's
 * Litestream sidecar. It is thrown before the command writes anything.
 */
export class V3ReplicationUnavailableError extends UserError {
  /**
   * Why, as a clause another message can embed: the message without its
   * closing "Nothing was changed." (swamp-club#3497).
   */
  readonly reason: string;

  constructor(detail: string, options: { readonly cause?: unknown } = {}) {
    const reason = `swamp cannot replicate this v3 datastore: ${detail}`;
    super(`${reason}. Nothing was changed.`, V3_REPLICATION_UNAVAILABLE_CODE);
    this.reason = reason;
    this.name = "V3ReplicationUnavailableError";
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

/** Error code for a datastore whose newest lineage is under another replica. */
export const V3_REPLICA_ROOT_MISMATCH_CODE =
  "datastore_v3_replica_root_mismatch";

/**
 * Thrown when the datastore's newest replication lineage was started under
 * another replica root than this checkout's (swamp-club#3801): another
 * bucket or path recorded in this datastore's control plane. Starting a
 * lineage beside it would fork the datastore, and reading past it would
 * show an empty one, so the command stops before either.
 */
export class V3ReplicaRootMismatchError extends UserError {
  constructor(
    datastorePath: string,
    lineageFence: string,
    recordedRoot: string,
    ownRoot: string,
  ) {
    super(
      `Replication lineage ${lineageFence} of the v3 datastore at ` +
        `${datastorePath} was started under replica root ${recordedRoot}, ` +
        `but this checkout replicates under ${ownRoot}. swamp does not start ` +
        `a second lineage beside it: check that this checkout's datastore ` +
        `names the same bucket and prefix as the checkout that wrote it (the ` +
        `S3 endpoint need not match). ` +
        `Nothing was changed.`,
      V3_REPLICA_ROOT_MISMATCH_CODE,
    );
    this.name = "V3ReplicaRootMismatchError";
  }
}

/** What Litestream's `POST /sync` with `wait` answers. */
export interface LitestreamSyncResponse {
  readonly status?: unknown;
  readonly txid?: unknown;
  readonly replicated_txid?: unknown;
}

/**
 * Whether a `/sync` call that started after a command's commits returned
 * confirms them: status `synced` or `no_change`, and the replicated TXID at
 * least the local one. Litestream's TXIDs count LTX files, so one call
 * confirms every commit before it. Anything else, a missing field included,
 * confirms nothing.
 */
export function isReplicated(response: LitestreamSyncResponse): boolean {
  const { status, txid, replicated_txid: replicated } = response;
  if (status !== "synced" && status !== "no_change") return false;
  const local = txidOf(txid);
  const remote = txidOf(replicated);
  return local !== undefined && remote !== undefined && remote >= local;
}

/**
 * A TXID as Litestream renders it: a number, or a 16-digit hex string in
 * some versions' JSON.
 */
function txidOf(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9a-fA-F]{1,16}$/.test(value)) {
    return BigInt(`0x${value}`);
  }
  return undefined;
}

/** How long an unused sidecar keeps running. */
export const SIDECAR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Whether a sidecar last used at `lastUsedAtMs` has been idle for its whole
 * timeout at `nowMs`. Five minutes, at least Litestream's L0 retention, so
 * compaction and retention run between bursts. The sidecar still exits only
 * once no command holds it.
 */
export function shouldIdleExit(
  lastUsedAtMs: number,
  nowMs: number,
  timeoutMs: number = SIDECAR_IDLE_TIMEOUT_MS,
): boolean {
  return nowMs - lastUsedAtMs >= timeoutMs;
}

/** What the presence record beside `commits.db` said, as a command read it. */
export type PresenceObservation =
  /** No record, or one this process cannot read or parse. */
  | { readonly kind: "missing" }
  /** A record another user wrote, or one in a directory another user owns. */
  | { readonly kind: "foreign" }
  | {
    readonly kind: "found";
    /** The record names another user or host. */
    readonly otherOwner: boolean;
    /** The supervisor pid's argv shows this database's supervisor. */
    readonly supervisorVerified: boolean;
    readonly supervisorPid: number;
    /** The Litestream pid, once the supervisor has recorded it. */
    readonly litestreamPid?: number;
    /** That pid is alive and its argv names this database's config. */
    readonly litestreamVerified: boolean;
    /** The lineage the sidecar's Litestream replicates. */
    readonly lineageFence: number;
  };

/** Everything a command observed about the sidecar, under the shared use lock. */
export interface SidecarObservation {
  /** Whether a supervisor holds the database's supervisor lock. */
  readonly supervisorLock: "free" | "held";
  readonly presence: PresenceObservation;
  /** Whether the control socket answered `GET /info` within its deadline. */
  readonly answered: boolean;
  /** The lineage this command replicates. */
  readonly lineageFence: number;
  /** A replacement mark names the recorded supervisor. */
  readonly marked: boolean;
  /** This command has waited out its start deadline already. */
  readonly waitedPastDeadline: boolean;
}

/** What a command does with the sidecar it found. */
export type SidecarAction =
  | { readonly kind: "reuse" }
  /** Start one, first killing an orphaned Litestream when one is named. */
  | { readonly kind: "start"; readonly orphanPid?: number }
  | {
    readonly kind: "replace";
    readonly reason: "frozen" | "lineage" | "marked";
    readonly supervisorPid: number;
    readonly litestreamPid?: number;
  }
  /** A sidecar is starting, or stopping: look again shortly. */
  | { readonly kind: "wait" }
  | { readonly kind: "refuse"; readonly reason: string };

/**
 * Decides what to do with the sidecar a command found. A kill is only ever
 * decided for a pid whose argv verified it as this database's own; anything
 * this command cannot verify is waited for, then refused, never killed, so
 * two sidecars never share a replica path.
 */
export function decideSidecarAction(o: SidecarObservation): SidecarAction {
  const presence = o.presence;
  if (o.supervisorLock === "free") {
    // No supervisor runs. A Litestream it left behind still replicates the
    // old lineage and must go first.
    if (
      presence.kind === "found" && presence.litestreamPid !== undefined &&
      presence.litestreamVerified
    ) {
      return { kind: "start", orphanPid: presence.litestreamPid };
    }
    return { kind: "start" };
  }
  if (
    presence.kind === "foreign" ||
    (presence.kind === "found" && presence.otherOwner)
  ) {
    return {
      kind: "refuse",
      reason: "another user or host runs this datastore's Litestream sidecar",
    };
  }
  if (presence.kind === "missing" || !presence.supervisorVerified) {
    // A supervisor that has not written its record yet, or one this command
    // cannot verify: wait for it, never kill it.
    return o.waitedPastDeadline
      ? {
        kind: "refuse",
        reason:
          "the datastore's supervisor lock is held by a process swamp cannot " +
          "verify as its Litestream sidecar",
      }
      : { kind: "wait" };
  }
  const replace = (reason: "frozen" | "lineage" | "marked"): SidecarAction => ({
    kind: "replace",
    reason,
    supervisorPid: presence.supervisorPid,
    ...(presence.litestreamPid !== undefined && presence.litestreamVerified
      ? { litestreamPid: presence.litestreamPid }
      : {}),
  });
  if (o.marked) return replace("marked");
  if (presence.lineageFence !== o.lineageFence) return replace("lineage");
  if (o.answered) return { kind: "reuse" };
  // Starting (no socket yet) or frozen (a socket that never answers).
  return o.waitedPastDeadline ? replace("frozen") : { kind: "wait" };
}
