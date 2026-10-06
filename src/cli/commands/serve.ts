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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  libSwampContextForRepo,
  refreshExtensionWorkflowDirs,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { pullManagedConfigAtBoot } from "../managed_config_sync.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  MAX_TIMER_DELAY_MS,
  parseTimeout,
  parseTimerDuration,
} from "../duration_parser.ts";
import {
  buildServeAuthConfig,
  type ServeAuthConfig,
} from "../../domain/access/serve_auth_config.ts";
import { handleConnection } from "../../serve/connection.ts";
import {
  cancelSuspendedRunAndPush,
  RUN_CANCEL_GRACE_MS,
  type SuspendedRunCancelResult,
} from "../../serve/suspended_run_cancel.ts";
import { createTriggerAuthorizer } from "../../serve/trigger_authorizer.ts";
import {
  auditScheduledEvent,
  auditWebhookEvent,
  createScheduledRunAuthorizer,
  createWebhookRunAuthorizer,
} from "../../serve/trigger_audit.ts";
import { WebhookRejectionCoalescer } from "../../serve/webhook_audit_coalescer.ts";
import { principalToString } from "../../domain/access/principal.ts";
import {
  SCHEDULER_PRINCIPAL,
  WEBHOOK_PRINCIPAL,
} from "../../domain/access/service_principal.ts";
import {
  collectClusterInstances,
  redactServeOptions,
} from "../../serve/handlers/admin_handlers.ts";
import {
  cancelActor,
  cancelReasonFor,
  closeConnectionsForPrincipal,
  type ConnectionContext,
  emitRunCancelAudit,
  emitSystemAuditEvent,
  listTokenSessions,
  MAX_CANCEL_REASON_LENGTH,
  registerStreamSession,
  removeConnection,
  resolveConnectionCompression,
  sanitizeErrorForClient,
  setConnectionCollectives,
  setConnectionCompression,
  setConnectionSourceIp,
  setConnectionToken,
  terminateTokenSessions,
  updateCollectivesForPrincipal,
} from "../../serve/handlers/shared.ts";
import {
  DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
  TokenSessionRevalidationService,
} from "../../serve/token_session_revalidation_service.ts";
import {
  DEFAULT_WORKER_TOKEN_REVALIDATION_MS,
  WorkerTokenRevalidationService,
} from "../../serve/worker_token_revalidation_service.ts";
import {
  createDeviceAuthDeps,
  handleDeviceAuth,
} from "../../serve/device_auth_handler.ts";
import { traceHttpRequests } from "../../serve/http_request_span.ts";
import { resolveOAuthClientCredentials } from "../../serve/oauth_registration.ts";
import { VaultService } from "../../domain/vaults/vault_service.ts";
import {
  SERVER_TOKEN_MODEL_TYPE,
  serverTokenModel,
  ServerTokenSchema,
} from "../../domain/models/access/server_token_model.ts";
import {
  authenticateServerToken,
  extractWebSocketToken,
  readServerTokenRecord,
} from "../../serve/token_auth.ts";
import {
  checkIpBurst,
  checkRateLimit,
  clearRateLimit,
  rateLimitKey,
} from "../../serve/rate_limiter.ts";
import {
  parsePrincipal,
  type Principal,
} from "../../domain/access/principal.ts";
import { executeWorkflowWithLocks } from "../../serve/deps.ts";
import { DaemonTelemetryFlushService } from "../../serve/telemetry_flush.ts";
import { runDetached } from "../../infrastructure/tracing/mod.ts";
import { getActiveTelemetryContext } from "../telemetry_integration.ts";
import { HttpTelemetrySender } from "../../infrastructure/telemetry/http_telemetry_sender.ts";
import { USER_AGENT } from "../load_identity.ts";
import { CapabilityService } from "../../serve/capability_service.ts";
import {
  fleetMemberSuffix,
  WorkerGateway,
} from "../../serve/worker_gateway.ts";
import {
  DEFAULT_WORKER_GC_GRACE_PERIOD_MS,
  DEFAULT_WORKER_GC_INTERVAL_MS,
  workerGcListPredicate,
  WorkerGcService,
} from "../../serve/worker_gc_service.ts";
import {
  createBookkeepingRecordQuery,
  reapEndedBookkeepingRecords,
} from "../../serve/bookkeeping_gc.ts";
import {
  DEFAULT_TOKEN_GC_GRACE_PERIOD_MS,
  DEFAULT_TOKEN_GC_INTERVAL_MS,
  ServerTokenGcService,
} from "../../serve/server_token_gc_service.ts";
import {
  createServerTokenGcDeps,
  createServerTokenGcRepos,
} from "../../serve/server_token_gc_deps.ts";
import { dispatchFleetProbe } from "../../serve/fleet_probe_dispatch.ts";
import { DispatchService } from "../../serve/dispatch_service.ts";
import { DispatchRegistry } from "../../serve/dispatch_registry.ts";
import { BundleRegistry } from "../../serve/bundle_registry.ts";
import { DataPlane } from "../../serve/data_plane.ts";
import {
  setRemoteOnlyMode,
  setRemoteStepDispatcher,
} from "../../domain/remote/remote_dispatch.ts";
import {
  enableServeOutput,
  getSwampLogger,
} from "../../infrastructure/logging/logger.ts";
import {
  createServiceScheduler,
  resolveServiceMode,
} from "../../infrastructure/daemon/service_scheduler_factory.ts";
import {
  renderDaemonDisabled,
  renderDaemonEnabled,
  renderDaemonStatus,
  toServiceMode,
} from "../../presentation/output/serve_daemon_output.ts";
import {
  renderServeCheckConfig,
  type TokenSecretsKeyCheck,
} from "../../presentation/output/serve_check_config_output.ts";
import type { TokenSecretsKeyRef } from "../../domain/vaults/token_secrets_key.ts";
import { AuthRepository } from "../../infrastructure/persistence/auth_repository.ts";
import {
  apiKeySourceName,
  CLUB_API_KEY_FILE_FLAG,
  resolveApiKey,
} from "../../infrastructure/persistence/api_key_source.ts";
import { selectCheckConfigToken } from "../serve_check_config_token.ts";
import { groupCommandAction } from "../group_action.ts";
import {
  consumeStream,
  createModelDeleteDeps,
  createWorkerListDeps,
  createWorkerModelRunDeps,
  type DetachedNestedRunData,
  modelDelete,
  modelMethodRun,
  normalizeFireTime,
  ScheduledExecutionService,
  type TriggerOverride,
  withDefaults,
  workerPrune,
  type WorkerPruneDeps,
  type WorkerPruneResult,
  workerTokenList,
} from "../../libswamp/mod.ts";
import { WorkerStateSchema } from "../../domain/models/worker/worker_model.ts";
import type { DataRecord } from "../../domain/data/data_record.ts";
import {
  isSensitiveHeader,
  parseWebhookFlag,
  readBodyWithLimit,
  resolveExtensionWebhookEndpoints,
  resolveSecret,
  type WebhookEndpoint,
  WebhookService,
} from "../../serve/webhook.ts";
import {
  hasCoLocatedTokenKey,
  TOKEN_SECRETS_VAULT_NAME,
} from "../../domain/vaults/control_plane_vault_provider.ts";
import {
  loadServeConfig,
  type MergedServeOptions,
  mergeServeOptions,
  parseAuditConfig,
  parseExplicitFlags,
  parseTokenSecretsKeyConfig,
  parseWebhookConfig,
  resolveServePath,
  resolveServeTlsPaths,
  SERVE_CONFIG_PATH,
  type WebhookConfigEntry,
} from "../../serve/serve_config.ts";
import {
  type AuditCategory,
  AuditChainState,
  AuditEmitter,
  type AuditLevel,
  AuditPolicy,
  type AuditPolicyRule,
  type AuditSink,
  type AuditStore,
  AuditWal,
} from "../../domain/serve_audit/mod.ts";
import { StoreSink } from "../../serve/audit_sinks/store_sink.ts";
import { WalSink } from "../../serve/audit_sinks/wal_sink.ts";
import { WebSocketSink } from "../../serve/audit_sinks/websocket_sink.ts";
import { WebhookSink } from "../../serve/audit_sinks/webhook_sink.ts";
import { SyslogSink } from "../../serve/audit_sinks/syslog_sink.ts";
import {
  type AlertRuleConfig,
  AlertRuleEngine,
  AuditSinkHotReloader,
  generateHmacKeyBytes,
  type HmacContext,
  HmacKeyRegistry,
  type HmacKeyVersion,
  importHmacKey,
  parseSinkFilter,
} from "../../domain/serve_audit/mod.ts";
import { RemoteAuditStore } from "../../infrastructure/persistence/remote_audit_store.ts";
import { resolveDatastoreExpressions } from "../datastore_expression_resolver.ts";
import { registerShutdownHandler } from "../../infrastructure/process/shutdown_handlers.ts";
import { setProcessGroupIsolation } from "../../infrastructure/process/process_group_policy.ts";
import { warnIfRunningAsInit } from "../../infrastructure/process/init_process.ts";
import {
  runShutdownDrain,
  SHUTDOWN_ABORT_GRACE_MS,
} from "../../serve/shutdown_drain.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { ActiveRunRegistry } from "../../serve/active_run_registry.ts";
import { RunMetricsTracker } from "../../serve/run_metrics_tracker.ts";
import { ComponentHealthChecker } from "../../serve/component_health_checker.ts";
import { HealthCollector } from "../../serve/health_collector.ts";
import { createHealthStreamResponse } from "../../serve/health_stream.ts";
import {
  cachedHealthResourceResolver,
  createHealthResourceResolver,
  healthSnapshotFor,
} from "../../serve/health_snapshot_view.ts";
import {
  type AdminAuthDeps,
  authenticateAdmin,
  authenticateToken,
  createReadAuthorizer,
} from "../../serve/admin_auth.ts";
import {
  deleteActiveRun,
  writeActiveRun,
} from "../../serve/active_run_tracker.ts";
import {
  type ExecutionType,
  RunCancelRegistry,
} from "../../serve/run_cancel_registry.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import { reportRegistry } from "../../domain/reports/report_registry.ts";
import { datastoreTypeRegistry } from "../../domain/datastore/datastore_type_registry.ts";
import { webhookTypeRegistry } from "../../domain/webhooks/webhook_type_registry.ts";
import { resolveWebhookType } from "../../domain/extensions/extension_auto_resolver.ts";
import { getAutoResolver } from "../../domain/extensions/auto_resolver_context.ts";
import {
  createExtensionDiscoverer,
  isReloading,
  performServeReload,
  seedPulledTypeSnapshot,
  serveReloadStatus,
} from "../../serve/extension_reload.ts";
import {
  CA_CERT_DESCRIPTION,
  CA_CERT_FLAG,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
} from "../remote_run.ts";
import { validateServerRepoExclusivity } from "./access_helpers.ts";
import { VERSION } from "./version.ts";
import {
  registerInstance,
  sendInstanceHeartbeat,
} from "../../serve/oauth_client.ts";
import {
  ClubHeartbeatService,
  DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS,
} from "../../serve/club_heartbeat_service.ts";
import type { ServeReloadResponse } from "../../serve/protocol.ts";
import { createServeReloadRenderer } from "../../presentation/renderers/serve_reload.ts";
import {
  type PolicyReloadMode,
  PolicySnapshotLoader,
} from "../../domain/access/policy_snapshot_loader.ts";
import { GrantsDirectoryPoller } from "../../domain/access/grants_directory_poller.ts";
import {
  materializeAdmins,
  migrateGrantDefinitions,
} from "../../domain/access/admin_materializer.ts";
import {
  collectErrors,
  parseGrantFile,
  readGrantFiles,
  resolveExternalGrantsDir,
  resolveExternalGrantsFile,
} from "../../domain/access/grant_file.ts";
import { validateGrantCondition } from "../../infrastructure/cel/grant_condition_environment.ts";
import { reconcileAllFileGrants } from "../../domain/access/grant_file_reconciler.ts";
import {
  GRANTS_FILE_SOURCE_NAME,
  grantsDirSourceName,
} from "../../domain/access/grant_source.ts";
import {
  createGrantWriteCommit,
  createGrantWriteTracking,
} from "../../serve/grant_write_tracking.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import { GRANT_MODEL_TYPE } from "../../domain/models/access/grant_model.ts";
import { cleanupEmptyParentDirs } from "../../infrastructure/persistence/directory_cleanup.ts";
import {
  basename,
  extname,
  isAbsolute,
  join,
  normalize,
  resolve,
} from "@std/path";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import {
  DEFAULT_STALE_TTL_MS,
  localOwnerLiveness,
  RunTrackerStore,
} from "../../infrastructure/persistence/run_tracker_store.ts";
import {
  getSwampConfigDir,
  getSwampDataDir,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { DefaultDatastorePathResolver } from "../../infrastructure/persistence/default_datastore_path_resolver.ts";
import {
  checkTokenHealth,
  cleanupExpiredClaims,
  hydrateLocalCache,
  reconcileRemoteInterruptedRuns,
  replayPendingRuns,
  sweepStaleRecords,
  sweepTokenConsistency,
} from "../../serve/boot_reconciliation.ts";
import { AccessDataPoller } from "../../serve/access_data_poller.ts";
import { ConfigPoller } from "../../serve/config_poller.ts";
import { computeFileContentHashIfExists } from "../../domain/extensions/extension_package_cache.ts";
import { RuntimeDataPoller } from "../../serve/runtime_data_poller.ts";
import { createSyncGate } from "../../serve/sync_gate.ts";

import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  InstanceHeartbeatService,
} from "../../serve/instance_heartbeat.ts";
import { FileSystemControlPlaneStore } from "../../infrastructure/persistence/fs_control_plane_store.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import { installUnhandledRejectionGuard } from "../../serve/unhandled_rejection_guard.ts";
import {
  checkOpenFileLimit,
  isProcessDead,
  tryRaiseOpenFileLimit,
} from "../../infrastructure/runtime/process.ts";
import {
  reapOrphanedWorkflowRuns,
  settleDeadOwnerMethodRuns,
} from "../../domain/workflows/orphaned_run_reaper.ts";
import { requireAuthenticated, requireScope } from "../auth_context.ts";
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { FilesystemDatastoreVerifier } from "../../infrastructure/persistence/filesystem_datastore_verifier.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import {
  type DatastoreClassification,
  resolveDeploymentMode,
  type VaultClassification,
} from "../../domain/serve/deployment_mode.ts";
import { validateEndEntityCert } from "../../infrastructure/runtime/tls_cert_validation.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

const logger = getSwampLogger(["serve"]);

export const CANCEL_GRACE_MS = RUN_CANCEL_GRACE_MS;

export type CancelStatus =
  | "cancelled"
  | "cancellation_requested"
  | "not_found"
  | "conflict";

export interface CancelResult {
  status: CancelStatus;
  executionType: ExecutionType;
  executionId: string;
  message?: string;
  /**
   * Nested runs a cancelled suspended run waited on, left suspended on their
   * own (swamp-club#2736).
   */
  detachedNestedRuns?: DetachedNestedRunData[];
}

export interface CancelDeps {
  cancelRegistry: RunCancelRegistry;
  activeRunRegistry?: ActiveRunRegistry;
  scheduledCancelByRunId?: (id: string) => boolean;
  /** Recorded as the cancelled run's `cancel_reason`. */
  reason?: string;
  /**
   * Cancels a persisted suspended workflow run no process here is driving.
   * Tried only for a workflow-run that no registry holds.
   */
  cancelSuspended?: (id: string) => Promise<SuspendedRunCancelResult>;
}

export interface CancelAuthorizationRequest {
  principal: Principal;
  collectives: readonly string[];
  groups: readonly string[];
  sourceIp: string;
  /** The run to cancel; absent for a bulk cancel. */
  execution?: { type: ExecutionType; id: string };
}

/**
 * Checks that an authenticated caller of the HTTP cancel endpoint holds
 * `admin`. Returns the 403 response to send, after auditing the refusal as
 * `denied`, or undefined when the cancel may go ahead.
 */
export function authorizeCancelRequest(
  ctx: Pick<
    ConnectionContext,
    "auditEmitter" | "instanceId" | "resolvedUserNames"
  >,
  policySnapshotLoader:
    | Pick<PolicySnapshotLoader, "decisionService">
    | undefined,
  request: CancelAuthorizationRequest,
): Response | undefined {
  const auditRefusal = (detail: string) =>
    emitRunCancelAudit(ctx, {
      action: request.execution ? "cancel" : "cancel.all",
      resourceKind: request.execution?.type === "method-run"
        ? "model"
        : request.execution
        ? "workflow"
        : "execution",
      resourceName: request.execution?.id ?? "*",
      principal: request.principal,
      sourceIp: request.sourceIp,
      requestId: crypto.randomUUID(),
      outcome: "denied",
      detail,
    });
  if (!policySnapshotLoader) {
    auditRefusal("access_not_configured");
    return Response.json({
      status: "error",
      message:
        "Authorization enforcement is enabled but no policy snapshot is available",
    }, { status: 403 });
  }
  const decision = policySnapshotLoader.decisionService.decide(
    {
      principal: request.principal,
      collectives: [...request.collectives],
      groups: [...request.groups],
    },
    "admin",
    { kind: "access", name: "*", fields: {} },
  );
  if (!decision || decision.effect !== "allow") {
    auditRefusal("admin required");
    return Response.json({
      status: "error",
      message: "Access denied: cancel requires admin permission",
    }, { status: 403 });
  }
  return undefined;
}

const CHAIN_RECONSTRUCT_LOOKBACK_DAYS = 14;

async function reconstructChainStateFromStore(
  store: AuditStore,
): Promise<{ sequence: number; previousDigest: string } | null> {
  try {
    let latestSeq = -1;
    let latestDigest = "";
    let found = false;
    for (let d = 0; d < CHAIN_RECONSTRUCT_LOOKBACK_DAYS; d++) {
      const date = new Date(Date.now() - d * 86_400_000).toISOString().slice(
        0,
        10,
      );
      const keys = await store.list(`events/${date}/`);
      for (const key of keys) {
        const data = await store.get(key);
        if (!data) continue;
        const text = new TextDecoder().decode(data);
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            const seq = event.sequence;
            const digest = event.digest;
            if (
              event.version === 1 &&
              typeof seq === "number" &&
              typeof digest === "string"
            ) {
              if (seq > latestSeq) {
                latestSeq = seq;
                latestDigest = digest;
                found = true;
              }
            }
          } catch {
            // skip malformed
          }
        }
      }
      if (found) break;
    }
    if (found) {
      return {
        sequence: latestSeq,
        previousDigest: latestDigest,
      };
    }
  } catch {
    // best-effort reconstruction
  }
  return null;
}

export async function cancelExecution(
  executionType: ExecutionType,
  executionId: string,
  deps: CancelDeps,
  graceMs: number = CANCEL_GRACE_MS,
): Promise<CancelResult> {
  let found = deps.cancelRegistry.cancel(
    executionType,
    executionId,
    deps.reason,
  );
  // Whether the abort went to a run in the active-run registry, which may
  // leave it suspended rather than cancelled.
  let abortedActive = false;
  if (!found && deps.activeRunRegistry) {
    found = deps.activeRunRegistry.cancel(executionId, deps.reason);
    abortedActive = found;
  }
  let foundViaScheduled = false;
  if (
    !found && executionType === "workflow-run" && deps.scheduledCancelByRunId
  ) {
    found = deps.scheduledCancelByRunId(executionId);
    foundViaScheduled = found;
  }
  if (
    !found && executionType === "workflow-run" && deps.cancelSuspended
  ) {
    const suspended = await deps.cancelSuspended(executionId);
    switch (suspended.status) {
      case "cancelled":
        return {
          status: "cancelled",
          executionType,
          executionId,
          ...(suspended.detachedNestedRuns
            ? { detachedNestedRuns: suspended.detachedNestedRuns }
            : {}),
        };
      case "active":
        // A resume registered the run after the registry miss above.
        found = deps.activeRunRegistry?.cancel(executionId, deps.reason) ??
          false;
        abortedActive = found;
        break;
      case "busy":
      case "not_suspended":
        return {
          status: "conflict",
          executionType,
          executionId,
          message: suspended.message,
        };
      case "not_found":
        break;
    }
  }
  if (!found) {
    return {
      status: "not_found",
      executionType,
      executionId,
      message: `No cancellable ${executionType} with id ${executionId}`,
    };
  }
  const activeRun = deps.activeRunRegistry?.get(executionId);
  if (activeRun || abortedActive) {
    if (activeRun) {
      await Promise.race([
        activeRun.completion,
        new Promise<void>((r) => setTimeout(r, graceMs)),
      ]);
    }
    const confirmed = deps.activeRunRegistry?.get(executionId) === undefined;
    if (!confirmed) {
      return { status: "cancellation_requested", executionType, executionId };
    }
    // A resume can save the run suspended at its next gate just before the
    // abort lands, and still be registered until its final push. Then the
    // abort stopped nothing: cancel the persisted run.
    if (executionType === "workflow-run" && deps.cancelSuspended) {
      const left = await deps.cancelSuspended(executionId);
      if (left.status === "busy") {
        return {
          status: "conflict",
          executionType,
          executionId,
          message: left.message,
        };
      }
      if (left.status === "active") {
        deps.activeRunRegistry?.cancel(executionId, deps.reason);
        return { status: "cancellation_requested", executionType, executionId };
      }
    }
    return { status: "cancelled", executionType, executionId };
  }
  if (foundViaScheduled) {
    return { status: "cancellation_requested", executionType, executionId };
  }
  return { status: "cancelled", executionType, executionId };
}

/** The largest body a single-run cancel request may send. */
export const MAX_CANCEL_BODY_BYTES = 8 * 1024;

export type CancelRequestReason =
  | { ok: true; reason?: string }
  | { ok: false; status: 400 | 413; message: string };

/**
 * Reads the optional reason from a single-run cancel request. An empty body
 * gives no reason, so clients that post nothing keep working; otherwise the
 * body must be a JSON object whose `reason`, if present, is a string of at most
 * {@link MAX_CANCEL_REASON_LENGTH} characters. An empty reason counts as none.
 */
export async function readCancelRequestReason(
  req: Request,
): Promise<CancelRequestReason> {
  const bytes = await readBodyWithLimit(req, MAX_CANCEL_BODY_BYTES);
  if (bytes === null) {
    return {
      ok: false,
      status: 413,
      message: `Request body exceeds ${MAX_CANCEL_BODY_BYTES} bytes`,
    };
  }
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return { ok: true };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { ok: false, status: 400, message: "Request body must be JSON" };
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      ok: false,
      status: 400,
      message: "Request body must be a JSON object",
    };
  }
  const reason = (body as Record<string, unknown>).reason;
  if (reason === undefined) return { ok: true };
  if (typeof reason !== "string") {
    return { ok: false, status: 400, message: "reason must be a string" };
  }
  if (reason.length > MAX_CANCEL_REASON_LENGTH) {
    return {
      ok: false,
      status: 400,
      message: `reason must be at most ${MAX_CANCEL_REASON_LENGTH} characters`,
    };
  }
  return reason === "" ? { ok: true } : { ok: true, reason };
}

/**
 * The body of a successful single-run cancel response. A workflow run also
 * gets the `cancel_reason` serve applied; a method run records no reason, so
 * reporting one would claim a record that does not exist.
 */
