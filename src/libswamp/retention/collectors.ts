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

import type { RetentionPolicy } from "../../domain/retention/retention_policy.ts";
import {
  type DatastorePathResolver,
  resolverEngine,
} from "../../domain/datastore/datastore_path_resolver.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { SignalWaitSupport } from "../../domain/workflows/signal_wait_store.ts";
import type { ContinuationClaimStore } from "../../domain/workflows/continuation_claim.ts";
import type { AuditRepository } from "../../domain/audit/audit_repository.ts";
import { JsonlAuditRepository } from "../../infrastructure/persistence/jsonl_audit_repository.ts";
import { createRunLifecycleService } from "../data/run_gc.ts";
import { createDataGcDeps, createDataGcDepsFrom } from "../data/gc.ts";
import type { CatalogStore } from "../../infrastructure/persistence/catalog_store.ts";
import type { FileSystemUnifiedDataRepository } from "../../infrastructure/persistence/unified_data_repository.ts";
import type { YamlWorkflowRunRepository } from "../../infrastructure/persistence/yaml_workflow_run_repository.ts";
import type { RetentionCollector } from "./pass.ts";

const DAY_MS = 86_400_000;

/** Output batches are this many times the pass's batch size. */
const OUTPUT_BATCH_MULTIPLIER = 10;

export interface RetentionCollectorSources {
  repoDir: string;
  datastoreResolver?: DatastorePathResolver;
  markDirty?: MarkDirtyHook;
  signalWaits?: SignalWaitSupport;
  continuationClaims?: Pick<ContinuationClaimStore, "removeForRun">;
  /**
   * The repository context's data repositories. A caller that runs often
   * passes them so no pass opens a catalog connection of its own; without
   * them the pass opens (and leaves to process exit) its own.
   */
  dataRepos?: {
    catalogStore: CatalogStore;
    unifiedDataRepo: FileSystemUnifiedDataRepository;
    workflowRunRepo: YamlWorkflowRunRepository;
  };
  /** The agent command log; defaults to the repository's `.swamp/audit`. */
  auditRepo?: AuditRepository;
  now?: () => number;
}

/**
 * The collectors of one retention pass, in the order they must run
 * (swamp-club#3473):
 *
 * 1. Runs, with their snapshots, signal wait records and continuation
 *    claims. First, since data with a `workflow` or `job` lifetime expires
 *    with its run.
 * 2. Evaluated snapshots: orphans, and snapshots of finished runs older
 *    than their own retention. Lists every snapshot, so one batch per pass.
 * 3. Method outputs and their run logs.
 * 4. Model data, every version older than the cutoff, the latest included,
 *    except built-in access and serve state.
 * 5. The agent command log (`.swamp/audit`), by whole day.
 *
 * Serve bookkeeping is reaped by serve's worker GC with the `bookkeeping`
 * grace, and serve audit stores by their own timer, so neither is here.
 */
export function createRetentionCollectors(
  sources: RetentionCollectorSources,
  policy: RetentionPolicy,
): RetentionCollector[] {
  const now = sources.now ?? Date.now;
  const runs = createRunLifecycleService(
    sources.repoDir,
    sources.datastoreResolver,
    sources.markDirty,
    sources.signalWaits,
    sources.continuationClaims,
  );
  const data = sources.dataRepos
    ? createDataGcDepsFrom(
      sources.dataRepos.catalogStore,
      sources.dataRepos.unifiedDataRepo,
      sources.dataRepos.workflowRunRepo,
      { keepLatestVersion: resolverEngine(sources.datastoreResolver) === "v3" },
    )
    : createDataGcDeps(
      sources.repoDir,
      sources.datastoreResolver,
      sources.markDirty,
    );
  const auditRepo = sources.auditRepo ??
    new JsonlAuditRepository(sources.repoDir);
  const daysBefore = (cutoff: Date): number =>
    Math.max(0, (now() - cutoff.getTime()) / DAY_MS);

  return [
    {
      kind: "workflowRuns",
      collectBatch: (cutoff, limit) =>
        runs.gcWorkflowRunBatch({ cutoff, limit }),
    },
    {
      kind: "evaluatedSnapshots",
      collectBatch: async (cutoff) => {
        const snapshotDays = daysBefore(cutoff);
        // Orphans are judged against the run retention; with none, against
        // the snapshot retention itself.
        const runMs = policy.retentionMs("workflowRuns");
        // Without its own key a snapshot simply goes with its run, so only
        // orphans are swept: a finished child kept for an unfinished parent
        // keeps its snapshot as long as its run record.
        const result = await runs.gcRunSnapshots({
          retentionDays: runMs === undefined ? snapshotDays : runMs / DAY_MS,
          deletedRunIds: [],
          dryRun: false,
          ...(policy.isExplicit("evaluatedSnapshots")
            ? { snapshotRetentionDays: snapshotDays }
            : {}),
        });
        return { ...result, more: false };
      },
    },
    {
      kind: "outputs",
      collectBatch: async (cutoff, limit) => {
        // Each output batch lists every output file before deleting, so
        // batches are larger here to keep a large backlog's listings few.
        const result = await runs.gcOutputs({
          retentionDays: daysBefore(cutoff),
          dryRun: false,
          limit: limit * OUTPUT_BATCH_MULTIPLIER,
        });
        return {
          deleted: result.deleted,
          bytesReclaimed: result.bytesReclaimed,
          more: result.more ?? false,
        };
      },
    },
    {
      kind: "data",
      collectBatch: async (cutoff, limit) => {
        if (!data.deleteDataOlderThan) {
          return { deleted: 0, bytesReclaimed: 0, more: false };
        }
        const result = await data.deleteDataOlderThan(cutoff, {
          dryRun: false,
          limit,
        });
        return {
          deleted: result.versionsDeleted,
          bytesReclaimed: result.bytesReclaimed,
          more: result.more,
          incomplete: result.failed > 0,
        };
      },
    },
    {
      kind: "audit",
      collectBatch: async (cutoff) => {
        const deleted = await auditRepo.deleteOlderThan(cutoff);
        return { deleted, bytesReclaimed: 0, more: false };
      },
    },
  ];
}
