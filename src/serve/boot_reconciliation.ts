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

import type { RepositoryContext } from "../infrastructure/persistence/repository_factory.ts";
import {
  createLibSwampContext,
  createWorkerModelRunDeps,
  modelMethodRun,
} from "../libswamp/mod.ts";
import { STEP_LEASE_MODEL_TYPE } from "../domain/models/worker/step_lease_model.ts";
import { PENDING_DISPATCH_MODEL_TYPE } from "../domain/models/worker/pending_dispatch_model.ts";
import {
  WORKER_MODEL_TYPE,
  workerDefinitionName,
} from "../domain/models/worker/worker_model.ts";
import { getSwampLogger } from "../infrastructure/logging/logger.ts";
import type { ModelType } from "../domain/models/model_type.ts";
import type { Data } from "../domain/data/data.ts";
import type { FileSystemUnifiedDataRepository } from "../infrastructure/persistence/unified_data_repository.ts";
import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import { InstanceHeartbeatService } from "./instance_heartbeat.ts";
import { cleanupActiveRunsForInstance } from "./active_run_tracker.ts";
import type { PendingRunEntry } from "../infrastructure/persistence/run_tracker_store.ts";

const logger = getSwampLogger(["serve", "boot-reconciliation"]);

export interface TransitionInput {
  typeArg: string;
  definitionName: string;
  methodName: string;
  inputs: Record<string, unknown>;
}

export interface BootReconciliationDeps {
  repoDir: string;
  repoContext: RepositoryContext;
  runTransition?: (input: TransitionInput) => Promise<void>;
}

export interface SweepResult {
  leases: number;
  pendingDispatches: number;
  workers: number;
}

// ── Startup Cache Hydration ─────────────────────────────────────────

export interface HydrateLocalCacheDeps {
  syncService: DatastoreSyncService;
  catalogInvalidate: () => void;
  signal?: AbortSignal;
}

export interface HydrateResult {
  pulled: number;
}