export function cancelSuccessBody(
  result: CancelResult,
  reason: string,
): Record<string, unknown> {
  return {
    status: result.status,
    executionType: result.executionType,
    executionId: result.executionId,
    ...(result.executionType === "workflow-run" ? { reason } : {}),
    // The endpoint requires admin on every resource, so the nested runs need
    // no further check.
    ...(result.detachedNestedRuns
      ? { detachedNestedRuns: result.detachedNestedRuns }
      : {}),
  };
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/** Up to this much random delay is added to each reconciliation tick. */
const RECONCILIATION_JITTER_MS = 500;

/** How long one health collection serves every reader: the stream minimum. */
const HEALTH_SNAPSHOT_MAX_AGE_MS = 1_000;

/**
 * How long a health entry's resolved workflow or model is reused. Bounds how
 * long a tag edit takes to change which entries a non-admin reader sees.
 */
const HEALTH_RESOURCE_CACHE_TTL_MS = 5_000;

export function assertOffLoopbackSecurity(
  host: string,
  tlsEnabled: boolean,
  authMode: string,
): void {
  if (LOOPBACK_HOSTS.has(host)) return;

  if (!tlsEnabled) {
    throw new UserError(
      "Off-loopback binding requires TLS — provide --cert-file and --key-file, or bind to 127.0.0.1",
    );
  }
  if (authMode === "none") {
    throw new UserError(
      "Off-loopback binding requires authentication — set --auth-mode token or --auth-mode oauth, or bind to 127.0.0.1",
    );
  }
}

export function validateWebSocketOrigin(
  origin: string | null,
  hostHeader: string | null,
  bindHost: string,
  tlsEnabled: boolean,
  trustedHosts?: readonly string[],
): { allowed: boolean; reason?: string } {
  if (origin) {
    const TRUSTED_ORIGINS = new Set([
      "http://127.0.0.1",
      "http://localhost",
      "https://127.0.0.1",
      "https://localhost",
      "http://[::1]",
      "https://[::1]",
    ]);
    if (tlsEnabled) {
      TRUSTED_ORIGINS.add(`https://${bindHost.toLowerCase()}`);
    }
    if (trustedHosts) {
      for (const h of trustedHosts) {
        const lh = h.toLowerCase();
        TRUSTED_ORIGINS.add(`http://${lh}`);
        TRUSTED_ORIGINS.add(`https://${lh}`);
      }
    }

    let originBase: string;
    try {
      const originUrl = new URL(origin);
      originBase = `${originUrl.protocol}//${originUrl.hostname}`;
    } catch {
      return { allowed: false, reason: `malformed origin: ${origin}` };
    }

    if (!TRUSTED_ORIGINS.has(originBase)) {
      return { allowed: false, reason: `untrusted origin: ${origin}` };
    }
  }

  // Only validate Host header when binding off-loopback (direct exposure).
  // When bound to loopback, a reverse proxy on the same machine handles
  // external connections and forwards the public domain as the Host header —
  // this is the documented production deployment model (Caddy, nginx).
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
  if (hostHeader && !LOOPBACK_HOSTS.has(bindHost.toLowerCase())) {
    let hostName: string;
    try {
      const parsed = new URL(`http://${hostHeader}`);
      hostName = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    } catch {
      return { allowed: false, reason: `malformed host: ${hostHeader}` };
    }
    const TRUSTED_HOSTS = new Set([
      "127.0.0.1",
      "localhost",
      "::1",
      bindHost.toLowerCase(),
    ]);
    if (trustedHosts) {
      for (const h of trustedHosts) {
        TRUSTED_HOSTS.add(h.toLowerCase());
      }
    }
    if (!TRUSTED_HOSTS.has(hostName)) {
      return { allowed: false, reason: `untrusted host: ${hostHeader}` };
    }
  }

  return { allowed: true };
}

/**
 * Builds the environment baked into the service definition written by
 * `swamp serve daemon enable`.
 *
 * Pins both the data dir and the config dir, resolved in the enabling
 * user's environment. Pinning only SWAMP_HOME would move the config dir to
 * `$SWAMP_HOME/config`, hiding the credentials `swamp auth login` wrote and
 * crash-looping token and oauth daemons. Both paths are made absolute here
 * because the service runs with the repository as its working directory.
 */
export function buildServeDaemonEnv(): Record<string, string> {
  return {
    SWAMP_HOME: resolve(getSwampDataDir()),
    SWAMP_CONFIG_DIR: resolve(getSwampConfigDir()),
  };
}

const CLUB_API_KEY_FILE_DESCRIPTION =
  "Path to a file containing the collective API key (oauth:manage scope) " +
  "used for headless OAuth registration, username lookup, instance " +
  "registration and heartbeat; overrides SWAMP_API_KEY_FILE and SWAMP_API_KEY";

export function collectServeExtraArgs(options: AnyOptions): string[] {
  const args: string[] = [];
  if (options.config) {
    args.push("--config", options.config as string);
  }
  if (options.schedule === false) {
    args.push("--no-schedule");
  }
  if (options.grantsFile) {
    args.push("--grants-file", options.grantsFile as string);
  }
  if (options.grantsDir) {
    args.push("--grants-dir", options.grantsDir as string);
  }
  if (options.grantReload && options.grantReload !== "manual") {
    args.push("--grant-reload", options.grantReload as string);
  }
  const webhooks = options.webhook as string[] | undefined;
  if (webhooks) {
    for (const spec of webhooks) {
      args.push("--webhook", spec);
    }
  }
  if (options.authMode && options.authMode !== "none") {
    args.push("--auth-mode", options.authMode as string);
  }
  if (options.admins) {
    args.push("--admins", options.admins as string);
  }
  if (options.allowedCollectives) {
    args.push("--allowed-collectives", options.allowedCollectives as string);
  }
  if (options.allowedUsers) {
    args.push("--allowed-users", options.allowedUsers as string);
  }
  if (options.oauthProvider) {
    args.push("--oauth-provider", options.oauthProvider as string);
  }
  if (options.oauthClientId) {
    args.push("--oauth-client-id", options.oauthClientId as string);
  }
  if (options.oauthClientName) {
    args.push("--oauth-client-name", options.oauthClientName as string);
  }
  if (options.clubApiKeyFile) {
    // The daemon runs from the repo directory, so a path relative to the
    // shell that ran `daemon enable` must be made absolute here.
    args.push(
      CLUB_API_KEY_FILE_FLAG,
      resolve(options.clubApiKeyFile as string),
    );
  }
  if (options.groupsField) {
    args.push("--groups-field", options.groupsField as string);
  }
  if (options.restrictedModelTypes) {
    args.push(
      "--restricted-model-types",
      options.restrictedModelTypes as string,
    );
  }
  if (options.restrictedCommands) {
    args.push(
      "--restricted-commands",
      options.restrictedCommands as string,
    );
  }
  if (options.approveRequiresExplicitGrant) {
    args.push("--approve-requires-explicit-grant");
  }
  if (options.groupRefreshInterval) {
    args.push(
      "--group-refresh-interval",
      options.groupRefreshInterval as string,
    );
  }
  if (options.trustProxy) {
    args.push("--trust-proxy");
  }
  if (options.wsIdleTimeout) {
    args.push("--ws-idle-timeout", options.wsIdleTimeout as string);
  }
  if (options.queueTimeout) {
    args.push("--queue-timeout", options.queueTimeout as string);
  }
  if (options.verifyOnEnroll) {
    args.push("--verify-on-enroll");
  }
  if (options.trustedHosts) {
    args.push("--trusted-hosts", options.trustedHosts as string);
  }
  if (options.heartbeatInterval) {
    args.push("--heartbeat-interval", options.heartbeatInterval as string);
  }
  if (options.staleTtl) {
    args.push("--stale-ttl", options.staleTtl as string);
  }
  if (options.reconciliationInterval) {
    args.push(
      "--reconciliation-interval",
      options.reconciliationInterval as string,
    );
  }
  if (options.hydrationTimeout) {
    args.push("--hydration-timeout", options.hydrationTimeout as string);
  }
  if (options.shutdownDrainTimeout) {
    args.push(
      "--shutdown-drain-timeout",
      options.shutdownDrainTimeout as string,
    );
  }
  if (options.datastorePollInterval) {
    args.push(
      "--datastore-poll-interval",
      options.datastorePollInterval as string,
    );
  }
  if (options.tokenGcInterval) {
    args.push("--token-gc-interval", options.tokenGcInterval as string);
  }
  if (options.tokenGcGracePeriod) {
    args.push(
      "--token-gc-grace-period",
      options.tokenGcGracePeriod as string,
    );
  }
  if (options.remoteOnly) {
    args.push("--remote-only");
  }
  if (options.maxConcurrentRuns !== undefined) {
    args.push(
      "--max-concurrent-runs",
      String(options.maxConcurrentRuns),
    );
  }
  if (options.maxRunsPerPrincipal !== undefined) {
    args.push(
      "--max-runs-per-principal",
      String(options.maxRunsPerPrincipal),
    );
  }
  if (options.maxRunDuration) {
    args.push("--max-run-duration", options.maxRunDuration as string);
  }
  if (options.hotReload) {
    args.push("--hot-reload");
  }
  if (options.enableInternalApi) {
    args.push("--enable-internal-api");
  }
  if (options.dashboard) {
    args.push("--dashboard");
  }
  if (options.autoResume) {
    args.push("--auto-resume");
  }
  return args;
}

/**
 * Reads a TLS file whose path resolveServeTlsPaths already made absolute, and
 * names that path when it cannot be read, since it may differ from the
 * relative one the operator configured.
 */
async function readTlsFile(
  kind: "certificate" | "private key",
  path: string,
): Promise<string> {
  try {
    return await Deno.readTextFile(path);
  } catch (cause) {
    if (cause instanceof Deno.errors.NotFound) {
      throw markErrorPaths(
        new UserError(`TLS ${kind} file not found: ${path}`),
        [path],
      );
    }
    throw markErrorPaths(
      new UserError(`Failed to read TLS ${kind} file ${path}: ${cause}`),
      [path, ...errorPaths(cause)],
    );
  }
}

/**
 * Runs serve's startup checks on the options a `swamp serve daemon enable`
 * unit will start with, so enable refuses arguments that would make the unit
 * fail on every start. Options are resolved as the daemon process sees them:
 * explicit flags are the ones written into the unit, env vars come from the
 * unit environment alone (never the enabling shell), and a relative --config
 * resolves against the repository, which is the unit's working directory.
 */
export function validateServeDaemonArgs(
  options: AnyOptions,
  repoDir: string,
  unitEnv: Readonly<Record<string, string>>,
): ServeStartupSettings {
  const unitArgs = [
    "--repo-dir",
    repoDir,
    "--port",
    String(options.port),
    "--host",
    options.host as string,
  ];
  if (options.certFile) {
    unitArgs.push("--cert-file", options.certFile as string);
  }
  if (options.keyFile) {
    unitArgs.push("--key-file", options.keyFile as string);
  }
  for (const arg of collectServeExtraArgs(options)) {
    unitArgs.push(arg);
  }

  const configFile = loadServeConfig(
    options.config as string | undefined,
    repoDir,
  );
  const merged = mergeServeOptions(
    configFile,
    options,
    parseExplicitFlags(unitArgs),
    (name) => unitEnv[name],
  );
  return resolveServeStartupSettings(merged);
}

/** Shutdown drain deadline when `--shutdown-drain-timeout` is unset. */
const DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS = 30_000;

/**
 * Parses `--shutdown-drain-timeout` into milliseconds. Unset keeps the 30s
 * default; `0` (with or without a unit) means abort in-flight runs at once.
 */
export function parseShutdownDrainTimeout(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_SHUTDOWN_DRAIN_TIMEOUT_MS;
  if (/^0+(ms|mo|[smhdwy])?$/i.test(raw.trim())) return 0;
  return parseTimerDuration(raw, "--shutdown-drain-timeout");
}

/**
 * Parses `--datastore-poll-interval` into milliseconds, or `undefined` when
 * unset so each poller keeps its own default. `parseTimeout` only returns
 * whole seconds, which makes 1s the floor; millisecond input gets its own
 * error because `parseTimeout`'s generic format error would not name the
 * flag.
 */
export function parseDatastorePollInterval(
  raw: string | undefined,
): number | undefined {
  if (raw === undefined) return undefined;
  if (/^\d+ms$/i.test(raw.trim())) {
    throw new UserError(
      `--datastore-poll-interval must be in whole seconds or larger units (minimum 1s, e.g. 1s, 30s, 1m); got ${raw}`,
    );
  }
  return parseTimerDuration(raw, "--datastore-poll-interval");
}

/**
 * Whether to warn that `--group-refresh-interval` has no effect. Only an
 * interval the operator supplied (flag, env var or config key) warrants the
 * warning — the unset 4h default must stay silent outside OAuth mode.
 */
export function shouldWarnGroupRefreshIgnored(
  raw: string | undefined,
  intervalMs: number,
  oauthReady: boolean,
): boolean {
  return raw !== undefined && intervalMs > 0 && !oauthReady;
}

export interface TokenGcSettings {
  /** How often the server token GC sweeps; 0 when it is disabled. */
  readonly intervalMs: number;
  /** How long an expired token is kept before it is collected. */
  readonly gracePeriodMs: number;
}

/**
 * Parses `--token-gc-interval` and `--token-gc-grace-period`, falling back to
 * the defaults when unset. An interval of `0` disables the GC; a grace period
 * of `0` collects expired tokens as soon as they expire. Like
 * `--datastore-poll-interval`, both take whole seconds or larger units, and
 * the interval is capped at the maximum safe timer duration because it
 * drives a timer.
 */
export function parseTokenGcSettings(
  interval: string | undefined,
  gracePeriod: string | undefined,
): TokenGcSettings {
  return {
    intervalMs: interval === undefined
      ? DEFAULT_TOKEN_GC_INTERVAL_MS
      : parseTokenGcDuration(interval, "--token-gc-interval", true),
    gracePeriodMs: gracePeriod === undefined
      ? DEFAULT_TOKEN_GC_GRACE_PERIOD_MS
      : parseTokenGcDuration(gracePeriod, "--token-gc-grace-period", false),
  };
}

function parseTokenGcDuration(
  raw: string,
  flagName: string,
  drivesTimer: boolean,
): number {
  const trimmed = raw.trim();
  if (/^0+(ms|mo|[smhdwy])?$/i.test(trimmed)) return 0;
  if (/^\d+ms$/i.test(trimmed)) {
    throw new UserError(
      `${flagName} must be in whole seconds or larger units (e.g. 30s, 1h); got ${raw}`,
    );
  }
  return drivesTimer
    ? parseTimerDuration(raw, flagName)
    : parseTimeout(raw, flagName);
}

/** Startup settings parsed from the merged serve options. */
export interface ServeStartupSettings {
  authConfig: ServeAuthConfig;
  tlsEnabled: boolean;
  wsIdleTimeoutSeconds?: number;
  queueTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  staleTtlMs?: number;
  reconciliationIntervalMs?: number;
  shutdownDrainTimeoutMs: number;
  hydrationTimeoutMs: number;
  datastorePollIntervalMs?: number;
  tokenGcSettings: TokenGcSettings;
  maxConcurrentRuns?: number;
  maxRunsPerPrincipal?: number;
  maxRunDurationMs?: number;
  grantReloadMode: "manual" | "auto";
}

/**
 * Runs the startup checks that depend only on the merged serve options and
 * returns the parsed settings. It does no I/O, so `swamp serve daemon enable`
 * runs the same checks before it writes a unit that would otherwise fail on
 * every start.
 */
export function resolveServeStartupSettings(
  merged: MergedServeOptions,
): ServeStartupSettings {
  const { certFile, keyFile } = merged;
  if ((certFile && !keyFile) || (!certFile && keyFile)) {
    throw new UserError(
      "Both --cert-file and --key-file must be provided together for TLS",
    );
  }
  const tlsEnabled = Boolean(certFile && keyFile);

  const wsIdleTimeoutRaw = merged.wsIdleTimeout;
  let wsIdleTimeoutSeconds: number | undefined;
  if (wsIdleTimeoutRaw !== undefined) {
    if (wsIdleTimeoutRaw === "0") {
      wsIdleTimeoutSeconds = 0;
    } else {
      wsIdleTimeoutSeconds = Math.round(
        parseTimeout(wsIdleTimeoutRaw) / 1000,
      );
    }
  }

  const queueTimeoutRaw = merged.queueTimeout;
  let queueTimeoutMs: number | undefined;
  if (queueTimeoutRaw !== undefined) {
    const normalized = queueTimeoutRaw.trim().replace(/^0[smhdw].*$/i, "0");
    queueTimeoutMs = normalized === "0"
      ? 0
      : parseTimeout(queueTimeoutRaw, "--queue-timeout");
  }

  const heartbeatIntervalMs = merged.heartbeatInterval !== undefined
    ? parseTimerDuration(merged.heartbeatInterval, "--heartbeat-interval")
    : undefined;

  const staleTtlMs = merged.staleTtl !== undefined
    ? parseTimeout(merged.staleTtl, "--stale-ttl")
    : undefined;

  const reconciliationIntervalMs = merged.reconciliationInterval !== undefined
    ? parseTimerDuration(
      merged.reconciliationInterval,
      "--reconciliation-interval",
      MAX_TIMER_DELAY_MS - RECONCILIATION_JITTER_MS,
    )
    : undefined;

  const shutdownDrainTimeoutMs = parseShutdownDrainTimeout(
    merged.shutdownDrainTimeout,
  );

  const hydrationTimeoutMs = merged.hydrationTimeout !== undefined
    ? parseTimerDuration(merged.hydrationTimeout, "--hydration-timeout")
    : 60_000;

  const datastorePollIntervalMs = parseDatastorePollInterval(
    merged.datastorePollInterval,
  );

  const tokenGcSettings = parseTokenGcSettings(
    merged.tokenGcInterval,
    merged.tokenGcGracePeriod,
  );

  const maxConcurrentRuns = merged.maxConcurrentRuns;
  if (
    maxConcurrentRuns !== undefined &&
    (!Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1)
  ) {
    throw new UserError(
      `--max-concurrent-runs must be a positive integer, got ${maxConcurrentRuns}`,
    );
  }
  const maxRunsPerPrincipal = merged.maxRunsPerPrincipal;
  if (
    maxRunsPerPrincipal !== undefined &&
    (!Number.isInteger(maxRunsPerPrincipal) || maxRunsPerPrincipal < 1)
  ) {
    throw new UserError(
      `--max-runs-per-principal must be a positive integer, got ${maxRunsPerPrincipal}`,
    );
  }
  const maxRunDurationMs = merged.maxRunDuration !== undefined
    ? parseTimerDuration(String(merged.maxRunDuration), "--max-run-duration")
    : undefined;

  const authConfig = buildServeAuthConfig({
    authMode: merged.authMode,
    admins: merged.admins,
    allowedCollectives: merged.allowedCollectives,
    allowedUsers: merged.allowedUsers,
    oauthProvider: merged.oauthProvider,
    oauthClientId: merged.oauthClientId,
    groupsField: merged.groupsField,
    restrictedModelTypes: merged.restrictedModelTypes,
    restrictedCommands: merged.restrictedCommands,
    approveRequiresExplicitGrant: merged.approveRequiresExplicitGrant,
  });

  assertOffLoopbackSecurity(merged.host, tlsEnabled, authConfig.mode);

  const grantReloadMode = merged.grantReload;
  if (grantReloadMode !== "manual" && grantReloadMode !== "auto") {
    throw new UserError(
      `Invalid --grant-reload value "${grantReloadMode}": must be "manual" or "auto"`,
    );
  }

  return {
    authConfig,
    tlsEnabled,
    wsIdleTimeoutSeconds,
    queueTimeoutMs,
    heartbeatIntervalMs,
    staleTtlMs,
    reconciliationIntervalMs,
    shutdownDrainTimeoutMs,
    hydrationTimeoutMs,
    datastorePollIntervalMs,
    tokenGcSettings,
    maxConcurrentRuns,
    maxRunsPerPrincipal,
    maxRunDurationMs,
    grantReloadMode,
  };
}

const daemonEnableCommand = new Command()
  .name("enable")
  .description("Enable swamp serve as a system daemon (launchd/systemd)")
  .option(
    "--user",
    "Install as a per-user service (systemd --user / launchd agent)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option("--port <port:number>", "Port for the daemon to listen on", {
    default: 9090,
  })
  .option("--host <host:string>", "Host for the daemon to bind to", {
    default: "127.0.0.1",
  })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate (a relative path resolves against the repository)",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key (a relative path resolves against the repository)",
  )
  .option(
    "--grants-file <path:string>",
    "Path to an external grants YAML file loaded at startup (a relative path resolves against the repository); its grants are stored with source file:grants-file",
  )
  .option(
    "--grants-dir <path:string>",
    "Path to an additional directory of grants YAML files, read alongside the repository grants/ directory (a relative path resolves against the repository); their grants are stored with source file:grants-dir/<filename>",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "scheme is one of github (default), jira, linear, stripe, slack, generic, " +
      "or a webhook extension type (@collective/name). " +
      "Secret may use @env=VAR to read from an environment variable, " +
      "@file=/path to read from a file, or @vault=<vault>:<key> to read " +
      "from a configured vault (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated principal IDs for admin access",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated swamp-club usernames or user:<sub> subjects for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID — auto-registered on first start if omitted. " +
      "Set SWAMP_API_KEY, SWAMP_API_KEY_FILE or --club-api-key-file (a collective " +
      "API token with oauth:manage scope) for headless registration without " +
      "browser interaction.",
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    CLUB_API_KEY_FILE_DESCRIPTION,
  )
  .option(
    "--oauth-client-name <name:string>",
    "OAuth client name used during registration (env: SWAMP_OAUTH_CLIENT_NAME). " +
      "Defaults to swamp-serve-{repoName}-{hostname}.",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--restricted-model-types <types:string>",
    "Comma-separated model types that require admin authority to create or run (e.g. command/shell). Requires --auth-mode token or oauth",
  )
  .option(
    "--restricted-commands <cmds:string>",
    "Comma-separated server commands that require admin authority (e.g. datastore.namespace.list,extension.install). Requires --auth-mode token or oauth",
  )
  .option(
    "--approve-requires-explicit-grant",
    "Require a grant that names approve to decide a manual approval gate; " +
      "a run grant alone no longer implies approve. Off by default. " +
      "Requires --auth-mode token or oauth " +
      "(env: SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT)",
  )
  .option(
    "--group-refresh-interval <duration:string>",
    "How often to re-fetch IdP group memberships for active server tokens. " +
      "Accepts seconds (14400), explicit units (4h, 30m), or 0 to disable. Default: 4h. " +
      "Requires --auth-mode oauth (env: SWAMP_GROUP_REFRESH_INTERVAL).",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable",
  )
  .option(
    "--trusted-hosts <hosts:string>",
    "Comma-separated hostnames to trust for Host header validation (env: SWAMP_TRUSTED_HOSTS)",
  )
  .option(
    "--detach-runs",
    "Deprecated — HA mode is now detected automatically based on your datastore configuration. " +
      "This flag is accepted for backwards compatibility but has no effect.",
  )
  .option(
    "--heartbeat-interval <duration:string>",
    "Instance heartbeat interval (default: 30s, env: SWAMP_HEARTBEAT_INTERVAL)",
  )
  .option(
    "--stale-ttl <duration:string>",
    "Heartbeat stale TTL — instance considered dead after this (default: 90s, env: SWAMP_STALE_TTL)",
  )
  .option(
    "--reconciliation-interval <duration:string>",
    "Peer reconciliation scan interval (default: 60s, env: SWAMP_RECONCILIATION_INTERVAL)",
  )
  .option(
    "--hydration-timeout <duration:string>",
    "Startup cache hydration timeout (default: 60s, env: SWAMP_HYDRATION_TIMEOUT)",
  )
  .option(
    "--shutdown-drain-timeout <duration:string>",
    "How long shutdown waits for in-flight runs before aborting them (default: 30s, 0 aborts at once, env: SWAMP_SHUTDOWN_DRAIN_TIMEOUT)",
  )
  .option(
    "--datastore-poll-interval <duration:string>",
    "Datastore poll interval (default: 30s, minimum: 1s, env: SWAMP_DATASTORE_POLL_INTERVAL)",
  )
  .option(
    "--token-gc-interval <duration:string>",
    "Server token GC interval (default: 1h, 0 disables, env: SWAMP_TOKEN_GC_INTERVAL)",
  )
  .option(
    "--token-gc-grace-period <duration:string>",
    "How long expired server tokens are kept before GC (default: 1h, env: SWAMP_TOKEN_GC_GRACE_PERIOD)",
  )
  .option(
    "--remote-only",
    "Disable local (loopback) execution — all steps must declare placement " +
      "(env: SWAMP_REMOTE_ONLY)",
  )
  .option(
    "--ws-idle-timeout <duration:string>",
    "WebSocket idle timeout (env: SWAMP_WS_IDLE_TIMEOUT). Default: 30s",
  )
  .option(
    "--queue-timeout <duration:string>",
    "Queue timeout for placed steps (env: SWAMP_QUEUE_TIMEOUT). Default: 10m",
  )
  .option(
    "--max-concurrent-runs <count:integer>",
    "Maximum concurrent detached runs across all principals. Default: 100 " +
      "(env: SWAMP_MAX_CONCURRENT_RUNS)",
  )
  .option(
    "--max-runs-per-principal <count:integer>",
    "Maximum concurrent detached runs per authenticated principal " +
      "(env: SWAMP_MAX_RUNS_PER_PRINCIPAL)",
  )
  .option(
    "--max-run-duration <duration:string>",
    "Maximum wall-clock time a detached run may execute " +
      "(env: SWAMP_MAX_RUN_DURATION)",
  )
  .option(
    "--hot-reload",
    "Enable SIGHUP-based hot-reload for pulled extension bundles. " +
      "Writes a PID file to .swamp/serve.pid; use 'swamp serve reload' to trigger",
  )
  .option(
    "--enable-internal-api",
    "Enable the /internal/runs endpoint for full run history access " +
      "(env: SWAMP_ENABLE_INTERNAL_API)",
  )
  .option(
    "--dashboard",
    "Enable the web dashboard at /dashboard " +
      "(env: SWAMP_DASHBOARD)",
  )
  .option(
    "--auto-resume",
    "Resume a suspended run once every approval gate on it is decided. " +
      "Applies to workflows that declare no inputs; a workflow with inputs " +
      "must set autoResume: true itself, and autoResume: false opts out " +
      "(env: SWAMP_AUTO_RESUME)",
  )
  .example("Enable daemon", "swamp serve daemon enable")
  .example(
    "Enable with custom port",
    "swamp serve daemon enable --port 8080",
  )
  .example(
    "Enable with TLS and auth",
    "swamp serve daemon enable --cert-file cert.pem --key-file key.pem --auth-mode token",
  )
  .example(
    "Enable with config file",
    "swamp serve daemon enable --config /etc/swamp/serve.yaml",
  )
  .action(async function (options: AnyOptions) {
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const env = buildServeDaemonEnv();
    const { authConfig } = validateServeDaemonArgs(options, repoDir, env);
    if (authConfig.mode === "oauth" || authConfig.mode === "token") {
      requireAuthenticated("swamp serve is a team feature", "serve:*");
      requireScope("serve:*");
    }

    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "enable",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });
    const extraArgs = collectServeExtraArgs(options);

    await scheduler.enable({
      binaryPath: Deno.execPath(),
      repoDir,
      port: options.port as number,
      host: options.host as string,
      certFile: options.certFile as string | undefined,
      keyFile: options.keyFile as string | undefined,
      extraArgs: extraArgs.length > 0 ? extraArgs : undefined,
      env,
    });

    renderDaemonEnabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonDisableCommand = new Command()
  .name("disable")
  .description("Disable and remove the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Disable daemon", "swamp serve daemon disable")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "disable",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    await scheduler.disable();

    renderDaemonDisabled(ctx.outputMode, toServiceMode(mode));
  });

const daemonStatusCommand = new Command()
  .name("status")
  .description("Show the status of the swamp serve daemon")
  .option(
    "--user",
    "Target the per-user service (systemd --user / launchd agent)",
  )
  .example("Check daemon status", "swamp serve daemon status")
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "daemon",
      "status",
    ]);
    const mode = await resolveServiceMode({
      user: options.user as boolean | undefined,
    });
    const scheduler = await createServiceScheduler({ mode });

    const status = await scheduler.status();

    renderDaemonStatus(status, ctx.outputMode, toServiceMode(mode));
  });

