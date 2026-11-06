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
 * entries go in outbox order, each rebased on the caught-up partition and built
 * under its original txnId, so one a cut-off flush landed settles next time; an
 * entry leaves the outbox only once landed
 */

import {
  RUN_INITIATOR_MISMATCH_CODE,
  RUN_INITIATOR_MISMATCH_REASON,
} from "../../domain/datastore_v3/commit_authorization.ts";
import { Commit, type CommitWriter } from "../../domain/datastore_v3/commit.ts";
import {
  COMPACTED_TXN_RETENTION_MS,
  type OutboxEntry,
  type OutboxEntryState,
  type OutboxKey,
  outboxKeyOf,
} from "../../domain/datastore_v3/commit_outbox.ts";
import { CommitsCompactedError } from "../../domain/datastore_v3/commit_store.ts";
import type { DataMetadata } from "../../domain/data/data_metadata.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  restatedVersionOf,
  type VersionObservation,
} from "../../domain/datastore_v3/latest_choice.ts";
import {
  EMPTY_REBASE_CARRY,
  type LatestOutcome,
  mergeRebaseCarry,
  type OfflineRebaseCarry,
  type OfflineRebaseLookups,
  rebaseOfflineCommits,
  type RenumberedVersion,
  type VersionContent,
} from "../../domain/datastore_v3/offline_rebase.ts";
import { type Op, putOp } from "../../domain/datastore_v3/op.ts";
import {
  CommitRejectedError,
  type Partition,
} from "../../domain/datastore_v3/partition.ts";
import type { PartitionKey } from "../../domain/datastore_v3/partition_key.ts";
import type { BlobRef } from "../../domain/datastore_v3/blob_ref.ts";
import { getSwampLogger } from "../logging/logger.ts";
import { ChunkIngestError } from "./chunk_ingest.ts";
import {
  ChunkNotCachedError,
  ServeCommitMayLandError,
  ServeCommitRefusedError,
  ServeNeverReadError,
  ServeUnreachableError,
  ServeUpstreamDivergedError,
  ServeUpstreamError,
  ServeUpstreamUpgradeRequiredError,
} from "./serve_upstream_errors.ts";
import { emitServeOfflineNotice } from "./serve_offline.ts";

const logger = getSwampLogger(["datastore", "v3", "offline"]);

const FLUSH_SEQ_GAP_ATTEMPTS = 8;

export interface OfflineFlushPort {
  catchUpPartition(namespace: string, partition: PartitionKey): Promise<void>;
  partitionState(
    namespace: string,
    partition: PartitionKey,
  ): Promise<Partition>;
  partitionCommits(
    namespace: string,
    partition: PartitionKey,
  ): Promise<readonly Commit[]>;
  head(namespace: string, partition: PartitionKey): Promise<number>;
  send(commit: Commit, leaseId: string | undefined): Promise<unknown>;
  encodeMetadata(metadata: DataMetadata): Uint8Array;
  storeChunks(namespace: string, bytes: Uint8Array): Promise<BlobRef>;
  mark(
    keys: readonly OutboxKey[],
    state: OutboxEntryState,
    reason?: string,
    code?: string,
  ): Promise<void>;
  settle(keys: readonly OutboxKey[]): Promise<void>;
  /**
   * Records that an offline entry landed, before its settle: a later flush
   * judges the versions it wrote as this checkout's own, and its later
   * entries follow what it renumbered and rewrote (`carry`).
   */
  recordOwnLanded?(
    key: OutboxKey,
    at: number,
    carry?: OfflineRebaseCarry,
  ): Promise<void>;
  landedCarry?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<OfflineRebaseCarry>;
  ownLanded?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<ReadonlySet<string>>;
  markSentMaybe?(key: OutboxKey, at: number): Promise<void>;
  compactedThrough?(
    namespace: string,
    partition: PartitionKey,
  ): Promise<number>;
  compactedVersion?(
    namespace: string,
    partition: PartitionKey,
    name: string,
    version: number,
  ): Promise<
    | { readonly metadata: DataMetadata; readonly raw?: Uint8Array }
    | undefined
  >;
  /**
   * an entry serve refused for a missing grant, now marked quarantined and
   * deposited with serve for an admin to accept; a failed deposit is logged and
   * the entry stays either way
   */
  quarantined?(entry: OutboxEntry, reason: string): Promise<void>;
  /**
   * what serve did with a quarantined entry's deposit; undefined when serve
   * holds none or cannot be asked. A discarded one is settled here as declined
   */
  quarantineState?(
    entry: OutboxEntry,
  ): Promise<"held" | "accepted" | "discarded" | undefined>;
}

