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
  controlPlaneStore?:
    import("../domain/datastore/control_plane_store.ts").ControlPlaneStore;
}

export async function replayPendingRuns(
  deps: ReplayPendingRunsDeps,
): Promise<number> {
  const localPending = deps.runTracker.findAllPendingRuns();
  const localIds = new Set(localPending.map((e) => e.id));

  const remotePending:
    import("../infrastructure/persistence/run_tracker_store.ts").PendingRunEntry[] =
      [];
  if (deps.controlPlaneStore) {
    const keys = await deps.controlPlaneStore.list("pending-runs/");
    for (const key of keys) {
      const data = await deps.controlPlaneStore.get(key);
      if (!data) continue;
      try {
        const parsed = JSON.parse(new TextDecoder().decode(data));
        if (
          parsed.id && parsed.source && parsed.workflowIdOrName &&
          !localIds.has(parsed.id)
        ) {
          remotePending.push(parsed);
        }
      } catch {
        const id = key.replace("pending-runs/", "");
        logger
          .warn`Discarding remote pending run ${id}: corrupt payload`;
        await deps.controlPlaneStore.delete(key);
      }
    }
  }

  const pending = [...localPending, ...remotePending];
  if (pending.length === 0) return 0;

  const remoteCount = remotePending.length;
  if (remoteCount > 0) {
    logger
      .info`Found ${remoteCount} pending run(s) from remote control-plane store`;
  }
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
        await deps.controlPlaneStore.delete(`pending-runs/${entry.id}`)
          .catch(() => {});
      }
    }
  }

  return replayed;
}

export interface RemoteReconciliationDeps {
  controlPlaneStore:
    import("../domain/datastore/control_plane_store.ts").ControlPlaneStore;
  instanceId: string;
  workflowRunRepo: {
    findAllGlobalSince(
      since: Date,
    ): Promise<
      Array<{
        run: import("../domain/workflows/workflow_run.ts").WorkflowRun;
        workflowId: import("../domain/workflows/workflow_id.ts").WorkflowId;
      }>
    >;
    save(
      workflowId: import("../domain/workflows/workflow_id.ts").WorkflowId,
      run: import("../domain/workflows/workflow_run.ts").WorkflowRun,
    ): Promise<void>;
  };
}

export async function reconcileRemoteInterruptedRuns(
  deps: RemoteReconciliationDeps,
): Promise<number> {
  const { InstanceHeartbeatService } = await import("./instance_heartbeat.ts");

  const heartbeatKeys = await deps.controlPlaneStore.list("heartbeats/");
  if (heartbeatKeys.length === 0) return 0;

  const staleInstanceIds: string[] = [];
  for (const key of heartbeatKeys) {
    const data = await deps.controlPlaneStore.get(key);
    if (!data) continue;

    const record = InstanceHeartbeatService.parseRecord(data);
    if (!record) continue;
    if (record.instanceId === deps.instanceId) continue;

    if (InstanceHeartbeatService.isStale(record)) {
      staleInstanceIds.push(record.instanceId);
      logger.warn(
        "Stale instance detected: {instanceId} (last heartbeat: {heartbeatAt})",
        {
          instanceId: record.instanceId,
          heartbeatAt: record.heartbeatAt,
        },
      );
    }
  }

  if (staleInstanceIds.length === 0) return 0;

  const staleSet = new Set(staleInstanceIds);
  const reapCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const runs = await deps.workflowRunRepo.findAllGlobalSince(reapCutoff);

  let reconciled = 0;
  for (const { run, workflowId } of runs) {
    if (run.status !== "running") continue;
    if (!run.instanceId || !staleSet.has(run.instanceId)) continue;

    run.interrupt("server_crash");
    await deps.workflowRunRepo.save(workflowId, run);
    reconciled++;
    logger.warn(
      "Reconciled interrupted run {runId} (workflow: {workflowName}, stale instance: {instanceId})",
      {
        runId: run.id,
        workflowName: run.workflowName,
        instanceId: run.instanceId,
      },
    );
  }

  for (const instanceId of staleInstanceIds) {
    await deps.controlPlaneStore.delete(`heartbeats/${instanceId}`);
  }

  return reconciled;
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
