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

import {
  type DatastoreConfig,
  getDatastoreDirectories,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { OutboxEntry } from "../../domain/datastore_v3/commit_outbox.ts";
import type { QuarantineRecord } from "../../domain/datastore_v3/quarantine.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the datastore status output.
 */
export interface DatastoreStatusData {
  type: string;
  path?: string;
  healthy: boolean;
  message: string;
  latencyMs: number;
  directories: string[];
  exclude?: string[];
  /** Set to 3 on a v3 datastore (swamp-club#3279); absent on v2. */
  format?: 3;
  /** The v3 commit log, on a v3 datastore. */
  commitLog?: DatastoreCommitLogStatus;
  /**
   * The explicit leases serve holds (swamp-club#4195), from
   * `datastore status --server`: who holds each and when it ends unless
   * renewed. Absent from a local status.
   */
  explicitLeases?: DatastoreExplicitLeaseStatus[];
  /**
   * This checkout's outbox entries that are not simply waiting to land
   * (swamp-club#4195): queued offline, rejected or quarantined. Absent
   * when the checkout holds none, and from `--server`.
   */
  outbox?: DatastoreOutboxEntryStatus[];
  /**
   * The changes serve keeps because their author lacks a grant they need
   * (swamp-club#4195), from `datastore status --server`: every held one and
   * the latest accepted. Absent from a local status.
   */
  quarantine?: DatastoreQuarantineStatus[];
  /** More accepted changes are kept than `quarantine` lists. */
  quarantineTruncated?: boolean;
  /**
   * The explicit leases this serve-mode checkout holds
   * (`swamp behavior lease acquire --for`), from its own record
   * (swamp-club#4195). Absent outside a serve-mode checkout.
   */
  heldLeases?: DatastoreHeldLeaseStatus[];
  /**
   * Why serve's section (`explicitLeases`, `quarantine`) is missing from a
   * serve-mode checkout's status: serve did not answer, or the caller is
   * not an admin (swamp-club#4195). Absent when it is shown, and outside a
   * serve-mode checkout.
   */
  serveSectionAbsent?: string;
}

/** An explicit lease this checkout holds, as `datastore status` lists it. */
export interface DatastoreHeldLeaseStatus {
  lockKey: string;
  fence: number;
  /** When it ends unless renewed, by serve's clock (ISO). */
  expiresAt: string;
}

/**
 * Serve's section of a serve-mode checkout's status, or why it is absent
 * (swamp-club#4195).
 */
export type DatastoreServeSection =
  | {
    readonly kind: "shown";
    readonly explicitLeases: DatastoreExplicitLeaseStatus[];
    readonly quarantine?: DatastoreQuarantineStatus[];
    readonly quarantineTruncated?: boolean;
  }
  | { readonly kind: "absent"; readonly reason: string };

/** An outbox entry, as `datastore status` lists it. */
export interface DatastoreOutboxEntryStatus {
  state: "offline" | "rejected" | "quarantined";
  partition: string;
  txnId: string;
  /** Why it is rejected or quarantined. */
  reason?: string;
  /** When it was first saved (ISO). */
  savedAt: string;
}

/** A change serve keeps for an admin, as `datastore status --server` lists it. */
export interface DatastoreQuarantineStatus {
  txnId: string;
  partition: string;
  /** Who made it: the principal it lands as. */
  author: string;
  reason: string;
  depositedAt: string;
  state: "held" | "accepted" | "discarded";
  acceptedBy?: string;
  acceptedAt?: string;
  seq?: number;
  discardedBy?: string;
  discardedAt?: string;
}

/** An explicit lease serve holds, as `datastore status --server` lists it. */
export interface DatastoreExplicitLeaseStatus {
  lockKey: string;
  holder: string;
  /** ISO time it ends unless renewed. */
  expiresAt: string;
}

/** What `datastore status` reports of a v3 datastore's commit log. */
export interface DatastoreCommitLogStatus {
  /** Commits stored above the compaction point. */
  storedCommits: number;
  /** The cursor history is compacted through; 0 before any compaction. */
  compactedThrough: number;
}

export type DatastoreStatusEvent =
  | { kind: "completed"; data: DatastoreStatusData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the datastore status operation. */
export interface DatastoreStatusDeps {
  loadConfig: () => DatastoreConfig;
  verifyHealth: (
    config: DatastoreConfig,
  ) => Promise<{ healthy: boolean; message: string; latencyMs: number }>;
  getDirectories: (config: DatastoreConfig) => string[];
  /** Describes the commit log of a v3 datastore; absent on v2. */
  describeCommitLog?: () => Promise<DatastoreCommitLogStatus>;
  /** The explicit leases serve holds; given by serve only. */
  listExplicitLeases?: () => DatastoreExplicitLeaseStatus[];
  /** This checkout's kept outbox entries; given on a v3 checkout. */
  listOutboxEntries?: () => Promise<DatastoreOutboxEntryStatus[]>;
  /** The changes serve keeps for an admin; given by serve only. */
  listQuarantine?: () => Promise<{
    readonly entries: DatastoreQuarantineStatus[];
    readonly truncated: boolean;
  }>;
  /** The explicit leases a serve-mode checkout holds. */
  listHeldLeases?: () => Promise<DatastoreHeldLeaseStatus[]>;
  /** Serve's section, asked of serve by a serve-mode checkout. */
  serveSection?: () => Promise<DatastoreServeSection>;
}

/**
 * The kept entries of a checkout's outbox as `datastore status` lists them:
 * queued offline, rejected or quarantined (swamp-club#4195). Entries simply
 * waiting to land are not listed.
 */
export function outboxEntryStatusesOf(
  entries: readonly OutboxEntry[],
): DatastoreOutboxEntryStatus[] {
  const listed: DatastoreOutboxEntryStatus[] = [];
  for (const entry of entries) {
    if (entry.state === undefined) continue;
    listed.push({
      state: entry.state,
      partition: entry.commit.partition.toString(),
      txnId: entry.commit.txnId,
      ...(entry.stateReason === undefined ? {} : { reason: entry.stateReason }),
      savedAt: new Date(entry.createdAt).toISOString(),
    });
  }
  return listed;
}

/** A change serve keeps, as `datastore status --server` lists it. */
export function quarantineStatusOf(
  record: QuarantineRecord,
): DatastoreQuarantineStatus {
  return {
    txnId: record.txnId,
    partition: record.partition,
    author: record.principal,
    reason: record.reason,
    depositedAt: record.depositedAt,
    state: record.state,
    ...(record.acceptedBy === undefined
      ? {}
      : { acceptedBy: record.acceptedBy }),
    ...(record.acceptedAt === undefined
      ? {}
      : { acceptedAt: record.acceptedAt }),
    ...(record.seq === undefined ? {} : { seq: record.seq }),
    ...(record.discardedBy === undefined
      ? {}
      : { discardedBy: record.discardedBy }),
    ...(record.discardedAt === undefined
      ? {}
      : { discardedAt: record.discardedAt }),
  };
}

/** Wires real infrastructure into DatastoreStatusDeps. */
export async function createDatastoreStatusDeps(
  datastoreResolver: DatastorePathResolver,
  options: {
    /** The commit log's description, given by the caller on a v3 datastore. */
    readonly describeCommitLog?: () => Promise<DatastoreCommitLogStatus>;
    /** The explicit leases serve holds, given by serve. */
    readonly listExplicitLeases?: () => DatastoreExplicitLeaseStatus[];
    /** This checkout's kept outbox entries, given on a v3 checkout. */
    readonly listOutboxEntries?: () => Promise<DatastoreOutboxEntryStatus[]>;
    /** The changes serve keeps for an admin, given by serve. */
    readonly listQuarantine?: DatastoreStatusDeps["listQuarantine"];
    /** The explicit leases a serve-mode checkout holds. */
    readonly listHeldLeases?: DatastoreStatusDeps["listHeldLeases"];
    /** Serve's section, for a serve-mode checkout. */
    readonly serveSection?: DatastoreStatusDeps["serveSection"];
    /**
     * The datastore the status describes, when it is not the resolver's: a
     * serve-mode checkout describes its own copy, never the storage its
     * config names, which it does not read (swamp-club#4195).
     */
    readonly config?: DatastoreConfig;
  } = {},
): Promise<DatastoreStatusDeps> {
  await datastoreTypeRegistry.ensureLoaded();
  return {
    ...(options.listHeldLeases !== undefined
      ? { listHeldLeases: options.listHeldLeases }
      : {}),
    ...(options.serveSection !== undefined
      ? { serveSection: options.serveSection }
      : {}),
    ...(options.listOutboxEntries !== undefined
      ? { listOutboxEntries: options.listOutboxEntries }
      : {}),
    ...(options.listQuarantine !== undefined
      ? { listQuarantine: options.listQuarantine }
      : {}),
    ...(options.listExplicitLeases !== undefined
      ? { listExplicitLeases: options.listExplicitLeases }
      : {}),
    ...(options.describeCommitLog !== undefined
      ? { describeCommitLog: options.describeCommitLog }
      : {}),
    loadConfig: () => options.config ?? datastoreResolver.config(),
    verifyHealth: async (config: DatastoreConfig) => {
      if (isCustomDatastoreConfig(config)) {
        await datastoreTypeRegistry.ensureTypeLoaded(config.type);
        const typeInfo = datastoreTypeRegistry.get(config.type);
        if (typeInfo?.createProvider) {
          const provider = typeInfo.createProvider(config.config);
          const verifier = provider.createVerifier();
          return await verifier.verify();
        }
        return {
          healthy: false,
          message: "No provider available",
          latencyMs: 0,
        };
      } else {
        const verifier = new FilesystemDatastoreVerifier(config.path);
        return await verifier.verify();
      }
    },
    getDirectories: (config: DatastoreConfig) => [
      ...getDatastoreDirectories(config),
    ],
  };
}

/** Returns datastore configuration and health status. */
export async function* datastoreStatus(
  ctx: LibSwampContext,
  deps: DatastoreStatusDeps,
): AsyncIterable<DatastoreStatusEvent> {
  yield* withGeneratorSpan(
    "swamp.datastore.status",
    {},
    (async function* () {
      ctx.logger.debug`Executing datastore status`;

      const config = deps.loadConfig();
      const directories = deps.getDirectories(config);
      const { healthy, message, latencyMs } = await deps.verifyHealth(config);

      const data: DatastoreStatusData = {
        type: config.type,
        path: !isCustomDatastoreConfig(config) ? config.path : undefined,
        healthy,
        message,
        latencyMs,
        directories,
        exclude: config.exclude,
      };
      if (deps.describeCommitLog !== undefined) {
        data.format = 3;
        data.commitLog = await deps.describeCommitLog();
      }
      if (deps.listExplicitLeases !== undefined) {
        data.explicitLeases = deps.listExplicitLeases();
      }
      if (deps.listOutboxEntries !== undefined) {
        const entries = await deps.listOutboxEntries();
        if (entries.length > 0) data.outbox = entries;
      }
      if (deps.listQuarantine !== undefined) {
        const { entries, truncated } = await deps.listQuarantine();
        data.quarantine = entries;
        if (truncated) data.quarantineTruncated = true;
      }
      if (deps.listHeldLeases !== undefined) {
        data.heldLeases = await deps.listHeldLeases();
      }
      if (deps.serveSection !== undefined) {
        // Never fails the status: the checkout's own section is what a
        // member offline needs to see.
        const section = await deps.serveSection();
        if (section.kind === "shown") {
          data.explicitLeases = section.explicitLeases;
          if (section.quarantine !== undefined) {
            data.quarantine = section.quarantine;
          }
          if (section.quarantineTruncated === true) {
            data.quarantineTruncated = true;
          }
        } else {
          data.serveSectionAbsent = section.reason;
        }
      }

      ctx.logger.debug`Datastore status complete`;

      yield { kind: "completed", data };
    })(),
  );
}