export interface OfflineFlushReport {
  readonly landed: number;
  readonly waiting: number;
  readonly rejected: number;
  readonly quarantined: number;
  readonly renumbered: readonly FlushedVersion[];
  readonly latest: readonly FlushedLatest[];
  readonly latestAtEnd: readonly FlushedLatest[];
}

export type FlushedVersion = RenumberedVersion & { readonly behavior: string };

export type FlushedLatest = LatestOutcome & { readonly behavior: string };

/**
 * a later entry's outcome supersedes an earlier one's for the same behavior and
 * name; names of different behaviors never mix, though spelled alike
 */
export function latestAtEndOf(
  latest: readonly FlushedLatest[],
): FlushedLatest[] {
  const atEnd = new Map<string, FlushedLatest>();
  for (const choice of latest) {
    atEnd.set(JSON.stringify([choice.behavior, choice.name]), choice);
  }
  return [...atEnd.values()];
}

function behaviorOf(partition: Commit["partition"]): string {
  const identity = partition.identity;
  return identity.kind === "model"
    ? `${identity.type}/${identity.id}`
    : partition.toString();
}

type EntryOutcome =
  | {
    readonly kind: "landed";
    readonly renumbered: readonly RenumberedVersion[];
    readonly latest: readonly LatestOutcome[];
    readonly carry: OfflineRebaseCarry;
  }
  | { readonly kind: "waiting" }
  | { readonly kind: "stop"; readonly sentMaybe?: boolean }
  | {
    readonly kind: "rejected";
    readonly reason: string;
    readonly code?: string;
  }
  | { readonly kind: "quarantined"; readonly reason: string };

