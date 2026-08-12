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
import { isSensitiveHeader } from "./webhook.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  SERVER_TOKEN_SECRET_KEY_PREFIX,
} from "../domain/models/access/server_token_model.ts";
import type {
  VaultDeleteProvider,
  VaultProvider,
} from "../domain/vaults/vault_provider.ts";

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
  namespace?: string;
}

export interface HydrateResult {
  pulled: number;
}

export async function hydrateLocalCache(
  deps: HydrateLocalCacheDeps,
): Promise<HydrateResult> {
  logger.info("Hydrating local cache from remote datastore");
  try {
    const pulled = await deps.syncService.pullChanged({
      signal: deps.signal,
      ...(deps.namespace ? { namespace: deps.namespace } : {}),
    });
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
  configuredWebhookWorkflows: ReadonlySet<string>;
  configuredWebhookRoutes: ReadonlySet<string>;
  configuredCronWorkflows: ReadonlySet<string>;
}

export async function replayPendingRuns(
  deps: ReplayPendingRunsDeps,
): Promise<number> {
  const localPending = deps.runTracker.findAllPendingRuns();

  // Merge remote entries from the control-plane store when available.
  // Remote entries that already exist locally (by id) are skipped.
  // Track the source key for remote entries so discard deletes the
  // actual key, not a key reconstructed from the entry's own id.
  const pending: PendingRunEntry[] = [...localPending];
  const remoteSourceKeys = new Map<string, string>();
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
          remoteSourceKeys.set(entry.id, key);
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

  const discardEntry = async (
    id: string,
    reason: string,
  ): Promise<void> => {
    logger.warn`Discarding pending run ${id}: ${reason}`;
    deps.runTracker.deletePendingRun(id);
    if (deps.controlPlaneStore) {
      const cpKey = remoteSourceKeys.get(id) ?? `pending-runs/${id}`;
      await deps.controlPlaneStore.delete(cpKey).catch(
        (err: unknown) => {
          logger.warn(
            "Control-plane delete failed for discarded entry {id}: {error}",
            {
              id,
              error: err instanceof Error ? err.message : String(err),
            },
          );
        },
      );
    }
  };

  let replayed = 0;
  for (const entry of pending) {
    try {
      if (entry.source === "webhook" && deps.webhookService) {
        if (!deps.configuredWebhookWorkflows.has(entry.workflowIdOrName)) {
          await discardEntry(
            entry.id,
            `workflow '${entry.workflowIdOrName}' is not a configured webhook endpoint`,
          );
          continue;
        }
        const entryRoute = entry.route ?? "";
        if (entryRoute && !deps.configuredWebhookRoutes.has(entryRoute)) {
          await discardEntry(
            entry.id,
            `route '${entryRoute}' is not a configured webhook endpoint`,
          );
          continue;
        }
        let parsed: Record<string, unknown> = {};
        if (entry.payload) {
          try {
            const raw = JSON.parse(entry.payload);
            if (raw && typeof raw === "object") {
              parsed = raw as Record<string, unknown>;
            }
          } catch {
            await discardEntry(entry.id, "corrupt payload");
            continue;
          }
        }
        const rawHeaders = (parsed.headers ?? {}) as Record<string, string>;
        const redactedHeaders: Record<string, string> = {};
        for (const [name, value] of Object.entries(rawHeaders)) {
          if (!isSensitiveHeader(name)) {
            redactedHeaders[name] = value;
          }
        }
        deps.webhookService.enqueueForReplay({
          pendingRunId: entry.id,
          workflowIdOrName: entry.workflowIdOrName,
          route: entryRoute,
          payload: {
            body: parsed.body ?? null,
            headers: redactedHeaders,
            route: typeof parsed.route === "string" ? parsed.route : entryRoute,
          },
          traceparent: entry.traceparent,
          tracestate: entry.tracestate,
        });
        replayed++;
        logger
          .info`Replayed pending webhook run for ${entry.workflowIdOrName}`;
      } else if (entry.source === "cron" && deps.scheduledExecution) {
        if (!deps.configuredCronWorkflows.has(entry.workflowIdOrName)) {
          await discardEntry(
            entry.id,
            `workflow '${entry.workflowIdOrName}' is not a configured scheduled workflow`,
          );
          continue;
        }
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

// ── Token Durability Health Check ───────────────────────────────────

export interface TokenHealthCheckDeps {
  tokenSecretsProvider: VaultProvider & VaultDeleteProvider & {
    list(): Promise<string[]>;
  };
  hasRemoteControlPlane: boolean;
}

export interface TokenHealthResult {
  totalSecrets: number;
  undecryptable: string[];
  localOnlyWarning: boolean;
}

export async function checkTokenHealth(
  deps: TokenHealthCheckDeps,
): Promise<TokenHealthResult> {
  const result: TokenHealthResult = {
    totalSecrets: 0,
    undecryptable: [],
    localOnlyWarning: false,
  };

  let secretKeys: string[];
  try {
    secretKeys = await deps.tokenSecretsProvider.list();
  } catch (err) {
    logger.warn(
      "Token health check: failed to list secrets: {error}",
      { error: err instanceof Error ? err.message : String(err) },
    );
    return result;
  }

  const tokenSecretKeys = secretKeys.filter((k) =>
    k.startsWith(SERVER_TOKEN_SECRET_KEY_PREFIX)
  );
  result.totalSecrets = tokenSecretKeys.length;

  if (tokenSecretKeys.length === 0) return result;

  if (!deps.hasRemoteControlPlane) {
    result.localOnlyWarning = true;
    logger.warn(
      "Token secrets ({count}) are stored in a local-only control plane — they will be lost if this pod restarts. Configure a remote datastore to make tokens durable.",
      { count: tokenSecretKeys.length },
    );
  }

  for (const key of tokenSecretKeys) {
    try {
      await deps.tokenSecretsProvider.get(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) continue;
      result.undecryptable.push(key);
      logger.error(
        "Token health check: secret {key} is undecryptable — the encryption key may have been lost or rotated. Affected token will fail authentication.",
        { key },
      );
    }
  }

  if (result.undecryptable.length > 0) {
    logger.error(
      "Token health check: {count} of {total} token secret(s) are undecryptable — re-mint affected tokens",
      { count: result.undecryptable.length, total: tokenSecretKeys.length },
    );
  }

  return result;
}

// ── Three-Layer Token Consistency Sweep ─────────────────────────────

export interface TokenConsistencyDeps {
  repoContext: RepositoryContext;
  tokenSecretsProvider: VaultProvider & VaultDeleteProvider & {
    list(): Promise<string[]>;
  };
}

export interface TokenInconsistency {
  mode:
    | "orphaned-secret"
    | "orphaned-data"
    | "undecryptable-secret"
    | "missing-secret";
  tokenName: string;
  detail: string;
}

export interface TokenConsistencyResult {
  inconsistencies: TokenInconsistency[];
}

export async function sweepTokenConsistency(
  deps: TokenConsistencyDeps,
): Promise<TokenConsistencyResult> {
  const inconsistencies: TokenInconsistency[] = [];

  let secretKeys: string[];
  try {
    const allKeys = await deps.tokenSecretsProvider.list();
    secretKeys = allKeys.filter((k) =>
      k.startsWith(SERVER_TOKEN_SECRET_KEY_PREFIX)
    );
  } catch {
    return { inconsistencies };
  }

  const secretTokenNames = new Set(
    secretKeys.map((k) => k.slice(SERVER_TOKEN_SECRET_KEY_PREFIX.length)),
  );

  const dataItems = await loadAttrsForType(
    deps.repoContext.unifiedDataRepo,
    SERVER_TOKEN_MODEL_TYPE,
  );
  const dataTokenNames = new Set(
    dataItems.map((item) => item.modelName).filter(Boolean),
  );

  const allTokenNames = new Set([...secretTokenNames, ...dataTokenNames]);
  const definitionNames = new Set<string>();
  for (const tokenName of allTokenNames) {
    const def = await deps.repoContext.definitionRepo.findByName(
      SERVER_TOKEN_MODEL_TYPE,
      tokenName,
    );
    if (def) definitionNames.add(tokenName);
  }

  for (const tokenName of secretTokenNames) {
    if (!definitionNames.has(tokenName)) {
      inconsistencies.push({
        mode: "orphaned-secret",
        tokenName,
        detail:
          "Secret exists in _token-secrets but no definition found in auto-definitions",
      });
    }
  }

  for (const tokenName of dataTokenNames) {
    if (!definitionNames.has(tokenName)) {
      inconsistencies.push({
        mode: "orphaned-data",
        tokenName,
        detail: "Token data exists but no definition found in auto-definitions",
      });
    }
  }

  for (const tokenName of definitionNames) {
    if (!secretTokenNames.has(tokenName)) {
      inconsistencies.push({
        mode: "missing-secret",
        tokenName,
        detail:
          "Definition and data exist but no secret found in _token-secrets — token will fail authentication",
      });
    }
  }

  for (const tokenName of definitionNames) {
    if (!secretTokenNames.has(tokenName)) continue;
    const key = `${SERVER_TOKEN_SECRET_KEY_PREFIX}${tokenName}`;
    try {
      await deps.tokenSecretsProvider.get(key);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("not found")) continue;
      inconsistencies.push({
        mode: "undecryptable-secret",
        tokenName,
        detail:
          "Secret exists but cannot be decrypted — encryption key may have been lost or rotated",
      });
    }
  }

  inconsistencies.sort((a, b) => {
    const order: Record<TokenInconsistency["mode"], number> = {
      "undecryptable-secret": 0,
      "missing-secret": 1,
      "orphaned-secret": 2,
      "orphaned-data": 3,
    };
    return order[a.mode] - order[b.mode];
  });

  for (const item of inconsistencies) {
    const level = item.mode === "undecryptable-secret" ||
        item.mode === "missing-secret"
      ? "error"
      : "warn";
    if (level === "error") {
      logger.error(
        "Token consistency: [{mode}] {tokenName} — {detail}",
        { mode: item.mode, tokenName: item.tokenName, detail: item.detail },
      );
    } else {
      logger.warn(
        "Token consistency: [{mode}] {tokenName} — {detail}",
        { mode: item.mode, tokenName: item.tokenName, detail: item.detail },
      );
    }
  }

  if (inconsistencies.length > 0) {
    logger.warn(
      "Token consistency sweep found {count} inconsistency/ies across server tokens",
      { count: inconsistencies.length },
    );
  }

  return { inconsistencies };
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