const reloadCommand = new Command()
  .name("reload")
  .description(
    "Reload pulled extension bundles and refresh the trust list on a running serve process.\n\n" +
      "With --server, sends a reload request to the running server over WebSocket. " +
      "Without --server, reads .swamp/serve.pid and sends SIGHUP locally. " +
      "Requires the serve process to be running with --hot-reload.",
  )
  .example(
    "Reload on a remote server",
    "swamp serve reload --server wss://swamp.acme.internal:9090",
  )
  .example("Reload locally", "swamp serve reload")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--server <url:string>",
    "Reload extensions on a 'swamp serve' server instead of locally (env: SWAMP_SERVE_URL)",
  )
  .option(
    "--token <token:string>",
    "Server token; only applies with --server (falls back to stored credential or SWAMP_SERVER_TOKEN)",
  )
  .option(
    "--token-file <path:string>",
    "Path to a file containing the server token; mutually exclusive with --token (env: SWAMP_SERVER_TOKEN_FILE)",
  )
  .option(CA_CERT_FLAG, CA_CERT_DESCRIPTION)
  .action(async function (options: AnyOptions) {
    const server = resolveServeUrl(options.server as string | undefined);

    validateServerRepoExclusivity(
      server,
      options.repoDir as string | undefined,
    );

    const ctx = createContext(options as GlobalOptions, ["serve", "reload"]);
    const renderer = createServeReloadRenderer(ctx.outputMode);

    if (server) {
      const token = await resolveServerTokenFromOptions(
        server,
        options,
      );

      const response = await requestServerResponse<ServeReloadResponse>(
        { server, ...(token ? { token } : {}) },
        { type: "serve.reload" },
      );

      if (!response.success) {
        renderer.render({
          success: false,
          reloadedCount: 0,
          errors: response.errors,
        });
        throw new UserError("Extension reload failed on the server");
      }

      renderer.render(response);
      return;
    }

    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const pidPath = swampPath(repoDir, "serve.pid");

    let pidStr: string;
    try {
      pidStr = await Deno.readTextFile(pidPath);
    } catch {
      throw markErrorPaths(
        new UserError(
          "No PID file found at " + pidPath + ". " +
            "Is swamp serve running with --hot-reload?",
        ),
        [pidPath],
      );
    }

    const pid = parseInt(pidStr.trim(), 10);
    if (isNaN(pid)) {
      throw markErrorPaths(
        new UserError("Invalid PID in " + pidPath + ": " + pidStr.trim()),
        [pidPath],
      );
    }

    try {
      Deno.kill(pid, "SIGHUP");
    } catch {
      throw markErrorPaths(
        new UserError(
          "Process " + pid + " not found — stale PID file. " +
            "Remove " + pidPath + " and restart serve with --hot-reload.",
        ),
        [pidPath],
      );
    }

    logger.info`Sent SIGHUP to serve process ${pid}`;
  });

/**
 * Reads the external token secrets key the way serve would at startup and
 * reports whether it is usable. Returns undefined when serve.yaml has no
 * token-secrets block. The key itself is never returned or printed.
 */