export async function flushOfflineEntries(
  port: OfflineFlushPort,
  entries: readonly OutboxEntry[],
  options: {
    readonly writer: CommitWriter;
    readonly fence: number;
    readonly clock?: () => Date;
    readonly signal?: AbortSignal;
  },
): Promise<OfflineFlushReport> {
  const clock = options.clock ?? (() => new Date());
  let landed = 0;
  let waiting = 0;
  let rejected = 0;
  let quarantined = 0;
  const renumbered: FlushedVersion[] = [];
  const latest: FlushedLatest[] = [];
  // A partition whose entry waits keeps its later entries waiting too:
  // they were queued after it.
  const held = new Set<string>();
  const flushed = new Set<string>();
  const carries = new Map<string, OfflineRebaseCarry>();
  const carryOf = async (entry: OutboxEntry): Promise<OfflineRebaseCarry> => {
    const id = entry.commit.partition.toString();
    let carry = carries.get(id);
    if (carry === undefined) {
      carry = await port.landedCarry?.(
        entry.commit.namespace,
        entry.commit.partition,
      ) ?? EMPTY_REBASE_CARRY;
      carries.set(id, carry);
    }
    return carry;
  };
  let stopped = false;
  for (const entry of entries) {
    options.signal?.throwIfAborted();
    const partition = entry.commit.partition.toString();
    if (stopped || held.has(partition)) {
      waiting++;
      continue;
    }
    const key = outboxKeyOf(entry.commit);
    let outcome: EntryOutcome;
    try {
      outcome = await flushEntry(
        port,
        entry,
        options,
        clock,
        flushed,
        await carryOf(entry),
        reservedBy(entries, entry, flushed),
      );
    } catch (error) {
      if (stopsTheFlush(error)) throw error;
      if (isEntryOwnError(error)) {
        outcome = { kind: "rejected", reason: messageOf(error) };
      } else {
        // A local failure that may pass (a full disk, a refused
        // permission): the entry stays queued and is tried again.
        logger
          .warn`Could not send a change this checkout saved offline to ${partition}; it stays queued and a later command tries again: ${error}`;
        outcome = { kind: "stop" };
      }
    }
    switch (outcome.kind) {
      case "landed":
        landed++;
        flushed.add(entry.commit.txnId);
        for (const version of outcome.renumbered) {
          renumbered.push({
            ...version,
            behavior: behaviorOf(entry.commit.partition),
          });
        }
        for (const choice of outcome.latest) {
          latest.push({
            ...choice,
            behavior: behaviorOf(entry.commit.partition),
          });
        }
        carries.set(
          partition,
          mergeRebaseCarry(await carryOf(entry), outcome.carry),
        );
        await port.recordOwnLanded?.(key, clock().getTime(), outcome.carry);
        await port.settle([key]);
        break;
      case "waiting":
        waiting++;
        held.add(partition);
        break;
      case "stop":
        waiting++;
        stopped = true;
        if (outcome.sentMaybe === true && port.markSentMaybe !== undefined) {
          await port.markSentMaybe(key, clock().getTime());
        }
        break;
      case "rejected":
        rejected++;
        held.add(partition);
        await port.mark([key], "rejected", outcome.reason, outcome.code);
        if (outcome.code === RUN_INITIATOR_MISMATCH_CODE) {
          logger
            .warn`A run record this checkout saved offline to ${partition} was refused for its initiator: an older swamp CLI wrote it. It is kept in the outbox; upgrade swamp and run the work again: ${outcome.reason}`;
        } else {
          logger
            .warn`A change this checkout saved offline to ${partition} could not be sent and is kept in its outbox: ${outcome.reason}`;
        }
        break;
      case "quarantined":
        quarantined++;
        held.add(partition);
        await port.mark([key], "quarantined", outcome.reason);
        logger
          .warn`Serve refused a change this checkout saved offline to ${partition} because you lack a grant it needs; it is quarantined, kept in this checkout's outbox for an admin to accept: ${outcome.reason}`;
        if (port.quarantined !== undefined) {
          try {
            await port.quarantined(entry, outcome.reason);
          } catch (error) {
            logger
              .warn`Could not hand the quarantined change to serve; it stays in this checkout's outbox: ${error}`;
          }
        }
        break;
    }
  }
  const report = {
    landed,
    waiting,
    rejected,
    quarantined,
    renumbered,
    latest,
    latestAtEnd: latestAtEndOf(latest),
  };
  reportFlush(report);
  emitServeOfflineNotice({ notice: "datastore_offline_flush", ...report });
  return report;
}

