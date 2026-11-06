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
export interface DatastoreStatusData {
  type: string;
  path?: string;
  healthy: boolean;
  message: string;
  latencyMs: number;
  directories: string[];
  exclude?: string[];
  format?: 3;
  commitLog?: DatastoreCommitLogStatus;
  explicitLeases?: DatastoreExplicitLeaseStatus[];
  outbox?: DatastoreOutboxEntryStatus[];
  quarantine?: DatastoreQuarantineStatus[];
  quarantineTruncated?: boolean;
  heldLeases?: DatastoreHeldLeaseStatus[];
  /**
   * why serve's section is missing: serve did not answer, or the caller is not
   * an admin
   */
  serveSectionAbsent?: string;
}

export interface DatastoreHeldLeaseStatus {
  lockKey: string;
  fence: number;
  expiresAt: string;
}

export type DatastoreServeSection =
  | {
    readonly kind: "shown";
    readonly explicitLeases: DatastoreExplicitLeaseStatus[];
    readonly quarantine?: DatastoreQuarantineStatus[];
    readonly quarantineTruncated?: boolean;
  }
  | { readonly kind: "absent"; readonly reason: string };

export interface DatastoreOutboxEntryStatus {
  state: "offline" | "rejected" | "quarantined";
  partition: string;
  txnId: string;
  reason?: string;
  /** what the refusal was, when it has a code of its own */
  code?: string;
  savedAt: string;
}

export interface DatastoreQuarantineStatus {
  txnId: string;
  partition: string;
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

export interface DatastoreExplicitLeaseStatus {
  lockKey: string;
  holder: string;
  expiresAt: string;
}

export interface DatastoreCommitLogStatus {
  storedCommits: number;
  compactedThrough: number;
}

export type DatastoreStatusEvent =
  | { kind: "completed"; data: DatastoreStatusData }
  | { kind: "error"; error: SwampError };

export interface DatastoreStatusDeps {
  loadConfig: () => DatastoreConfig;
  verifyHealth: (
    config: DatastoreConfig,
  ) => Promise<{ healthy: boolean; message: string; latencyMs: number }>;
  getDirectories: (config: DatastoreConfig) => string[];
  describeCommitLog?: () => Promise<DatastoreCommitLogStatus>;
  listExplicitLeases?: () => DatastoreExplicitLeaseStatus[];
  listOutboxEntries?: () => Promise<DatastoreOutboxEntryStatus[]>;
  listQuarantine?: () => Promise<{
    readonly entries: DatastoreQuarantineStatus[];
    readonly truncated: boolean;
  }>;
  listHeldLeases?: () => Promise<DatastoreHeldLeaseStatus[]>;
  serveSection?: () => Promise<DatastoreServeSection>;
}

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
      ...(entry.stateCode === undefined ? {} : { code: entry.stateCode }),
      savedAt: new Date(entry.createdAt).toISOString(),
    });
  }
  return listed;
}

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

export async function createDatastoreStatusDeps(
  datastoreResolver: DatastorePathResolver,
  options: {
    readonly describeCommitLog?: () => Promise<DatastoreCommitLogStatus>;
    readonly listExplicitLeases?: () => DatastoreExplicitLeaseStatus[];
    readonly listOutboxEntries?: () => Promise<DatastoreOutboxEntryStatus[]>;
    readonly listQuarantine?: DatastoreStatusDeps["listQuarantine"];
    readonly listHeldLeases?: DatastoreStatusDeps["listHeldLeases"];
    readonly serveSection?: DatastoreStatusDeps["serveSection"];
    /**
     * a serve-mode checkout describes its own copy, never the storage its
     * config names, which it does not read
     */
    readonly config?: DatastoreConfig;
    /** a serve-mode checkout's health is serve's, not the storage's */
    readonly verifyHealth?: DatastoreStatusDeps["verifyHealth"];
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
    verifyHealth: options.verifyHealth ?? (async (config: DatastoreConfig) => {
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
    }),
    getDirectories: (config: DatastoreConfig) => [
      ...getDatastoreDirectories(config),
    ],
  };
}

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
