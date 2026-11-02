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

import { UserError } from "../errors.ts";

export const V3_REPLICATION_UNCONFIRMED_CODE =
  "datastore_v3_replication_unconfirmed";

export const V3_CHUNK_COLLECTION_DEFERRED_CODE =
  "datastore_v3_chunk_collection_deferred";

/**
 * another copy may still restore a lineage whose commits name chunks this copy
 * does not; nothing was deleted, and a later collection runs once only the
 * current lineage is restorable
 */
export class V3ChunkCollectionDeferredError extends UserError {
  constructor(
    datastorePath: string,
    reason: string,
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
 * the commits are kept in commits.db and replicate when this checkout writes
 * next; another checkout's write first replaces them
 */
export class V3ReplicationError extends UserError {
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

export const V3_REPLICATION_UNAVAILABLE_CODE =
  "datastore_v3_replication_unavailable";

/**
 * Thrown when a write command cannot start or reuse the datastore's
 * Litestream sidecar. It is thrown before the command writes anything.
 */
export class V3ReplicationUnavailableError extends UserError {
  /**
   * a clause another message can embed: the message without its closing
   * "Nothing was changed."
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

export const V3_REPLICA_ROOT_MISMATCH_CODE =
  "datastore_v3_replica_root_mismatch";

/**
 * starting a lineage beside another replica root would fork the datastore, and
 * reading past it would show an empty one, so the command stops before either
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

export interface LitestreamSyncResponse {
  readonly status?: unknown;
  readonly txid?: unknown;
  readonly replicated_txid?: unknown;
}

/**
 * TXIDs count LTX files, so one call confirms every commit before it; anything
 * else, a missing field included, confirms nothing
 */
export function isReplicated(response: LitestreamSyncResponse): boolean {
  const { status, txid, replicated_txid: replicated } = response;
  if (status !== "synced" && status !== "no_change") return false;
  const local = txidOf(txid);
  const remote = txidOf(replicated);
  return local !== undefined && remote !== undefined && remote >= local;
}

function txidOf(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && /^[0-9a-fA-F]{1,16}$/.test(value)) {
    return BigInt(`0x${value}`);
  }
  return undefined;
}

export const SIDECAR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * five minutes, at least Litestream's L0 retention, so compaction and retention
 * run between bursts; the sidecar still exits only once no command holds it
 */
export function shouldIdleExit(
  lastUsedAtMs: number,
  nowMs: number,
  timeoutMs: number = SIDECAR_IDLE_TIMEOUT_MS,
): boolean {
  return nowMs - lastUsedAtMs >= timeoutMs;
}

export type PresenceObservation =
  | { readonly kind: "missing" }
  | { readonly kind: "foreign" }
  | {
    readonly kind: "found";
    readonly otherOwner: boolean;
    readonly supervisorVerified: boolean;
    readonly supervisorPid: number;
    readonly litestreamPid?: number;
    readonly litestreamVerified: boolean;
    readonly lineageFence: number;
  };

export interface SidecarObservation {
  readonly supervisorLock: "free" | "held";
  readonly presence: PresenceObservation;
  readonly answered: boolean;
  readonly lineageFence: number;
  readonly marked: boolean;
  readonly waitedPastDeadline: boolean;
}

export type SidecarAction =
  | { readonly kind: "reuse" }
  | { readonly kind: "start"; readonly orphanPid?: number }
  | {
    readonly kind: "replace";
    readonly reason: "frozen" | "lineage" | "marked";
    readonly supervisorPid: number;
    readonly litestreamPid?: number;
  }
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