async function flushEntry(
  port: OfflineFlushPort,
  entry: OutboxEntry,
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
  flushed: ReadonlySet<string>,
  carry: OfflineRebaseCarry,
  reserved: (name: string) => ReadonlySet<number>,
): Promise<EntryOutcome> {
  const { commit } = entry;
  const namespace = commit.namespace;
  // Sent before without an answer, and serve may have pruned its txnId
  // since: whether it landed cannot be told, so it is never sent again.
  if (
    entry.sentMaybeAt !== undefined &&
    clock().getTime() - entry.sentMaybeAt > COMPACTED_TXN_RETENTION_MS
  ) {
    return {
      kind: "rejected",
      reason:
        `possible-duplicate: it was sent at ${
          new Date(entry.sentMaybeAt).toISOString()
        } without an answer, and serve no longer records whether it landed; ` +
        `check the datastore before applying it again`,
    };
  }
  // Under the lease it was queued under first; once serve says that lease
  // has ended or been superseded, under none.
  let leaseId = entry.lease?.leaseId;
  // Cleared when serve will not give this checkout the content a
  // restatement re-puts: the rebased version then takes latest.
  let restate = true;
  for (let attempt = 1;; attempt++) {
    let ops: readonly Op[];
    let outcome: Pick<
      Extract<EntryOutcome, { kind: "landed" }>,
      "renumbered" | "latest" | "carry"
    >;
    let seq: number;
    let built: Commit;
    try {
      await port.catchUpPartition(namespace, commit.partition);
      const partition = await port.partitionState(namespace, commit.partition);
      seq = await port.head(namespace, commit.partition);
      const lookups = await lookupsOf(port, namespace, commit, partition, {
        baseSeq: entry.base.seq,
        flushed,
      });
      const [rebased] = await asEntryOwn(() =>
        rebaseOfflineCommits([commit], partition, lookups, {
          encodeMetadata: port.encodeMetadata,
          restate,
          carry,
          reserved,
        })
      );
      if (rebased.kind === "rejected") {
        return { kind: "rejected", reason: rebased.detail };
      }
      ops = rebased.kind === "unchanged"
        ? rebased.commit.ops
        : await opsOf(port, namespace, rebased.changes);
      outcome = rebased.kind === "unchanged"
        ? { renumbered: [], latest: [], carry: EMPTY_REBASE_CARRY }
        : {
          renumbered: rebased.renumbered,
          latest: restate ? rebased.latest : rebased.latest.map(notProvided),
          carry: rebased.carry,
        };
      const sentOps = ops;
      built = await asEntryOwn(() =>
        Promise.resolve(buildCommit(commit, sentOps, seq, options, clock))
      );
    } catch (error) {
      if (error instanceof ServeUnreachableError) return { kind: "stop" };
      throw error;
    }
    try {
      await port.send(built, leaseId);
      return { kind: "landed", ...outcome };
    } catch (error) {
      if (error instanceof ServeUnreachableError) {
        return { kind: "stop", sentMaybe: error.sent === "maybe" };
      }
      if (error instanceof ServeCommitMayLandError) {
        return { kind: "stop", sentMaybe: true };
      }
      if (
        error instanceof ServeUpstreamError &&
        error.code === CHUNK_NOT_PROVIDED
      ) {
        // The restatement re-puts the current latest's content, which serve
        // will not let this checkout name: sent again without it.
        if (
          restate && outcome.latest.some((choice) => choice.kind === "restated")
        ) {
          restate = false;
          continue;
        }
        return { kind: "rejected", reason: error.message };
      }
      if (error instanceof CommitRejectedError) {
        if (error.reason === "seq-gap" && attempt < FLUSH_SEQ_GAP_ATTEMPTS) {
          continue;
        }
        // The lease it was queued under has ended or was superseded: sent
        // again under none, rebased on what landed meanwhile.
        if (
          leaseId !== undefined &&
          (error.reason === "lease-lost" || error.reason === "stale-lease")
        ) {
          leaseId = undefined;
          continue;
        }
        if (error.reason === "lease-lost") return { kind: "waiting" };
        return { kind: "rejected", reason: error.message };
      }
      if (error instanceof ServeCommitRefusedError) {
        if (error.reason === "forbidden") {
          return { kind: "quarantined", reason: error.message };
        }
        return {
          kind: "rejected",
          reason: error.message,
          ...(error.reason === RUN_INITIATOR_MISMATCH_REASON
            ? { code: RUN_INITIATOR_MISMATCH_CODE }
            : {}),
        };
      }
      throw error;
    }
  }
}

/**
 * versions of a data name that the partition's other still-queued entries hold
 * by their queued numbers; this entry's renumbered versions never land on one
 */
function reservedBy(
  entries: readonly OutboxEntry[],
  entry: OutboxEntry,
  flushed: ReadonlySet<string>,
): (name: string) => ReadonlySet<number> {
  return (name) => {
    const reserved = new Set<number>();
    for (const other of entries) {
      if (
        other === entry || flushed.has(other.commit.txnId) ||
        !other.commit.partition.equals(entry.commit.partition)
      ) {
        continue;
      }
      for (const op of other.commit.ops) {
        if (op.kind === "data-version" && op.metadata.name === name) {
          reserved.add(op.metadata.version);
        }
      }
    }
    return reserved;
  };
}

const CHUNK_NOT_PROVIDED = "chunk_not_provided";

function notProvided(choice: LatestOutcome): LatestOutcome {
  return choice.kind === "rebased" && choice.restateSkipped === "disabled"
    ? { ...choice, restateSkipped: "content-not-provided" }
    : choice;
}