export async function hydrateLocalCache(
  deps: HydrateLocalCacheDeps,
): Promise<HydrateResult> {
  logger.info("Hydrating local cache from remote datastore");
  try {
    const pulled = await deps.syncService.pullChanged({ signal: deps.signal });
    const count = typeof pulled === "number" ? pulled : 0;
    if (count > 0) {
      logger.info`Pulled ${count} file(s) from remote datastore`;
    }
    deps.catalogInvalidate();
    return { pulled: count };
  } catch (err: unknown) {
    logger.warn(
      "Startup cache hydration failed: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return { pulled: 0 };
  }
}

async function defaultRunTransition(
  repoDir: string,
  repoContext: RepositoryContext,
  input: TransitionInput,
): Promise<void> {
  const runDeps = await createWorkerModelRunDeps(repoDir, repoContext);
  for await (
    const event of modelMethodRun(createLibSwampContext({}), runDeps, {
      modelIdOrName: input.definitionName,
      methodName: input.methodName,
      inputs: input.inputs,
      lastEvaluated: false,
      typeArg: input.typeArg,
      definitionName: input.definitionName,
      skipAllReports: true,
    })
  ) {
    if (event.kind === "error") {
      const detail = event.error;
      const message = typeof detail === "object" && detail !== null &&
          "message" in detail
        ? String((detail as { message: unknown }).message)
        : String(detail);
      throw new Error(message);
    }
  }
}

export async function sweepStaleRecords(
  deps: BootReconciliationDeps,
): Promise<SweepResult> {
  const transition = deps.runTransition ??
    ((input: TransitionInput) =>
      defaultRunTransition(deps.repoDir, deps.repoContext, input));

  const result: SweepResult = { leases: 0, pendingDispatches: 0, workers: 0 };
  const repo = deps.repoContext.unifiedDataRepo;

  for (
    const { attrs, modelName } of await loadAttrsForType(
      repo,
      STEP_LEASE_MODEL_TYPE,
    )
  ) {
    if (attrs.state !== "active") continue;
    const leaseId = attrs.leaseId;
    if (typeof leaseId !== "string") continue;
    try {
      await transition({
        typeArg: STEP_LEASE_MODEL_TYPE.normalized,
        definitionName: modelName,
        methodName: "expire",
        inputs: { leaseId, error: "orchestrator restart" },
      });
      result.leases++;
    } catch (err) {
      logger.warn("Failed to expire stale lease {leaseId}: {error}", {
        leaseId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  for (
    const { attrs, modelName } of await loadAttrsForType(
      repo,
      PENDING_DISPATCH_MODEL_TYPE,
    )
  ) {
    if (attrs.state !== "waiting") continue;
    const queueId = attrs.queueId;
    if (typeof queueId !== "string") continue;
    try {
      await transition({
        typeArg: PENDING_DISPATCH_MODEL_TYPE.normalized,
        definitionName: modelName,
        methodName: "orphan",
        inputs: { queueId, endedAt: new Date().toISOString() },
      });
      result.pendingDispatches++;
    } catch (err) {
      logger.warn(
        "Failed to orphan stale pending dispatch {queueId}: {error}",
        {
          queueId,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  for (
    const { attrs, data } of await loadAttrsForType(
      repo,
      WORKER_MODEL_TYPE,
    )
  ) {
    if (data.name !== "state-main") continue;
    if (attrs.status === "disconnected") continue;
    const workerName = attrs.name;
    if (typeof workerName !== "string") continue;
    try {
      await transition({
        typeArg: WORKER_MODEL_TYPE.normalized,
        definitionName: workerDefinitionName(workerName),
        methodName: "set_status",
        inputs: { status: "disconnected" },
      });
      result.workers++;
    } catch (err) {
      logger.warn(
        "Failed to disconnect stale worker {workerName}: {error}",
        {
          workerName,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return result;
}

export interface ReplayPendingRunsDeps {
  runTracker:
    import("../infrastructure/persistence/run_tracker_store.ts").RunTrackerStore;
  webhookService?: import("./webhook.ts").WebhookService;
  scheduledExecution?:
    import("../libswamp/workflows/scheduled_execution.ts").ScheduledExecutionService;
  controlPlaneStore?: ControlPlaneStore;
}

export async function replayPendingRuns(
  deps: ReplayPendingRunsDeps,
): Promise<number> {
  const localPending = deps.runTracker.findAllPendingRuns();

  // Merge remote entries from the control-plane store when available.
  // Remote entries that already exist locally (by id) are skipped.
  const pending: PendingRunEntry[] = [...localPending];
  if (deps.controlPlaneStore) {
    try {
      const remoteKeys = await deps.controlPlaneStore.list("pending-runs/");
      const localIds = new Set(localPending.map((e) => e.id));
      for (const key of remoteKeys) {
        const data = await deps.controlPlaneStore.get(key);
        if (!data) continue;
        let entry: PendingRunEntry;
        try {
          const raw = JSON.parse(new TextDecoder().decode(data));
          if (
            !raw || typeof raw !== "object" ||
            typeof raw.id !== "string" ||
            typeof raw.source !== "string" ||
            typeof raw.workflowIdOrName !== "string"
          ) {
            logger.warn`Discarding invalid remote pending run at ${key}`;
            await deps.controlPlaneStore.delete(key).catch(
              (err: unknown) => {
                logger.warn(
                  "Control-plane delete failed for invalid entry {key}: {error}",
                  {
                    key,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              },
            );
            continue;
          }
          entry = raw as PendingRunEntry;
        } catch {
          logger.warn`Discarding corrupt remote pending run at ${key}`;
          await deps.controlPlaneStore.delete(key).catch(
            (err: unknown) => {
              logger.warn(
                "Control-plane delete failed for corrupt entry {key}: {error}",
                {
                  key,
                  error: err instanceof Error ? err.message : String(err),
                },
              );
            },
          );
          continue;
        }
        if (!localIds.has(entry.id)) {
          pending.push(entry);
          logger
            .debug`Merged remote pending run ${entry.id} for ${entry.workflowIdOrName}`;
        }
      }
    } catch (err) {
      logger.warn(
        "Failed to list remote pending runs: {error}",
        { error: err instanceof Error ? err.message : String(err) },
      );
    }
  }

  if (pending.length === 0) return 0;

  logger
    .debug`Replaying ${pending.length} pending run(s) from previous process`;

  let replayed = 0;
  for (const entry of pending) {
    try {
      if (entry.source === "webhook" && deps.webhookService) {
        let parsed: Record<string, unknown> = {};
        if (entry.payload) {
          try {
            const raw = JSON.parse(entry.payload);
            if (raw && typeof raw === "object") {
              parsed = raw as Record<string, unknown>;
            }
          } catch {
            logger
              .warn`Discarding pending run ${entry.id}: corrupt payload`;
            deps.runTracker.deletePendingRun(entry.id);
            if (deps.controlPlaneStore) {
              await deps.controlPlaneStore.delete(
                `pending-runs/${entry.id}`,
              ).catch((err: unknown) => {
                logger.warn(
                  "Control-plane delete failed for discarded entry {id}: {error}",
                  {
                    id: entry.id,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              });
            }
            continue;
          }
        }
        deps.webhookService.enqueueForReplay({
          pendingRunId: entry.id,
          workflowIdOrName: entry.workflowIdOrName,
          route: entry.route ?? "",
          payload: {
            body: parsed.body ?? null,
            headers: (parsed.headers ?? {}) as Record<string, string>,
            route: typeof parsed.route === "string"
              ? parsed.route
              : (entry.route ?? ""),
          },
          traceparent: entry.traceparent,
          tracestate: entry.tracestate,
        });
        replayed++;
        logger
          .info`Replayed pending webhook run for ${entry.workflowIdOrName}`;
      } else if (entry.source === "cron" && deps.scheduledExecution) {
        deps.scheduledExecution.enqueueForReplay({
          pendingRunId: entry.id,
          workflowIdOrName: entry.workflowIdOrName,
        });
        replayed++;
        logger
          .info`Replayed pending cron run for ${entry.workflowIdOrName}`;
      } else {
        deps.runTracker.deletePendingRun(entry.id);
        if (deps.controlPlaneStore) {
          await deps.controlPlaneStore.delete(
            `pending-runs/${entry.id}`,
          ).catch((err: unknown) => {
            logger.warn(
              "Control-plane delete failed for discarded entry {id}: {error}",
              {
                id: entry.id,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
        }
        logger
          .warn`Discarding pending run ${entry.id} (source: ${entry.source}, no matching service)`;
      }
    } catch (err) {
      logger.warn("Failed to replay pending run {id}: {error}", {
        id: entry.id,
        error: err instanceof Error ? err.message : String(err),
      });
      deps.runTracker.deletePendingRun(entry.id);
      if (deps.controlPlaneStore) {
        await deps.controlPlaneStore.delete(
          `pending-runs/${entry.id}`,
        ).catch((deleteErr: unknown) => {
          logger.warn(
            "Control-plane delete failed for errored entry {id}: {error}",
            {
              id: entry.id,
              error: deleteErr instanceof Error
                ? deleteErr.message
                : String(deleteErr),
            },
          );
        });
      }
    }
  }

  return replayed;
}

// ── Remote Interrupted Run Reconciliation ─────────────────────────────

export const CLAIM_TTL_MS = 5 * 60 * 1000;

export interface ReconcileRemoteInterruptedRunsDeps {
  controlPlaneStore: ControlPlaneStore;
  instanceId: string;
  runTracker:
    import("../infrastructure/persistence/run_tracker_store.ts").RunTrackerStore;
  staleTtlMs?: number;
}

/**
 * Scan heartbeats from the control-plane store and interrupt runs
 * belonging to instances that have gone stale (crashed / lost network).
 *
 * When putIfAbsent is available, claims each stale instance before
 * reaping to prevent multiple instances from reconciling the same peer.
 * Heartbeat deletion is deferred until after runs are reaped so that
 * a crash mid-reconciliation leaves the heartbeat for another instance
 * to pick up once the claim expires.
 *
 * Returns the number of runs reaped.
 */
export async function reconcileRemoteInterruptedRuns(
  deps: ReconcileRemoteInterruptedRunsDeps,
): Promise<number> {
  const heartbeatKeys = await deps.controlPlaneStore.list("heartbeats/");
  if (heartbeatKeys.length === 0) return 0;

  const staleInstances: Array<{ instanceId: string; heartbeatKey: string }> =
    [];
  for (const key of heartbeatKeys) {
    const data = await deps.controlPlaneStore.get(key);
    if (!data) continue;
    const record = InstanceHeartbeatService.parseRecord(data);
    if (!record) continue;
    if (record.instanceId === deps.instanceId) continue;
    if (InstanceHeartbeatService.isStale(record, deps.staleTtlMs)) {
      staleInstances.push({ instanceId: record.instanceId, heartbeatKey: key });
    }
  }

  if (staleInstances.length === 0) return 0;

  const claimedInstanceIds: string[] = [];
  const claimedHeartbeatKeys: string[] = [];
  for (const { instanceId, heartbeatKey } of staleInstances) {
    if (deps.controlPlaneStore.putIfAbsent) {
      const claimKey = `claims/reconcile-instance/${instanceId}`;
      const claimData = new TextEncoder().encode(JSON.stringify({
        claimedBy: deps.instanceId,
        claimedAt: new Date().toISOString(),
      }));
      const claimed = await deps.controlPlaneStore.putIfAbsent(
        claimKey,
        claimData,
      );
      if (!claimed) {
        logger.debug(
          "Skipping stale instance {instanceId}: already claimed by another instance",
          { instanceId },
        );
        continue;
      }
    }
    claimedInstanceIds.push(instanceId);
    claimedHeartbeatKeys.push(heartbeatKey);
  }

  if (claimedInstanceIds.length === 0) return 0;

  const claimedSet = new Set(claimedInstanceIds);
  const allRunning = deps.runTracker.findAllRunning();
  let reaped = 0;

  for (const run of allRunning) {
    if (!run.instanceId) continue;
    if (run.status !== "running") continue;
    if (!claimedSet.has(run.instanceId)) continue;
    deps.runTracker.complete(run.id, "failed", "remote_instance_dead");
    reaped++;
    logger.warn(
      "Reaped run {runId} from dead remote instance {instanceId}",
      { runId: run.id, instanceId: run.instanceId },
    );
  }

  for (const claimedId of claimedInstanceIds) {
    const activeRunsCleaned = await cleanupActiveRunsForInstance(
      deps.controlPlaneStore,
      claimedId,
    );
    if (activeRunsCleaned > 0) {
      logger.info(
        "Cleaned up {count} stale active-run records for instance {instanceId}",
        { count: activeRunsCleaned, instanceId: claimedId },
      );
    }
  }

  for (const key of claimedHeartbeatKeys) {
    await deps.controlPlaneStore.delete(key).catch((err: unknown) => {
      logger.warn(
        "Failed to delete stale heartbeat {key}: {error}",
        {
          key,
          error: err instanceof Error ? err.message : String(err),
        },
      );
    });
  }

  return reaped;
}

// ── Reconciliation Claim Cleanup ────────────────────────────────────

export interface CleanupExpiredClaimsDeps {
  controlPlaneStore: ControlPlaneStore;
}

export async function cleanupExpiredClaims(
  deps: CleanupExpiredClaimsDeps,
): Promise<number> {
  const claimKeys = await deps.controlPlaneStore.list(
    "claims/reconcile-instance/",
  );
  let cleaned = 0;
  for (const key of claimKeys) {
    const data = await deps.controlPlaneStore.get(key);
    if (!data) continue;
    try {
      const claim = JSON.parse(new TextDecoder().decode(data)) as {
        claimedAt: string;
      };
      const age = Date.now() - new Date(claim.claimedAt).getTime();
      if (Number.isNaN(age) || age > CLAIM_TTL_MS) {
        await deps.controlPlaneStore.delete(key);
        cleaned++;
      }
    } catch {
      await deps.controlPlaneStore.delete(key).catch(() => {});
      cleaned++;
    }
  }
  return cleaned;
}

async function loadAttrsForType(
  repo: FileSystemUnifiedDataRepository,
  modelType: ModelType,
): Promise<
  Array<{ data: Data; modelName: string; attrs: Record<string, unknown> }>
> {
  const items = await repo.findAllForType(modelType);
  const results: Array<
    { data: Data; modelName: string; attrs: Record<string, unknown> }
  > = [];
  for (const { data, modelType: mt, modelId } of items) {
    if (data.isRenamed || data.isDeleted) continue;
    const content = await repo.getContent(mt, modelId, data.name);
    if (!content) continue;
    try {
      const attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
        string,
        unknown
      >;
      results.push({ data, modelName: data.tags["modelName"] ?? "", attrs });
    } catch {
      // Skip items with unparseable content
    }
  }
  return results;
}