async function checkTokenSecretsKey(
  ref: TokenSecretsKeyRef | undefined,
  repoDir: string,
): Promise<TokenSecretsKeyCheck | undefined> {
  if (!ref) return undefined;
  const { resolveTokenSecretsKey } = await import(
    "../../domain/vaults/control_plane_vault_init.ts"
  );
  try {
    await resolveTokenSecretsKey(
      ref,
      await VaultService.fromRepository(repoDir),
    );
    return { vault: ref.vault, key: ref.key, status: "ok" };
  } catch (err) {
    return {
      vault: ref.vault,
      key: ref.key,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

const checkConfigCommand = new Command()
  .name("check-config")
  .description(
    "Check a serve config's auth settings and token secrets key without starting the server.\n\n" +
      "Loads the auth settings the same way 'swamp serve' does (flags, env vars, then the " +
      "config file), validates them, and in oauth mode looks up every admin and " +
      "allowed-user name on the OAuth provider. Exits non-zero if a name is unknown " +
      "or serve would refuse to start. Uses --club-api-key-file, SWAMP_API_KEY_FILE, " +
      "SWAMP_API_KEY or your 'swamp auth login' " +
      "credential, and only sends it to the provider that issued it (set SWAMP_CLUB_URL " +
      "for a custom provider). With a token-secrets block, also reads the token " +
      "secrets key from its vault and checks it is a usable 32-byte key, without " +
      "printing it. It reads only this repository's files and never contacts the " +
      "datastore, so it cannot tell whether a control plane was already moved to a " +
      "key (or to a different key), and vaults whose configs arrive through the " +
      "datastore must be synced first; serve checks both at startup. Nothing is " +
      "written to the repository or the vault.",
  )
  .example("Check the repository's serve config", "swamp serve check-config")
  .example(
    "Check a config file before deploying it",
    "swamp serve check-config --config deploy/serve.yaml",
  )
  .example(
    "Check names passed as flags",
    "swamp serve check-config --auth-mode oauth --admins alice,bob --allowed-collectives eng",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode to check, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated admin usernames, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated allowed-user usernames, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth provider URL, as passed to 'swamp serve' (overrides the config file)",
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    "Path to a file containing the collective API key used to look up " +
      "usernames; overrides SWAMP_API_KEY_FILE and SWAMP_API_KEY",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, [
      "serve",
      "check-config",
    ]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    const configFile = loadServeConfig(
      options.config as string | undefined,
      repoDir,
    );
    const merged = mergeServeOptions(
      configFile,
      options,
      parseExplicitFlags(Deno.args),
    );
    const authConfig = buildServeAuthConfig({
      authMode: merged.authMode,
      admins: merged.admins,
      allowedCollectives: merged.allowedCollectives,
      allowedUsers: merged.allowedUsers,
      oauthProvider: merged.oauthProvider,
      oauthClientId: merged.oauthClientId,
      groupsField: merged.groupsField,
      restrictedModelTypes: merged.restrictedModelTypes,
      restrictedCommands: merged.restrictedCommands,
      approveRequiresExplicitGrant: merged.approveRequiresExplicitGrant,
    });

    const tokenSecretsKey = await checkTokenSecretsKey(
      parseTokenSecretsKeyConfig(
        configFile,
        options.config === undefined
          ? SERVE_CONFIG_PATH
          : resolveServePath(repoDir, options.config as string),
      ),
      repoDir,
    );
    const keyUsable = tokenSecretsKey?.status !== "failed";

    if (authConfig.mode !== "oauth") {
      renderServeCheckConfig({
        passed: keyUsable,
        authMode: authConfig.mode,
        entries: [],
        allowedCollectives: [],
        wouldStart: keyUsable,
        ...(tokenSecretsKey ? { tokenSecretsKey } : {}),
      }, ctx.outputMode);
      if (!keyUsable) Deno.exitCode = 1;
      return;
    }

    const providerUrl = authConfig.oauthProvider;
    // AuthRepository.load() returns the collective API key (issued by
    // SWAMP_CLUB_URL or the default server) when set, otherwise the stored
    // login.
    const creds = await new AuthRepository().load();
    const token = selectCheckConfigToken(
      providerUrl,
      creds
        ? {
          serverUrl: creds.serverUrl,
          apiKey: creds.apiKey,
          source: apiKeySourceName() ?? "login",
        }
        : null,
    );
    const { resolveUsername } = await import("../../serve/oauth_client.ts");
    const { checkAccessLists } = await import(
      "../../serve/oauth_access_list_resolution.ts"
    );
    const check = await checkAccessLists(
      authConfig,
      (username) =>
        resolveUsername(
          providerUrl,
          username,
          token,
          AbortSignal.timeout(10_000),
        ),
      providerUrl,
    );
    const notFound = check.entries.filter((e) => e.status === "not-found");
    const passed = check.wouldStart && notFound.length === 0 && keyUsable;

    renderServeCheckConfig({
      passed,
      authMode: authConfig.mode,
      oauthProvider: providerUrl,
      entries: check.entries,
      allowedCollectives: authConfig.allowedCollectives,
      wouldStart: check.wouldStart && keyUsable,
      ...(check.refusal !== undefined ? { refusal: check.refusal } : {}),
      ...(tokenSecretsKey ? { tokenSecretsKey } : {}),
    }, ctx.outputMode);

    // The rendered result already says what failed; like `access can-i`,
    // report failure through the exit code rather than a second error.
    if (!passed) Deno.exitCode = 1;
  });

const daemonCommand = new Command()
  .name("daemon")
  .description("Manage swamp serve as a system daemon (EXPERIMENTAL)")
  .action(groupCommandAction)
  .command("enable", daemonEnableCommand)
  .command("disable", daemonDisableCommand)
  .command("status", daemonStatusCommand);

export const serveCommand = new Command()
  .name("serve")
  .description(
    "Start a WebSocket API server for workflow and model execution.\n\n" +
      "Service deployments: swamp loads all extensions — including " +
      "already-pulled repo extensions — through an embedded runtime under the " +
      "swamp data directory (SWAMP_HOME, or ~/.swamp). `swamp serve daemon " +
      "enable` sets SWAMP_HOME and SWAMP_CONFIG_DIR in the generated service " +
      "unit automatically. If you author a service unit manually, set " +
      "SWAMP_HOME or HOME in the unit environment, e.g. " +
      "`Environment=SWAMP_HOME=/opt/swamp`. Without it, scheduled workflow " +
      'runs fail with "Unknown model type" for pulled extension types. ' +
      "SWAMP_HOME also moves the config directory, where `swamp auth login` " +
      "stores credentials, to $SWAMP_HOME/config; for --auth-mode token or " +
      "oauth, also set SWAMP_CONFIG_DIR to the config directory holding " +
      "those credentials (~/.config/swamp by default).",
  )
  .example("Start server", "swamp serve")
  .example("Custom port", "swamp serve --port 8080")
  .example(
    "Config file",
    "swamp serve --config /etc/swamp/serve.yaml",
  )
  .example(
    "Bind to all interfaces (TLS + auth required)",
    "swamp serve --host 0.0.0.0 --port 3000 --cert-file server.crt --key-file server.key --auth-mode token",
  )
  .example(
    "Headless OAuth (CI / container)",
    "SWAMP_API_KEY=<token> swamp serve --auth-mode oauth --admins dmc --allowed-collectives my-org",
  )
  .example(
    "Headless OAuth with the key in a mounted secret file",
    "swamp serve --auth-mode oauth --club-api-key-file /run/secrets/swamp-api-key --admins dmc --allowed-collectives my-org",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--config <path:string>",
    "Path to serve config file (default: .swamp/serve.yaml; a relative path resolves against the repository)",
  )
  .option("--port <port:number>", "Port to listen on", { default: 9090 })
  .option("--host <host:string>", "Host to bind to", { default: "127.0.0.1" })
  .option("--no-schedule", "Disable scheduled workflow execution")
  .option(
    "--cert-file <path:string>",
    "Path to PEM-encoded TLS certificate (env: SWAMP_SERVE_CERT_FILE; a relative path resolves against the repository)",
  )
  .option(
    "--key-file <path:string>",
    "Path to PEM-encoded TLS private key (env: SWAMP_SERVE_KEY_FILE; a relative path resolves against the repository)",
  )
  .option(
    "--grants-file <path:string>",
    "Path to an external grants YAML file loaded at startup (a relative path resolves against the repository); its grants are stored with source file:grants-file (env: SWAMP_GRANTS_FILE)",
  )
  .option(
    "--grants-dir <path:string>",
    "Path to an additional directory of grants YAML files, read alongside the repository grants/ directory (a relative path resolves against the repository); their grants are stored with source file:grants-dir/<filename> (env: SWAMP_GRANTS_DIR)",
  )
  .option(
    "--grant-reload <mode:string>",
    "Policy snapshot reload mode: manual (default) or auto",
    { default: "manual" },
  )
  .option(
    "--webhook <spec:string>",
    "Register a webhook endpoint: <route>:<workflow>:<secret>[:<scheme>[:<header>[:<prefix>]]]. " +
      "scheme is one of github (default), jira, linear, stripe, slack, generic, " +
      "or a webhook extension type (@collective/name); " +
      "generic requires a header name and accepts an optional value prefix. " +
      "Secret may use @env=VAR to read from an environment variable, " +
      "@file=/path to read from a file, or @vault=<vault>:<key> to read " +
      "from a configured vault (avoids secrets in argv)",
    { collect: true },
  )
  .option(
    "--auth-mode <mode:string>",
    "Authentication mode: none (default, deprecated), token, or oauth",
    { default: "none" },
  )
  .option(
    "--admins <principals:string>",
    "Comma-separated admin principals: plain usernames for OAuth mode (e.g. dmc), user:<subject-id> for token mode",
  )
  .option(
    "--allowed-collectives <list:string>",
    "Comma-separated collective slugs for OAuth admission policy",
  )
  .option(
    "--allowed-users <list:string>",
    "Comma-separated swamp-club usernames or user:<sub> subjects for OAuth admission policy",
  )
  .option(
    "--oauth-provider <url:string>",
    "OAuth authorization server URL (default: https://swamp-club.com)",
  )
  .option(
    "--oauth-client-id <id:string>",
    "OAuth client ID — auto-registered on first start if omitted. " +
      "Set SWAMP_API_KEY, SWAMP_API_KEY_FILE or --club-api-key-file (a collective " +
      "API token with oauth:manage scope) for headless registration without " +
      "browser interaction.",
  )
  .option(
    `${CLUB_API_KEY_FILE_FLAG} <path:string>`,
    CLUB_API_KEY_FILE_DESCRIPTION,
  )
  .option(
    "--oauth-client-name <name:string>",
    "OAuth client name used during registration (env: SWAMP_OAUTH_CLIENT_NAME). " +
      "Defaults to swamp-serve-{repoName}-{hostname}.",
  )
  .option(
    "--groups-field <field:string>",
    "Userinfo field name for group/collective memberships (default: collectives)",
  )
  .option(
    "--restricted-model-types <types:string>",
    "Comma-separated model types that require admin authority to create or run (e.g. command/shell). Requires --auth-mode token or oauth",
  )
  .option(
    "--restricted-commands <cmds:string>",
    "Comma-separated server commands that require admin authority (e.g. datastore.namespace.list,extension.install). Requires --auth-mode token or oauth",
  )
  .option(
    "--approve-requires-explicit-grant",
    "Require a grant that names approve to decide a manual approval gate; " +
      "a run grant alone no longer implies approve. Off by default. " +
      "Requires --auth-mode token or oauth " +
      "(env: SWAMP_APPROVE_REQUIRES_EXPLICIT_GRANT)",
  )
  .option(
    "--group-refresh-interval <duration:string>",
    "How often to re-fetch IdP group memberships for active server tokens (env: SWAMP_GROUP_REFRESH_INTERVAL). " +
      "Accepts seconds (14400), explicit units (4h, 30m), or 0 to disable. Default: 4h. Requires --auth-mode oauth.",
  )
  .option(
    "--trust-proxy",
    "Trust X-Forwarded-For header for client IP in token auth rate limiting (enable when behind a reverse proxy)",
  )
  .option(
    "--ws-idle-timeout <duration:string>",
    "WebSocket idle timeout — how long the server waits for a pong before closing the connection (env: SWAMP_WS_IDLE_TIMEOUT). " +
      "Accepts seconds (30), explicit units (2m, 5m), or 0 to disable. Default: 30s",
  )
  .option(
    "--queue-timeout <duration:string>",
    "How long a placed step queues for a matching worker before timing out (env: SWAMP_QUEUE_TIMEOUT). " +
      "Accepts seconds (60), explicit units (2m, 10m), or 0 to disable. Default: 10m",
  )
  .option(
    "--verify-on-enroll",
    "Run a fleet probe on each enrolling worker before it becomes schedulable — workers that fail are marked unverified (env: SWAMP_VERIFY_ON_ENROLL)",
  )
  .option(
    "--trusted-hosts <hosts:string>",
    "Comma-separated hostnames to trust for Host header validation when binding off-loopback " +
      "(e.g. host.docker.internal,host.minikube.internal). " +
      "Preserves the DNS rebinding defense while allowing Docker/Kubernetes worker connections " +
      "(env: SWAMP_TRUSTED_HOSTS)",
  )
  .option(
    "--detach-runs",
    "Deprecated — HA mode is now detected automatically based on your datastore configuration. " +
      "This flag is accepted for backwards compatibility but has no effect.",
  )
  .option(
    "--heartbeat-interval <duration:string>",
    "How often to write an instance heartbeat to the control-plane store. " +
      "Accepts seconds (30), explicit units (30s, 1m). Default: 30s. " +
      "Only effective with a control-plane-capable datastore (env: SWAMP_HEARTBEAT_INTERVAL)",
  )
  .option(
    "--stale-ttl <duration:string>",
    "How long a heartbeat can go without update before the instance is considered dead. " +
      "Must be at least 2x --heartbeat-interval (values below this are rejected). " +
      "Accepts seconds (90), explicit units (90s, 2m). Default: 90s. " +
      "Only effective with a control-plane-capable datastore (env: SWAMP_STALE_TTL)",
  )
  .option(
    "--reconciliation-interval <duration:string>",
    "How often to scan for dead peer instances and reconcile their orphaned runs. " +
      "Accepts seconds (60), explicit units (60s, 2m). Default: 60s. " +
      "Only effective with a control-plane-capable datastore (env: SWAMP_RECONCILIATION_INTERVAL)",
  )
  .option(
    "--hydration-timeout <duration:string>",
    "Maximum time to wait for initial datastore cache hydration at startup. " +
      "Accepts seconds (60), explicit units (60s, 5m). Default: 60s. " +
      "Increase for large repos where the initial pull takes longer (env: SWAMP_HYDRATION_TIMEOUT)",
  )
  .option(
    "--shutdown-drain-timeout <duration:string>",
    "How long shutdown (SIGTERM/SIGINT) waits for in-flight webhook, scheduled and API runs to finish before aborting them. " +
      "Accepts seconds (30), explicit units (30s, 5m), or 0 to abort at once. Default: 30s. " +
      "Keep it below the pod's terminationGracePeriodSeconds minus about 10s (env: SWAMP_SHUTDOWN_DRAIN_TIMEOUT)",
  )
  .option(
    "--datastore-poll-interval <duration:string>",
    "How often to pull config, access data and runtime data from the remote datastore, " +
      "and to check the managedConfig extension lockfile for changes. " +
      "Accepts seconds (30), explicit units (30s, 1m). Default: 30s. Minimum: 1s. " +
      "Only effective with a remote datastore or managedConfig (env: SWAMP_DATASTORE_POLL_INTERVAL)",
  )
  .option(
    "--token-gc-interval <duration:string>",
    "How often to delete revoked server tokens, and expired ones past the grace period. " +
      "Accepts seconds (3600), explicit units (30s, 1h). Default: 1h. 0 disables (env: SWAMP_TOKEN_GC_INTERVAL)",
  )
  .option(
    "--token-gc-grace-period <duration:string>",
    "How long an expired server token is kept before the token GC deletes it. " +
      "Accepts seconds (3600), explicit units (30s, 1h). Default: 1h. 0 deletes at expiry (env: SWAMP_TOKEN_GC_GRACE_PERIOD)",
  )
  .option(
    "--max-concurrent-runs <count:integer>",
    "Maximum number of concurrent detached runs across all principals. Default: 100. " +
      "(env: SWAMP_MAX_CONCURRENT_RUNS)",
  )
  .option(
    "--max-runs-per-principal <count:integer>",
    "Maximum number of concurrent detached runs per authenticated principal. " +
      "Unset by default (no per-principal limit). (env: SWAMP_MAX_RUNS_PER_PRINCIPAL)",
  )
  .option(
    "--max-run-duration <duration:string>",
    "Maximum wall-clock time a run may execute before being aborted. " +
      "Accepts seconds (3600), explicit units (1h, 30m). Unset by default (no limit). " +
      "(env: SWAMP_MAX_RUN_DURATION)",
  )
  .option(
    "--hot-reload",
    "Enable SIGHUP-based hot-reload for pulled extension bundles and " +
      "trigger overrides from serve.yaml. " +
      "Writes a PID file to .swamp/serve.pid; use 'swamp serve reload' to trigger a reload",
  )
  .option(
    "--enable-internal-api",
    "Enable the /internal/runs endpoint for full run history access " +
      "(env: SWAMP_ENABLE_INTERNAL_API)",
  )
  .option(
    "--remote-only",
    "Disable local (loopback) execution — all steps must declare placement " +
      "and be dispatched to remote workers. Steps without placement will error " +
      "(env: SWAMP_REMOTE_ONLY)",
  )
  .option(
    "--dashboard",
    "Enable the web dashboard at /dashboard " +
      "(env: SWAMP_DASHBOARD)",
  )
  .option(
    "--auto-resume",
    "Resume a suspended run once every approval gate on it is decided. " +
      "Applies to workflows that declare no inputs; a workflow with inputs " +
      "must set autoResume: true itself, and autoResume: false opts out " +
      "(env: SWAMP_AUTO_RESUME)",
  )
  .example(
    "Enable TLS",
    "swamp serve --cert-file server.crt --key-file server.key",
  )
  .example(
    "Token auth",
    "swamp serve --auth-mode token --admins 'user:abc-123'",
  )
  .example(
    "OAuth auth",
    "swamp serve --auth-mode oauth --admins dmc --allowed-collectives my-org",
  )
  .example(
    "Webhook (secret from env var)",
    "swamp serve --webhook '/hooks/github:my-workflow:@env=WEBHOOK_SECRET'",
  )
  .example(
    "Webhook (secret from file)",
    "swamp serve --webhook '/hooks/github:my-workflow:@file=/run/secrets/webhook'",
  )
  .example(
    "Webhook (secret from vault)",
    "swamp serve --webhook '/hooks/github:my-workflow:@vault=production:webhook-secret'",
  )
  .example(
    "Webhook with a provider scheme",
    "swamp serve --webhook '/hooks/linear:my-workflow:@env=LINEAR_SECRET:linear' " +
      "--webhook '/hooks/custom:my-workflow:@env=CUSTOM_SECRET:generic:X-Signature:sha256='",
  )
  .example(
    "Webhook with an extension scheme",
    "swamp serve --webhook '/hooks/telegram:my-workflow:@env=TELEGRAM_SECRET:@swamp/telegram'",
  )
  .example(
    "Docker workers",
    "swamp serve --host 0.0.0.0 --trusted-hosts host.docker.internal " +
      "--cert-file server.crt --key-file server.key --auth-mode token",
  )
  .action(async function (options: AnyOptions) {
    const ctx = createContext(options as GlobalOptions, ["serve"]);
    const repoDir = resolveRepoDir(options.repoDir as string | undefined);
    // Runs here are triggered remotely: nobody at serve's terminal answers a
    // step's prompts, so aborting a run must reach every process it started
    // even when serve runs in the foreground.
    setProcessGroupIsolation("always");
    const isJson = ctx.outputMode === "json";
    if (!isJson) {
      enableServeOutput();
    }
    warnIfRunningAsInit();

    // Load config file and merge with CLI flags (four-level priority:
    // CLI flag > env var > config file > default)
    const configFile = loadServeConfig(
      options.config as string | undefined,
      repoDir,
    );
    // The file trigger overrides and webhooks were loaded from. Hot reload
    // and the workflow.trigger handlers re-read it, so they must use the
    // same path, not the default under the repo.
    const serveConfigPath = options.config === undefined
      ? undefined
      : resolveServePath(repoDir, options.config as string);
    const explicitFlags = parseExplicitFlags(Deno.args);
    const merged = resolveServeTlsPaths(
      repoDir,
      mergeServeOptions(configFile, options, explicitFlags),
    );

    const port = merged.port;
    const host = merged.host;
    const certFile = merged.certFile;
    const keyFile = merged.keyFile;

    const {
      authConfig,
      tlsEnabled,
      wsIdleTimeoutSeconds,
      queueTimeoutMs,
      heartbeatIntervalMs,
      staleTtlMs,
      reconciliationIntervalMs,
      shutdownDrainTimeoutMs,
      hydrationTimeoutMs,
      datastorePollIntervalMs,
      tokenGcSettings,
      maxConcurrentRuns,
      maxRunsPerPrincipal,
      maxRunDurationMs,
      grantReloadMode,
    } = resolveServeStartupSettings(merged);
    const heartbeatIntervalRaw = merged.heartbeatInterval;
    const staleTtlRaw = merged.staleTtl;

    let cert: string | undefined;
    let key: string | undefined;
    if (certFile && keyFile) {
      cert = await readTlsFile("certificate", certFile);
      key = await readTlsFile("private key", keyFile);
    }

    if (cert) {
      for (const warning of validateEndEntityCert(cert)) {
        logger.warn("{warning}", { warning: warning.message });
      }
    }
    const trustProxy = merged.trustProxy;

    if (authConfig.mode === "none" && authConfig.admins.length > 0) {
      logger.warn(
        "--admins is set but --auth-mode is {mode} — admins will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (
      authConfig.mode === "none" &&
      authConfig.restrictedModelTypes.length > 0
    ) {
      logger.warn(
        "--restricted-model-types is set but --auth-mode is {mode} — type restrictions will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (
      authConfig.mode === "none" &&
      authConfig.restrictedCommands.length > 0
    ) {
      logger.warn(
        "--restricted-commands is set but --auth-mode is {mode} — command restrictions will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (
      authConfig.mode === "none" && authConfig.approveRequiresExplicitGrant
    ) {
      logger.warn(
        "--approve-requires-explicit-grant is set but --auth-mode is {mode} — approval policy will have no effect",
        { mode: authConfig.mode },
      );
    }

    if (authConfig.mode === "oauth" || authConfig.mode === "token") {
      requireAuthenticated("swamp serve is a team feature", "serve:*");
      requireScope("serve:*");
    }

    if (authConfig.mode === "none") {
      logger.warn(
        "auth-mode is 'none' — this mode is deprecated and will be removed in a future release. " +
          "Use --auth-mode token for authenticated access. " +
          "See https://swamp-club.com/manual/how-to/swamp-serve/set-up-token-auth",
      );
    }

    const trustedHostsRaw = merged.trustedHosts;
    const trustedHosts = trustedHostsRaw
      ? trustedHostsRaw.split(",").map((h) => h.trim()).filter((h) =>
        h.length > 0
      )
      : undefined;

    const rejectionGuard = installUnhandledRejectionGuard();

    const raiseResult = tryRaiseOpenFileLimit();
    if (raiseResult.raised) {
      logger
        .info`raised open-file limit from ${raiseResult.from} to ${raiseResult.to}`;
    } else {
      const fileLimitWarning = checkOpenFileLimit();
      if (fileLimitWarning) {
        logger
          .warn`could not raise open-file limit automatically (${raiseResult.reason})`;
        logger.warn(fileLimitWarning.message);
      }
    }

    ctx.logger.info`Initializing repository at ${repoDir}`;

    const {
      repoDir: resolvedRepoDir,
      repoContext,
      datastoreConfig,
      syncService,
      lockfilePath: managedLockfilePath,
      vaultsDir,
    } = await requireInitializedRepoUnlocked({
      repoDir,
      outputMode: ctx.outputMode,
    });

    // One gate per serve process, shared by the pollers, the WebSocket
    // mutation handlers and the device-auth mint path so a pull can never
    // land between a local delete and its push (swamp-club#2247). Only
    // meaningful with a sync service — without one nothing syncs.
    const syncGate = syncService ? createSyncGate() : undefined;

    let configPoller: ConfigPoller | null = null;
    let accessDataPoller: AccessDataPoller | null = null;
    let runtimeDataPoller: RuntimeDataPoller | null = null;
    let repoMarker = null;
    try {
      const markerRepo = new RepoMarkerRepository();
      repoMarker = await markerRepo.read(RepoPath.create(resolvedRepoDir));
    } catch {
      // Not in a swamp repo or marker unreadable — resolveModelsDir(null) returns the default
    }
    const extensionLockfilePath = managedLockfilePath;

    // Remote-execution control plane: capability verbs, worker enrollment,
    // and the dispatch/lease registries shared with the HTTP data plane.
    // See design/enablers/remote-execution.md.
    const dispatchRegistry = new DispatchRegistry();
    const capabilityService = new CapabilityService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
    });
    const bundleRegistry = new BundleRegistry();
    const dispatchService = new DispatchService({
      repoDir: resolvedRepoDir,
      repoContext,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      queueTimeoutMs,
    });
    const verifyOnEnroll = merged.verifyOnEnroll;
    const workerGateway = new WorkerGateway({
      repoDir: resolvedRepoDir,
      repoContext,
      capabilityService,
      onWorkerIdle: (worker) => dispatchService.notifyWorkerIdle(worker),
      onGraceExpired: (worker) => dispatchService.notifyGraceExpired(worker),
      onWorkerRemoved: (worker) => dispatchService.notifyWorkerRemoved(worker),
      onWorkerEnrolled: (worker) =>
        dispatchService.notifyWorkerEnrolled(worker),
      onWorkerDraining: (worker) =>
        dispatchService.notifyWorkerDraining(worker),
      verifyOnEnroll,
      verifyWorker: verifyOnEnroll
        ? async (workerName) => {
          const probe = await dispatchFleetProbe(
            dispatchService,
            repoContext.unifiedDataRepo,
            workerName,
            "verify-on-enroll",
            AbortSignal.timeout(60_000),
          );
          if (probe.status === "pass") {
            return { ok: true };
          }
          return {
            ok: false,
            failureReason: probe.status === "error"
              ? probe.error ?? "probe error"
              : (probe.failures ?? []).join("; ") || "probe failed",
          };
        }
        : undefined,
    });
    dispatchService.bindGateway(workerGateway);
    setRemoteStepDispatcher(dispatchService);
    if (merged.remoteOnly) {
      setRemoteOnlyMode(true);
      logger.info(
        "Remote-only mode enabled — all steps require explicit placement",
      );
    }
    if (merged.autoResume) {
      logger.info(
        "Auto-resume enabled — runs resume once every approval gate is decided, for workflows that declare no inputs (a workflow with inputs must set autoResume: true)",
      );
    }
    const dataPlane = new DataPlane({
      repoDir: resolvedRepoDir,
      repoContext,
      sessions: workerGateway.sessions,
      dispatches: dispatchRegistry,
      bundles: bundleRegistry,
      onFirstWrite: (dispatch) => dispatchService.recordFirstWrite(dispatch),
    });
    dispatchService.setOnDispatchEnd((dispatchId) =>
      dataPlane.releaseDispatch(dispatchId)
    );

    // When managedConfig is active, pull the config and auto-definitions
    // prefixes from the datastore BEFORE loading extensions. config/ is
    // needed so extension loaders can scan managed dirs; auto-definitions/
    // is needed so model resolution finds definitions created by prior
    // serve instances (enrollment tokens, server tokens, grants). The
    // repository context was created before this pull, so its pulled
    // workflow dirs are re-enumerated here (swamp-club#2434).
    if (repoMarker?.datastore?.managedConfig && syncService) {
      await pullManagedConfigAtBoot({
        syncService,
        namespace: isCustomDatastoreConfig(datastoreConfig)
          ? datastoreConfig.namespace
          : undefined,
        catalogInvalidate: () => repoContext.catalogStore.invalidate(),
        extensionWorkflowRepo: repoContext.extensionWorkflowRepo,
        repoDir: resolvedRepoDir,
        lockfilePath: extensionLockfilePath,
      });
    }
    // The extension set the registries load below. The config poller reloads
    // only when the tier lockfile's hash moves away from it. An unreadable
    // lockfile leaves the baseline to the poller's first poll.
    const bootLockfileHash = repoMarker?.datastore?.managedConfig
      ? await computeFileContentHashIfExists(extensionLockfilePath).catch(() =>
        undefined
      )
      : undefined;
    // The pulled types that lockfile version registers, so a reload can
    // unregister an extension removed since (swamp-club#2742). Recorded
    // again once the registries have loaded, below.
    const recordPulledTypes = () =>
      seedPulledTypeSnapshot(resolvedRepoDir, extensionLockfilePath)
        .catch((error: unknown) => {
          logger.warn(
            "Could not record the pulled extension types at boot; an extension removed before the next reload may stay registered until serve restarts: {error}",
            { error: error instanceof Error ? error.message : String(error) },
          );
        });
    await recordPulledTypes();

    // Re-enumerates pulled extension workflow dirs and, once the scheduler
    // exists, rescans schedules. Shared by `serve reload` and the config
    // poller so an extension the poller pulls in registers its workflows
    // without a manual reload. `rescan` is bound after the scheduler starts.
    const scheduledWorkflows: { rescan?: () => Promise<void> } = {};
    const extWorkflowRepo = repoContext.extensionWorkflowRepo;
    const reloadExtensionWorkflows = extWorkflowRepo
      ? async (): Promise<number> => {
        const count = await refreshExtensionWorkflowDirs(
          extWorkflowRepo,
          resolvedRepoDir,
          extensionLockfilePath,
        );
        await scheduledWorkflows.rescan?.();
        return count;
      }
      : undefined;

    // Index extension registries so types are discoverable at startup.
    // Bundles are imported on demand when workflow steps target them.
    await Promise.all([
      modelRegistry.ensureLoaded(),
      vaultTypeRegistry.ensureLoaded(),
      datastoreTypeRegistry.ensureLoaded(),
      reportRegistry.ensureLoaded(),
      webhookTypeRegistry.ensureLoaded(),
    ]);
    // On an extension-backed datastore the catalog repair ran in that load,
    // after the baseline record: add what it catalogued.
    await recordPulledTypes();

    // Probe deployment stack and resolve durability mode.
    const datastoreClass: DatastoreClassification =
      isCustomDatastoreConfig(datastoreConfig)
        ? {
          kind: "remote",
          type: datastoreConfig.type,
          hasControlPlane: !!syncService?.capabilities?.().controlPlane,
        }
        : { kind: "filesystem" };

    let vaultClass: VaultClassification = { kind: "none" };
    try {
      const vaultRepo = new YamlVaultConfigRepository(resolvedRepoDir);
      const vaults = await vaultRepo.findAll();
      if (vaults.length > 0) {
        const remoteVault = vaults.find((v) => v.type !== "local_encryption");
        vaultClass = remoteVault
          ? { kind: "remote", type: remoteVault.type }
          : { kind: "local" };
      }
    } catch (e: unknown) {
      logger.warn("Could not probe vault configuration: {error}", {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    const deploymentMode = resolveDeploymentMode(datastoreClass, vaultClass);

    if (datastoreClass.kind === "remote") {
      const cpLabel = datastoreClass.hasControlPlane
        ? "available"
        : "not available";
      logger.info(
        `Datastore: ${datastoreClass.type} (control-plane: ${cpLabel})`,
      );
    } else {
      logger.info("Datastore: filesystem");
    }
    if (vaultClass.kind === "remote") {
      logger.info(`Vault: ${vaultClass.type}`);
    }
    for (const warning of deploymentMode.warnings) {
      logger.warn(warning);
    }
    if (deploymentMode.mode === "durable") {
      logger.info("Mode: durable — runs survive instance replacement");
    } else if (deploymentMode.mode === "durable (limited)") {
      logger.info(
        "Mode: durable (limited) — runs survive but secret-dependent workflows may fail",
      );
    } else {
      logger.info("Mode: local — runs survive process restart");
    }

    const modelsDir = join(resolvedRepoDir, "models");
    const autoDefDir = repoContext.autoDefinitionsDir;
    const grantTypeDir = GRANT_MODEL_TYPE.toDirectoryPath();
    const grantSourceDir = join(modelsDir, grantTypeDir);
    const migrationResult = await migrateGrantDefinitions(
      grantSourceDir,
      join(autoDefDir, grantTypeDir),
    );
    if (migrationResult.moved > 0) {
      logger
        .info`Migrated ${migrationResult.moved} grant definition(s) from models/ to .swamp/auto-definitions/`;
      await cleanupEmptyParentDirs(
        join(grantSourceDir, "_placeholder"),
        modelsDir,
      );
    }

    const tokenTypeDir = SERVER_TOKEN_MODEL_TYPE.toDirectoryPath();
    const tokenSourceDir = join(modelsDir, tokenTypeDir);
    const tokenMigrationResult = await migrateGrantDefinitions(
      tokenSourceDir,
      join(autoDefDir, tokenTypeDir),
    );
    if (tokenMigrationResult.moved > 0) {
      logger
        .info`Migrated ${tokenMigrationResult.moved} server-token definition(s) from models/ to .swamp/auto-definitions/`;
      await cleanupEmptyParentDirs(
        join(tokenSourceDir, "_placeholder"),
        modelsDir,
      );
    }

    // The migrations move files on disk, outside any repository, so mark
    // each moved file by path and push once. A bare markDirty() would turn
    // the push into a walk of the whole cache (swamp-club#2415). Marking
    // the destination directories instead would delete, remotely, any
    // definition a partial startup pull left missing locally.
    const migratedPaths = [
      ...migrationResult.movedPaths,
      ...tokenMigrationResult.movedPaths,
    ];
    if (syncService && migratedPaths.length > 0) {
      const namespace = isCustomDatastoreConfig(datastoreConfig)
        ? datastoreConfig.namespace
        : undefined;
      for (const path of migratedPaths) {
        await repoContext.markDirty?.(path);
      }
      await syncService.pushChanged({ namespace });
    }

    const caps = syncService?.capabilities?.();
    const hasRemoteControlPlane = !!(caps?.controlPlane &&
      syncService?.controlPlaneStore);

    if (!hasRemoteControlPlane) {
      if (heartbeatIntervalMs !== undefined) {
        logger.warn(
          "--heartbeat-interval has no effect without a control-plane-capable datastore",
        );
      }
      if (staleTtlMs !== undefined) {
        logger.warn(
          "--stale-ttl has no effect without a control-plane-capable datastore",
        );
      }
      if (reconciliationIntervalMs !== undefined) {
        logger.warn(
          "--reconciliation-interval has no effect without a control-plane-capable datastore",
        );
      }
    }

    // The access and runtime pollers start whenever a sync service exists,
    // and the config poller whenever managedConfig is active, so this is a
    // different gate from the control-plane flags above.
    if (
      !syncService && !repoMarker?.datastore?.managedConfig &&
      datastorePollIntervalMs !== undefined
    ) {
      logger.warn(
        "--datastore-poll-interval has no effect without a remote datastore or managedConfig",
      );
    }

    if (hasRemoteControlPlane) {
      const effectiveStaleTtl = staleTtlMs ?? DEFAULT_STALE_TTL_MS;
      const effectiveHeartbeat = heartbeatIntervalMs ??
        DEFAULT_HEARTBEAT_INTERVAL_MS;
      if (effectiveStaleTtl < effectiveHeartbeat * 2) {
        const staleTtlLabel = staleTtlRaw ?? `${DEFAULT_STALE_TTL_MS}ms`;
        const heartbeatLabel = heartbeatIntervalRaw ??
          `${DEFAULT_HEARTBEAT_INTERVAL_MS}ms`;
        throw new UserError(
          `--stale-ttl (${staleTtlLabel}) must be at least 2x --heartbeat-interval (${heartbeatLabel}), ` +
            "otherwise live instances will appear stale",
        );
      }
    }

    if (hasRemoteControlPlane) {
      logger.info(
        "HA: detached runs, pending-run durability, instance heartbeat, continuous reconciliation",
      );
    } else {
      logger.info(
        "HA: detached runs, pending-run durability (no remote control-plane — heartbeat and reconciliation disabled)",
      );
    }

    // Bind namespace and migrate control-plane records before creating the
    // store that all downstream consumers share. The S3/GCS extensions
    // capture controlPrefixPath at controlPlaneStore() construction time
    // for list(), so the store must be created after namespace binding.
    const serveNamespace = isCustomDatastoreConfig(datastoreConfig)
      ? datastoreConfig.namespace
      : undefined;
    const MIGRATION_SENTINEL = "migration/root-import-complete";
    if (hasRemoteControlPlane && syncService) {
      // Migration: if a namespace is configured, read root control-plane
      // records before the main sync service is namespace-bound. The
      // extension's controlPlaneStore() methods call ensureBound(), which
      // irrevocably binds the sync service's namespace on first use. Using
      // the main sync service here would bind it to undefined (root),
      // causing all subsequent namespace-aware pullChanged/pushChanged
      // calls to fail with a namespace mismatch. A separate short-lived
      // sync service isolates the root reads from the main service.
      const rootRecords = new Map<string, Uint8Array>();
      const rootReadErrors: Array<{ prefix: string; error: Error }> = [];
      if (serveNamespace && isCustomDatastoreConfig(datastoreConfig)) {
        const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
        const rootProvider = typeInfo?.createProvider
          ? typeInfo.createProvider(datastoreConfig.config)
          : undefined;
        const rootSyncService = rootProvider && datastoreConfig.cachePath
          ? rootProvider.createSyncService?.(
            resolvedRepoDir,
            datastoreConfig.cachePath,
          )
          : undefined;
        if (rootSyncService?.controlPlaneStore) {
          const rootStore = rootSyncService.controlPlaneStore();
          for (
            const prefix of [
              "token-secrets/",
              "pending-runs/",
              "heartbeats/",
              "active-runs/",
              "fire-records/",
              "claims/",
            ]
          ) {
            try {
              const keys = await rootStore.list(prefix);
              for (const key of keys) {
                const data = await rootStore.get(key);
                if (data) rootRecords.set(key, new Uint8Array(data));
              }
            } catch (err) {
              rootReadErrors.push({
                prefix,
                error: err instanceof Error ? err : new Error(String(err)),
              });
            }
          }
        }
      }

      await hydrateLocalCache({
        syncService,
        catalogInvalidate: () => repoContext.catalogStore.invalidate(),
        signal: AbortSignal.timeout(hydrationTimeoutMs),
        namespace: serveNamespace,
      });

      if (serveNamespace && rootReadErrors.length > 0) {
        const namespacedStore = syncService.controlPlaneStore!();
        const sentinel = await namespacedStore.get(MIGRATION_SENTINEL);
        if (sentinel) {
          for (const { prefix, error } of rootReadErrors) {
            logger.debug(
              "Root read failed for {prefix} (migration already complete): {error}",
              { prefix, error: error.message },
            );
          }
        } else {
          throw new Error(
            `Cannot complete namespace migration: root control-plane read failed for ` +
              `${rootReadErrors.map((e) => e.prefix).join(", ")}: ` +
              rootReadErrors[0].error.message,
          );
        }
      }

      if (
        serveNamespace && rootRecords.size > 0 && rootReadErrors.length === 0
      ) {
        const namespacedStore = syncService.controlPlaneStore!();
        const sentinel = await namespacedStore.get(MIGRATION_SENTINEL);
        if (!sentinel) {
          let migrated = 0;
          for (const [key, data] of rootRecords) {
            const existing = await namespacedStore.get(key);
            if (!existing) {
              await namespacedStore.put(key, data);
              migrated++;
            }
          }
          await namespacedStore.put(
            MIGRATION_SENTINEL,
            new TextEncoder().encode(new Date().toISOString()),
          );
          if (migrated > 0) {
            logger.info(
              "Migrated {count} control-plane record(s) from root to namespace {namespace}",
              { count: migrated, namespace: serveNamespace },
            );
          }
        }
      }

      // The namespace move copies root token-secrets but never deletes them.
      // With an external key configured, a co-located key left at the root
      // still decrypts every token secret minted before the move.
      if (
        serveNamespace &&
        configFile?.["token-secrets"] !== undefined &&
        hasCoLocatedTokenKey(rootRecords)
      ) {
        logger.error(
          "The datastore root still holds a co-located token encryption key and token secrets under _control/token-secrets/, copied into namespace {namespace} but never removed. Anyone with read access to the datastore can decrypt every token secret that existed before the namespace move. Delete _control/token-secrets/ at the datastore root once no swamp serve without a namespace uses it, then rotate those tokens.",
          { namespace: serveNamespace },
        );
      }
    }

    // Watches the managedConfig tier: pulls config/ when a sync service
    // exists, and reloads extensions when the tier lockfile's hash changes —
    // a peer's pull, update, rm or pin, or a CLI write on this host.
    if (repoMarker?.datastore?.managedConfig) {
      const extensionDiscoverer = createExtensionDiscoverer({
        lockfilePath: extensionLockfilePath,
        repoDir: resolvedRepoDir,
      });
      configPoller = new ConfigPoller({
        syncService,
        syncGate,
        pollIntervalMs: datastorePollIntervalMs,
        catalogInvalidate: () => repoContext.catalogStore.invalidate(),
        lockfileHash: () =>
          computeFileContentHashIfExists(extensionLockfilePath),
        baselineLockfileHash: bootLockfileHash,
        extensionReloader: async () => {
          const result = await performServeReload(
            resolvedRepoDir,
            extensionLockfilePath,
            {
              extensionDiscoverer,
              workflowReloader: reloadExtensionWorkflows,
            },
          );
          if (result.success && result.reloadedCount > 0) {
            logger.info(
              "Config poller: reloaded {count} extension type(s)",
              { count: result.reloadedCount },
            );
          }
          const status = serveReloadStatus(result);
          // A successful reload's errors are soft (one discoverer failed)
          // and logged here. A failed reload's go to the poller, which
          // warns only on its first and last attempt.
          if (status === "ok") {
            for (const err of result.errors) {
              logger.warn`Config poller extension reload: ${err}`;
            }
          }
          return {
            status,
            errors: status === "failed" ? result.errors : [],
          };
        },
        namespace: serveNamespace,
      });
      configPoller.start();
    }

    // Create the control-plane store AFTER namespace binding (which happens
    // in hydrateLocalCache's pullChanged call). The extension's ensureBound()
    // evaluates controlPrefixPath() lazily — after binding, it resolves to
    // {namespace}/_control/ instead of the root _control/.
    let controlPlaneStore: ControlPlaneStore;
    if (hasRemoteControlPlane && syncService?.controlPlaneStore) {
      controlPlaneStore = syncService.controlPlaneStore();
      logger.info("Control-plane store: remote datastore");
    } else {
      controlPlaneStore = new FileSystemControlPlaneStore(
        swampPath(resolvedRepoDir),
      );
      logger.info("Control-plane store: local filesystem fallback");
    }

    // Initialize the encrypted control-plane vault provider for serve-internal
    // secrets (OAuth credentials, per-login token secrets). This replaces
    // secrets in the user's vault (which is a poor fit for external backends
    // like AWS SM) with an encrypted control-plane store that supports
    // immediate deletion and has no per-secret cost.
    // With a serve.yaml `token-secrets` block the key comes from that vault
    // and never from the datastore; serve refuses to start if it can't be read.
    const { initializeControlPlaneVault } = await import(
      "../../domain/vaults/control_plane_vault_init.ts"
    );
    const { provider: tokenSecretsProvider } =
      await initializeControlPlaneVault(
        controlPlaneStore,
        hasRemoteControlPlane,
        {
          tokenSecretsKey: parseTokenSecretsKeyConfig(
            configFile,
            serveConfigPath ?? SERVE_CONFIG_PATH,
          ),
          vaultService: () =>
            VaultService.fromRepository(resolvedRepoDir, {
              defaultVaultName: repoMarker?.defaultVault,
            }),
        },
      );

    const healthResult = await checkTokenHealth({
      tokenSecretsProvider,
      hasRemoteControlPlane,
    });

    await sweepTokenConsistency({
      repoContext,
      tokenSecretsProvider,
      knownUndecryptable: new Set(healthResult.undecryptable),
      probeVaultSecret: async (vaultName, secretKey) => {
        try {
          const vs = await VaultService.fromRepository(resolvedRepoDir, {
            defaultVaultName: repoMarker?.defaultVault,
          });
          await vs.get(vaultName, secretKey, "serve:token-consistency-probe");
          return true;
        } catch {
          return false;
        }
      },
    });

    // Only OAuth mode uses the collective key, so a misconfigured key source
    // must not stop serve from starting in none or token mode.
    const clubApiKey = authConfig.mode === "oauth"
      ? resolveApiKey() ?? null
      : null;
    const oauthClientName = merged.oauthClientName ??
      `swamp-serve-${basename(resolvedRepoDir)}-${Deno.hostname()}`.slice(
        0,
        128,
      );

    let oauthClientSecret = "";
    const resolvedUserNames: Record<string, string> = {};
    if (authConfig.mode === "oauth") {
      const oauthVaultService = await VaultService.fromRepository(
        resolvedRepoDir,
        { defaultVaultName: repoMarker?.defaultVault },
      );
      const userVaultName = oauthVaultService.getDefaultVaultName() ??
        oauthVaultService.getVaultNames().find((n) =>
          n !== TOKEN_SECRETS_VAULT_NAME
        );
      let credentials;
      try {
        credentials = await resolveOAuthClientCredentials(
          {
            getVaultSecret: async (_v, k) => {
              try {
                return await oauthVaultService.get(
                  TOKEN_SECRETS_VAULT_NAME,
                  k,
                  "serve:oauth-resolve",
                );
              } catch {
                if (userVaultName) {
                  try {
                    return await oauthVaultService.get(
                      userVaultName,
                      k,
                      "serve:oauth-resolve",
                    );
                  } catch {
                    return null;
                  }
                }
                return null;
              }
            },
            putVaultSecret: (_v, k, val) =>
              oauthVaultService.put(TOKEN_SECRETS_VAULT_NAME, k, val),
            registerClient: async (providerUrl, signal) => {
              if (clubApiKey) {
                const { registerClientWithApiKey } = await import(
                  "../../serve/oauth_registration.ts"
                );
                const result = await registerClientWithApiKey(
                  providerUrl,
                  clubApiKey,
                  oauthClientName,
                  signal,
                );
                return {
                  clientId: result.clientId,
                  clientSecret: result.clientSecret,
                  accessToken: null,
                };
              }

              const { startDeviceGrant, pollForToken } = await import(
                "../../serve/oauth_client.ts"
              );
              const { BOOTSTRAP_CLIENT_ID } = await import(
                "../../serve/oauth_registration.ts"
              );
              const { DeviceGrantPollError } = await import(
                "../../serve/oauth_client.ts"
              );

              const grant = await startDeviceGrant(
                providerUrl,
                BOOTSTRAP_CLIENT_ID,
                signal,
              );

              const verifyUrl = grant.verificationUriComplete ||
                grant.verificationUri;
              logger.info(
                "First-time OAuth setup — visit {uri} and verify code: {code}",
                { uri: verifyUrl, code: grant.userCode },
              );

              let currentIntervalMs = (grant.interval || 5) * 1000;
              const deadline = Date.now() + grant.expiresIn * 1000;
              let tokenResponse;
              while (Date.now() < deadline) {
                try {
                  tokenResponse = await pollForToken(
                    providerUrl,
                    BOOTSTRAP_CLIENT_ID,
                    "",
                    grant.deviceCode,
                    signal,
                  );
                  break;
                } catch (err) {
                  if (err instanceof DeviceGrantPollError) {
                    if (err.code === "slow_down") {
                      currentIntervalMs += 5000;
                    }
                    if (
                      err.code === "authorization_pending" ||
                      err.code === "slow_down"
                    ) {
                      await new Promise((resolve) =>
                        setTimeout(resolve, currentIntervalMs)
                      );
                      continue;
                    }
                    throw new UserError(
                      `OAuth bootstrap failed: ${err.message}`,
                    );
                  }
                  throw err;
                }
              }
              if (!tokenResponse) {
                throw new UserError(
                  "OAuth bootstrap failed: device grant timed out",
                );
              }

              const resp = await fetch(
                `${providerUrl}/api/auth/oauth2/register`,
                {
                  method: "POST",
                  headers: {
                    "content-type": "application/json",
                    "authorization": `Bearer ${tokenResponse.accessToken}`,
                  },
                  body: JSON.stringify({
                    client_name: oauthClientName,
                    redirect_uris: ["http://localhost"],
                    grant_types: ["authorization_code"],
                    scope: "openid profile email collectives",
                  }),
                  signal,
                },
              );
              if (!resp.ok) {
                const body = await resp.text().catch(() => "");
                throw new Error(
                  `OAuth client registration failed: ${resp.status} ${resp.statusText}${
                    body ? ` — ${body}` : ""
                  }`,
                );
              }
              const data = await resp.json();
              return {
                clientId: data.client_id as string,
                clientSecret: data.client_secret as string,
                accessToken: tokenResponse.accessToken,
              };
            },
          },
          authConfig.oauthProvider,
          TOKEN_SECRETS_VAULT_NAME,
          authConfig.oauthClientId,
          AbortSignal.timeout(300_000),
        );
      } catch (err) {
        if (err instanceof UserError) throw err;
        throw new UserError(
          `OAuth bootstrap: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      authConfig.oauthClientId = credentials.clientId;
      oauthClientSecret = credentials.clientSecret;
      logger.info(
        "OAuth client credentials resolved (clientId: {clientId})",
        { clientId: credentials.clientId },
      );

      const {
        assertAccessListsUsable,
        chooseResolutionMode,
        listUncachedNames,
        resolveAccessLists,
      } = await import("../../serve/oauth_access_list_resolution.ts");
      const cachedMap = credentials.resolvedAdmins ?? {};
      const resolutionMode = chooseResolutionMode(
        authConfig.admins,
        authConfig.allowedUsers,
        cachedMap,
      );

      let accessToken = credentials.accessToken;

      if (resolutionMode === "full" && !accessToken) {
        const missingNames = listUncachedNames(
          authConfig.admins,
          authConfig.allowedUsers,
          cachedMap,
        ).join(", ");

        if (clubApiKey) {
          logger.info(
            "Using {source} to resolve admin/allowed-user usernames: {admins}",
            { source: apiKeySourceName(), admins: missingNames },
          );
          accessToken = clubApiKey;
        } else {
          logger.info(
            "OAuth user config changed — device grant required to resolve: {admins}",
            { admins: missingNames },
          );

          const { startDeviceGrant, pollForToken, DeviceGrantPollError } =
            await import(
              "../../serve/oauth_client.ts"
            );
          const { BOOTSTRAP_CLIENT_ID } = await import(
            "../../serve/oauth_registration.ts"
          );
          const grantSignal = AbortSignal.timeout(300_000);
          const grant = await startDeviceGrant(
            authConfig.oauthProvider,
            BOOTSTRAP_CLIENT_ID,
            grantSignal,
          );

          const verifyUrl = grant.verificationUriComplete ||
            grant.verificationUri;
          logger.info(
            "Visit {uri} and verify code: {code}",
            { uri: verifyUrl, code: grant.userCode },
          );

          let currentIntervalMs = (grant.interval || 5) * 1000;
          const deadline = Date.now() + grant.expiresIn * 1000;
          let tokenResponse;
          while (Date.now() < deadline) {
            try {
              tokenResponse = await pollForToken(
                authConfig.oauthProvider,
                BOOTSTRAP_CLIENT_ID,
                "",
                grant.deviceCode,
                grantSignal,
              );
              break;
            } catch (err) {
              if (err instanceof DeviceGrantPollError) {
                if (err.code === "slow_down") {
                  currentIntervalMs += 5000;
                }
                if (
                  err.code === "authorization_pending" ||
                  err.code === "slow_down"
                ) {
                  await new Promise((resolve) =>
                    setTimeout(resolve, currentIntervalMs)
                  );
                  continue;
                }
                throw new UserError(
                  `OAuth re-registration failed: ${err.message}`,
                );
              }
              throw err;
            }
          }
          if (!tokenResponse) {
            throw new UserError(
              "OAuth re-registration failed: device grant timed out",
            );
          }
          accessToken = tokenResponse.accessToken;
        }
      }

      const { resolveUsername } = await import(
        "../../serve/oauth_client.ts"
      );
      const { storeResolvedAdmins } = await import(
        "../../serve/oauth_registration.ts"
      );
      const resolution = await resolveAccessLists({
        admins: authConfig.admins,
        allowedUsers: authConfig.allowedUsers,
        cache: cachedMap,
        mode: resolutionMode,
        resolve: resolutionMode === "cached"
          ? null
          : (username) =>
            resolveUsername(
              authConfig.oauthProvider,
              username,
              accessToken!,
              AbortSignal.timeout(10_000),
            ),
        providerUrl: authConfig.oauthProvider,
        now: () => new Date().toISOString(),
      });

      for (const resolvedEntry of resolution.resolved) {
        const { kind, entry, username, sub, fromCache, notFoundNow } =
          resolvedEntry;
        if (notFoundNow !== undefined) {
          const list = kind === "admin"
            ? "--admins / auth.admins"
            : "--allowed-users / auth.allowed-users";
          logger
            .warn`Keeping ${entry} from ${list} as ${sub}: the provider now reports it not found (${notFoundNow}), but it resolved before. If the account was deleted or renamed, remove the name.`;
        }
        if (kind === "admin") {
          logger.info(
            fromCache
              ? "Using cached admin resolution: {username} → user:{sub}"
              : "Resolved admin {username} to user:{sub}",
            { username, sub },
          );
        } else {
          logger.info(
            fromCache
              ? "Using cached allowed-user resolution: {username} → {sub}"
              : "Resolved allowed-user {username} to {sub}",
            { username, sub },
          );
        }
      }
      for (const u of resolution.unresolved) {
        // A fresh 404 carries a reason; a recorded one does not.
        if (u.kind === "admin") {
          if (u.reason !== undefined) {
            logger
              .error`Skipping admin ${u.entry}: ${u.reason}. Fix the name in --admins / auth.admins, or remove it.`;
          } else {
            logger
              .error`Skipping admin ${u.entry}: not found on ${authConfig.oauthProvider} since ${u.notFoundSince}. It stays skipped until removed from --admins / auth.admins. If the account exists now (swamp serve check-config), remove the name, restart, then add it back.`;
          }
        } else if (u.reason !== undefined) {
          logger
            .error`Skipping allowed-user ${u.entry}: ${u.reason}. Fix the name in --allowed-users / auth.allowed-users, or remove it.`;
        } else {
          logger
            .error`Skipping allowed-user ${u.entry}: not found on ${authConfig.oauthProvider} since ${u.notFoundSince}. It stays skipped until removed from --allowed-users / auth.allowed-users. If the account exists now (swamp serve check-config), remove the name, restart, then add it back.`;
        }
      }

      // Refuse to start before persisting or applying anything, so a
      // refused start can never leave behind an unusable cache.
      assertAccessListsUsable(
        {
          admins: authConfig.admins,
          allowedUsers: authConfig.allowedUsers,
          allowedCollectives: authConfig.allowedCollectives,
        },
        resolution,
        authConfig.oauthProvider,
      );

      // Written in either mode: dropping a removed name's record is what
      // lets it be looked up fresh if it is added back.
      if (resolution.cacheChanged) {
        await storeResolvedAdmins(
          {
            putVaultSecret: (_v, k, val) =>
              oauthVaultService.put(TOKEN_SECRETS_VAULT_NAME, k, val),
          },
          TOKEN_SECRETS_VAULT_NAME,
          resolution.cache,
        );
      }

      authConfig.admins.splice(
        0,
        authConfig.admins.length,
        ...resolution.admins,
      );
      authConfig.allowedUsers.splice(
        0,
        authConfig.allowedUsers.length,
        ...resolution.allowedUsers,
      );
      Object.assign(resolvedUserNames, resolution.usernamesBySub);
    }

    const autoDefRepo = new YamlDefinitionRepository(
      resolvedRepoDir,
      undefined,
      autoDefDir,
      false,
      repoContext.markDirty,
    );
    // Both stores record what they write, so startup and the grants
    // auto-reload can push their grant writes as access.reload does.
    const grantWrites = createGrantWriteTracking(
      repoContext.definitionRepo,
      autoDefRepo,
      repoContext.unifiedDataRepo,
    );
    const commitGrantWrites = createGrantWriteCommit(syncGate, grantWrites, {
      syncService,
      markDirty: repoContext.markDirty,
      namespace: serveNamespace,
    });

    const grantsDir = join(resolvedRepoDir, "grants");
    const grantFileResults = await readGrantFiles(
      grantsDir,
      validateGrantCondition,
    );
    const grantFileErrors = collectErrors(grantFileResults);

    if (grantFileErrors.length > 0) {
      const errorMessages = grantFileErrors.map((e) => {
        const loc = e.entryIndex !== undefined
          ? `${e.filename} entry ${e.entryIndex + 1}`
          : e.filename;
        return `  ${loc}: ${e.message}`;
      });
      throw new UserError(
        `Grant file validation failed — refusing to start:\n${
          errorMessages.join("\n")
        }`,
      );
    }

    const validEntries = new Map<
      string,
      import("../../domain/access/grant_file.ts").GrantFileEntry[]
    >();
    for (const [filename, result] of grantFileResults) {
      validEntries.set(filename, result.entries);
    }

    const externalGrantsFilePath = resolveExternalGrantsFile(
      resolvedRepoDir,
      merged.grantsFile,
    );
    if (externalGrantsFilePath) {
      let content: string;
      try {
        content = await Deno.readTextFile(externalGrantsFilePath);
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) {
          throw markErrorPaths(
            new UserError(
              `External grants file not found: ${externalGrantsFilePath}`,
            ),
            [externalGrantsFilePath],
          );
        }
        throw markErrorPaths(
          new UserError(
            `Failed to read external grants file ${externalGrantsFilePath}: ${cause}`,
          ),
          [externalGrantsFilePath, ...errorPaths(cause)],
        );
      }

      if (content.trim().length > 0) {
        const externalResult = parseGrantFile(
          externalGrantsFilePath,
          content,
          validateGrantCondition,
        );
        if (externalResult.errors.length > 0) {
          const errorMessages = externalResult.errors.map((e) => {
            const loc = e.entryIndex !== undefined
              ? `${e.filename} entry ${e.entryIndex + 1}`
              : e.filename;
            return `  ${loc}: ${e.message}`;
          });
          throw new UserError(
            `External grants file validation failed — refusing to start:\n${
              errorMessages.join("\n")
            }`,
          );
        }
        validEntries.set(GRANTS_FILE_SOURCE_NAME, externalResult.entries);
        logger
          .info`Loaded ${externalResult.entries.length} grant(s) from external file ${externalGrantsFilePath}`;
      } else {
        logger
          .info`External grants file ${externalGrantsFilePath} is empty — no external grants added`;
      }
    }

    const externalGrantsDirPath = await resolveExternalGrantsDir(
      resolvedRepoDir,
      merged.grantsDir,
    );
    if (merged.grantsDir && !externalGrantsDirPath) {
      logger
        .info`Grants directory ${merged.grantsDir} is the repository grants directory — its files are read once, from there`;
    }
    if (externalGrantsDirPath) {
      let dirEntries: Deno.DirEntry[];
      try {
        dirEntries = [];
        for await (const entry of Deno.readDir(externalGrantsDirPath)) {
          dirEntries.push(entry);
        }
      } catch (cause) {
        if (cause instanceof Deno.errors.NotFound) {
          throw markErrorPaths(
            new UserError(
              `External grants directory not found: ${externalGrantsDirPath}`,
            ),
            [externalGrantsDirPath],
          );
        }
        throw markErrorPaths(
          new UserError(
            `Failed to read external grants directory ${externalGrantsDirPath}: ${cause}`,
          ),
          [externalGrantsDirPath, ...errorPaths(cause)],
        );
      }

      const yamlFiles = dirEntries
        .filter((e) =>
          (e.isFile || e.isSymlink) &&
          (e.name.endsWith(".yaml") || e.name.endsWith(".yml")) &&
          !e.name.startsWith(".")
        )
        .sort((a, b) => a.name.localeCompare(b.name));

      let totalLoaded = 0;
      for (const file of yamlFiles) {
        const filePath = join(externalGrantsDirPath, file.name);
        let content: string;
        try {
          content = await Deno.readTextFile(filePath);
        } catch (cause) {
          throw markErrorPaths(
            new UserError(
              `Failed to read grants file ${filePath}: ${cause}`,
            ),
            [filePath, ...errorPaths(cause)],
          );
        }

        if (content.trim().length === 0) continue;

        const result = parseGrantFile(
          filePath,
          content,
          validateGrantCondition,
        );
        if (result.errors.length > 0) {
          const errorMessages = result.errors.map((e) => {
            const loc = e.entryIndex !== undefined
              ? `${e.filename} entry ${e.entryIndex + 1}`
              : e.filename;
            return `  ${loc}: ${e.message}`;
          });
          throw new UserError(
            `Grants directory file validation failed — refusing to start:\n${
              errorMessages.join("\n")
            }`,
          );
        }
        validEntries.set(grantsDirSourceName(file.name), result.entries);
        totalLoaded += result.entries.length;
      }

      if (totalLoaded > 0) {
        logger
          .info`Loaded ${totalLoaded} grant(s) from ${yamlFiles.length} file(s) in external grants directory ${externalGrantsDirPath}`;
      } else {
        logger
          .info`External grants directory ${externalGrantsDirPath} contains no grants`;
      }
    }

    // One unit under the exclusive sync gate: ConfigPoller is already
    // pulling, and a pull landing between these writes and their push can
    // undo them (swamp-club#2247, swamp-club#2405). Unlike the definition
    // migration push above, a failed push here only warns: the local policy
    // is already right, and reconcile collapses any duplicate grants a peer
    // creates because it could not see these (swamp-club#2822).
    const { materializeResult, fileReconcileResult } = await commitGrantWrites(
      async () => ({
        materializeResult: await materializeAdmins(
          authConfig.mode,
          authConfig.admins,
          grantWrites.adminGrantStore,
        ),
        fileReconcileResult: await reconcileAllFileGrants(
          validEntries,
          grantWrites.fileGrantStore,
        ),
      }),
    );

    if (
      materializeResult.created > 0 || materializeResult.updated > 0 ||
      materializeResult.revoked > 0 || materializeResult.reactivated > 0
    ) {
      logger
        .info`Admin grants materialized: ${materializeResult.created} created, ${materializeResult.updated} updated, ${materializeResult.revoked} revoked, ${materializeResult.reactivated} reactivated, ${materializeResult.unchanged} unchanged`;
    }

    if (
      fileReconcileResult.totalCreated > 0 ||
      fileReconcileResult.totalUpdated > 0 ||
      fileReconcileResult.totalRevoked > 0 ||
      fileReconcileResult.totalReactivated > 0
    ) {
      logger
        .info`File grants reconciled (${fileReconcileResult.filesProcessed} file(s)): ${fileReconcileResult.totalCreated} created, ${fileReconcileResult.totalUpdated} updated, ${fileReconcileResult.totalRevoked} revoked, ${fileReconcileResult.totalReactivated} reactivated, ${fileReconcileResult.totalUnchanged} unchanged`;
    }

    const policySnapshotLoader = new PolicySnapshotLoader(
      repoContext.unifiedDataRepo,
      repoContext.eventBus,
      grantReloadMode as PolicyReloadMode,
      { runImpliesApprove: !authConfig.approveRequiresExplicitGrant },
    );
    await policySnapshotLoader.load();
    logger.info("Policy snapshot loaded (reload mode: {mode})", {
      mode: grantReloadMode,
    });
    logger.info(
      authConfig.approveRequiresExplicitGrant
        ? "Approval policy: deciding an approval gate requires a grant that names approve"
        : "Approval policy: a run grant also permits deciding approval gates",
    );

    let grantsDirectoryPoller: GrantsDirectoryPoller | null = null;
    if (grantReloadMode === "auto") {
      grantsDirectoryPoller = new GrantsDirectoryPoller({
        grantsDir,
        externalGrantsFile: externalGrantsFilePath,
        externalGrantsDir: externalGrantsDirPath,
        validateCondition: validateGrantCondition,
        fileGrantStore: grantWrites.fileGrantStore,
        policySnapshotLoader,
        commitReconcile: commitGrantWrites,
      });
      await grantsDirectoryPoller.start();
    }

    if (syncService) {
      accessDataPoller = new AccessDataPoller({
        syncService,
        syncGate,
        pollIntervalMs: datastorePollIntervalMs,
        policySnapshotLoader,
        catalogInvalidate: () => repoContext.catalogStore.invalidate(),
        namespace: serveNamespace,
      });
      accessDataPoller.start();

      runtimeDataPoller = new RuntimeDataPoller({
        syncService,
        syncGate,
        pollIntervalMs: datastorePollIntervalMs,
        catalogInvalidate: () => repoContext.catalogStore.invalidate(),
        namespace: serveNamespace,
      });
      runtimeDataPoller.start();
    }

    const cancelRegistry = new RunCancelRegistry();
    const detachRuns = merged.detachRuns;
    const activeRunRegistry = new ActiveRunRegistry({
      maxConcurrent: maxConcurrentRuns,
      maxPerPrincipal: maxRunsPerPrincipal,
      maxRunDurationMs,
    });

    if (detachRuns) {
      logger.warn(
        "The --detach-runs flag is deprecated and has no effect — HA mode is determined automatically by your datastore configuration; see startup mode log for details",
      );
    }

    const instanceId = crypto.randomUUID();
    if (
      authConfig.mode === "oauth" &&
      authConfig.oauthClientId &&
      authConfig.allowedCollectives.length > 0 &&
      clubApiKey
    ) {
      try {
        await registerInstance(
          authConfig.oauthProvider,
          clubApiKey,
          {
            oauthClientId: authConfig.oauthClientId,
            instanceId,
            collectiveSlugs: [...authConfig.allowedCollectives],
            hostname: Deno.hostname(),
            version: VERSION,
            deploymentMode: deploymentMode.mode,
          },
          AbortSignal.timeout(30_000),
        );
        logger.info(
          "Registered serve instance with swamp-club (clientId: {clientId})",
          { clientId: authConfig.oauthClientId },
        );
      } catch (err) {
        logger.warn(
          "Failed to register serve instance with swamp-club: {error}",
          { error: err instanceof Error ? err.message : String(err) },
        );
      }
    }

    // Migrate existing vault-backed token secrets to the encrypted
    // control-plane store. Runs before auth middleware accepts tokens.
    if (authConfig.mode === "oauth") {
      const { createTokenMigrationLockDeps, migrateTokenSecrets } =
        await import("../../serve/token_secret_migration.ts");
      const { createResourceWriter } = await import(
        "../../domain/models/data_writer.ts"
      );
      const migrationVaultService = await VaultService.fromRepository(
        resolvedRepoDir,
        { defaultVaultName: repoMarker?.defaultVault },
      );
      await migrateTokenSecrets({
        tokenSecretsVaultName: TOKEN_SECRETS_VAULT_NAME,
        vaultService: migrationVaultService,
        dataQueryService: repoContext.dataQueryService,
        updateTokenVaultName: async (tokenName, newVaultName, currentAttrs) => {
          const def = await repoContext.definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!def) {
            throw new Error(
              `Definition not found for token '${tokenName}' — skipping migration`,
            );
          }
          const updated = {
            ...currentAttrs,
            vaultName: newVaultName,
          };
          const { writeResource } = createResourceWriter(
            repoContext.unifiedDataRepo,
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            serverTokenModel.resources!,
            undefined,
            undefined,
            undefined,
            undefined,
            tokenName,
          );
          await writeResource(
            "token",
            "token-main",
            updated as Record<string, unknown>,
          );
        },
        // The pollers are already running, so each token's pull, write and
        // push runs under the sync gate as well as its name lock.
        ...createTokenMigrationLockDeps({
          datastoreConfig,
          repoContext,
          syncService,
          syncGate,
        }),
      });

      const { migrateOAuthSecrets } = await import(
        "../../serve/oauth_secret_migration.ts"
      );
      await migrateOAuthSecrets(
        migrationVaultService,
        TOKEN_SECRETS_VAULT_NAME,
      );
    }

    let heartbeatService: InstanceHeartbeatService | undefined;
    let workerGcService: WorkerGcService | undefined;
    let serverTokenGcService: ServerTokenGcService | undefined;

    logger.info("Boot: reaping stale runs via tracker");
    // Reap stale runs via the SQLite tracker (heartbeat + PID liveness).
    // This handles both model-method and workflow runs registered with the tracker.
    const runTracker = RunTrackerStore.fromSwampDir(
      swampPath(resolvedRepoDir),
    );
    const scrubbedHeaders = runTracker.scrubPendingRunHeaders(
      isSensitiveHeader,
    );
    if (scrubbedHeaders > 0) {
      logger.info(
        "Scrubbed sensitive headers from {count} existing pending run(s)",
        { count: scrubbedHeaders },
      );
    }
    const reapedRuns = runTracker.reapStaleRuns(
      DEFAULT_STALE_TTL_MS,
      instanceId,
    );
    for (const run of reapedRuns) {
      logger.warn`Reaped stale ${run.runKind} run ${run.id} (${
        run.methodName ?? run.workflowName ?? "unknown"
      })`;
    }
    const deadPidRuns = runTracker.reapDeadProcessRuns(instanceId);
    for (const run of deadPidRuns) {
      logger.warn`Reaped dead-process ${run.runKind} run ${run.id} (${
        run.methodName ?? run.workflowName ?? "unknown"
      })`;
    }

    logger.info("Boot: reconciling workflow run state");
    // Reconcile YAML-persisted workflow run state with tracker verdicts.
    // The tracker is the liveness authority; the YAML entity is the run record.
    // Legacy runs (pre-tracker) fall back to PID liveness checking.
    // Whatever their age: a run can wait at a gate for longer than any
    // window and be left running by a resume (swamp-club#2518).
    const runningRuns = await repoContext.workflowRunRepo.findGlobalByStatus(
      "running",
    );
    // The boot reap and the method-run settle below run in root units of
    // work with no push, so their saves stage into a root instead of reaching
    // the hook through signalChange's fallback (swamp-club#3056). Nothing
    // pushes, as before.
    const reapResult = await runInRootUnitOfWork(
      repoContext,
      { flush: undefined },
      () =>
        reapOrphanedWorkflowRuns(
          runningRuns,
          async (wid, r) => {
            await repoContext.workflowRunRepo.save(wid, r);
            runTracker.markSettled(r.id, "server_crash");
          },
          (runId) => {
            const tracked = runTracker.findById(runId);
            return tracked ? { status: tracked.status } : null;
          },
          isProcessDead,
          instanceId,
          hasRemoteControlPlane
            ? async (id) => {
              const data = await controlPlaneStore.get(`heartbeats/${id}`);
              return data !== null;
            }
            : undefined,
        ),
    );
    if (reapResult.reaped > 0) {
      logger.warn(
        "Boot: {reaped} workflow run(s) interrupted by crash — recover with 'swamp workflow recover <workflow>'",
        { reaped: reapResult.reaped },
      );
    }

    // Method runs a dead owner left running on this host, such as the steps
    // of a run the previous serve process was driving when it died. A row is
    // judged on host and pid, not instance id: this serve's instance id is
    // new, so the rows of the process it replaces carry another one.
    // Best-effort: a row left unsettled is kept for `run doctor --fix`.
    try {
      const settledMethodRuns = await runInRootUnitOfWork(
        repoContext,
        { flush: undefined },
        () =>
          settleDeadOwnerMethodRuns(
            repoContext.outputRepo,
            runTracker,
            localOwnerLiveness(),
          ),
      );
      if (settledMethodRuns.length > 0) {
        logger.warn(
          "Boot: cancelled {count} method run(s) whose owning process is gone",
          { count: settledMethodRuns.length },
        );
      }
    } catch (error) {
      logger.warn(
        "Boot: could not settle method runs whose owning process is gone: {error}",
        { error: error instanceof Error ? error.message : String(error) },
      );
    }

    logger.info("Boot: sweeping stale records");
    const swept = await sweepStaleRecords({
      repoContext,
    });
    if (swept.leases + swept.pendingDispatches + swept.workers > 0) {
      logger.info(
        "Boot reconciliation: swept {leases} lease(s), {pendingDispatches} pending dispatch(es), {workers} worker(s)",
        {
          leases: swept.leases,
          pendingDispatches: swept.pendingDispatches,
          workers: swept.workers,
        },
      );
    }

    const datastoreResolver = new DefaultDatastorePathResolver(
      resolvedRepoDir,
      datastoreConfig,
    );
    const connectionCtx: import("../../serve/connection.ts").ConnectionContext =
      {
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        datastoreResolver,
        syncService,
        syncGate,
        workerGateway,
        policySnapshotLoader,
        authConfig,
        cancelRegistry,
        activeRunRegistry,
        runTracker,
        dispatchService,
        controlPlaneStore,
        defaultVault: repoMarker?.defaultVault,
        instanceId,
        staleTtlMs,
        grantsFile: externalGrantsFilePath,
        grantsDir: externalGrantsDirPath,
        hotReload: merged.hotReload,
        serveConfigPath,
        ...(Object.keys(resolvedUserNames).length > 0
          ? { resolvedUserNames }
          : {}),
        serveOptions: merged,
        vaultsDir,
        managedDefinitionsDir: repoMarker?.datastore?.managedConfig
          ? join(datastoreResolver.resolvePath("config"), "models")
          : undefined,
      };

    const ac = new AbortController();

    // ── Audit Pipeline ───────────────────────────────────────────────
    const auditConfig = parseAuditConfig(configFile);
    if (auditConfig) {
      const auditStoresWithConfig: {
        store: AuditStore;
        entry: (typeof auditConfig.stores)[number];
      }[] = [];
      for (const entry of auditConfig.stores) {
        if (entry.type && entry.config) {
          await datastoreTypeRegistry.ensureLoaded();
          await datastoreTypeRegistry.ensureTypeLoaded(entry.type);
          const typeInfo = datastoreTypeRegistry.get(entry.type);
          if (!typeInfo?.createProvider) {
            throw new UserError(
              `Audit store target "${entry.target}": datastore type "${entry.type}" is not registered or has no provider`,
            );
          }
          const resolvedConfig = await resolveDatastoreExpressions(
            entry.config as Record<string, unknown>,
            { repoDir: resolvedRepoDir },
          );
          const provider = typeInfo.createProvider(resolvedConfig);
          const tmpCachePath = join(
            resolvedRepoDir,
            ".swamp",
            `audit-cache-${entry.target}`,
          );
          const syncService = provider.createSyncService?.(
            resolvedRepoDir,
            tmpCachePath,
          );
          const store = syncService?.controlPlaneStore?.();
          if (!store) {
            throw new UserError(
              `Audit store target "${entry.target}": datastore type "${entry.type}" does not support control-plane storage`,
            );
          }
          auditStoresWithConfig.push({
            store: new RemoteAuditStore(store, `audit/${entry.target}/`),
            entry,
          });
          logger.info(
            "Audit target {target}: dedicated {type} datastore",
            { target: entry.target, type: entry.type },
          );
        } else if (controlPlaneStore) {
          auditStoresWithConfig.push({
            store: new RemoteAuditStore(
              controlPlaneStore,
              `_audit/${entry.target}/`,
            ),
            entry,
          });
          logger.warn(
            "Audit target {target}: using shared control-plane store (configure type + config for a dedicated audit store)",
            { target: entry.target },
          );
        } else {
          logger.warn(
            "Audit target {target}: skipped — no control-plane store available and no dedicated store configured",
            { target: entry.target },
          );
        }
      }
      const auditStores = auditStoresWithConfig.map((s) => s.store);
      if (auditStores.length > 0) {
        const storesWithRetention = auditStoresWithConfig.map(
          ({ store, entry }) => {
            const retentionDays = (entry as { retention?: { days?: number } })
              ?.retention?.days;
            return retentionDays ? { store, retentionDays } : store;
          },
        );
        const storeSink = new StoreSink({
          stores: storesWithRetention,
          batchSize: auditConfig.batchSize,
          flushIntervalMs: auditConfig.flushIntervalMs,
          signal: ac.signal,
        });

        const walDir = resolve(resolvedRepoDir, auditConfig.walDir);
        const wal = new AuditWal({
          dir: walDir,
          maxWalBytes: auditConfig.walMaxBytes,
        });
        await wal.initialize();
        const walSink = new WalSink({
          wal,
          downstream: storeSink,
          checkpointIntervalMs: auditConfig.flushIntervalMs,
        });

        const policyRules = auditConfig.policyRules.map((r) => ({
          category: r.category as AuditCategory | undefined,
          action: r.action,
          tier: r.tier as AuditPolicyRule["tier"],
          level: r.level as AuditLevel,
        }));
        const policy = new AuditPolicy(
          policyRules,
          auditConfig.policyDefaultLevel as AuditLevel,
        );

        let highestSeq = -1;
        let highestDigest = "";
        for (const segName of wal.listSegments()) {
          const events = await wal.readSegment(segName);
          for (const event of events) {
            const e = event as unknown as Record<string, unknown>;
            if (
              typeof e.sequence === "number" && typeof e.digest === "string" &&
              e.sequence > highestSeq
            ) {
              highestSeq = e.sequence;
              highestDigest = e.digest as string;
            }
          }
        }

        const replayed = await walSink.replay();
        if (replayed > 0) {
          logger.info(
            "Queued {count} WAL event(s) from previous session for audit store delivery",
            { count: replayed },
          );
        }

        let chainState: AuditChainState | undefined;
        const savedChainState = await wal.loadChainState();
        if (savedChainState) {
          chainState = new AuditChainState(
            savedChainState.sequence,
            savedChainState.previousDigest,
          );
        }
        if (highestSeq > (chainState?.sequence ?? -1)) {
          chainState = new AuditChainState(highestSeq, highestDigest);
          logger.info(
            "Chain state advanced from WAL segments: sequence {seq}",
            { seq: highestSeq },
          );
        }
        if (!chainState) {
          const reconstructed = await reconstructChainStateFromStore(
            auditStores[0],
          );
          if (reconstructed) {
            chainState = new AuditChainState(
              reconstructed.sequence,
              reconstructed.previousDigest,
            );
            logger.info(
              "Reconstructed chain state from store: sequence {seq}",
              { seq: reconstructed.sequence },
            );
          }
        }

        const webSocketSink = new WebSocketSink();
        const auditSinks: AuditSink[] = [walSink, webSocketSink];

        let auditVaultService: VaultService | null = null;
        const needsVault = auditConfig.sinks.length > 0 ||
          auditConfig.hmacEnabled;
        if (needsVault) {
          try {
            auditVaultService = await VaultService.fromRepository(
              resolvedRepoDir,
              { defaultVaultName: repoMarker?.defaultVault },
            );
          } catch {
            logger.warn("Could not initialize vault for audit sinks/HMAC");
          }
        }

        for (const sinkEntry of auditConfig.sinks) {
          try {
            if (sinkEntry.type === "webhook") {
              const cfg = sinkEntry.config;
              let auth: {
                type: "bearer" | "basic" | "header";
                value: string;
                headerName?: string;
              } | undefined;
              const authCfg = cfg.auth as Record<string, unknown> | undefined;
              if (authCfg) {
                const authType = authCfg.type as string;
                const rawValue =
                  (authCfg.token ?? authCfg.value ?? authCfg.password ??
                    "") as string;
                const resolvedValue = await resolveSecret(
                  rawValue,
                  auditVaultService ?? undefined,
                );
                auth = {
                  type: authType as "bearer" | "basic" | "header",
                  value: resolvedValue,
                  headerName: authCfg["header-name"] as string | undefined,
                };
              }
              const batchCfg = cfg.batch as Record<string, unknown> | undefined;
              const retryCfg = cfg.retry as Record<string, unknown> | undefined;
              auditSinks.push(
                new WebhookSink({
                  url: cfg.url as string,
                  format: (cfg.format as "json" | "cef") ?? "json",
                  auth,
                  filter: parseSinkFilter(cfg),
                  batchSize: batchCfg?.size as number | undefined,
                  batchIntervalMs: batchCfg?.["interval-ms"] as
                    | number
                    | undefined,
                  maxAttempts: retryCfg?.["max-attempts"] as number | undefined,
                  backoffMs: retryCfg?.["backoff-ms"] as number | undefined,
                  maxPending: cfg["max-pending"] as number | undefined,
                  signal: ac.signal,
                  namespace: serveNamespace,
                }),
              );
              logger.info("Audit webhook sink enabled: {url}", {
                url: cfg.url,
              });
            } else if (sinkEntry.type === "syslog") {
              const cfg = sinkEntry.config;
              let caCert: string | undefined;
              const transport = (cfg.transport as string | undefined) ?? "tcp";
              if (transport === "tcp+tls" && cfg["ca-cert"]) {
                caCert = await resolveSecret(
                  cfg["ca-cert"] as string,
                  auditVaultService ?? undefined,
                );
              }
              auditSinks.push(
                new SyslogSink({
                  host: cfg.host as string,
                  port: cfg.port as number,
                  transport: transport as "tcp" | "tcp+tls" | "udp",
                  filter: parseSinkFilter(cfg),
                  caCert,
                  signal: ac.signal,
                }),
              );
              logger.info("Audit syslog sink enabled: {host}:{port}", {
                host: cfg.host,
                port: cfg.port,
              });
            }
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            if (auditConfig.failOpen) {
              logger.warn("Failed to create audit sink, skipping: {error}", {
                error: msg,
              });
            } else {
              throw error;
            }
          }
        }

        let hmacContext: HmacContext | undefined;
        let hmacKeyRegistry: HmacKeyRegistry | undefined;
        if (auditConfig.hmacEnabled && auditVaultService) {
          try {
            const vaultName = auditConfig.hmacVault;
            const keyName = auditConfig.hmacKey;
            let rawKey: string | null = null;
            try {
              rawKey = await auditVaultService.get(vaultName, keyName);
            } catch {
              // key doesn't exist yet
            }
            if (!rawKey) {
              const newKey = await generateHmacKeyBytes();
              const hex = Array.from(newKey).map((b) =>
                b.toString(16).padStart(2, "0")
              ).join("");
              await auditVaultService.put(vaultName, keyName, hex);
              rawKey = hex;
              logger.info("Generated HMAC key in vault {vault}:{key}", {
                vault: vaultName,
                key: keyName,
              });
            }
            if (!/^[0-9a-f]+$/i.test(rawKey) || rawKey.length % 2 !== 0) {
              throw new Error(
                `HMAC key in vault ${vaultName}:${keyName} is not valid hex (must be even-length hex string)`,
              );
            }
            const keyBytes = new Uint8Array(
              rawKey.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
            );
            const cryptoKey = await importHmacKey(keyBytes);
            const hmacKeyVersions: HmacKeyVersion[] = [{
              version: 1,
              key: cryptoKey,
            }];
            let versionNum = 2;
            const maxVersionScan = 1000;
            while (versionNum <= maxVersionScan) {
              let versionedHex: string;
              try {
                versionedHex = await auditVaultService.get(
                  vaultName,
                  `${keyName}-v${versionNum}`,
                );
              } catch {
                break;
              }
              if (
                !/^[0-9a-f]+$/i.test(versionedHex) ||
                versionedHex.length % 2 !== 0
              ) {
                logger.warn(
                  "HMAC key version {version} in vault has invalid hex, skipping",
                  { version: versionNum },
                );
                versionNum++;
                continue;
              }
              const versionedBytes = new Uint8Array(
                versionedHex.match(/.{2}/g)!.map((h) => parseInt(h, 16)),
              );
              const versionedKey = await importHmacKey(versionedBytes);
              hmacKeyVersions.push({
                version: versionNum,
                key: versionedKey,
              });
              versionNum++;
            }
            const currentVersion =
              hmacKeyVersions[hmacKeyVersions.length - 1].version;
            hmacContext = {
              key: hmacKeyVersions[hmacKeyVersions.length - 1].key,
              keyVersion: currentVersion,
            };
            hmacKeyRegistry = new HmacKeyRegistry(hmacKeyVersions);
            logger.info(
              "HMAC enabled for audit events with {count} key version(s) (current: v{version})",
              { count: hmacKeyVersions.length, version: currentVersion },
            );
          } catch (error: unknown) {
            logger.error(
              "Failed to initialize HMAC for audit — events will NOT be HMAC-signed: {error}",
              {
                error: error instanceof Error ? error.message : String(error),
              },
            );
          }
        }

        connectionCtx.auditEmitter = new AuditEmitter({
          sinks: auditSinks,
          policy,
          chainState,
          hmacContext,
          hmacKeyRegistry,
        });
        connectionCtx.auditStores = auditStores;
        connectionCtx.auditPolicy = policy;
        connectionCtx.auditFailOpen = auditConfig.failOpen;
        connectionCtx.auditWal = wal;
        connectionCtx.auditWebSocketSink = webSocketSink;
        connectionCtx.auditNamespace = serveNamespace;
        if (auditVaultService && auditConfig.hmacEnabled) {
          connectionCtx.auditVaultService = auditVaultService;
          connectionCtx.auditHmacConfig = {
            vaultName: auditConfig.hmacVault,
            keyName: auditConfig.hmacKey,
          };
        }

        const capturedExternalSinks = auditSinks.filter(
          (s) => s !== walSink && s !== webSocketSink,
        );
        let currentExternalSinks = capturedExternalSinks;
        connectionCtx.auditSinkRebuilder = async () => {
          const reloadedConfig = loadServeConfig(
            options.config as string | undefined,
            resolvedRepoDir,
          );
          const reloadedAudit = parseAuditConfig(reloadedConfig);
          const newExtSinks: AuditSink[] = [];
          if (reloadedAudit) {
            for (const sinkEntry of reloadedAudit.sinks) {
              if (sinkEntry.type === "webhook") {
                const cfg = sinkEntry.config;
                let auth: {
                  type: "bearer" | "basic" | "header";
                  value: string;
                  headerName?: string;
                } | undefined;
                const authCfg = cfg.auth as
                  | Record<string, unknown>
                  | undefined;
                if (authCfg) {
                  const rawValue =
                    (authCfg.token ?? authCfg.value ?? authCfg.password ??
                      "") as string;
                  const resolvedValue = await resolveSecret(
                    rawValue,
                    auditVaultService ?? undefined,
                  );
                  auth = {
                    type: authCfg.type as "bearer" | "basic" | "header",
                    value: resolvedValue,
                    headerName: authCfg["header-name"] as string | undefined,
                  };
                }
                const batchCfg = cfg.batch as
                  | Record<string, unknown>
                  | undefined;
                const retryCfg = cfg.retry as
                  | Record<string, unknown>
                  | undefined;
                newExtSinks.push(
                  new WebhookSink({
                    url: cfg.url as string,
                    format: (cfg.format as "json" | "cef") ?? "json",
                    auth,
                    filter: parseSinkFilter(cfg),
                    batchSize: batchCfg?.size as number | undefined,
                    batchIntervalMs: batchCfg?.["interval-ms"] as
                      | number
                      | undefined,
                    maxAttempts: retryCfg?.["max-attempts"] as
                      | number
                      | undefined,
                    backoffMs: retryCfg?.["backoff-ms"] as number | undefined,
                    maxPending: cfg["max-pending"] as number | undefined,
                    signal: ac.signal,
                    namespace: serveNamespace,
                  }),
                );
              } else if (sinkEntry.type === "syslog") {
                const cfg = sinkEntry.config;
                const transport = (cfg.transport as string | undefined) ??
                  "tcp";
                let caCert: string | undefined;
                if (transport === "tcp+tls" && cfg["ca-cert"]) {
                  caCert = await resolveSecret(
                    cfg["ca-cert"] as string,
                    auditVaultService ?? undefined,
                  );
                }
                newExtSinks.push(
                  new SyslogSink({
                    host: cfg.host as string,
                    port: cfg.port as number,
                    transport: transport as "tcp" | "tcp+tls" | "udp",
                    filter: parseSinkFilter(cfg),
                    caCert,
                    signal: ac.signal,
                  }),
                );
              }
            }
          }
          const hotReloader = new AuditSinkHotReloader();
          const result = await hotReloader.reload(
            currentExternalSinks,
            () => Promise.resolve(newExtSinks),
          );
          currentExternalSinks = result;
          return [walSink, webSocketSink, ...result];
        };

        if (auditConfig.alerts.length > 0) {
          const alertConfigs: AlertRuleConfig[] = auditConfig.alerts.map(
            (a) => ({
              name: a.name,
              description: a.description,
              match: {
                category: a.match.category,
                action: a.match.action,
                outcome: a.match.outcome,
                principal: a.match.principal,
              },
              threshold: {
                count: a.threshold.count,
                windowSeconds: a.threshold["window-seconds"],
              },
              action: a.action.type === "webhook"
                ? { type: "webhook" as const, url: a.action.url! }
                : { type: "log" as const },
            }),
          );
          connectionCtx.auditEmitter!.alertEngine = new AlertRuleEngine(
            alertConfigs,
          );
          logger.info("Audit alert engine enabled with {count} rule(s)", {
            count: alertConfigs.length,
          });
        }

        logger.info(
          "Audit pipeline enabled with {count} store target(s), {sinkCount} sink(s), WAL at {walDir}",
          { count: auditStores.length, sinkCount: auditSinks.length, walDir },
        );

        emitSystemAuditEvent(
          connectionCtx,
          "instance.start",
          `version=${VERSION}`,
        );
      }
    }

    let telemetryFlushService: DaemonTelemetryFlushService | null = null;
    const enableSchedule = merged.schedule;
    const webhookFlags: string[] = merged.webhook ?? [];

    logger.info("Boot: starting scheduler");
    let triggerOverrides: Map<string, TriggerOverride> | undefined;
    if (merged.triggerOverrides) {
      triggerOverrides = new Map(Object.entries(merged.triggerOverrides));
    }

    // Scheduled and webhook runs have no client behind them; they run as
    // built-in service principals and are authorized per run (#2464).
    const triggerAuthorizer = createTriggerAuthorizer({
      authMode: authConfig.mode,
      policySnapshotLoader,
      workflowRepo: repoContext.workflowRepo,
    });

    let scheduledExecution: ScheduledExecutionService | null = null;
    if (enableSchedule) {
      if (triggerOverrides && triggerOverrides.size > 0) {
        logger.info(
          "Loaded {count} trigger override(s) from serve.yaml",
          { count: triggerOverrides.size },
        );
      }
      scheduledExecution = new ScheduledExecutionService({
        workflowRepo: repoContext.workflowRepo,
        repoDir: resolvedRepoDir,
        triggerOverrides,
        initiatedBy: principalToString(SCHEDULER_PRINCIPAL),
        authorizeRun: createScheduledRunAuthorizer(
          triggerAuthorizer,
          connectionCtx,
        ),
        executeWorkflow: (input, signal, onEvent) =>
          executeWorkflowWithLocks(
            resolvedRepoDir,
            repoContext,
            datastoreConfig,
            { ...input, instanceId },
            signal,
            onEvent,
            syncService,
            runTracker,
            {
              syncGate,
              triggerSource: "schedule",
              initiatedBy: input.initiatedBy,
            },
          ),
        pendingRunHook: {
          enqueue: async (entry) => {
            runTracker.enqueuePendingRun(entry);
            if (controlPlaneStore) {
              try {
                await controlPlaneStore.put(
                  `pending-runs/${entry.id}`,
                  new TextEncoder().encode(JSON.stringify(entry)),
                );
              } catch (err: unknown) {
                logger.warn(
                  "Control-plane dual-write failed for cron pending run {id}: {error}",
                  {
                    id: entry.id,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }
            }
          },
          delete: async (id) => {
            runTracker.deletePendingRun(id);
            if (controlPlaneStore) {
              try {
                await controlPlaneStore.delete(
                  `pending-runs/${id}`,
                );
              } catch (err: unknown) {
                logger.warn(
                  "Control-plane delete failed for cron pending run {id}: {error}",
                  {
                    id,
                    error: err instanceof Error ? err.message : String(err),
                  },
                );
              }
            }
          },
        },
        activeRunHook: controlPlaneStore && instanceId
          ? {
            write: (runId: string, resourceName: string, runKind: string) => {
              writeActiveRun(controlPlaneStore, instanceId, runId, {
                resourceName,
                runKind: runKind as
                  | "workflow-run"
                  | "workflow-resume"
                  | "method-run",
                startedAt: new Date().toISOString(),
              });
            },
            delete: (runId: string) => {
              deleteActiveRun(controlPlaneStore, instanceId, runId);
            },
          }
          : undefined,
        cronFireDedup: controlPlaneStore?.putIfAbsent
          ? async (workflowId, fireTime) => {
            const key = `fire-records/${workflowId}/${
              normalizeFireTime(fireTime)
            }`;
            const data = new TextEncoder().encode(
              JSON.stringify({
                instanceId,
                claimedAt: new Date().toISOString(),
              }),
            );
            return await controlPlaneStore!.putIfAbsent!(key, data);
          }
          : undefined,
      });

      await scheduledExecution.start((event) => {
        // Audit before the output branch so --json mode audits too.
        auditScheduledEvent(connectionCtx, event);
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "schedule_registered":
              logger.info(
                "Scheduled workflow {name} ({cron})",
                { name: event.workflowName, cron: event.cronExpression },
              );
              break;
            case "schedule_unregistered":
              logger.info(
                "Unregistered scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_fired":
              logger.info(
                "Running scheduled workflow {name}",
                { name: event.workflowName },
              );
              break;
            case "schedule_skipped":
              if (event.dedupSkip) {
                logger.info(
                  "Skipped scheduled workflow {name}: {reason}",
                  { name: event.workflowName, reason: event.reason },
                );
              } else {
                logger.warn(
                  "Skipped scheduled workflow {name}: {reason}",
                  { name: event.workflowName, reason: event.reason },
                );
              }
              break;
            case "schedule_completed": {
              logger.info(
                "Scheduled workflow {name} completed (run: {runId})",
                { name: event.workflowName, runId: event.runId },
              );
              const schedRun = runTracker.findById(event.runId);
              const schedDuration = schedRun
                ? Date.now() - schedRun.startedAt.getTime()
                : 0;
              runMetricsTracker.record("completed", schedDuration);
              break;
            }
            case "schedule_suspended":
              logger.info(
                "Scheduled workflow {name} suspended awaiting approval (run: {runId})",
                { name: event.workflowName, runId: event.runId },
              );
              break;
            case "schedule_failed":
              logger.error(
                "Scheduled workflow {name} failed: {error}",
                { name: event.workflowName, error: event.error },
              );
              runMetricsTracker.record("failed", 0);
              break;
          }
        }
      });
      connectionCtx.scheduledExecution = scheduledExecution;
    }

    // Wire workflow reloader for hot-reload. Built here (cli layer) so the
    // serve handlers never import from src/cli/.
    scheduledWorkflows.rescan = async () => {
      if (connectionCtx.scheduledExecution) {
        await connectionCtx.scheduledExecution.rescanWorkflows();
      }
    };
    connectionCtx.workflowReloader = reloadExtensionWorkflows;

    // Parse group refresh interval and construct service
    let collectiveRefreshService:
      | import("../../serve/collective_refresh_service.ts").CollectiveRefreshService
      | null = null;
    const groupRefreshRaw = merged.groupRefreshInterval;

    const DEFAULT_GROUP_REFRESH_MS = 4 * 60 * 60 * 1000;
    let groupRefreshMs = DEFAULT_GROUP_REFRESH_MS;
    if (groupRefreshRaw !== undefined) {
      const normalized = groupRefreshRaw.trim().replace(/^0[smhdw].*$/i, "0");
      groupRefreshMs = normalized === "0"
        ? 0
        : parseTimerDuration(groupRefreshRaw, "--group-refresh-interval");
    }

    if (
      shouldWarnGroupRefreshIgnored(
        groupRefreshRaw,
        groupRefreshMs,
        authConfig.mode === "oauth" && Boolean(oauthClientSecret),
      )
    ) {
      logger.warn(
        "--group-refresh-interval is set but --auth-mode oauth is not configured; group refresh is disabled",
      );
    }

    if (
      groupRefreshMs > 0 && authConfig.mode === "oauth" &&
      oauthClientSecret
    ) {
      const vaultService = await VaultService.fromRepository(
        resolvedRepoDir,
        { defaultVaultName: repoMarker?.defaultVault },
      );
      const userVaultName = vaultService.getDefaultVaultName() ??
        vaultService.getVaultNames().find((n) =>
          n !== TOKEN_SECRETS_VAULT_NAME
        );

      const {
        CollectiveRefreshService,
      } = await import("../../serve/collective_refresh_service.ts");
      const {
        getUserInfo,
      } = await import("../../serve/oauth_client.ts");
      const { oauthAccessTokenKey } = await import(
        "../../serve/device_auth_handler.ts"
      );

      collectiveRefreshService = new CollectiveRefreshService({
        intervalMs: groupRefreshMs,
        oauthProvider: authConfig.oauthProvider,
        groupsField: authConfig.groupsField,
        getUserInfo,
        listActiveTokens: async () => {
          const records = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          const tokens:
            import("../../serve/collective_refresh_service.ts").ActiveTokenInfo[] =
              [];
          for (const record of records) {
            const parsed = ServerTokenSchema.safeParse(record.attributes);
            if (!parsed.success || parsed.data.state !== "active") continue;
            if (Date.parse(parsed.data.expiresAt) <= Date.now()) continue;
            tokens.push({
              name: parsed.data.name,
              principalId: parsed.data.principalId,
              collectives: parsed.data.collectives,
              groups: parsed.data.groups,
            });
          }
          return tokens;
        },
        getAccessToken: async (tokenName) => {
          try {
            return await vaultService.get(
              TOKEN_SECRETS_VAULT_NAME,
              oauthAccessTokenKey(tokenName),
              "serve:group-refresh",
            );
          } catch {
            if (userVaultName) {
              try {
                return await vaultService.get(
                  userVaultName,
                  oauthAccessTokenKey(tokenName),
                  "serve:group-refresh",
                );
              } catch {
                return null;
              }
            }
            return null;
          }
        },
        updateTokenCollectives: async (tokenName, collectives, groups) => {
          const { createResourceWriter } = await import(
            "../../domain/models/data_writer.ts"
          );
          const def = await repoContext.definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!def) return;
          const { writeResource } = createResourceWriter(
            repoContext.unifiedDataRepo,
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            serverTokenModel.resources!,
            undefined,
            undefined,
            undefined,
            undefined,
            tokenName,
          );
          const record = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main" && modelName == "${tokenName}"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          if (record.length === 0) return;
          const parsed = ServerTokenSchema.safeParse(record[0].attributes);
          if (!parsed.success) return;
          const updated = { ...parsed.data, collectives, groups };
          // In a root unit of work with no push, so the write stages into
          // it instead of reaching the hook through signalChange's fallback
          // (swamp-club#3056). Nothing pushes here, as before.
          await runInRootUnitOfWork(
            repoContext,
            { flush: undefined },
            () =>
              writeResource(
                "token",
                "token-main",
                updated as unknown as Record<string, unknown>,
              ),
          );
        },
        revokeToken: async (tokenName) => {
          const { createResourceWriter } = await import(
            "../../domain/models/data_writer.ts"
          );
          const def = await repoContext.definitionRepo.findByName(
            SERVER_TOKEN_MODEL_TYPE,
            tokenName,
          );
          if (!def) return;
          const { writeResource } = createResourceWriter(
            repoContext.unifiedDataRepo,
            SERVER_TOKEN_MODEL_TYPE,
            def.id,
            serverTokenModel.resources!,
            undefined,
            undefined,
            undefined,
            undefined,
            tokenName,
          );
          const record = await repoContext.dataQueryService.query(
            `modelType == "${SERVER_TOKEN_MODEL_TYPE.normalized}" && name == "token-main" && modelName == "${tokenName}"`,
            { loadAttributes: true },
          ) as import("../../domain/data/data_record.ts").DataRecord[];
          if (record.length === 0) return;
          const parsed = ServerTokenSchema.safeParse(record[0].attributes);
          if (!parsed.success) return;
          const revoked = {
            ...parsed.data,
            state: "revoked" as const,
            revokedAt: new Date().toISOString(),
          };
          // In a root unit of work with no push, so the write stages into
          // it instead of reaching the hook through signalChange's fallback
          // (swamp-club#3056). Nothing pushes here, as before.
          await runInRootUnitOfWork(
            repoContext,
            { flush: undefined },
            () =>
              writeResource(
                "token",
                "token-main",
                revoked as unknown as Record<string, unknown>,
              ),
          );
        },
        updateConnectionCollectives: updateCollectivesForPrincipal,
        closeConnectionsForPrincipal,
      });
      collectiveRefreshService.start();
    }

    // Token and OAuth modes both authenticate sessions with server tokens.
    // Re-check them so a revoke, rotation or expiry — here, on a peer, or
    // from the CLI — ends sessions already open with the token.
    let tokenSessionRevalidationService:
      | TokenSessionRevalidationService
      | null = null;
    if (authConfig.mode !== "none") {
      tokenSessionRevalidationService = new TokenSessionRevalidationService({
        intervalMs: DEFAULT_TOKEN_SESSION_REVALIDATION_MS,
        listTokenSessions,
        readToken: (name) => readServerTokenRecord(repoContext, name),
        terminateSessions: (name, options) =>
          terminateTokenSessions(name, {
            ...options,
            initiatedBy: "system",
            audit: {
              emitter: connectionCtx.auditEmitter,
              instanceId: connectionCtx.instanceId,
            },
          }),
      });
      tokenSessionRevalidationService.start();
    }

    // Enrollment tokens revoked from the CLI or on a peer never reach this
    // gateway's revoke path; re-check them so their workers are cut off.
    const workerTokenRevalidationService = new WorkerTokenRevalidationService({
      intervalMs: DEFAULT_WORKER_TOKEN_REVALIDATION_MS,
      listBoundTokens: () => workerGateway.boundTokens(),
      readTokens: () => workerGateway.readTokenRecords(),
      revokeToken: (name, cause, options) =>
        workerGateway.revokeToken(name, cause, options),
    });
    workerTokenRevalidationService.start();

    let clubHeartbeatService: ClubHeartbeatService | null = null;
    if (
      authConfig.mode === "oauth" && authConfig.oauthClientId &&
      authConfig.allowedCollectives.length > 0 &&
      clubApiKey
    ) {
      clubHeartbeatService = new ClubHeartbeatService({
        providerUrl: authConfig.oauthProvider,
        oauthClientId: authConfig.oauthClientId,
        intervalMs: DEFAULT_CLUB_HEARTBEAT_INTERVAL_MS,
        getAccessToken: () => Promise.resolve(clubApiKey),
        sendHeartbeat: sendInstanceHeartbeat,
      });
      clubHeartbeatService.start();
    }

    // Parse and initialize webhook endpoints — resolve secrets (including
    // @vault= references) now that the vault type registry is loaded.
    let webhookService: WebhookService | null = null;
    const webhookSourceIsCliFlags = webhookFlags.length > 0;
    const hasWebhooks = webhookSourceIsCliFlags ||
      (merged.webhookConfigs && merged.webhookConfigs.length > 0);
    let webhookEndpoints: WebhookEndpoint[] = [];
    if (hasWebhooks) {
      const vaultService = await VaultService.fromRepository(
        resolvedRepoDir,
        { defaultVaultName: repoMarker?.defaultVault },
      );
      webhookEndpoints = webhookSourceIsCliFlags
        ? await Promise.all(
          webhookFlags.map((f) => parseWebhookFlag(f, vaultService)),
        )
        : await Promise.all(
          merged.webhookConfigs!.map((e) =>
            parseWebhookConfig(e, vaultService)
          ),
        );
      webhookEndpoints = await resolveExtensionWebhookEndpoints(
        webhookEndpoints,
        (type) => resolveWebhookType(type, getAutoResolver()),
      );
    }
    if (webhookEndpoints.length > 0) {
      const endpoints = webhookEndpoints;
      webhookService = new WebhookService({
        repoDir: resolvedRepoDir,
        repoContext,
        datastoreConfig,
        endpoints,
        syncService,
        syncGate,
        runTracker,
        instanceId,
        controlPlaneStore,
        initiatedBy: principalToString(WEBHOOK_PRINCIPAL),
        authorizeRun: createWebhookRunAuthorizer(
          triggerAuthorizer,
          connectionCtx,
        ),
      });

      const webhookRejections = new WebhookRejectionCoalescer();
      webhookService.setEventHandler((event) => {
        // Audit before the output branch so --json mode audits too.
        auditWebhookEvent(connectionCtx, event, webhookRejections);
        if (isJson) {
          console.log(JSON.stringify(event));
        } else {
          switch (event.kind) {
            case "webhook_received":
              logger.info(
                "Webhook received on {route} for workflow {workflow}",
                { route: event.route, workflow: event.workflowName },
              );
              break;
            case "webhook_rejected":
              logger.warn(
                "Webhook rejected on {route}: {reason}",
                { route: event.route, reason: event.reason },
              );
              break;
            case "webhook_queued":
              logger.info(
                "Webhook queued workflow {workflow}",
                { workflow: event.workflowName },
              );
              break;
            case "webhook_completed": {
              logger.info(
                "Webhook workflow {workflow} completed (run: {runId})",
                { workflow: event.workflowName, runId: event.runId },
              );
              const whRun = runTracker.findById(event.runId);
              const whDuration = whRun
                ? Date.now() - whRun.startedAt.getTime()
                : 0;
              runMetricsTracker.record("completed", whDuration);
              break;
            }
            case "webhook_failed":
              logger.error(
                "Webhook workflow {workflow} failed: {error}",
                { workflow: event.workflowName, error: event.error },
              );
              runMetricsTracker.record("failed", 0);
              break;
          }
        }
      });

      for (const ep of endpoints) {
        if (isJson) {
          console.log(JSON.stringify({
            kind: "webhook_registered",
            route: ep.route,
            workflow: ep.workflowIdOrName,
            scheme: ep.verifier.scheme,
          }));
        } else {
          logger.info(
            "Webhook registered: {route} → {workflow} (scheme: {scheme})",
            {
              route: ep.route,
              workflow: ep.workflowIdOrName,
              scheme: ep.verifier.scheme,
            },
          );
        }
      }
    }

    const webhookUpdater = (!webhookSourceIsCliFlags && webhookService)
      ? async (configs: readonly WebhookConfigEntry[]): Promise<number> => {
        const vaultService = await VaultService.fromRepository(
          resolvedRepoDir,
          { defaultVaultName: repoMarker?.defaultVault },
        );
        let parsed = await Promise.all(
          configs.map((e) => parseWebhookConfig(e, vaultService)),
        );
        parsed = await resolveExtensionWebhookEndpoints(
          parsed,
          (type) => resolveWebhookType(type, getAutoResolver()),
        );
        return webhookService!.updateEndpoints(parsed);
      }
      : undefined;
    connectionCtx.webhookUpdater = webhookUpdater;

    const wsUpgradeOpts: Deno.UpgradeWebSocketOptions = {};
    if (wsIdleTimeoutSeconds !== undefined) {
      wsUpgradeOpts.idleTimeout = wsIdleTimeoutSeconds;
    }

    let isReady = false;
    // Set when SIGTERM/SIGINT starts the shutdown; /ready reports 503 from
    // then on so load balancers stop routing here while runs drain.
    let shuttingDown = false;
    const enableInternalApi = merged.enableInternalApi;
    const serverStartedAt = Date.now();

    const runMetricsTracker = new RunMetricsTracker();

    const componentHealthChecker = new ComponentHealthChecker({
      checkDatastore: async (_signal) => {
        if (isCustomDatastoreConfig(datastoreConfig)) {
          await datastoreTypeRegistry.ensureTypeLoaded(datastoreConfig.type);
          const typeInfo = datastoreTypeRegistry.get(datastoreConfig.type);
          if (typeInfo?.createProvider) {
            const provider = typeInfo.createProvider(datastoreConfig.config);
            const verifier = provider.createVerifier();
            return await verifier.verify();
          }
          return {
            healthy: false,
            message: "No provider available for datastore type",
            latencyMs: 0,
            datastoreType: datastoreConfig.type,
          };
        }
        const verifier = new FilesystemDatastoreVerifier(datastoreConfig.path);
        return await verifier.verify();
      },
    });

    const healthCollector = new HealthCollector({
      instanceId,
      deploymentMode: deploymentMode.mode,
      startedAt: serverStartedAt,
      isReady: () => isReady,
      activeRunRegistry: activeRunRegistry ?? null,
      metricsTracker: runMetricsTracker,
      componentChecker: componentHealthChecker,
      workerProvider: workerGateway,
      scheduleProvider: scheduledExecution,
      scheduleEnabled: enableSchedule,
      webhookProvider: webhookService ?? null,
      remoteOnly: merged.remoteOnly,
      // Any valid token may read health, so one collection (component
      // probes included) serves every reader and stream tick for a second.
      snapshotMaxAgeMs: HEALTH_SNAPSHOT_MAX_AGE_MS,
      onHealthTransition: (previous, current) => {
        emitSystemAuditEvent(
          connectionCtx,
          "health.transition",
          `${previous}->${current}`,
        );
      },
    });

    connectionCtx.healthCollector = healthCollector;

    const healthResources = cachedHealthResourceResolver(
      createHealthResourceResolver(repoContext),
      { ttlMs: HEALTH_RESOURCE_CACHE_TTL_MS },
    );

    const adminAuthDeps: AdminAuthDeps = {
      authMode: authConfig.mode,
      repoDir: resolvedRepoDir,
      repoContext,
      policySnapshotLoader,
      trustProxy,
      auditEmitter: connectionCtx.auditEmitter,
      instanceId,
    };

    // Dashboard static file serving
    const dashboardEnabled = merged.dashboard;
    const dashboardDistDir = dashboardEnabled
      ? resolve(
        import.meta.dirname ?? ".",
        "..",
        "..",
        "..",
        "packages",
        "dashboard",
        "dist",
      )
      : null;

    const MIME_TYPES: Record<string, string> = {
      ".html": "text/html; charset=utf-8",
      ".js": "application/javascript",
      ".css": "text/css",
      ".json": "application/json",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".ico": "image/x-icon",
      ".woff2": "font/woff2",
      ".woff": "font/woff",
      ".ttf": "font/ttf",
    };

    async function serveDashboardFile(
      filePath: string,
    ): Promise<Response | null> {
      if (!dashboardDistDir) return null;
      const root = resolve(dashboardDistDir);
      const target = resolve(join(root, normalize(filePath)));
      if (
        isAbsolute(filePath) || filePath.includes("..") ||
        (!target.startsWith(root + "/") && target !== root &&
          !target.startsWith(root + "\\"))
      ) {
        return new Response("Forbidden", { status: 403 });
      }
      try {
        const content = await Deno.readFile(target);
        const ext = extname(target);
        const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
        const isIndexHtml = basename(target) === "index.html";
        return new Response(content, {
          headers: {
            "content-type": contentType,
            "cache-control": isIndexHtml
              ? "no-cache"
              : "public, max-age=31536000, immutable",
          },
        });
      } catch (e) {
        if (e instanceof Deno.errors.NotFound) return null;
        throw e;
      }
    }

    if (dashboardEnabled && !isJson) {
      const scheme = tlsEnabled ? "https" : "http";
      logger.info("Dashboard enabled at {url}", {
        url: `${scheme}://${host}:${port}/dashboard`,
      });
    }

    const wsScheme = tlsEnabled ? "wss" : "ws";
    const server = Deno.serve(
      {
        port,
        hostname: host,
        signal: ac.signal,
        cert,
        key,
        onListen({ hostname, port: listenPort }) {
          if (isJson) {
            console.log(JSON.stringify({
              status: "listening",
              host: hostname,
              port: listenPort,
              url: `${wsScheme}://${hostname}:${listenPort}`,
              schedulingEnabled: enableSchedule,
              detachRuns: true,
              mode: deploymentMode.mode,
            }));
          } else {
            logger.info("WebSocket API server listening on {url}", {
              url: `${wsScheme}://${hostname}:${listenPort}`,
            });
          }
        },
      },
      traceHttpRequests(async (req, info) => {
        const clientAddress = () =>
          trustProxy
            ? (req.headers.get("x-forwarded-for")
              ?.split(",")[0]?.trim() ??
              info.remoteAddr.hostname)
            : info.remoteAddr.hostname;

        // WebSocket upgrade (check first — upgrade requests are also GETs)
        const upgrade = req.headers.get("upgrade") ?? "";
        if (upgrade.toLowerCase() === "websocket") {
          const remoteAddr = clientAddress();

          const originCheck = validateWebSocketOrigin(
            req.headers.get("origin"),
            req.headers.get("host"),
            host,
            tlsEnabled,
            trustedHosts,
          );
          if (!originCheck.allowed) {
            logger.warn(
              "WebSocket upgrade rejected: {reason} from {ip}",
              { reason: originCheck.reason, ip: remoteAddr },
            );
            return new Response(
              `Forbidden: ${originCheck.reason}`,
              { status: 403 },
            );
          }

          if (authConfig.mode !== "none") {
            const ipBurst = checkIpBurst(remoteAddr);
            if (!ipBurst.allowed) {
              logger.warn("WebSocket IP burst rate-limited from {ip}", {
                ip: remoteAddr,
              });
              return new Response("Too Many Requests", {
                status: 429,
                headers: {
                  "Retry-After": String(ipBurst.retryAfterSeconds),
                },
              });
            }

            const extracted = extractWebSocketToken(req);
            if (!extracted) {
              logger.warn(
                "WebSocket auth rejected: no token provided from {ip}",
                { ip: remoteAddr },
              );
              return new Response("Unauthorized: token required", {
                status: 401,
              });
            }

            const rlKey = rateLimitKey(extracted.token, remoteAddr);
            const rateCheck = checkRateLimit(rlKey);
            if (!rateCheck.allowed) {
              logger.warn(
                "WebSocket auth rate-limited for {key} from {ip}",
                { key: rlKey, ip: remoteAddr },
              );
              return new Response("Too Many Requests", {
                status: 429,
                headers: {
                  "Retry-After": String(rateCheck.retryAfterSeconds),
                },
              });
            }

            logger.debug(
              "WebSocket token received via {transport} from {ip}",
              { transport: extracted.transport, ip: remoteAddr },
            );
            const result = await authenticateServerToken(
              extracted.token,
              resolvedRepoDir,
              repoContext,
              {
                emitter: connectionCtx.auditEmitter,
                instanceId: connectionCtx.instanceId,
                sourceIp: remoteAddr,
                ingress: `websocket:${extracted.transport}`,
              },
            );
            if (!result.ok) {
              logger.warn(
                "WebSocket auth rejected for {key} from {ip} ({reason}): {error}",
                {
                  key: rlKey,
                  ip: remoteAddr,
                  reason: result.reason,
                  error: result.error,
                },
              );
              return new Response(
                `Unauthorized: ${result.reason}`,
                { status: 401 },
              );
            }
            clearRateLimit(rlKey);
            const principal = parsePrincipal(result.principalId);
            const upgradeOpts = extracted.transport === "subprotocol"
              ? {
                ...wsUpgradeOpts,
                protocol: `bearer.${extracted.token}`,
              }
              : wsUpgradeOpts;
            const { socket, response } = Deno.upgradeWebSocket(
              req,
              upgradeOpts,
            );
            setConnectionCollectives(
              socket,
              result.collectives,
              result.groups,
              result.principalId,
            );
            setConnectionToken(socket, {
              name: result.tokenName,
              createdAt: result.tokenCreatedAt,
              principalId: result.principalId,
            });
            setConnectionSourceIp(socket, remoteAddr);
            setConnectionCompression(
              socket,
              resolveConnectionCompression(req.url),
            );
            socket.addEventListener("close", () => removeConnection(socket));
            handleConnection(socket, connectionCtx, principal);
            return response;
          }
          const { socket, response } = Deno.upgradeWebSocket(
            req,
            wsUpgradeOpts,
          );
          setConnectionSourceIp(socket, remoteAddr);
          setConnectionCompression(
            socket,
            resolveConnectionCompression(req.url),
          );
          handleConnection(socket, connectionCtx, null);
          return response;
        }

        // Remote-execution data plane (bearer-authenticated worker routes)
        const dataPlaneResponse = await dataPlane.handle(req);
        if (dataPlaneResponse) return dataPlaneResponse;

        // Webhook endpoints (POST only, checked before health)
        if (webhookService && req.method === "POST") {
          const webhookResponse = await webhookService.handleRequest(
            req,
            clientAddress(),
          );
          if (webhookResponse) return webhookResponse;
        }

        // Cancel endpoint (authenticated + authorized)
        if (req.method === "POST") {
          const url = new URL(req.url);
          const cancelMatch = url.pathname.match(
            /^\/api\/v1\/cancel\/(workflow-run|method-run)\/([^/]+)$/,
          );
          const isBulkCancel = url.pathname === "/api/v1/cancel";
          let cancelAuditPrincipal: ReturnType<typeof parsePrincipal> | null =
            null;
          const cancelRemoteAddr = trustProxy
            ? (req.headers.get("x-forwarded-for")
              ?.split(",")[0]?.trim() ??
              info.remoteAddr.hostname)
            : info.remoteAddr.hostname;
          if (cancelMatch || isBulkCancel) {
            if (authConfig.mode !== "none") {
              const cancelIpBurst = checkIpBurst(cancelRemoteAddr);
              if (!cancelIpBurst.allowed) {
                return new Response("Too Many Requests", {
                  status: 429,
                  headers: {
                    "Retry-After": String(cancelIpBurst.retryAfterSeconds),
                  },
                });
              }
              const authHeader = req.headers.get("authorization");
              const token = authHeader?.startsWith("Bearer ")
                ? authHeader.slice(7)
                : null;
              if (!token) {
                return new Response("Unauthorized: token required", {
                  status: 401,
                });
              }
              const cancelRlKey = rateLimitKey(token, cancelRemoteAddr);
              const cancelRateCheck = checkRateLimit(cancelRlKey);
              if (!cancelRateCheck.allowed) {
                return new Response("Too Many Requests", {
                  status: 429,
                  headers: {
                    "Retry-After": String(cancelRateCheck.retryAfterSeconds),
                  },
                });
              }
              const authResult = await authenticateServerToken(
                token,
                resolvedRepoDir,
                repoContext,
                {
                  emitter: connectionCtx.auditEmitter,
                  instanceId: connectionCtx.instanceId,
                  sourceIp: cancelRemoteAddr,
                  ingress: "http-cancel",
                },
              );
              if (!authResult.ok) {
                return new Response(
                  `Unauthorized: ${authResult.reason}`,
                  { status: 401 },
                );
              }
              clearRateLimit(cancelRlKey);

              const cancelPrincipal = parsePrincipal(authResult.principalId);
              cancelAuditPrincipal = cancelPrincipal;
              const refusal = authorizeCancelRequest(
                connectionCtx,
                policySnapshotLoader,
                {
                  principal: cancelPrincipal,
                  collectives: authResult.collectives,
                  groups: authResult.groups,
                  sourceIp: cancelRemoteAddr,
                  execution: cancelMatch
                    ? {
                      type: cancelMatch[1] as ExecutionType,
                      id: cancelMatch[2],
                    }
                    : undefined,
                },
              );
              if (refusal) return refusal;
            }
          }
          if (cancelMatch) {
            const executionType = cancelMatch[1] as ExecutionType;
            const executionId = cancelMatch[2];
            const requested = await readCancelRequestReason(req);
            if (!requested.ok) {
              return Response.json({
                status: "error",
                message: requested.message,
              }, { status: requested.status });
            }
            const reason = cancelReasonFor(
              cancelActor(cancelAuditPrincipal, connectionCtx),
              requested.reason,
            );
            const audit = {
              action: "cancel",
              resourceKind: executionType === "method-run"
                ? "model"
                : "workflow",
              resourceName: executionId,
              principal: cancelAuditPrincipal,
              sourceIp: cancelRemoteAddr,
              requestId: crypto.randomUUID(),
            };
            let result: CancelResult;
            try {
              result = await cancelExecution(
                executionType,
                executionId,
                {
                  cancelRegistry,
                  activeRunRegistry,
                  reason,
                  scheduledCancelByRunId: scheduledExecution
                    ? (id) => scheduledExecution.cancelByRunId(id, reason)
                    : undefined,
                  // The endpoint already required admin on every resource, so
                  // the run's own workflow needs no further check.
                  cancelSuspended: (id) =>
                    cancelSuspendedRunAndPush(
                      connectionCtx,
                      { runId: id, reason },
                      () => true,
                    ),
                },
              );
            } catch (error) {
              emitRunCancelAudit(connectionCtx, {
                ...audit,
                outcome: "failure",
                detail: error instanceof Error ? error.message : String(error),
              });
              return Response.json({
                status: "error",
                message: sanitizeErrorForClient(error),
              }, { status: 500 });
            }
            const succeeded = result.status === "cancelled" ||
              result.status === "cancellation_requested";
            emitRunCancelAudit(connectionCtx, {
              ...audit,
              outcome: succeeded ? "success" : "failure",
              detail: succeeded ? result.status : result.message,
            });
            if (result.status === "not_found") {
              return Response.json({
                status: result.status,
                message: result.message,
              }, { status: 404 });
            }
            if (result.status === "conflict") {
              return Response.json({
                status: result.status,
                message: result.message,
              }, { status: 409 });
            }
            return Response.json(cancelSuccessBody(result, reason));
          }
          if (url.pathname === "/api/v1/cancel") {
            const body = await req.json().catch(() => ({}));
            const typeFilter = typeof body.executionType === "string"
              ? body.executionType
              : undefined;
            if (
              typeFilter && typeFilter !== "workflow-run" &&
              typeFilter !== "method-run"
            ) {
              return Response.json({
                status: "error",
                message: "executionType must be 'workflow-run' or 'method-run'",
              }, { status: 400 });
            }
            const reason = cancelReasonFor(
              cancelActor(cancelAuditPrincipal, connectionCtx),
            );
            let count = cancelRegistry.cancelAll(typeFilter, reason);
            if (activeRunRegistry) {
              count += activeRunRegistry.cancelAll(typeFilter, reason);
            }
            if (
              (!typeFilter || typeFilter === "workflow-run") &&
              scheduledExecution
            ) {
              count += scheduledExecution.cancelAllRuns(reason);
            }
            emitRunCancelAudit(connectionCtx, {
              action: "cancel.all",
              resourceKind: typeFilter === "method-run"
                ? "model"
                : typeFilter === "workflow-run"
                ? "workflow"
                : "execution",
              resourceName: "*",
              principal: cancelAuditPrincipal,
              sourceIp: cancelRemoteAddr,
              requestId: crypto.randomUUID(),
              outcome: "success",
              detail: `count=${count}`,
            });
            return Response.json({ status: "cancellation_requested", count });
          }
        }

        // Health snapshot endpoints (any valid token; the snapshot is
        // narrowed to what the token may read)
        if (req.method === "GET") {
          const url = new URL(req.url);
          if (url.pathname === "/api/v1/health") {
            const auth = await authenticateToken(
              req,
              info.remoteAddr.hostname,
              adminAuthDeps,
            );
            if (!auth.ok) return auth.response;
            const reader = createReadAuthorizer(auth.authResult, adminAuthDeps);
            const snapshot = await healthCollector.collect(ac.signal);
            return Response.json(
              await healthSnapshotFor(snapshot, reader, healthResources),
            );
          }

          // SSE health stream, bound to its token session so revoking,
          // rotating or expiring the token ends it
          if (url.pathname === "/api/v1/health/stream") {
            const auth = await authenticateToken(
              req,
              info.remoteAddr.hostname,
              adminAuthDeps,
            );
            if (!auth.ok) return auth.response;
            const token = auth.token;
            const reader = createReadAuthorizer(auth.authResult, adminAuthDeps);

            return createHealthStreamResponse({
              collect: async (signal) =>
                await healthSnapshotFor(
                  await healthCollector.collect(signal),
                  reader,
                  healthResources,
                ),
              intervalParam: url.searchParams.get("interval"),
              lastEventId: req.headers.get("Last-Event-ID"),
              serverSignal: ac.signal,
              requestSignal: req.signal,
              // Auth mode none has no token, so there is no session to bind
              // and no per-token cap: that mode is unauthenticated by design.
              registerSession: token === null
                ? undefined
                : (closer) =>
                  registerStreamSession({
                    name: token.name,
                    createdAt: token.createdAt,
                    principalId: auth.authResult.principalId,
                  }, {
                    sourceIp: auth.clientAddr,
                    close: (code, reason) => closer.close(code, reason),
                  }),
            });
          }

          // Cluster instances endpoint (authenticated + authorized)
          if (url.pathname === "/api/v1/cluster/instances") {
            const auth = await authenticateAdmin(
              req,
              info.remoteAddr.hostname,
              adminAuthDeps,
            );
            if (!auth.ok) return auth.response;

            const instances = await collectClusterInstances({
              controlPlaneStore,
              healthCollector,
              instanceId,
              staleTtlMs,
              serveOptions: merged,
              signal: ac.signal,
            });

            return Response.json({ instances });
          }

          // Serve config endpoint (authenticated + authorized)
          if (url.pathname === "/api/v1/serve/config") {
            const auth = await authenticateAdmin(
              req,
              info.remoteAddr.hostname,
              adminAuthDeps,
            );
            if (!auth.ok) return auth.response;

            return Response.json({
              config: redactServeOptions(merged),
            });
          }

          // Internal runs endpoint (opt-in, authenticated + authorized)
          if (url.pathname === "/internal/runs") {
            if (!enableInternalApi) {
              return new Response("Not found", { status: 404 });
            }
            const auth = await authenticateAdmin(
              req,
              info.remoteAddr.hostname,
              adminAuthDeps,
            );
            if (!auth.ok) return auth.response;
            const limitParam = url.searchParams.get("limit");
            const offsetParam = url.searchParams.get("offset");
            const limit = limitParam !== null
              ? Math.max(1, Math.min(10000, parseInt(limitParam, 10) || 100))
              : 100;
            const offset = offsetParam !== null
              ? Math.max(0, parseInt(offsetParam, 10) || 0)
              : 0;
            const allRuns = runTracker.findAll();
            const paged = allRuns.slice(offset, offset + limit);
            return Response.json({
              total: allRuns.length,
              limit,
              offset,
              runs: paged.map((r) => ({
                id: r.id,
                runKind: r.runKind,
                modelType: r.modelType,
                methodName: r.methodName,
                workflowName: r.workflowName,
                pid: r.pid,
                hostname: r.hostname,
                status: r.status,
                startedAt: r.startedAt.toISOString(),
                heartbeatAt: r.heartbeatAt.toISOString(),
                initiatedBy: r.initiatedBy,
                instanceId: r.instanceId,
              })),
            });
          }
        }

        // Device authorization endpoints (OAuth mode only)
        if (authConfig.mode === "oauth" && authConfig.oauthClientId) {
          const deviceRemoteAddr = trustProxy
            ? (req.headers.get("x-forwarded-for")
              ?.split(",")[0]?.trim() ??
              info.remoteAddr.hostname)
            : info.remoteAddr.hostname;
          const url = new URL(req.url);
          if (
            url.pathname === "/auth/device" ||
            url.pathname === "/auth/device/token"
          ) {
            const deviceRateCheck = checkIpBurst(deviceRemoteAddr);
            if (!deviceRateCheck.allowed) {
              return new Response(
                JSON.stringify({ error: "Too Many Requests" }),
                {
                  status: 429,
                  headers: {
                    "content-type": "application/json",
                    "Retry-After": String(deviceRateCheck.retryAfterSeconds),
                  },
                },
              );
            }
          }
          const oauthConfig = {
            ...authConfig,
            oauthClientId: authConfig.oauthClientId!,
          };
          const deviceAuthDeps = createDeviceAuthDeps(
            oauthConfig,
            oauthClientSecret,
            resolvedRepoDir,
            repoContext,
            repoMarker?.defaultVault,
            syncService,
            serveNamespace,
            syncGate,
            connectionCtx.auditEmitter,
            connectionCtx.instanceId,
            deviceRemoteAddr,
          );
          const deviceAuthResponse = await handleDeviceAuth(
            req,
            deviceAuthDeps,
          );
          if (deviceAuthResponse) return deviceAuthResponse;
        }

        // Auth discovery (unauthenticated — mode is not sensitive)
        if (
          req.method === "GET" && new URL(req.url).pathname === "/auth/info"
        ) {
          const authInfo: Record<string, string> = { mode: authConfig.mode };
          if (authConfig.mode === "oauth") {
            authInfo.verificationBaseUri = authConfig.oauthProvider;
          }
          return new Response(JSON.stringify(authInfo), {
            headers: { "content-type": "application/json" },
          });
        }

        // Readiness endpoint — returns 200 only after full startup and
        // before shutdown begins
        if (req.method === "GET" && new URL(req.url).pathname === "/ready") {
          if (shuttingDown) {
            return Response.json(
              { status: "shutting_down", instanceId },
              { status: 503 },
            );
          }
          if (!isReady) {
            return Response.json(
              { status: "not_ready", instanceId },
              { status: 503 },
            );
          }
          return Response.json({
            status: "ready",
            mode: deploymentMode.mode,
            instanceId,
          });
        }

        // Health check endpoint
        if (req.method === "GET") {
          const url = new URL(req.url);
          if (url.pathname === "/" || url.pathname === "/health") {
            const schedules = scheduledExecution?.listSchedules().map((s) => ({
              workflowId: s.workflowId,
              workflowName: s.workflowName,
              cronExpression: s.cronExpression,
              nextRun: s.nextRun?.toISOString() ?? null,
              running: scheduledExecution!.isRunning(s.workflowId),
            })) ?? [];

            const webhooks = webhookService
              ? webhookService.listEndpoints().map((ep) => ({
                route: ep.route,
                workflow: ep.workflowIdOrName,
                scheme: ep.scheme,
              }))
              : [];

            return Response.json({
              status: "ok",
              version: "1",
              remoteOnly: merged.remoteOnly,
              scheduling: {
                enabled: enableSchedule,
                schedules,
              },
              webhooks,
            });
          }
        }

        // Dashboard SPA
        if (dashboardEnabled) {
          const dashUrl = new URL(req.url);
          if (
            dashUrl.pathname === "/dashboard" ||
            dashUrl.pathname.startsWith("/dashboard/")
          ) {
            if (req.method !== "GET" && req.method !== "HEAD") {
              return new Response("Method not allowed", { status: 405 });
            }
            const subPath = dashUrl.pathname === "/dashboard"
              ? "index.html"
              : dashUrl.pathname.slice("/dashboard/".length) || "index.html";
            const fileResponse = await serveDashboardFile(subPath);
            if (fileResponse) return fileResponse;
            const indexResponse = await serveDashboardFile("index.html");
            if (indexResponse) return indexResponse;
            return new Response(
              "Dashboard assets not available in this build",
              { status: 404, headers: { "content-type": "text/plain" } },
            );
          }
        }

        return new Response("Not found", { status: 404 });
      }),
    );

    // Hot-reload: PID file + SIGHUP handler
    const hotReload = merged.hotReload;
    const pidPath = hotReload ? swampPath(resolvedRepoDir, "serve.pid") : null;

    if (hotReload && pidPath) {
      if (Deno.build.os === "windows") {
        throw new UserError(
          "--hot-reload is not supported on Windows (SIGHUP is unavailable). " +
            "Restart the serve process to pick up extension changes.",
        );
      }
      await Deno.writeTextFile(pidPath, String(Deno.pid));
      logger.info`Hot-reload enabled, PID file written to ${pidPath}`;

      Deno.addSignalListener("SIGHUP", () => {
        if (isReloading()) {
          logger.warn("Hot-reload already in progress, ignoring SIGHUP");
          return;
        }
        logger.info("SIGHUP received, reloading pulled extensions...");
        const sighupDiscoverer = createExtensionDiscoverer({
          lockfilePath: extensionLockfilePath,
          repoDir: resolvedRepoDir,
        });
        const reloadOptions:
          import("../../serve/extension_reload.ts").ServeReloadOptions = {
            triggerOverrideUpdater: scheduledExecution
              ? (overrides: ReadonlyMap<string, TriggerOverride>) =>
                scheduledExecution!.updateTriggerOverrides(overrides)
              : undefined,
            workflowReloader: connectionCtx.workflowReloader,
            extensionDiscoverer: sighupDiscoverer,
            webhookUpdater,
            configPath: serveConfigPath,
          };
        performServeReload(
          resolvedRepoDir,
          extensionLockfilePath,
          reloadOptions,
        )
          .then((result) => {
            if (result.success) {
              logger.info`Hot-reloaded ${result.reloadedCount} type(s)`;
              if (result.workflowsReloaded && result.workflowsReloaded > 0) {
                logger.info(
                  "Refreshed {count} extension workflow dir(s)",
                  { count: result.workflowsReloaded },
                );
              }
              if (
                result.triggerOverridesChanged &&
                result.triggerOverridesChanged > 0
              ) {
                logger.info(
                  "Reloaded {count} trigger override(s) from serve.yaml",
                  { count: result.triggerOverridesChanged },
                );
              }
              if (
                result.webhooksReloaded &&
                result.webhooksReloaded > 0
              ) {
                logger.info(
                  "Reloaded {count} webhook route(s) from serve.yaml",
                  { count: result.webhooksReloaded },
                );
              }
              if (result.errors.length > 0) {
                for (const err of result.errors) {
                  logger.warn`${err}`;
                }
              }
            } else {
              for (const err of result.errors) {
                logger.error`${err}`;
              }
            }
          })
          .catch((err) => {
            logger.error`Unexpected error during hot-reload: ${err}`;
          });
      });
    }

    // Handle SIGINT/SIGTERM for graceful shutdown
    const shutdown = async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      isReady = false;
      if (isJson) {
        console.log(JSON.stringify({ status: "stopping" }));
      }
      if (shutdownDrainTimeoutMs > 0) {
        logger.info`Shutting down, draining in-flight runs for up to ${
          shutdownDrainTimeoutMs / 1000
        }s...`;
      } else {
        logger.info`Shutting down, aborting in-flight runs immediately...`;
      }
      const remaining = await runShutdownDrain({
        webhookService,
        scheduledExecution,
        activeRunRegistry: activeRunRegistry ?? null,
        drainTimeoutMs: shutdownDrainTimeoutMs,
        abortGraceMs: SHUTDOWN_ABORT_GRACE_MS,
        onAborting: (undrained) => {
          if (isJson) {
            console.log(JSON.stringify({ status: "aborting", undrained }));
          }
        },
      });
      const workflowRuns = remaining.filter((r) =>
        r.kind === "workflow-run" || r.kind === "workflow-resume"
      );
      if (workflowRuns.length > 0) {
        const earliestCutoff = new Date(
          Math.min(...workflowRuns.map((r) => r.startedAt.getTime())) -
            60_000,
        );
        let allRuns:
          | Awaited<
            ReturnType<
              typeof repoContext.workflowRunRepo.findGlobalByStatus
            >
          >
          | undefined;
        try {
          allRuns = await repoContext.workflowRunRepo
            .findGlobalByStatus(
              ["running", "cancelled"],
              earliestCutoff,
            );
        } catch (err) {
          logger.warn(
            "Failed to load workflow runs for interrupt: {error}",
            {
              error: err instanceof Error ? err.message : String(err),
            },
          );
        }
        if (allRuns) {
          // The interrupts run in a root unit of work with no push, so their
          // saves stage into it instead of reaching the hook through
          // signalChange's fallback (swamp-club#3056). Nothing pushes here,
          // as before.
          await runInRootUnitOfWork(
            repoContext,
            { flush: undefined },
            async () => {
              for (const run of workflowRuns) {
                try {
                  const match = allRuns.find((r) => r.run.id === run.runId);
                  if (
                    match &&
                    (match.run.status === "running" ||
                      match.run.status === "cancelled")
                  ) {
                    match.run.interrupt("server_shutdown");
                    await repoContext.workflowRunRepo.save(
                      match.workflowId,
                      match.run,
                    );
                    if (isJson) {
                      console.log(JSON.stringify({
                        status: "interrupted",
                        runId: run.runId,
                      }));
                    }
                    logger
                      .info`Interrupted workflow run ${run.runId} (server shutdown)`;
                  }
                } catch (err) {
                  logger.warn(
                    "Failed to interrupt run {runId}: {error}",
                    {
                      runId: run.runId,
                      error: err instanceof Error ? err.message : String(err),
                    },
                  );
                }
              }
            },
          );
        }
      }
      if (workerGcService) {
        await workerGcService.dispose();
      }
      if (serverTokenGcService) {
        await serverTokenGcService.dispose();
      }
      if (heartbeatService) {
        await heartbeatService.stop();
      }
      // Stop revalidation before the gateway it cuts workers off from.
      await workerTokenRevalidationService.dispose();
      workerGateway.dispose();
      if (collectiveRefreshService) {
        await collectiveRefreshService.dispose();
      }
      if (tokenSessionRevalidationService) {
        await tokenSessionRevalidationService.dispose();
      }
      if (clubHeartbeatService) {
        clubHeartbeatService.stop();
      }
      if (grantsDirectoryPoller) {
        await grantsDirectoryPoller.stop();
      }
      if (accessDataPoller) {
        await accessDataPoller.stop();
      }
      if (runtimeDataPoller) {
        await runtimeDataPoller.stop();
      }
      if (configPoller) {
        await configPoller.stop();
      }
      await policySnapshotLoader.dispose();
      // Final telemetry flush, after runs have drained so their entries are
      // included. Must happen BEFORE ac.abort(), which releases
      // `await server.finished` and with it the CLI's own teardown flush.
      if (telemetryFlushService) {
        await telemetryFlushService.stop();
      }
      if (connectionCtx.auditEmitter) {
        emitSystemAuditEvent(connectionCtx, "instance.stop");
        await connectionCtx.auditEmitter.flush();
        await connectionCtx.auditEmitter.close();
        if (connectionCtx.auditWal) {
          await connectionCtx.auditWal.saveChainState(
            connectionCtx.auditEmitter.chainState.snapshot(),
          );
        }
      }
      rejectionGuard.dispose();
      setRemoteStepDispatcher(null);
      setRemoteOnlyMode(false);
      ac.abort();
      if (pidPath) {
        try {
          await Deno.remove(pidPath);
        } catch {
          // PID file may already be gone
        }
      }
      if (isJson) {
        console.log(JSON.stringify({ status: "stopped" }));
      }
    };
    registerShutdownHandler({
      handler: () => {
        shutdown().catch((e) =>
          logger.error("Shutdown error: {error}", {
            error: e instanceof Error ? e.message : String(e),
          })
        );
      },
      includePosixSignals: !hotReload,
    });
    if (hotReload) {
      // SIGHUP is handled by the hot-reload handler above, but
      // SIGTERM still needs to trigger shutdown on POSIX.
      if (Deno.build.os !== "windows") {
        Deno.addSignalListener("SIGTERM", () => {
          shutdown().catch((e) =>
            logger.error("Shutdown error: {error}", {
              error: e instanceof Error ? e.message : String(e),
            })
          );
        });
      }
    }

    if (hasRemoteControlPlane) {
      const remoteReaped = await reconcileRemoteInterruptedRuns({
        controlPlaneStore,
        instanceId,
        runTracker,
        staleTtlMs,
        workflowRunRepo: repoContext.workflowRunRepo,
        markDirty: repoContext.markDirty,
      });
      if (remoteReaped > 0) {
        logger
          .info`Reaped ${remoteReaped} run(s) from dead remote instance(s)`;
      }

      const deadPidRunsRemote = runTracker.reapDeadProcessRuns(instanceId);
      for (const run of deadPidRunsRemote) {
        logger.warn`Reaped dead-process ${run.runKind} run ${run.id} (${
          run.methodName ?? run.workflowName ?? "unknown"
        })`;
      }
    }

    const configuredWebhookWorkflows = new Set(
      webhookEndpoints.map((e) => e.workflowIdOrName),
    );
    const configuredWebhookRoutes = new Set(
      webhookEndpoints.map((e) => e.route),
    );
    const allWorkflows = await repoContext.workflowRepo.findAll();
    const configuredCronWorkflows = new Set(
      allWorkflows.filter((w) => w.schedule).map((w) => w.name),
    );
    const replayed = await replayPendingRuns({
      runTracker,
      webhookService: webhookService ?? undefined,
      scheduledExecution: scheduledExecution ?? undefined,
      controlPlaneStore,
      configuredWebhookWorkflows,
      configuredWebhookRoutes,
      configuredCronWorkflows,
    });
    if (replayed > 0) {
      logger.info`Replayed ${replayed} pending run(s) from previous process`;
    }

    if (hasRemoteControlPlane) {
      const scheme = tlsEnabled ? "https" : "http";
      const serveAddress = `${scheme}://${host}:${port}`;
      heartbeatService = new InstanceHeartbeatService(
        controlPlaneStore,
        instanceId,
        {
          ...(heartbeatIntervalMs ? { intervalMs: heartbeatIntervalMs } : {}),
          address: serveAddress,
        },
      );
      await heartbeatService.start();
      logger.info`Instance heartbeat started (id: ${instanceId})`;

      const RECONCILIATION_INTERVAL_MS = reconciliationIntervalMs ?? 60_000;
      let knownPeerIds: Set<string> | null = null;
      const runReconciliationTick = async () => {
        try {
          const reaped = await reconcileRemoteInterruptedRuns({
            controlPlaneStore,
            instanceId,
            runTracker,
            staleTtlMs,
            workflowRunRepo: repoContext.workflowRunRepo,
            markDirty: repoContext.markDirty,
          });
          if (reaped > 0) {
            logger
              .info`Continuous reconciliation reaped ${reaped} run(s)`;
          }
        } catch (err: unknown) {
          logger.warn(
            "Continuous reconciliation failed: {error}",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
        try {
          await cleanupExpiredClaims({
            controlPlaneStore,
          });
        } catch (err: unknown) {
          logger.warn(
            "Reconciliation claim cleanup failed: {error}",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
        try {
          const keys = await controlPlaneStore.list("heartbeats/");
          const currentPeerIds = new Set<string>();
          for (const key of keys) {
            const parts = key.split("/");
            if (parts.length >= 2) currentPeerIds.add(parts[1]);
          }
          if (knownPeerIds !== null) {
            for (const id of currentPeerIds) {
              if (!knownPeerIds.has(id)) {
                emitSystemAuditEvent(
                  connectionCtx,
                  "instance.join",
                  `instanceId=${id}`,
                );
              }
            }
            for (const id of knownPeerIds) {
              if (!currentPeerIds.has(id)) {
                emitSystemAuditEvent(
                  connectionCtx,
                  "instance.leave",
                  `instanceId=${id}`,
                );
              }
            }
          }
          knownPeerIds = currentPeerIds;
        } catch (err: unknown) {
          logger.warn(
            "Peer delta check failed: {error}",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      };
      const scheduleReconciliation = () => {
        const jitter = new Uint32Array(1);
        crypto.getRandomValues(jitter);
        const jitterMs = (jitter[0] / 0xFFFFFFFF) * RECONCILIATION_JITTER_MS;
        const timer = setTimeout(
          () =>
            runReconciliationTick().catch(() => {}).finally(
              scheduleReconciliation,
            ),
          RECONCILIATION_INTERVAL_MS + jitterMs,
        );
        Deno.unrefTimer(timer);
      };
      scheduleReconciliation();
      logger.info("Continuous reconciliation timer started");
    }

    if (controlPlaneStore?.putIfAbsent) {
      const FIRE_RECORD_REAP_INTERVAL_MS = 10 * 60 * 1000;
      const FIRE_RECORD_TTL_MS = 4 * 60 * 60 * 1000;
      const reapFireRecords = async () => {
        try {
          const keys = await controlPlaneStore!.list("fire-records/");
          const cutoff = Date.now() - FIRE_RECORD_TTL_MS;
          for (const key of keys) {
            const segments = key.split("/");
            if (segments.length < 3) continue;
            const timePart = segments.slice(2).join("/");
            const isoTime = timePart.replace(
              /T(\d{2})-(\d{2})-(\d{2})Z/,
              "T$1:$2:$3Z",
            );
            const ts = new Date(isoTime).getTime();
            if (Number.isNaN(ts) || ts < cutoff) {
              await controlPlaneStore!.delete(key);
            }
          }
        } catch (err: unknown) {
          logger.warn(
            "Fire record reaper failed: {error}",
            { error: err instanceof Error ? err.message : String(err) },
          );
        }
      };
      // Armed detached so the reaper's work never joins swamp.cli's trace.
      const reaperTimer = runDetached(() =>
        setInterval(
          () => reapFireRecords().catch(() => {}),
          FIRE_RECORD_REAP_INTERVAL_MS,
        )
      );
      Deno.unrefTimer(reaperTimer);
    }

    // Telemetry flush loop. A daemon reaches the CLI's teardown flush only at
    // process exit, so without this everything it spools sits unsent for the
    // life of the process. Absent context = telemetry disabled for this run
    // (--no-telemetry, marker opt-out, user-level opt-out); serve then stays
    // as silent as it has always been.
    const telemetryContext = getActiveTelemetryContext();
    if (telemetryContext) {
      const distinctId = telemetryContext.userId ?? telemetryContext.repoId;
      if (distinctId) {
        telemetryFlushService = new DaemonTelemetryFlushService(
          telemetryContext.service,
          {
            sender: new HttpTelemetrySender(
              telemetryContext.telemetryEndpoint,
              USER_AGENT,
            ),
            distinctId,
            repoId: telemetryContext.repoId,
            authToken: telemetryContext.authToken ?? undefined,
            keepFlushed: telemetryContext.keepFlushed,
          },
        );
        telemetryFlushService.start();
        // Log the identity the daemon will report under. A serve process
        // running with a different HOME than the operator's shell resolves a
        // different user identity, and its runs then credit an account nobody
        // is looking at — indistinguishable at the UI from not reporting at
        // all. The token is never logged, only whether one was found.
        const authenticated = telemetryContext.authToken !== null;
        logger.info(
          "Telemetry: flushing to {endpoint} as {identity} (authenticated: {authenticated})",
          {
            endpoint: telemetryContext.telemetryEndpoint,
            identity: distinctId,
            authenticated,
          },
        );
        if (!authenticated) {
          logger.info(
            "Telemetry: runs are reported but not attributed to your account — run `swamp auth login` or set SWAMP_API_KEY or SWAMP_API_KEY_FILE to authenticate",
          );
        }
      } else {
        let identityPath: string | undefined;
        try {
          identityPath = join(getSwampConfigDir(), "identity.json");
        } catch {
          // HOME not set — the path itself is the problem
        }
        if (identityPath) {
          logger.warn(
            "Telemetry: no user or repo identity resolved — checked {path}; run `swamp auth whoami` to diagnose",
            { path: identityPath },
          );
        } else {
          logger.warn(
            "Telemetry: no user or repo identity resolved — HOME is not set, so no identity file can be located",
          );
        }
      }
    } else {
      logger.info("Telemetry: disabled for this process");
    }

    // Worker GC — prunes disconnected worker records and stale token bindings
    {
      const libCtx = libSwampContextForRepo(repoContext);
      const listDeps = createWorkerListDeps(
        repoContext.dataQueryService,
      );
      const runDeps = await createWorkerModelRunDeps(
        repoDir,
        repoContext,
      );
      const deleteDeps = createModelDeleteDeps(
        repoDir,
        datastoreResolver,
        undefined,
        repoContext.markDirty,
      );

      const buildPruneDeps = (): WorkerPruneDeps => ({
        listWorkers: async () => {
          const records = await repoContext.dataQueryService.query(
            workerGcListPredicate(repoContext.unifiedDataRepo.namespace),
            { loadAttributes: true },
          ) as DataRecord[];
          return records.flatMap((r) => {
            const parsed = WorkerStateSchema.safeParse(r.attributes);
            if (!parsed.success) return [];
            const s = parsed.data;
            return [{
              name: s.name,
              definitionName: `worker-${s.name}`,
              status: s.status,
              tokenName: s.tokenName,
              disconnectedAt: s.disconnectedAt,
            }];
          });
        },
        listTokens: async () => {
          const tokens: WorkerPruneDeps extends
            { listTokens(): Promise<infer R> } ? R : never = [];
          await consumeStream(
            workerTokenList(libCtx, listDeps),
            withDefaults({
              completed: (
                e: {
                  data: {
                    tokens: Array<
                      { name: string; bindings: Array<{ machineId: string }> }
                    >;
                  };
                },
              ) => {
                for (const t of e.data.tokens) {
                  tokens.push({ name: t.name, bindings: t.bindings });
                }
              },
            }),
          );
          return tokens;
        },
        deleteWorker: (definitionName) =>
          modelDelete(libCtx, deleteDeps, {
            modelIdOrName: definitionName,
            force: true,
          }),
        pruneBindings: (tokenName, machineIds) =>
          modelMethodRun(libCtx, runDeps, {
            modelIdOrName: tokenName,
            methodName: "prune_bindings",
            inputs: { machineIds },
            lastEvaluated: false,
          }),
        resolveStaleBindings: async (token, remainingWorkerNames) => {
          const remaining = new Set(remainingWorkerNames);
          const stale: string[] = [];
          for (const binding of token.bindings) {
            const suffix = await fleetMemberSuffix(binding.machineId);
            const expectedName = `${token.name}-${suffix}`;
            if (
              !remaining.has(expectedName) && !remaining.has(token.name)
            ) {
              stale.push(binding.machineId);
            }
          }
          return stale.length > 0 ? stale : null;
        },
      });

      const gcSyncNamespace = isCustomDatastoreConfig(datastoreConfig)
        ? datastoreConfig.namespace
        : undefined;
      workerGcService = new WorkerGcService({
        intervalMs: DEFAULT_WORKER_GC_INTERVAL_MS,
        gracePeriodMs: DEFAULT_WORKER_GC_GRACE_PERIOD_MS,
        syncService,
        syncNamespace: gcSyncNamespace,
        syncGate,
        reapBookkeeping: (gracePeriodMs, isStopping) =>
          reapEndedBookkeepingRecords(
            {
              query: createBookkeepingRecordQuery(
                repoContext.dataQueryService,
              ),
              repo: repoContext.unifiedDataRepo,
              markDirty: repoContext.markDirty,
              syncService,
              syncNamespace: gcSyncNamespace,
              syncGate,
            },
            gracePeriodMs,
            isStopping,
          ),
        runPrune: async (gracePeriodMs: number): Promise<WorkerPruneResult> => {
          const deps = buildPruneDeps();
          let result: WorkerPruneResult = {
            workersDeleted: 0,
            workersFailed: 0,
            bindingsPruned: 0,
            tokensCleaned: 0,
          };
          await consumeStream(
            workerPrune(libCtx, deps, { gracePeriodMs, dryRun: false }),
            withDefaults({
              completed: (e: { result: WorkerPruneResult }) => {
                result = e.result;
              },
              error: (e: { error: { message: string } }) => {
                throw new Error(e.error.message);
              },
            }),
          );
          return result;
        },
      });
      workerGcService.start();
    }

    // Server token GC — deletes revoked tokens, and expired ones past the
    // grace period, in every auth mode. It starts after token secret
    // migration so every token's secret is already where the GC looks.
    if (tokenGcSettings.intervalMs === 0) {
      logger.info("Server token GC disabled (token GC interval is 0)");
      if (merged.tokenGcGracePeriod !== undefined) {
        logger.warn(
          "The token GC grace period (--token-gc-grace-period, SWAMP_TOKEN_GC_GRACE_PERIOD or token-gc-grace-period in serve.yaml) has no effect while the server token GC is disabled",
        );
      }
    } else {
      const tokenGcSync = syncService;
      serverTokenGcService = new ServerTokenGcService(
        createServerTokenGcDeps({
          intervalMs: tokenGcSettings.intervalMs,
          gracePeriodMs: tokenGcSettings.gracePeriodMs,
          dataQueryService: repoContext.dataQueryService,
          ...createServerTokenGcRepos(
            resolvedRepoDir,
            repoContext,
            datastoreResolver,
          ),
          vaultService: await VaultService.fromRepository(resolvedRepoDir, {
            defaultVaultName: repoMarker?.defaultVault,
          }),
          libCtx: libSwampContextForRepo(repoContext),
          pushChanged: tokenGcSync
            ? async () => {
              await tokenGcSync.pushChanged({ namespace: serveNamespace });
            }
            : undefined,
          syncGate,
        }),
      );
      serverTokenGcService.start();
    }

    isReady = true;
    logger.info("Startup complete — /ready is now serving 200");

    await server.finished;

    repoContext.catalogStore.close();
  })
  .command("reload", reloadCommand)
  .command("check-config", checkConfigCommand)
  .command("daemon", daemonCommand);