function buildCommit(
  commit: Commit,
  ops: readonly Op[],
  seq: number,
  options: { readonly writer: CommitWriter; readonly fence: number },
  clock: () => Date,
): Commit {
  return Commit.create({
    seq: seq + 1,
    partition: commit.partition,
    namespace: commit.namespace,
    txnId: commit.txnId,
    writer: options.writer,
    ...(commit.executedAt !== undefined
      ? { executedAt: commit.executedAt }
      : {}),
    ...(commit.clockOffsetMs !== undefined
      ? { clockOffsetMs: commit.clockOffsetMs }
      : {}),
    ...(commit.principal !== undefined ? { principal: commit.principal } : {}),
    fence: options.fence,
    at: clock().toISOString(),
    ops,
  });
}

class OfflineEntryUnbuildableError extends Error {
  constructor(cause: unknown) {
    super(
      `The change cannot be rebuilt for sending: ${messageOf(cause)}`,
      { cause },
    );
    this.name = "OfflineEntryUnbuildableError";
  }
}

/**
 * a failure in this pure rebuild step is the entry's own, unless it is a local
 * I/O failure that may pass
 */
async function asEntryOwn<T>(build: () => Promise<T>): Promise<T> {
  try {
    return await build();
  } catch (error) {
    if (isTransientLocalError(error)) throw error;
    throw new OfflineEntryUnbuildableError(error);
  }
}

function isEntryOwnError(error: unknown): boolean {
  return error instanceof ChunkNotCachedError ||
    error instanceof ChunkIngestError ||
    error instanceof OfflineEntryUnbuildableError;
}

function isTransientLocalError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (Object.values(Deno.errors).some((type) => error instanceof type)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) ||
    /\(os error \d+\)/.test(error.message);
}

/**
 * only a version the offline writer could not have seen is judged: landed after
 * the entry's base and not this checkout's own offline work; a restatement is
 * never own, since it stands for another writer's version
 */
async function lookupsOf(
  port: OfflineFlushPort,
  namespace: string,
  entryCommit: Commit,
  state: Partition,
  seen: { readonly baseSeq: number; readonly flushed: ReadonlySet<string> },
): Promise<OfflineRebaseLookups> {
  const partition = entryCommit.partition;
  const observations = new Map<string, VersionObservation>();
  const contents = new Map<string, VersionContent>();
  const stored = new Set<string>();
  const own = await port.ownLanded?.(namespace, partition) ?? new Set();
  for (const commit of await port.partitionCommits(namespace, partition)) {
    const ownOffline = seen.flushed.has(commit.txnId) || own.has(commit.txnId);
    for (const op of commit.ops) {
      if (op.kind !== "data-version") continue;
      const id = `${op.metadata.name}@${op.metadata.version}`;
      stored.add(id);
      // This checkout's own offline writes were seen by its later offline
      // work; a restatement such a commit carries was not: it stands for
      // another writer's version and competes with that version's time.
      const restatement = restatedVersionOf(op.metadata.tags) !== undefined;
      const sawIt = commit.seq <= seen.baseSeq ||
        (ownOffline && !restatement);
      if (!sawIt) {
        observations.set(id, {
          committedAt: commit.at,
          createdAt: op.metadata.createdAt,
          tags: op.metadata.tags,
        });
      }
      const suffix = `/${op.metadata.name}/${op.metadata.version}/raw`;
      const raw = commit.ops.find((other) =>
        other.kind === "put" && other.key.toString().endsWith(suffix)
      );
      if (raw !== undefined && raw.kind === "put") {
        contents.set(id, {
          raw: raw.content,
          ...(raw.access === undefined ? {} : { rawAccess: raw.access }),
          metadata: op.metadata,
        });
      }
    }
  }
  await addCompactedVersions(port, namespace, entryCommit, state, seen, {
    stored,
    observations,
    contents,
  });
  return {
    observation: (name, version) => observations.get(`${name}@${version}`),
    content: (name, version) => contents.get(`${name}@${version}`),
  };
}

const MAX_COMPACTED_LOOKUPS = 8;

/**
 * Adds what the checkout's files hold of compacted versions the offline
 * writer may not have seen: none when compaction stopped at or before the
 * entry's base, since it saw everything compacted then.
 */
async function addCompactedVersions(
  port: OfflineFlushPort,
  namespace: string,
  entryCommit: Commit,
  state: Partition,
  seen: { readonly baseSeq: number },
  known: {
    readonly stored: ReadonlySet<string>;
    readonly observations: Map<string, VersionObservation>;
    readonly contents: Map<string, VersionContent>;
  },
): Promise<void> {
  if (
    port.compactedThrough === undefined || port.compactedVersion === undefined
  ) {
    return;
  }
  const partition = entryCommit.partition;
  if (await port.compactedThrough(namespace, partition) <= seen.baseSeq) {
    return;
  }
  const names = new Set<string>();
  for (const op of entryCommit.ops) {
    if (op.kind === "data-version") names.add(op.metadata.name);
  }
  for (const name of names) {
    let version = state.latest(name);
    for (
      let hop = 0;
      version !== undefined && hop < MAX_COMPACTED_LOOKUPS;
      hop++
    ) {
      const id = `${name}@${version}`;
      if (known.stored.has(id) || known.observations.has(id)) break;
      const found = await port.compactedVersion(
        namespace,
        partition,
        name,
        version,
      );
      if (found === undefined) break;
      const { metadata } = found;
      known.observations.set(id, {
        createdAt: metadata.createdAt,
        tags: metadata.tags,
      });
      if (found.raw !== undefined) {
        known.contents.set(id, {
          raw: found.raw.length <= MAX_INLINE
            ? { inline: base64Of(found.raw) }
            : { blob: await port.storeChunks(namespace, found.raw) },
          metadata,
        });
      }
      version = restatedVersionOf(metadata.tags);
    }
  }
}

/**
 * a cancelled command or serve refusing the caller, diverging, compacting past
 * the copy or asking for an upgrade stops the flush; other errors reject only
 * the one entry
 */
function stopsTheFlush(error: unknown): boolean {
  return (error instanceof DOMException && error.name === "AbortError") ||
    error instanceof ServeUpstreamError ||
    error instanceof ServeUpstreamDivergedError ||
    error instanceof ServeUpstreamUpgradeRequiredError ||
    error instanceof ServeNeverReadError ||
    error instanceof CommitsCompactedError;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function opsOf(
  port: OfflineFlushPort,
  namespace: string,
  changes: readonly TypedChange[],
): Promise<Op[]> {
  const ops: Op[] = [];
  for (const change of changes) {
    if ("op" in change) {
      ops.push(change.op);
      continue;
    }
    const { put } = change;
    if (!(put.content instanceof Uint8Array)) {
      throw new Error(
        "Internal error: a rebased offline commit stages bytes only",
      );
    }
    const content = put.content.length <= MAX_INLINE
      ? { inline: base64Of(put.content) }
      : { blob: await port.storeChunks(namespace, put.content) };
    ops.push(
      await putOp({
        intent: put.intent,
        key: put.key,
        ...content,
        ...(put.expect === undefined ? {} : { expect: put.expect }),
        ...(put.access === undefined ? {} : { access: put.access }),
      }),
    );
  }
  return ops;
}

const MAX_INLINE = 8 * 1024;

function base64Of(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function reportFlush(report: OfflineFlushReport): void {
  if (report.landed > 0) {
    const moved = report.renumbered
      .filter((version) => version.from !== version.to)
      .map((version) =>
        `${version.behavior} ${version.name} ${version.from}→${version.to}`
      );
    logger
      .info`Sent ${report.landed} change(s) this checkout saved while serve was unreachable`;
    if (moved.length > 0) {
      logger
        .info`Versions saved offline were renumbered after what landed meanwhile: ${
        moved.join(", ")
      }`;
    }
    for (const outcome of report.latestAtEnd) {
      if (outcome.kind === "restated") {
        logger
          .info`${outcome.behavior} ${outcome.name}: the latest version stays the one observed last, restated as version ${outcome.version} (its content is version ${outcome.restates}'s)`;
      } else if (outcome.restateSkipped === "content-not-provided") {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest, though the version it follows was observed later: serve would not let this checkout restate that version's content`;
      } else if (outcome.restateSkipped !== undefined) {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest (${outcome.restateSkipped})`;
      } else {
        logger
          .info`${outcome.behavior} ${outcome.name}: version ${outcome.version}, saved offline, is now latest`;
      }
    }
  }
  if (report.waiting > 0) {
    logger
      .info`${report.waiting} change(s) saved offline are still waiting in this checkout's outbox; a later command sends them`;
  }
}
