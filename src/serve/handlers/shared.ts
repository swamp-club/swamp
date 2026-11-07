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
  integrationOfClient,
  isIntegrationClient,
} from "../../domain/access/client.ts";
import type { IntegrationDirectory } from "../../domain/access/integration_directory.ts";
import type { FollowerCatchUp } from "../follower_feed.ts";
import type { GcMutex } from "../gc_mutex.ts";
import type { EventLoopLagReader } from "../ws_request_span.ts";
import type { DefinitionOwnerIndex } from "../../domain/definitions/repositories.ts";
import {
  markActiveSpanError,
  setActiveSpanAttributes,
  withSpan,
} from "../../infrastructure/tracing/mod.ts";
import { gzipSync } from "node:zlib";
import {
  FRAME_TOO_LARGE,
  MAX_RPC_FRAME_BYTES,
} from "../../domain/remote/rpc_channel.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { GrantUsernameResolver } from "../../domain/access/grant_username_resolution.ts";
import { repoUnitOfWorkFactory } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import {
  CONFIG_EDIT_CONFLICT_CODE,
  configEditConflictOf,
} from "../../domain/datastore_v3/config_edit_conflict.ts";
import { V3_REPLICATION_UNCONFIRMED_CODE } from "../../domain/datastore_v3/litestream_replication.ts";
import {
  V3_STORAGE_UNREACHABLE_CODE,
  V3_WRITER_BUSY_CODE,
  WRITER_FENCED_CODE,
} from "../../domain/datastore_v3/writer_lease.ts";
import { SERVE_NOT_LEADER_CODE } from "../../domain/datastore_v3/serve_leader.ts";
import {
  COMMIT_PARTLY_COMMITTED_CODE,
  COMMIT_UNREACHABLE_CODE,
  CommitUnreachableError,
  RUN_PARTLY_COMMITTED_CODE,
  RunPartlyCommittedError,
  withRunUnknownSteps,
} from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { UserError } from "../../domain/errors.ts";
import { secretRefusalCode } from "../../domain/expressions/errors.ts";
import {
  createLibSwampContext,
  type LibSwampContext,
} from "../../libswamp/context.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import type { LockTimeoutError } from "../../domain/datastore/distributed_lock.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import type { ControlPlaneStore } from "../../domain/datastore/control_plane_store.ts";
import type { RunCancelRegistry } from "../run_cancel_registry.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { SerializedEvent, ServerMessage } from "../protocol.ts";
import type { WorkerGateway } from "../worker_gateway.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { readServerTokenRecord } from "../token_auth.ts";
import { displayPrincipal } from "../known_usernames.ts";
import {
  parsePrincipal,
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import type { Action } from "../../domain/access/action.ts";
import { isControlPlaneRecordResource } from "../../domain/access/control_plane_records.ts";
import {
  tagsChanged,
  vaultKindResource,
  type VaultMethod,
} from "../../domain/access/access_resources.ts";
import {
  isControlPlaneModelType,
  normalizeModelTypeName,
} from "../../domain/models/control_plane_types.ts";
import type {
  AccessDecision,
  AccessPrincipal,
  AccessResource,
} from "../../domain/access/access_decision_service.ts";
import type { ResourceKind } from "../../domain/access/resource_selector.ts";
import type { ScheduledExecutionService } from "../../libswamp/workflows/scheduled_execution.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { MergedServeOptions } from "../serve_config.ts";
import type { HealthCollector } from "../health_collector.ts";
import type { AuditEmitter } from "../../domain/serve_audit/audit_emitter.ts";
import type {
  ActorIdentity,
  AuditDecision,
  AuditOutcome,
} from "../../domain/serve_audit/audit_event.ts";
import { buildAuditEvent } from "../../domain/serve_audit/audit_event_builder.ts";
import { resolveActorIdentity } from "../../domain/serve_audit/actor_identity.ts";
import type { AuditStore } from "../../domain/serve_audit/audit_store.ts";
import type { AuditPolicy } from "../../domain/serve_audit/audit_policy.ts";
import type { AuditWal } from "../../domain/serve_audit/audit_wal.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import type { SyncGate } from "../sync_gate.ts";
import type { RunWriteFence } from "../../domain/workflows/run_write_fence.ts";
import { pushNamespace } from "../../infrastructure/persistence/push_paths.ts";
import type { FollowerGate } from "../follower_requests.ts";
import type { LeaderLink } from "../leader_link.ts";
import type { V3CommitFeedSource } from "../../infrastructure/datastore_v3/v3_repo_context.ts";
import type { QuarantineStore } from "../../domain/datastore_v3/quarantine.ts";

const pushLogger = getSwampLogger(["serve", "sync"]);
const streamLogger = getSwampLogger(["serve", "stream"]);

/**
 * each write use case's unit of work is bound to the process's
 * repoContext.markDirty itself, so the repositories stage into it; read use
 * cases never open a unit
 */
export function handlerLibSwampContext(
  ctx: Pick<ConnectionContext, "repoContext">,
  options?: { signal?: AbortSignal },
): LibSwampContext {
  return createLibSwampContext({
    ...options,
    openUnitOfWork: repoUnitOfWorkFactory(ctx.repoContext),
  });
}

export interface PushChangedOptions {
  onError?: (error: string) => void;
}

/**
 * without this push, mutations are lost on cold boot when the local filesystem
 * is ephemeral; a failed push is reported, never thrown
 */
export async function pushChangedToRemote(
  ctx: ConnectionContext,
  options: PushChangedOptions = {},
): Promise<void> {
  const syncService = ctx.syncService;
  if (!syncService) return;
  const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
    ? ctx.datastoreConfig.namespace
    : undefined;
  try {
    await pushNamespace(syncService, namespace);
  } catch (pushError) {
    const error = pushError instanceof Error
      ? pushError.message
      : String(pushError);
    if (options.onError) {
      options.onError(error);
    } else {
      pushLogger.warn("Failed to push changes to remote datastore: {error}", {
        error,
      });
    }
  }
}

export const MAX_CLIENT_ERROR_LENGTH = 512;

export const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private|proc|sys|mnt|srv|run)\//;

export const WINDOWS_PATH_PATTERN = /[A-Z]:\\/i;

export const SWAMP_INTERNAL_PATH_PATTERN = /\/.swamp\//;

const withheldErrorLogger = getSwampLogger(["serve", "error"]);

/**
 * a message that names a path is withheld and replaced with a generic one; the
 * original is logged server-side so the operator can still diagnose the failure
 */
export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    ABSOLUTE_PATH_PATTERN.test(raw) ||
    WINDOWS_PATH_PATTERN.test(raw) ||
    SWAMP_INTERNAL_PATH_PATTERN.test(raw)
  ) {
    withheldErrorLogger.warn(
      "Error withheld from client ({type}): {message}",
      {
        type: exceptionTypeForClient(error) ??
          (error instanceof Error ? "Error" : typeof error),
        message: raw,
      },
    );
    return "An internal error occurred";
  }
  if (raw.length > MAX_CLIENT_ERROR_LENGTH) {
    return raw.slice(0, MAX_CLIENT_ERROR_LENGTH) + "...";
  }
  return raw;
}

// Exception class names (e.g. "LockTimeoutError") are safe to surface — they
// carry no user data or paths, unlike the message which may contain either.
export function exceptionTypeForClient(error: unknown): string | undefined {
  if (error instanceof Error) {
    const ctorName = error.constructor.name;
    if (ctorName && ctorName !== "Error") return ctorName;
    if (error.name && error.name !== "Error") return error.name;
  }
  return undefined;
}

function isPathLike(value: string): boolean {
  return ABSOLUTE_PATH_PATTERN.test(value) ||
    WINDOWS_PATH_PATTERN.test(value) ||
    SWAMP_INTERNAL_PATH_PATTERN.test(value);
}

export interface LockTimeoutClientError {
  code: "lock_timeout";
  message: string;
  details: { retryable: true; exceptionType: "LockTimeoutError" };
}

export function lockTimeoutErrorForClient(
  error: LockTimeoutError,
): LockTimeoutClientError {
  const safeLockKey = isPathLike(error.lockKey)
    ? "behavior lock"
    : error.lockKey;
  const message = error.holder
    ? `Lock contention on "${safeLockKey}" held by ${error.holder.holder} ` +
      `(pid ${error.holder.pid}) — timed out after ${error.waitedMs}ms`
    : `Lock contention on "${safeLockKey}" — timed out after ${error.waitedMs}ms`;
  return {
    code: "lock_timeout",
    message,
    details: { retryable: true, exceptionType: "LockTimeoutError" },
  };
}

export class LibSwampStreamError extends Error {
  constructor(readonly swampError: SwampError) {
    super(swampError.message);
    this.name = "LibSwampStreamError";
  }
}

export type ClientErrorReason =
  | "not_found"
  | "validation_failed"
  | "data_pending";

const CLIENT_ERROR_REASONS: ReadonlySet<string> = new Set<ClientErrorReason>([
  "not_found",
  "validation_failed",
  "data_pending",
]);

// Fixed entity labels passed to libswamp's notFound(); never user data.
const CLIENT_ENTITY_TYPES: ReadonlySet<string> = new Set([
  "Model",
  "Workflow",
  "Workflow run",
  "Workflow run or workflow",
  "Data",
]);

export interface ClientErrorDetails {
  reason: ClientErrorReason;
  entityType?: string;
  reapedBefore?: string;
  retention?: string;
}

// A retention timeframe as `.swamp.yaml` spells it (e.g. `14d`, `2w`).
const RETENTION_TIMEFRAME = /^[0-9A-Za-z ]{1,32}$/;

/**
 * never user data: the cutoff is a timestamp and the timeframe comes from the
 * repository's own configuration
 */
function reapedDetails(
  details: object,
): { reapedBefore: string; retention: string } | undefined {
  const { reapedBefore, retention } = details as {
    reapedBefore?: unknown;
    retention?: unknown;
  };
  if (typeof reapedBefore !== "string" || typeof retention !== "string") {
    return undefined;
  }
  const cutoff = Date.parse(reapedBefore);
  if (Number.isNaN(cutoff) || !RETENTION_TIMEFRAME.test(retention)) {
    return undefined;
  }
  return { reapedBefore: new Date(cutoff).toISOString(), retention };
}

/**
 * returns undefined for anything else, so identifiers and message fragments
 * never reach the client through `details`
 */
export function clientErrorDetails(
  error: unknown,
): ClientErrorDetails | undefined {
  if (!(error instanceof LibSwampStreamError)) return undefined;
  const { code, details } = error.swampError;
  if (!CLIENT_ERROR_REASONS.has(code)) return undefined;
  const entityType = details !== null && typeof details === "object" &&
      "entityType" in details && typeof details.entityType === "string" &&
      CLIENT_ENTITY_TYPES.has(details.entityType)
    ? details.entityType
    : undefined;
  const reaped = code === "not_found" && details !== null &&
      typeof details === "object"
    ? reapedDetails(details)
    : undefined;
  return {
    reason: code as ClientErrorReason,
    ...(entityType !== undefined && { entityType }),
    ...reaped,
  };
}

export const MAX_PREDICATE_LENGTH = 4096;

export { MAX_QUERY_RESULTS } from "../../domain/data/query_sort.ts";

export const DEFAULT_QUERY_LIMIT = 1000;

export interface ConnectionContext {
  integrationDirectory?: IntegrationDirectory;
  repoDir: string;
  repoContext: RepositoryContext;
  followerGate?: FollowerGate;
  leaderLink?: LeaderLink;
  feedBarrier?: () => Promise<void>;
  followerCatchUp?: () => Promise<FollowerCatchUp>;
  commitFeed?: V3CommitFeedSource;
  quarantine?: QuarantineStore;
  explicitLeases?: () => readonly {
    readonly lockKey: string;
    readonly principal: string;
    readonly expiresAt: string;
  }[];
  gcMutex?: GcMutex;
  eventLoopLag?: EventLoopLagReader;
  definitionIndex?: DefinitionOwnerIndex;
  ownerAddress?: string;
  datastoreConfig: DatastoreConfig;
  datastoreResolver: DatastorePathResolver;
  /**
   * same one the repo context's markDirty hook references; undefined for
   * filesystem datastores or custom datastores without a cache
   */
  syncService?: DatastoreSyncService;
  /**
   * serializes poller pulls against whole mutation+push units, so a pull cannot
   * land between a local delete and the push that deletes the remote object;
   * present whenever syncService is. Not reentrant.
   */
  syncGate?: SyncGate;
  runWriteFence?: RunWriteFence;
  /**
   * set only on a v3 datastore while replication is on, so without it nothing
   * waits
   */
  confirmReplicated?: () => Promise<void>;
  /**
   * read when a write request starts, so one that committed nothing, such as
   * `run doctor` without `--fix`, never waits on other writers' commits
   */
  replicationMark?: () => number;
  /**
   * set on every v3 datastore, which commits when a root ends, replicating or
   * not; confirmReplicated adds the replication check on top
   */
  holdRepliesUntilCommitted?: boolean;
  workerGateway?: WorkerGateway;
  policySnapshotLoader?: PolicySnapshotLoader;
  authConfig: ServeAuthConfig;
  cancelRegistry?: RunCancelRegistry;
  activeRunRegistry?: import("../active_run_registry.ts").ActiveRunRegistry;
  runTracker?: RunTrackerRepository;
  dispatchService?: import("../dispatch_service.ts").DispatchService;
  controlPlaneStore?: ControlPlaneStore;
  defaultVault?: string;
  instanceId?: string;
  staleTtlMs?: number;
  grantsFile?: string;
  grantsDir?: string;
  hotReload?: boolean;
  serveConfigPath?: string;
  scheduledExecution?: ScheduledExecutionService;
  webhookRuns?: Pick<
    import("../webhook.ts").WebhookService,
    "workflowOfRun" | "cancelByRunId"
  >;
  workflowReloader?: () => Promise<number>;
  extensionChangeReloader?: () => Promise<
    import("../protocol.ts").ServeReloadResponse
  >;
  webhookAdmissionSnapshots?: () =>
    import("../../domain/remote/run_progress.ts").WebhookAdmissionSnapshot[];
  webhookUpdater?: (
    configs: readonly import("../serve_config.ts").WebhookConfigEntry[],
  ) => Promise<number>;
  resolvedUserNames?: Record<string, string>;
  grantUsernameResolver?: GrantUsernameResolver;
  serveOptions?: MergedServeOptions;
  healthCollector?: HealthCollector;
  vaultsDir?: string;
  managedDefinitionsDir?: string;
  auditEmitter?: AuditEmitter;
  auditStores?: readonly AuditStore[];
  auditPolicy?: AuditPolicy;
  auditFailOpen?: boolean;
  auditWal?: AuditWal;
  auditWebSocketSink?: import("../audit_sinks/websocket_sink.ts").WebSocketSink;
  auditNamespace?: string;
  auditSinkRebuilder?: () => Promise<
    import("../../domain/serve_audit/audit_sink.ts").AuditSink[]
  >;
  auditVaultService?:
    import("../../domain/vaults/vault_service.ts").VaultService;
  auditHmacConfig?: { vaultName: string; keyName: string };
}

// authorize on canonical model types, never raw client input; any type that
// normalizes to a control-plane type (access control or worker fleet) requires
// admin
export function isAccessModelType(
  typeArg: string | undefined,
  resolvedType: string | undefined,
): boolean {
  if (typeArg && isControlPlaneModelType(requestedTypeKey(typeArg))) {
    return true;
  }
  if (resolvedType && isControlPlaneModelType(resolvedType)) return true;
  return false;
}

/**
 * requested, resolved and listed types are compared by normalized key so any
 * spelling restricts every path; list entries are canonicalized here too in
 * case the config skipped the parser
 */
export function isAdminOnlyModelType(
  typeArg: string | undefined,
  resolvedType: string | undefined,
  restrictedModelTypes: readonly string[],
): boolean {
  if (isAccessModelType(typeArg, resolvedType)) return true;
  if (restrictedModelTypes.length === 0) return false;
  const restricted = new Set(
    restrictedModelTypes.map((entry) => normalizeModelTypeName(entry)),
  );
  if (typeArg && restricted.has(requestedTypeKey(typeArg))) return true;
  if (resolvedType) {
    const resolvedKey = normalizeModelTypeName(resolvedType);
    // A stored type that names no type cannot be judged; require admin.
    if (resolvedKey === null || restricted.has(resolvedKey)) return true;
  }
  return false;
}

/**
 * a blank or separator-only type names no type and fails the request rather
 * than passing the gate unjudged
 */
function requestedTypeKey(typeArg: string): string {
  const key = normalizeModelTypeName(typeArg);
  if (key === null) {
    throw new Error(`Invalid behavior type: ${JSON.stringify(typeArg)}`);
  }
  return key;
}

export function isRestrictedCommand(
  command: string,
  restrictedCommands: readonly string[],
): boolean {
  if (restrictedCommands.length === 0) return false;
  return restrictedCommands.includes(command);
}

const connectionCollectives = new WeakMap<WebSocket, readonly string[]>();
const connectionGroups = new WeakMap<WebSocket, readonly string[]>();
const connectionPrincipalId = new WeakMap<WebSocket, string>();
const connectionSourceIp = new WeakMap<WebSocket, string>();
const connectionLoginIdentity = new WeakMap<WebSocket, ActorIdentity>();
const connectionClient = new WeakMap<WebSocket, string>();
const connectionCompression = new WeakMap<WebSocket, ConnectionCompression>();
const principalSockets = new Map<string, Set<WebSocket>>();
const connectionTokens = new WeakMap<WebSocket, TokenSessionBinding>();
const tokenSockets = new Map<string, Set<WebSocket>>();
const tokenStreams = new Map<string, Set<StreamSession>>();

export function setConnectionCollectives(
  socket: WebSocket,
  collectives: readonly string[],
  groups: readonly string[],
  principalId?: string,
): void {
  connectionCollectives.set(socket, collectives);
  connectionGroups.set(socket, groups);
  if (principalId) {
    connectionPrincipalId.set(socket, principalId);
    let sockets = principalSockets.get(principalId);
    if (!sockets) {
      sockets = new Set();
      principalSockets.set(principalId, sockets);
    }
    sockets.add(socket);
  }
}

export function removeConnection(socket: WebSocket): void {
  const principalId = connectionPrincipalId.get(socket);
  if (principalId) {
    const sockets = principalSockets.get(principalId);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        principalSockets.delete(principalId);
      }
    }
    connectionPrincipalId.delete(socket);
  }
  const binding = connectionTokens.get(socket);
  if (binding) {
    const sockets = tokenSockets.get(binding.name);
    if (sockets) {
      sockets.delete(socket);
      if (sockets.size === 0) {
        tokenSockets.delete(binding.name);
      }
    }
    connectionTokens.delete(socket);
  }
}

export function updateCollectivesForPrincipal(
  principalId: string,
  collectives: readonly string[],
  groups: readonly string[],
): void {
  for (const socket of principalSockets.get(principalId) ?? []) {
    connectionCollectives.set(socket, collectives);
    connectionGroups.set(socket, groups);
  }
  // A stream authorized each snapshot with the memberships it opened with.
  // End it so the client reconnects and is authorized with the new ones.
  for (const streams of [...tokenStreams.values()]) {
    for (const stream of [...streams]) {
      if (stream.binding.principalId !== principalId) continue;
      unregisterStream(stream);
      closeStream(
        stream,
        ACCESS_CHANGED_CLOSE_CODE,
        STREAM_ACCESS_CHANGED_REASON,
      );
    }
  }
}

export function closeConnectionsForPrincipal(principalId: string): void {
  const sockets = principalSockets.get(principalId);
  for (const socket of [...(sockets ?? [])]) {
    closeSession(socket, 4003, PRINCIPAL_REVOKED_REASON);
  }
  for (const streams of [...tokenStreams.values()]) {
    for (const stream of [...streams]) {
      if (stream.binding.principalId !== principalId) continue;
      unregisterStream(stream);
      closeStream(stream, 4003, PRINCIPAL_REVOKED_REASON);
    }
  }
}

const connectionTeardowns = new WeakMap<WebSocket, () => void>();

export function setConnectionTeardown(
  socket: WebSocket,
  teardown: () => void,
): void {
  connectionTeardowns.set(socket, teardown);
}

/**
 * stop the session's work now: the close event waits for the peer's close
 * handshake, which a peer ignoring the close frame could withhold indefinitely
 */
export function closeSession(
  socket: WebSocket,
  code: number,
  reason: string,
): void {
  try {
    connectionTeardowns.get(socket)?.();
  } catch (error) {
    sessionLogger.warn("Session teardown failed before close: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  socket.close(code, reason);
}

export interface TokenSessionBinding {
  readonly name: string;
  readonly createdAt: string;
  readonly principalId: string;
}

/** required so no stream can forget it and survive a revoke */
export interface StreamSessionBinding extends TokenSessionBinding {
  readonly client: string | undefined;
}

export type TokenSessionTerminationCause =
  | "revoked"
  | "rotated"
  | "expired"
  | "deleted"
  | "invalid"
  | "integration-revoked"
  | "integration-narrowed";

// each close reason names its cause so a client can tell a revoked token from a
// principal losing access; keep under the close-frame size limit
export const PRINCIPAL_REVOKED_REASON = "Session revoked: access removed";
export const ACCESS_CHANGED_CLOSE_CODE = 4004;
export const STREAM_ACCESS_CHANGED_REASON =
  "Session ended: access changed, reconnect";
export const TOKEN_REVOKED_REASON = "Session revoked: token revoked";
export const TOKEN_ROTATED_REASON =
  "Session revoked: token rotated, reconnect with the new credential";
export const TOKEN_GONE_REASON = "Session revoked: token no longer exists";
export const TOKEN_INVALID_REASON =
  "Session revoked: token record is unreadable";
// Unlike the 8-hour session cap, reconnecting with the same token will fail.
export const TOKEN_EXPIRED_REASON =
  "Session expired: token expired, re-authenticate with a new token";

export interface TokenSessionAuditContext {
  readonly emitter?: Pick<AuditEmitter, "emit">;
  readonly instanceId?: string;
}

export interface TerminateTokenSessionsOptions {
  readonly onlyCreatedAt?: string;
  readonly exceptCreatedAt?: string;
  readonly code: number;
  readonly reason: string;
  readonly cause: TokenSessionTerminationCause;
  readonly initiatedBy: string;
  /** of the request ending the sessions; serve's own revalidation has none */
  readonly client?: string;
  readonly requestId?: string;
  readonly audit?: TokenSessionAuditContext;
}

const sessionLogger = getSwampLogger(["serve", "sessions"]);

/**
 * streams run until the client leaves, so bound them or a token holder could
 * hold open unlimited streams
 */
export const MAX_STREAM_SESSIONS_PER_TOKEN = 10;

/**
 * counted across all of a principal's tokens so minting more tokens does not
 * raise the bound
 */
export const MAX_STREAM_SESSIONS_PER_PRINCIPAL = 20;

export interface StreamSessionHandle {
  readonly sourceIp: string;
  close(code: number, reason: string): void;
}

interface StreamSession {
  readonly binding: StreamSessionBinding;
  readonly handle: StreamSessionHandle;
}

/** the token count spans every mint of the name, so rotating does not reset it */
export function registerStreamSession(
  binding: StreamSessionBinding,
  handle: StreamSessionHandle,
): (() => void) | null {
  let streams = tokenStreams.get(binding.name);
  if (streams && streams.size >= MAX_STREAM_SESSIONS_PER_TOKEN) return null;
  if (
    principalStreamCount(binding.principalId) >=
      MAX_STREAM_SESSIONS_PER_PRINCIPAL
  ) {
    return null;
  }
  if (!streams) {
    streams = new Set();
    tokenStreams.set(binding.name, streams);
  }
  const session: StreamSession = { binding, handle };
  streams.add(session);
  return () => unregisterStream(session);
}

function principalStreamCount(principalId: string): number {
  let count = 0;
  for (const streams of tokenStreams.values()) {
    for (const stream of streams) {
      if (stream.binding.principalId === principalId) count++;
    }
  }
  return count;
}

function unregisterStream(session: StreamSession): void {
  const streams = tokenStreams.get(session.binding.name);
  if (!streams?.delete(session)) return;
  if (streams.size === 0) tokenStreams.delete(session.binding.name);
}

function closeStream(session: StreamSession, code: number, reason: string) {
  try {
    session.handle.close(code, reason);
  } catch (error) {
    sessionLogger.warn("Failed to close stream session: {error}", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export function setConnectionToken(
  socket: WebSocket,
  binding: TokenSessionBinding,
): void {
  connectionTokens.set(socket, binding);
  let sockets = tokenSockets.get(binding.name);
  if (!sockets) {
    sockets = new Set();
    tokenSockets.set(binding.name, sockets);
  }
  sockets.add(socket);
}

export function listTokenSessions(): {
  name: string;
  createdAt: string;
}[] {
  const mintsByName = new Map<string, Set<string>>();
  const addMint = (name: string, createdAt: string) => {
    let mints = mintsByName.get(name);
    if (!mints) {
      mints = new Set();
      mintsByName.set(name, mints);
    }
    mints.add(createdAt);
  };
  for (const [name, sockets] of tokenSockets) {
    for (const socket of sockets) {
      const binding = connectionTokens.get(socket);
      if (binding) addMint(name, binding.createdAt);
    }
  }
  for (const [name, streams] of tokenStreams) {
    for (const stream of streams) addMint(name, stream.binding.createdAt);
  }
  const sessions: { name: string; createdAt: string }[] = [];
  for (const [name, mints] of mintsByName) {
    for (const createdAt of mints) sessions.push({ name, createdAt });
  }
  return sessions;
}

export function terminateTokenSessions(
  name: string,
  options: TerminateTokenSessionsOptions,
): number {
  const matches = (binding: TokenSessionBinding | undefined) => {
    if (!binding) return false;
    if (
      options.onlyCreatedAt !== undefined &&
      binding.createdAt !== options.onlyCreatedAt
    ) return false;
    if (
      options.exceptCreatedAt !== undefined &&
      binding.createdAt === options.exceptCreatedAt
    ) return false;
    return true;
  };

  const sockets = tokenSockets.get(name);
  // Copy first: closing a socket runs removeConnection, which edits the set.
  const targets = [...(sockets ?? [])].filter((socket) =>
    matches(connectionTokens.get(socket))
  );
  for (const socket of targets) {
    emitSessionTerminated(
      connectionTokens.get(socket)?.principalId ?? "",
      getConnectionSourceIp(socket),
      name,
      options,
    );
    // Unbind before closing: the close event (and removeConnection) waits for
    // the peer's close handshake, and a peer that never answers must not be
    // listed, closed and audited again on every revalidation pass.
    sockets?.delete(socket);
    connectionTokens.delete(socket);
    closeSession(socket, options.code, options.reason);
  }
  if (sockets?.size === 0) tokenSockets.delete(name);

  const streamTargets = [...(tokenStreams.get(name) ?? [])].filter((stream) =>
    matches(stream.binding)
  );
  for (const stream of streamTargets) {
    emitSessionTerminated(
      stream.binding.principalId,
      stream.handle.sourceIp,
      name,
      options,
    );
    unregisterStream(stream);
    closeStream(stream, options.code, options.reason);
  }

  const closed = targets.length + streamTargets.length;
  if (closed > 0) {
    sessionLogger.info(
      "Closed {count} session(s) for token {name} ({cause})",
      { count: closed, name, cause: options.cause },
    );
  }
  return closed;
}

function emitSessionTerminated(
  principalId: string,
  sourceIp: string,
  name: string,
  options: TerminateTokenSessionsOptions,
): void {
  const emitter = options.audit?.emitter;
  if (!emitter) return;
  try {
    const principal = parsePrincipal(principalId);
    emitter.emit(buildAuditEvent({
      instanceId: options.audit?.instanceId ?? "unknown",
      category: "auth",
      stage: "response",
      outcome: "success",
      action: "auth.session.terminated",
      resourceKind: "server-token",
      resourceName: name,
      principalKind: principal.kind,
      principalId: principal.id,
      initiatedBy: options.initiatedBy,
      client: options.client,
      sourceIp,
      requestId: options.requestId ?? crypto.randomUUID(),
      detail: options.cause,
    }));
  } catch (error) {
    // Best-effort: an audit failure must never keep a dead session open.
    sessionLogger.warn(
      "Failed to emit session termination audit event for {name}: {error}",
      { name, error: error instanceof Error ? error.message : String(error) },
    );
  }
}

function clientNamesIntegration(
  client: string | undefined,
  id: string,
): boolean {
  const integration = integrationOfClient(client);
  return integration.kind === "integration" && integration.id === id;
}

/**
 * a request decides afresh, but a stream authorized when it opened would keep
 * flowing; closing a session leaves a started run running
 */
export function terminateIntegrationSessions(
  id: string,
  options: Omit<
    TerminateTokenSessionsOptions,
    "onlyCreatedAt" | "exceptCreatedAt"
  >,
): number {
  let closed = 0;
  const names = new Set([...tokenSockets.keys(), ...tokenStreams.keys()]);
  for (const name of names) {
    for (const socket of [...(tokenSockets.get(name) ?? [])]) {
      if (!clientNamesIntegration(connectionClient.get(socket), id)) continue;
      emitSessionTerminated(
        connectionTokens.get(socket)?.principalId ?? "",
        getConnectionSourceIp(socket),
        name,
        options,
      );
      tokenSockets.get(name)?.delete(socket);
      connectionTokens.delete(socket);
      closeSession(socket, options.code, options.reason);
      closed++;
    }
    if (tokenSockets.get(name)?.size === 0) tokenSockets.delete(name);
    for (const stream of [...(tokenStreams.get(name) ?? [])]) {
      if (!clientNamesIntegration(stream.binding.client, id)) continue;
      emitSessionTerminated(
        stream.binding.principalId,
        stream.handle.sourceIp,
        name,
        options,
      );
      unregisterStream(stream);
      closeStream(stream, options.code, options.reason);
      closed++;
    }
  }
  return closed;
}

export function getConnectionCollectives(
  socket: WebSocket,
): readonly string[] {
  return connectionCollectives.get(socket) ?? [];
}

export function getConnectionGroups(socket: WebSocket): readonly string[] {
  return connectionGroups.get(socket) ?? [];
}

export function setConnectionSourceIp(
  socket: WebSocket,
  ip: string,
): void {
  connectionSourceIp.set(socket, ip);
}

/**
 * Deno upgradeWebSocket cannot negotiate permessage-deflate, so large frames go
 * as gzip binary frames to clients that opt in
 */
export type ConnectionCompression = "gzip";

export const COMPRESSION_THRESHOLD_BYTES = 16 * 1024;

/**
 * the opt-in is in the query string because the subprotocol slot already
 * carries the bearer token
 */
export function resolveConnectionCompression(
  url: string,
): ConnectionCompression | undefined {
  return new URL(url).searchParams.get("compress") === "gzip"
    ? "gzip"
    : undefined;
}

export function setConnectionCompression(
  socket: WebSocket,
  compression: ConnectionCompression | undefined,
): void {
  if (compression) connectionCompression.set(socket, compression);
}

export function getConnectionSourceIp(socket: WebSocket): string {
  return connectionSourceIp.get(socket) ?? "unknown";
}

export function setConnectionLoginIdentity(
  socket: WebSocket,
  identity: ActorIdentity | undefined,
): void {
  if (identity) connectionLoginIdentity.set(socket, identity);
}

export function getConnectionLoginIdentity(
  socket: WebSocket,
): ActorIdentity | undefined {
  return connectionLoginIdentity.get(socket);
}

export function setConnectionClient(
  socket: WebSocket,
  client: string | undefined,
): void {
  if (client !== undefined) connectionClient.set(socket, client);
}

export function getConnectionClient(socket: WebSocket): string | undefined {
  return connectionClient.get(socket);
}

/**
 * Binds what a credential proved to its connection. A follower forwards the
 * credential, so the leader binds the same values from its own read of it.
 */
export function bindAuthenticatedConnection(
  socket: WebSocket,
  auth: {
    readonly principalId: string;
    readonly collectives: readonly string[];
    readonly groups: readonly string[];
    readonly tokenName: string;
    readonly tokenCreatedAt: string;
    readonly oauthIdentity?: ActorIdentity;
    readonly client?: string;
  },
): void {
  setConnectionCollectives(
    socket,
    auth.collectives,
    auth.groups,
    auth.principalId,
  );
  setConnectionToken(socket, {
    name: auth.tokenName,
    createdAt: auth.tokenCreatedAt,
    principalId: auth.principalId,
  });
  setConnectionLoginIdentity(socket, auth.oauthIdentity);
  setConnectionClient(socket, auth.client);
}

export function connectionActorIdentity(
  socket: WebSocket,
  principal: Principal | null,
  ctx: Pick<ConnectionContext, "resolvedUserNames">,
): ActorIdentity | undefined {
  return resolveActorIdentity(
    principal,
    ctx.resolvedUserNames,
    connectionLoginIdentity.get(socket),
  );
}

export interface AuthorizationResult {
  readonly allowed: boolean;
  readonly decision: AccessDecision | null;
}

type AccessOutcome =
  | { kind: "allowed"; decision: AccessDecision | null }
  | { kind: "not_configured" }
  | { kind: "no_principal" }
  | {
    kind: "refused";
    principal: Principal;
    decision: AccessDecision | null;
    groups: readonly string[];
  };

export interface AccessCaller {
  readonly principal: Principal | null;
  readonly collectives: readonly string[];
  readonly groups: readonly string[];
  readonly sourceIp: string;
  readonly loginIdentity?: ActorIdentity;
  readonly client?: string;
}

type DenialOrigin = Pick<AccessCaller, "sourceIp" | "loginIdentity" | "client">;

export function accessCallerOf(
  socket: WebSocket,
  principal: Principal | null,
): AccessCaller {
  return {
    principal,
    collectives: connectionCollectives.get(socket) ?? [],
    groups: connectionGroups.get(socket) ?? [],
    sourceIp: getConnectionSourceIp(socket),
    loginIdentity: connectionLoginIdentity.get(socket),
    client: connectionClient.get(socket),
  };
}

function decideAccess(
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
  every = false,
): AccessOutcome {
  return decideForCaller(
    accessCallerOf(socket, principal),
    action,
    resource,
    ctx,
    every,
  );
}

function decideForCaller(
  caller: AccessCaller,
  action: Action,
  resource: AccessResource,
  ctx: Pick<ConnectionContext, "authConfig" | "policySnapshotLoader">,
  every = false,
): AccessOutcome {
  if (ctx.authConfig.mode === "none") {
    return { kind: "allowed", decision: null };
  }
  if (!ctx.policySnapshotLoader) return { kind: "not_configured" };
  const { principal } = caller;
  if (!principal) return { kind: "no_principal" };

  const collectives = [...caller.collectives];
  const groups = [...caller.groups];
  const service = ctx.policySnapshotLoader.decisionService;
  const accessPrincipal: AccessPrincipal = {
    principal,
    collectives,
    groups,
    client: caller.client,
  };
  const decision = every
    ? service.decideAll(accessPrincipal, action, resource.kind)
    : service.decide(accessPrincipal, action, resource);

  if (decision && decision.effect === "allow") {
    return { kind: "allowed", decision };
  }

  if (!decision) {
    const adminDecision = service.decide(
      accessPrincipal,
      "admin",
      { kind: "access", name: "*", fields: {} },
    );
    if (adminDecision && adminDecision.effect === "allow") {
      return { kind: "allowed", decision: adminDecision };
    }
  }

  return { kind: "refused", principal, decision, groups };
}

/**
 * kept so a later decision made with no socket is taken for the same principal
 * and credential
 */
export interface DecisionSubject {
  readonly principal: Principal | null;
  readonly token?: TokenSessionBinding;
}

export function captureDecisionSubject(
  socket: WebSocket,
  principal: Principal | null,
): DecisionSubject {
  const token = connectionTokens.get(socket);
  return { principal, ...(token ? { token: { ...token } } : {}) };
}

/**
 * memberships are re-read from the token record: it must be active, unexpired,
 * same mint and same principal; no token, record or policy refuses
 */
export async function decideSubjectAccess(
  ctx: ConnectionContext,
  subject: DecisionSubject,
  action: Action,
  resource: AccessResource,
): Promise<boolean> {
  if (ctx.authConfig.mode === "none") return true;
  const loader = ctx.policySnapshotLoader;
  const principal = subject.principal;
  const token = subject.token;
  if (!loader || !principal || !token) return false;
  let record;
  try {
    record = await readServerTokenRecord(ctx.repoContext, token.name);
  } catch {
    return false;
  }
  if (
    record.state !== "active" ||
    Date.parse(record.expiresAt) <= Date.now() ||
    record.createdAt !== token.createdAt ||
    record.principalId !== token.principalId ||
    record.principalId !== principalToString(principal)
  ) {
    return false;
  }
  const subjectPrincipal: AccessPrincipal = {
    principal,
    collectives: record.collectives,
    groups: record.groups,
    client: record.client,
  };
  const service = loader.decisionService;
  const decision = service.decide(subjectPrincipal, action, resource);
  if (decision) return decision.effect === "allow";
  const adminDecision = service.decide(
    subjectPrincipal,
    "admin",
    { kind: "access", name: "*", fields: {} },
  );
  return adminDecision !== null && adminDecision.effect === "allow";
}

export function authorizeOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): AuthorizationResult {
  return replyToOutcome(
    socket,
    requestId,
    principal,
    action,
    resource,
    ctx,
    decideAccess(socket, principal, action, resource, ctx),
  );
}

/**
 * tag is checked on every prior tag set and on the result so a principal cannot
 * move a resource out of or into a tag; a rename counts as a retag; a null
 * stored set fails closed
 */
export function authorizeRetag(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  retag: Retag,
  ctx: ConnectionContext,
): boolean {
  return retagResources(retag).every((resource) =>
    authorizeOrReject(socket, requestId, principal, "tag", resource, ctx)
      .allowed
  );
}

export interface Retag {
  readonly prior: (tags: Record<string, string>) => AccessResource;
  readonly after: AccessResource;
  readonly loaded: Record<string, string>;
  readonly stored: Record<string, string> | null;
  readonly afterTags: Record<string, string>;
}

export function retagResources(retag: Retag): AccessResource[] {
  const { loaded, stored, afterTags } = retag;
  const renamed = retag.prior(loaded).name !== retag.after.name;
  const changed = stored === null
    ? [loaded]
    : [loaded, stored].filter((prior) =>
      renamed || tagsChanged(prior, afterTags)
    );
  if (changed.length === 0) return [];
  const priors = changed.filter((tags, i) =>
    changed.findIndex((other) => !tagsChanged(other, tags)) === i
  );
  return [...priors.map(retag.prior), retag.after];
}

/**
 * any deny for the kind and action refuses whatever its pattern, since the
 * operation reaches every resource
 */
export function authorizeAllOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  kind: ResourceKind,
  ctx: ConnectionContext,
): AuthorizationResult {
  const resource: AccessResource = { kind, name: "*", fields: { name: "*" } };
  return replyToOutcome(
    socket,
    requestId,
    principal,
    action,
    resource,
    ctx,
    decideAccess(socket, principal, action, resource, ctx, true),
    true,
  );
}

function replyToOutcome(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
  outcome: AccessOutcome,
  every = false,
): AuthorizationResult {
  switch (outcome.kind) {
    case "allowed":
      return { allowed: true, decision: outcome.decision };
    case "not_configured":
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Authorization enforcement is enabled but no policy snapshot is available",
      );
      emitDenial(
        socket,
        ctx,
        requestId,
        principal,
        action,
        resource,
        "access_not_configured",
        null,
        [],
      );
      return { allowed: false, decision: null };
    case "no_principal":
      sendError(
        socket,
        requestId,
        "unauthorized",
        `Access denied: no authenticated principal for '${action}' on ${resource.kind}:${resource.name}`,
      );
      emitDenial(
        socket,
        ctx,
        requestId,
        null,
        action,
        resource,
        "no_principal",
        null,
        [],
      );
      return { allowed: false, decision: null };
    case "refused": {
      const { decision, groups } = outcome;
      const principalStr = resolveDisplayPrincipal(outcome.principal, ctx);
      // a control-plane record is decided as admin whatever was asked, so the
      // refusal names admin
      const needed = isControlPlaneRecordResource(resource) ? "admin" : action;
      if (decision && decision.effect === "deny" && every) {
        // An operation over every resource is decided per kind, never on a
        // control-plane record, so it names the action it asked for.
        sendError(
          socket,
          requestId,
          "unauthorized",
          `Access denied: ${principalStr} has a ${
            decision.condition ? "conditional " : ""
          }deny grant (${decision.grantId}) for '${action}' on ${resource.kind} resources, and an operation over every ${resource.kind} resource needs '${action}' on all of them`,
        );
      } else if (decision && decision.effect === "deny") {
        sendError(
          socket,
          requestId,
          "unauthorized",
          `Access denied: ${principalStr} is explicitly denied '${needed}' on ${resource.kind}:${resource.name}`,
        );
      } else {
        sendError(
          socket,
          requestId,
          "unauthorized",
          `Access denied: ${principalStr} does not have '${needed}' on ${resource.kind}:${resource.name}`,
        );
      }
      emitDenial(
        socket,
        ctx,
        requestId,
        outcome.principal,
        action,
        resource,
        "unauthorized",
        decision,
        groups,
      );
      return { allowed: false, decision: decision ?? null };
    }
  }
}

export function wouldAuthorize(
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): boolean {
  return decideAccess(socket, principal, action, resource, ctx).kind ===
    "allowed";
}

/**
 * audits a refusal but sends nothing, for replies that must not reveal what the
 * caller was refused
 */
export function isAuthorized(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): boolean {
  return auditRefusal(
    socket,
    requestId,
    principal,
    action,
    resource,
    ctx,
    decideAccess(socket, principal, action, resource, ctx),
  );
}

export function isAuthorizedForAll(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  kind: ResourceKind,
  ctx: ConnectionContext,
): boolean {
  const resource: AccessResource = { kind, name: "*", fields: { name: "*" } };
  return auditRefusal(
    socket,
    requestId,
    principal,
    action,
    resource,
    ctx,
    decideAccess(socket, principal, action, resource, ctx, true),
  );
}

export function isCallerAuthorized(
  caller: AccessCaller,
  requestId: string,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): boolean {
  return auditCallerRefusal(
    caller,
    requestId,
    caller.principal,
    action,
    resource,
    ctx,
    decideForCaller(caller, action, resource, ctx),
  );
}

export function isCallerAuthorizedForAll(
  caller: AccessCaller,
  requestId: string,
  action: Action,
  kind: ResourceKind,
  ctx: ConnectionContext,
): boolean {
  const resource: AccessResource = { kind, name: "*", fields: { name: "*" } };
  return auditCallerRefusal(
    caller,
    requestId,
    caller.principal,
    action,
    resource,
    ctx,
    decideForCaller(caller, action, resource, ctx, true),
  );
}

/** decided rather than just refused, so the audit event names the ceiling */
export function refuseIntegrationCaller(
  caller: AccessCaller,
  requestId: string,
  surface: string,
  ctx: ConnectionContext,
): boolean {
  if (!isIntegrationClient(caller.client)) return false;
  isCallerAuthorized(
    caller,
    requestId,
    "read",
    { kind: "access", name: surface, fields: {} },
    ctx,
  );
  return true;
}

export interface RequestAuthority {
  allows(action: Action, resource: AccessResource): boolean;
  allowsAll(action: Action, kind: ResourceKind): boolean;
}

export function socketAuthority(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
): RequestAuthority {
  return {
    allows: (action, resource) =>
      isAuthorized(socket, requestId, principal, action, resource, ctx),
    allowsAll: (action, kind) =>
      isAuthorizedForAll(socket, requestId, principal, action, kind, ctx),
  };
}

export function callerAuthority(
  caller: AccessCaller,
  requestId: string,
  ctx: ConnectionContext,
): RequestAuthority {
  return {
    allows: (action, resource) =>
      isCallerAuthorized(caller, requestId, action, resource, ctx),
    allowsAll: (action, kind) =>
      isCallerAuthorizedForAll(caller, requestId, action, kind, ctx),
  };
}

function auditRefusal(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
  outcome: AccessOutcome,
): boolean {
  return auditCallerRefusal(
    accessCallerOf(socket, principal),
    requestId,
    principal,
    action,
    resource,
    ctx,
    outcome,
  );
}

function auditCallerRefusal(
  origin: DenialOrigin,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
  outcome: AccessOutcome,
): boolean {
  switch (outcome.kind) {
    case "allowed":
      return true;
    case "not_configured":
      emitDenialFrom(
        origin,
        ctx,
        requestId,
        principal,
        action,
        resource,
        "access_not_configured",
        null,
        [],
      );
      return false;
    case "no_principal":
      emitDenialFrom(
        origin,
        ctx,
        requestId,
        null,
        action,
        resource,
        "no_principal",
        null,
        [],
      );
      return false;
    case "refused":
      emitDenialFrom(
        origin,
        ctx,
        requestId,
        outcome.principal,
        action,
        resource,
        "unauthorized",
        outcome.decision,
        outcome.groups,
      );
      return false;
  }
}

function buildAuditDecision(
  action: Action,
  resource: AccessResource,
  decision: AccessDecision | null,
  groups: readonly string[],
): AuditDecision {
  return {
    action: String(action),
    resourceKind: resource.kind,
    resourceName: resource.name,
    effect: decision?.effect ?? "deny",
    grantId: decision?.grantId ?? null,
    principalGroups: groups,
  };
}

function emitDenial(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  detail: string,
  accessDecision: AccessDecision | null,
  groups: readonly string[],
): void {
  emitDenialFrom(
    accessCallerOf(socket, principal),
    ctx,
    requestId,
    principal,
    action,
    resource,
    detail,
    accessDecision,
    groups,
  );
}

function emitDenialFrom(
  origin: DenialOrigin,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  detail: string,
  accessDecision: AccessDecision | null,
  groups: readonly string[],
): void {
  if (!ctx.auditEmitter) return;
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "access",
    stage: "response",
    outcome: "denied",
    action: String(action),
    resourceKind: resource.kind,
    resourceName: resource.name,
    principalKind: principal?.kind ?? "anonymous",
    principalId: principal?.id ?? "anonymous",
    initiatedBy: principal ? resolveDisplayPrincipal(principal, ctx) : "ghost",
    actor: resolveActorIdentity(
      principal,
      ctx.resolvedUserNames,
      origin.loginIdentity,
    ),
    client: origin.client,
    sourceIp: origin.sourceIp,
    requestId,
    detail,
    decision: buildAuditDecision(action, resource, accessDecision, groups),
  }));
}

export function resolveDisplayPrincipal(
  principal: Principal,
  ctx: Pick<ConnectionContext, "resolvedUserNames">,
): string {
  return displayPrincipal(principal, ctx.resolvedUserNames);
}

/**
 * an item with several owners needs all of them allowed; a resource no grant
 * decides is allowed only for an admin
 */
export async function filterByResources<T>(
  items: T[],
  resourcesOf: (item: T) => Promise<AccessResource[]>,
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  ctx: ConnectionContext,
): Promise<T[]> {
  if (ctx.authConfig.mode === "none") return items;
  const allowed = resourceReadability(
    resourcesOf,
    socket,
    principal,
    action,
    ctx,
  );
  const kept: T[] = [];
  for (const item of items) {
    if (await allowed(item)) kept.push(item);
  }
  return kept;
}

export function resourceReadability<A extends unknown[]>(
  resourcesOf: (...args: A) => Promise<AccessResource[]>,
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  ctx: ConnectionContext,
): (...args: A) => Promise<boolean> {
  if (ctx.authConfig.mode === "none") return () => Promise.resolve(true);
  const allows = resourceDecider(socket, principal, action, ctx);
  return async (...args) => {
    const resources = await resourcesOf(...args);
    return resources.length > 0 && resources.every(allows);
  };
}

export function resourceDecider(
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  ctx: ConnectionContext,
): (resource: AccessResource) => boolean {
  return callerResourceDecider(accessCallerOf(socket, principal), action, ctx);
}

export function callerResourceDecider(
  caller: AccessCaller,
  action: Action,
  ctx: Pick<ConnectionContext, "authConfig" | "policySnapshotLoader">,
): (resource: AccessResource) => boolean {
  if (ctx.authConfig.mode === "none") return () => true;
  const loader = ctx.policySnapshotLoader;
  const { principal } = caller;
  if (!loader || !principal) return () => false;

  const service = loader.decisionService;
  const accessPrincipal: AccessPrincipal = {
    principal,
    collectives: [...caller.collectives],
    groups: [...caller.groups],
    client: caller.client,
  };
  const adminDecision = service.decide(
    accessPrincipal,
    "admin",
    { kind: "access", name: "*", fields: {} },
  );
  const isAdmin = adminDecision !== null && adminDecision.effect === "allow";

  const decided = new Map<string, boolean>();
  return (resource) => {
    const key = JSON.stringify([resource.kind, resource.name, resource.fields]);
    let allowed = decided.get(key);
    if (allowed === undefined) {
      const decision = service.decide(accessPrincipal, action, resource);
      allowed = decision ? decision.effect === "allow" : isAdmin;
      decided.set(key, allowed);
    }
    return allowed;
  };
}

/**
 * apply after filterByResources so total and page boundaries reflect only what
 * the principal may read
 */
export function paginate<T>(
  items: T[],
  offset: number | undefined,
  limit: number | undefined,
): { page: T[]; total: number } {
  const start = offset ?? 0;
  const end = limit === undefined ? undefined : start + limit;
  return { page: items.slice(start, end), total: items.length };
}

export function authorizeAnyOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  kindOrKinds: ResourceKind | readonly [ResourceKind, ...ResourceKind[]],
  ctx: ConnectionContext,
): boolean {
  if (ctx.authConfig.mode === "none") return true;

  const kinds: readonly ResourceKind[] = typeof kindOrKinds === "string"
    ? [kindOrKinds]
    : kindOrKinds;
  const kind = kinds[0];
  const resource: AccessResource = { kind, name: "*", fields: {} };

  if (!ctx.policySnapshotLoader) {
    sendError(
      socket,
      requestId,
      "access_not_configured",
      "Authorization enforcement is enabled but no policy snapshot is available",
    );
    emitDenial(
      socket,
      ctx,
      requestId,
      principal,
      action,
      resource,
      "access_not_configured",
      null,
      [],
    );
    return false;
  }

  if (!principal) {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: no authenticated principal for '${action}' on ${kind}:*`,
    );
    emitDenial(
      socket,
      ctx,
      requestId,
      null,
      action,
      resource,
      "no_principal",
      null,
      [],
    );
    return false;
  }

  const collectives = connectionCollectives.get(socket) ?? [];
  const groups = connectionGroups.get(socket) ?? [];
  const service = ctx.policySnapshotLoader.decisionService;
  const accessPrincipal: AccessPrincipal = {
    principal,
    collectives,
    groups,
    client: connectionClient.get(socket),
  };

  if (
    kinds.some((k) => service.hasAnyGrantForKind(accessPrincipal, action, k))
  ) return true;

  const adminDecision = service.decide(
    accessPrincipal,
    "admin",
    { kind: "access", name: "*", fields: {} },
  );
  if (adminDecision && adminDecision.effect === "allow") return true;

  const principalStr = resolveDisplayPrincipal(principal, ctx);
  sendError(
    socket,
    requestId,
    "unauthorized",
    `Access denied: ${principalStr} does not have '${action}' on ${kind}:*`,
  );
  emitDenial(
    socket,
    ctx,
    requestId,
    principal,
    action,
    resource,
    "unauthorized",
    null,
    groups,
  );
  return false;
}

/**
 * a vault has complete fields, so a conditional data deny decides on it rather
 * than failing closed
 */
export function vaultAccessResource(name: string): AccessResource {
  return { kind: "data", name, fields: { name, ns: "", tags: {} } };
}

export { vaultKindResource };

export interface VaultRequest {
  readonly vaultName: string;
  readonly action: Action;
  /**
   * the resource the request was authorized as before the vault kind existed;
   * it is decided first and unchanged, and its refusal is the reply when
   * nothing else allows
   */
  readonly existing: AccessResource;
  readonly key?: string;
  readonly method: VaultMethod;
  /**
   * false when only the existing check may admit: a vault:<name> allow does
   * not, though a deny still refuses; for requests reaching beyond the vault,
   * such as a refresh hook run as a shell command
   */
  readonly vaultGrantAdmits?: boolean;
}

export interface VaultAuthorizationResult extends AuthorizationResult {
  /**
   * vault means only a vault:<name> grant admitted the request, so the handler
   * must not reveal anything beyond that one vault
   */
  readonly admittedBy?: "existing" | "vault";
}

interface VaultOutcome {
  readonly outcome: AccessOutcome;
  readonly resource: AccessResource;
  readonly admittedBy?: "existing" | "vault";
}

function accessPrincipalOf(
  caller: AccessCaller,
  principal: Principal,
): AccessPrincipal {
  return {
    principal,
    collectives: [...caller.collectives],
    groups: [...caller.groups],
    client: caller.client,
  };
}

/**
 * The names a deny on a vault may use: `data:vault`, `data:<name>` and
 * `vault:<name>`. Any of them refuses every request on the vault.
 */
function vaultDenyResources(
  vaultName: string,
  key: string | undefined,
  method: VaultMethod,
): AccessResource[] {
  return [
    vaultAccessResource("vault"),
    vaultAccessResource(vaultName),
    vaultKindResource(vaultName, key, method),
  ];
}

function sameResource(a: AccessResource, b: AccessResource): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/**
 * the existing check runs first and unchanged; a deny on any name of the vault
 * refuses; otherwise the existing allow, then a vault:<name> allow admits;
 * anything else gets the existing refusal
 */
function decideVaultRequest(
  caller: AccessCaller,
  request: VaultRequest,
  ctx: ConnectionContext,
): VaultOutcome {
  const principal = caller.principal;
  const existing = decideForCaller(
    caller,
    request.action,
    request.existing,
    ctx,
  );
  const todays: VaultOutcome = {
    outcome: existing,
    resource: request.existing,
  };
  if (ctx.authConfig.mode === "none") {
    return { ...todays, admittedBy: "existing" };
  }
  if (existing.kind === "not_configured" || existing.kind === "no_principal") {
    return todays;
  }
  if (existing.kind === "refused" && existing.decision?.effect === "deny") {
    return todays;
  }
  // A policy and a principal are present past the checks above.
  const loader = ctx.policySnapshotLoader!;
  const subject = principal!;
  const service = loader.decisionService;
  const accessPrincipal = accessPrincipalOf(caller, subject);
  let denied: VaultOutcome | null = null;
  let vaultAllow: AccessDecision | null = null;
  for (
    const resource of vaultDenyResources(
      request.vaultName,
      request.key,
      request.method,
    )
  ) {
    if (sameResource(resource, request.existing)) continue;
    const decision = service.decide(accessPrincipal, request.action, resource);
    if (decision && decision.effect === "deny") {
      denied ??= {
        outcome: {
          kind: "refused",
          principal: subject,
          decision,
          groups: accessPrincipal.groups,
        },
        resource,
      };
    } else if (resource.kind === "vault" && decision) {
      vaultAllow = decision;
    }
  }
  if (existing.kind === "allowed") {
    return denied ?? { ...todays, admittedBy: "existing" };
  }
  if (!vaultAllow || request.vaultGrantAdmits === false) return todays;
  return denied ?? {
    outcome: { kind: "allowed", decision: vaultAllow },
    resource: vaultKindResource(
      request.vaultName,
      request.key,
      request.method,
    ),
    admittedBy: "vault",
  };
}

export function authorizeVaultOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  request: VaultRequest,
  ctx: ConnectionContext,
): VaultAuthorizationResult {
  const decided = decideVaultRequest(
    accessCallerOf(socket, principal),
    request,
    ctx,
  );
  const result = replyToOutcome(
    socket,
    requestId,
    principal,
    request.action,
    decided.resource,
    ctx,
    decided.outcome,
  );
  return result.allowed
    ? { ...result, admittedBy: decided.admittedBy }
    : result;
}

export function isCallerVaultAuthorized(
  caller: AccessCaller,
  requestId: string,
  request: VaultRequest,
  ctx: ConnectionContext,
): boolean {
  const decided = decideVaultRequest(caller, request, ctx);
  return auditCallerRefusal(
    caller,
    requestId,
    caller.principal,
    request.action,
    decided.resource,
    ctx,
    decided.outcome,
  );
}

/**
 * admits the lookup for callers the existing check allows or that hold any
 * vault allow; others are refused before any lookup; authorize again once the
 * vault name is known
 */
export function admitVaultLookupOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  existing: AccessResource,
  ctx: ConnectionContext,
): boolean {
  const outcome = decideAccess(socket, principal, action, existing, ctx);
  if (
    outcome.kind === "refused" && outcome.decision === null && principal &&
    ctx.policySnapshotLoader &&
    ctx.policySnapshotLoader.decisionService.hasAnyGrantForKind(
      accessPrincipalOf(accessCallerOf(socket, principal), principal),
      action,
      "vault",
    )
  ) return true;
  return replyToOutcome(
    socket,
    requestId,
    principal,
    action,
    existing,
    ctx,
    outcome,
  ).allowed;
}

export interface VaultListingAdmission {
  readonly allowed: boolean;
  readonly existingAllowed: boolean;
}

export function admitVaultListingOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  existing: AccessResource,
  ctx: ConnectionContext,
): VaultListingAdmission {
  const outcome = decideAccess(socket, principal, action, existing, ctx);
  if (outcome.kind === "allowed") {
    return { allowed: true, existingAllowed: true };
  }
  if (
    outcome.kind === "refused" && outcome.decision === null && principal &&
    ctx.policySnapshotLoader &&
    ctx.policySnapshotLoader.decisionService.hasAnyGrantForKind(
      accessPrincipalOf(accessCallerOf(socket, principal), principal),
      action,
      "vault",
    )
  ) return { allowed: true, existingAllowed: false };
  replyToOutcome(socket, requestId, principal, action, existing, ctx, outcome);
  return { allowed: false, existingAllowed: false };
}

export function vaultListingDecider(
  socket: WebSocket,
  principal: Principal | null,
  action: Action,
  method: VaultMethod,
  ctx: ConnectionContext,
  existingAllows: (vaultName: string) => boolean,
): (vaultName: string) => boolean {
  if (ctx.authConfig.mode === "none") return () => true;
  const loader = ctx.policySnapshotLoader;
  if (!loader || !principal) return () => false;
  const service = loader.decisionService;
  const accessPrincipal = accessPrincipalOf(
    accessCallerOf(socket, principal),
    principal,
  );
  const decided = new Map<string, boolean>();
  return (vaultName) => {
    let kept = decided.get(vaultName);
    if (kept === undefined) {
      let vaultAllows = false;
      let denied = false;
      for (const resource of vaultDenyResources(vaultName, undefined, method)) {
        const decision = service.decide(accessPrincipal, action, resource);
        if (decision && decision.effect === "deny") {
          denied = true;
          break;
        }
        if (resource.kind === "vault") {
          vaultAllows = decision !== null && decision.effect === "allow";
        }
      }
      kept = !denied && (existingAllows(vaultName) || vaultAllows);
      decided.set(vaultName, kept);
    }
    return kept;
  };
}

export function sendTraced(
  socket: WebSocket,
  message: ServerMessage,
): Promise<void> {
  return withSpan("swamp.serve.response.send", {}, () => {
    send(socket, message);
    return Promise.resolve();
  });
}

export function send(socket: WebSocket, message: ServerMessage): void {
  const held = heldReplies.get(socket)?.get(message.id);
  if (message.type === "event") {
    // a run's outcome, and what follows it, waits for the commit with the
    // request's other replies; its progress streams
    if (
      held !== undefined &&
      (held.outcome || OUTCOME_EVENT_KINDS.has(message.event.kind))
    ) {
      held.outcome = true;
      held.replies.push(message);
      return;
    }
  } else {
    if (held !== undefined) {
      held.replies.push(message);
      return;
    }
    // a request already answered by an error: its handler's own reply would
    // contradict it
    if (answeredByError.get(socket)?.has(message.id)) return;
  }
  sendNow(socket, message);
}

const OUTCOME_EVENT_KINDS: ReadonlySet<string> = new Set([
  "completed",
  "cancelled",
  "suspended",
]);

function sendNow(socket: WebSocket, message: ServerMessage): void {
  sendSerialized(socket, JSON.stringify(message), {
    type: message.type,
    id: message.id,
    ...(message.type === "event" && { eventKind: message.event.kind }),
  });
}

/** what a refused oversize frame is reported as; never its payload */
export interface ClientFrameHeader {
  readonly type: string;
  readonly id?: string;
  readonly eventKind?: string;
}

const frameLogger = getSwampLogger(["serve", "frame"]);

const uncappedSockets = new WeakSet<WebSocket>();

/** for a reply channel with no frame limit, such as an HTTP response stream */
export function markUncappedSocket(socket: WebSocket): void {
  uncappedSockets.add(socket);
}

export function sendSerialized(
  socket: WebSocket,
  json: string,
  header: ClientFrameHeader,
  maxFrameBytes: number = MAX_RPC_FRAME_BYTES,
): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  let frame: string | Uint8Array = json;
  let bytes: number | undefined;
  if (connectionCompression.get(socket) === "gzip") {
    const encoded = new TextEncoder().encode(json);
    bytes = encoded.byteLength;
    if (bytes >= COMPRESSION_THRESHOLD_BYTES) {
      // synchronous so frames keep their order
      frame = gzipSync(encoded);
      bytes = frame.byteLength;
    }
  }
  if (!uncappedSockets.has(socket)) {
    // a UTF-16 code unit encodes to at most three UTF-8 bytes
    if (bytes === undefined && json.length * 3 > maxFrameBytes) {
      bytes = new TextEncoder().encode(json).byteLength;
    }
    if (bytes !== undefined && bytes > maxFrameBytes) {
      refuseOversizeFrame(socket, header, bytes, maxFrameBytes);
      return;
    }
  }
  socket.send(frame);
}

function refuseOversizeFrame(
  socket: WebSocket,
  header: ClientFrameHeader,
  bytes: number,
  limit: number,
): void {
  frameLogger.warn(
    "Refused to send a {frameType} frame for request {requestId} (event {eventKind}): {bytes} bytes exceeds the {limit} byte WebSocket frame limit",
    {
      frameType: header.type,
      requestId: header.id ?? "none",
      eventKind: header.eventKind ?? "none",
      bytes,
      limit,
    },
  );
  if (header.id === undefined) return;
  const outcome = header.type === "event" &&
    OUTCOME_EVENT_KINDS.has(header.eventKind ?? "");
  // a progress event is dropped and its run's stream goes on
  if (header.type === "event" && !outcome) return;
  const message = outcome
    ? `The run's ${header.eventKind} event is ${bytes} bytes, over the ` +
      `${limit} byte WebSocket frame limit; the run finished, but its ` +
      `outcome could not be sent over the socket. Read it from the run's history`
    : `The ${header.type} reply is ${bytes} bytes, over the ${limit} byte ` +
      `WebSocket frame limit; the request ran, but its reply could not be ` +
      `sent over the socket. A current swamp client reads replies this ` +
      `large over HTTP`;
  sendError(socket, header.id, FRAME_TOO_LARGE, message);
  // after the error went out, or the error itself would be dropped
  markAnsweredByError(socket, header.id);
}

const MAX_ERRORED_REQUESTS = 10_000;
const erroredRequests = new WeakMap<WebSocket, Set<string>>();

interface HeldReplies {
  readonly replies: ServerMessage[];
  outcome: boolean;
}

const heldReplies = new WeakMap<WebSocket, Map<string, HeldReplies>>();

const answeredByError = new WeakMap<WebSocket, Set<string>>();

export function wasAnsweredByError(
  socket: WebSocket,
  requestId: string,
): boolean {
  return answeredByError.get(socket)?.has(requestId) ?? false;
}

function markAnsweredByError(socket: WebSocket, requestId: string): void {
  let answered = answeredByError.get(socket);
  if (answered === undefined) {
    answered = new Set();
    answeredByError.set(socket, answered);
  }
  answered.add(requestId);
  if (answered.size > MAX_ERRORED_REQUESTS) {
    answered.delete(answered.values().next().value!);
  }
}

/**
 * replies are held around the whole handler, not a root's flush, because
 * handlers reply before their root commits; a failed commit or confirmation
 * drops the held success and sends the error
 */
export async function confirmRequest(
  ctx: Pick<
    ConnectionContext,
    "confirmReplicated" | "replicationMark" | "holdRepliesUntilCommitted"
  >,
  socket: WebSocket,
  requestId: string,
  handler: () => Promise<void>,
): Promise<void> {
  const confirm = ctx.confirmReplicated;
  if (confirm === undefined && ctx.holdRepliesUntilCommitted !== true) {
    return await handler();
  }
  let held = heldReplies.get(socket);
  if (held === undefined) {
    held = new Map();
    heldReplies.set(socket, held);
  }
  // Registered before the handler starts, so no reply can pass it.
  const replies: ServerMessage[] = [];
  held.set(requestId, { replies, outcome: false });
  const errored = () => replies.some((reply) => reply.type === "error");
  // A request during which nothing committed has nothing to confirm.
  const before = ctx.replicationMark?.();
  const committed = () =>
    before === undefined || ctx.replicationMark!() !== before;
  let failure: { readonly error: unknown } | undefined;
  let ended = false;
  try {
    await handler();
    ended = true;
    if (confirm !== undefined && !errored() && committed()) await confirm();
  } catch (error) {
    failure = { error };
  } finally {
    held.delete(requestId);
  }
  if (failure !== undefined && !errored()) {
    const { code, message } = replicationErrorForClient(
      failure.error,
      "internal_error",
    );
    sendError(socket, requestId, code, message);
    // After the error went out: from here on the request's replies drop.
    markAnsweredByError(socket, requestId);
  } else {
    // a request that answered with an error never reports its run's outcome or
    // that it finished before the error, so held outcome events and done drop
    const failed = errored();
    for (const reply of replies) {
      if (failed && (reply.type === "event" || reply.type === "done")) continue;
      send(socket, reply);
    }
  }
  // A handler that threw throws on, as it does without confirmation.
  if (!ended && failure !== undefined) throw failure.error;
}

export async function confirmRunReplicated(
  ctx: Pick<ConnectionContext, "confirmReplicated">,
  errorCode: string,
): Promise<{ readonly code: string; readonly message: string } | undefined> {
  if (ctx.confirmReplicated === undefined) return undefined;
  try {
    await ctx.confirmReplicated();
    return undefined;
  } catch (error) {
    return replicationErrorForClient(error, errorCode);
  }
}

export function runFailureForClient(
  error: unknown,
  fallbackCode: string,
): { readonly code: string; readonly message: string } {
  if (error instanceof CommitUnreachableError) {
    const worded = error.afterStepsRan();
    return {
      code: worded.code ?? COMMIT_UNREACHABLE_CODE,
      message: sanitizeErrorForClient(worded),
    };
  }
  // a run a checkpoint committed is left running
  if (error instanceof RunPartlyCommittedError) {
    return {
      code: RUN_PARTLY_COMMITTED_CODE,
      message: sanitizeErrorForClient(error.afterStepsRan()),
    };
  }
  return {
    code: secretRefusalCode(error) ?? fallbackCode,
    message: sanitizeErrorForClient(error),
  };
}

export function withCommittedUnknownSteps(
  error: unknown,
  checkpointer: {
    committedUnknownSteps(runId: string): readonly string[] | undefined;
  },
): unknown {
  return withRunUnknownSteps(
    error,
    (runId) => checkpointer.committedUnknownSteps(runId),
  );
}

export function replicationErrorForClient(
  error: unknown,
  fallbackCode: string,
): { readonly code: string; readonly message: string } {
  const conflict = configEditConflictOf(error);
  if (conflict !== undefined) {
    return {
      code: CONFIG_EDIT_CONFLICT_CODE,
      message: sanitizeErrorForClient(conflict),
    };
  }
  const message = sanitizeErrorForClient(error);
  if (
    error instanceof UserError &&
    (error.code === V3_REPLICATION_UNCONFIRMED_CODE ||
      error.code === WRITER_FENCED_CODE ||
      error.code === COMMIT_UNREACHABLE_CODE ||
      error.code === COMMIT_PARTLY_COMMITTED_CODE ||
      error.code === RUN_PARTLY_COMMITTED_CODE ||
      error.code === V3_STORAGE_UNREACHABLE_CODE ||
      error.code === V3_WRITER_BUSY_CODE ||
      error.code === SERVE_NOT_LEADER_CODE)
  ) {
    return { code: error.code, message };
  }
  return { code: fallbackCode, message };
}

/**
 * recorded only when an audit emitter will consume it, capped per socket, and
 * removed by the audit wrapper on every outcome
 */
const auditedResources = new WeakMap<
  WebSocket,
  Map<string, { kind: string; name: string }>
>();

/**
 * used only when the event audits that kind: a run attach audited as the run
 * keeps the run id although it authorized the run's model
 */
export function recordAuditedResource(
  socket: WebSocket,
  requestId: string,
  kind: string,
  name: string,
  ctx: Pick<ConnectionContext, "auditEmitter">,
): void {
  if (!ctx.auditEmitter) return;
  let names = auditedResources.get(socket);
  if (!names) {
    names = new Map();
    auditedResources.set(socket, names);
  }
  names.set(requestId, { kind, name });
  if (names.size > MAX_ERRORED_REQUESTS) {
    const first = names.keys().next().value!;
    names.delete(first);
  }
}

const auditedDetails = new WeakMap<WebSocket, Map<string, string>>();

/** a success worth telling apart in the log, such as a replayed start */
export function recordAuditedDetail(
  socket: WebSocket,
  requestId: string,
  detail: string,
): void {
  let details = auditedDetails.get(socket);
  if (!details) {
    details = new Map();
    auditedDetails.set(socket, details);
  }
  details.set(requestId, detail);
  if (details.size > MAX_ERRORED_REQUESTS) {
    details.delete(details.keys().next().value!);
  }
}

export function takeAuditedDetail(
  socket: WebSocket,
  requestId: string,
): string | undefined {
  const details = auditedDetails.get(socket);
  const detail = details?.get(requestId);
  details?.delete(requestId);
  return detail;
}

export function takeAuditedResource(
  socket: WebSocket,
  requestId: string,
  kind: string,
): string | undefined {
  const names = auditedResources.get(socket);
  const recorded = names?.get(requestId);
  names?.delete(requestId);
  return recorded?.kind === kind ? recorded.name : undefined;
}

function clientErrorReasonOf(details: unknown): string | undefined {
  if (details === null || typeof details !== "object") return undefined;
  if (!("reason" in details) || typeof details.reason !== "string") {
    return undefined;
  }
  return CLIENT_ERROR_REASONS.has(details.reason) ? details.reason : undefined;
}

/** codes a request can end with when the datastore could not confirm its write */
export const REPLICATION_REFUSALS = {
  notLeader: SERVE_NOT_LEADER_CODE,
  writerBusy: V3_WRITER_BUSY_CODE,
  unconfirmed: [
    V3_REPLICATION_UNCONFIRMED_CODE,
    WRITER_FENCED_CODE,
    COMMIT_UNREACHABLE_CODE,
    COMMIT_PARTLY_COMMITTED_CODE,
    RUN_PARTLY_COMMITTED_CODE,
    V3_STORAGE_UNREACHABLE_CODE,
  ],
} as const;

export function isServerFailureCode(code: string): boolean {
  if (code === "internal_error") return true;
  return code.endsWith("_failed") && code !== "validation_failed";
}

export function sendError(
  socket: WebSocket,
  id: string,
  code: string,
  message: string,
  details?: unknown,
): void {
  let errors = erroredRequests.get(socket);
  if (!errors) {
    errors = new Set();
    erroredRequests.set(socket, errors);
  }
  errors.add(id);
  if (errors.size > MAX_ERRORED_REQUESTS) {
    const first = errors.values().next().value!;
    errors.delete(first);
  }
  // an operation_failed reply whose details name a client reason, such as a run
  // not found, is the caller's error, not the server's
  const reason = clientErrorReasonOf(details);
  setActiveSpanAttributes({
    "swamp.serve.response.error_code": code,
    ...(reason !== undefined &&
      { "swamp.serve.response.error_reason": reason }),
  });
  if (reason === undefined && isServerFailureCode(code)) {
    markActiveSpanError(code);
  }
  send(socket, {
    type: "error",
    id,
    error: { code, message, ...(details !== undefined && { details }) },
  });
}

/**
 * edit generators fall back to opening an editor, which on serve would launch
 * on the server host, so remote edits must send the new YAML
 */
export function rejectEditWithoutContent(
  socket: WebSocket,
  requestId: string,
  content: string | undefined,
): boolean {
  if (content !== undefined) return false;
  sendError(
    socket,
    requestId,
    "invalid_request",
    "Edits over the server need the new YAML in the request content; the server does not open an editor",
  );
  return true;
}

export function wasRequestErrored(
  socket: WebSocket,
  requestId: string,
): boolean {
  return erroredRequests.get(socket)?.has(requestId) ?? false;
}

export function clearRequestErrored(
  socket: WebSocket,
  requestId: string,
): void {
  erroredRequests.get(socket)?.delete(requestId);
}

/**
 * with transform, deliveries are chained so events, the terminal and the detach
 * keep their order
 */
export function createSocketSubscriber(
  socket: WebSocket,
  requestId: string,
  onDetachCallback?: () => void,
  transform?: (event: SerializedEvent) => Promise<SerializedEvent>,
): import("../run_event_buffer.ts").RunEventSubscriber {
  const sendEvent = (seq: number, event: SerializedEvent) => {
    send(socket, { type: "event", id: requestId, event: { ...event, seq } });
  };
  const sendTerminal = (
    terminal: import("../run_event_buffer.ts").BufferTerminal,
  ) => {
    if (terminal.kind === "done") {
      send(socket, { type: "done", id: requestId });
    } else {
      sendError(
        socket,
        requestId,
        terminal.code,
        terminal.message,
        terminal.details,
      );
    }
  };
  // Without a transform, delivery stays synchronous, so a send that throws
  // reaches the buffer, which isolates subscriber errors.
  if (!transform) {
    return {
      onEvent: sendEvent,
      onTerminal: sendTerminal,
      onDetach() {
        onDetachCallback?.();
      },
    };
  }
  let delivering = Promise.resolve();
  const inOrder = (deliver: () => void | Promise<void>) => {
    delivering = delivering.then(deliver).catch((error) => {
      streamLogger.warn("Failed to deliver a run stream event: {error}", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  return {
    onEvent(seq, event) {
      inOrder(async () => sendEvent(seq, await transform(event)));
    },
    onTerminal(terminal) {
      inOrder(() => sendTerminal(terminal));
    },
    onDetach() {
      inOrder(() => onDetachCallback?.());
    },
  };
}

export function subscribeUntilDetach(
  buffer: import("../run_event_buffer.ts").RunEventBuffer,
  socket: WebSocket,
  requestId: string,
  controller: AbortController,
  afterSeq = 0,
  transform?: (event: SerializedEvent) => Promise<SerializedEvent>,
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsub = buffer.subscribe(
      createSocketSubscriber(socket, requestId, resolve, transform),
      afterSeq,
    );
    controller.signal.addEventListener("abort", () => {
      unsub();
    }, { once: true });
  });
}

export function cancelActor(
  principal: Principal | null,
  ctx: Pick<ConnectionContext, "resolvedUserNames">,
): string {
  if (!principal) return "anonymous";
  return resolveDisplayPrincipal(principal, ctx);
}

export const MAX_CANCEL_REASON_LENGTH = 1024;

export function cancelReasonFor(actor: string, reason?: string): string {
  return reason ? `${reason} (cancelled by ${actor})` : `cancelled by ${actor}`;
}

export interface RunCancelAudit {
  action: string;
  resourceKind: string;
  resourceName: string;
  principal: Principal | null;
  loginIdentity?: ActorIdentity;
  client?: string;
  sourceIp: string;
  requestId: string;
  outcome: AuditOutcome;
  detail?: string;
}

export function emitRunCancelAudit(
  ctx: Pick<
    ConnectionContext,
    "auditEmitter" | "instanceId" | "resolvedUserNames"
  >,
  audit: RunCancelAudit,
): void {
  if (!ctx.auditEmitter) return;
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "execution",
    stage: "response",
    outcome: audit.outcome,
    action: audit.action,
    resourceKind: audit.resourceKind,
    resourceName: audit.resourceName,
    principalKind: audit.principal?.kind ?? "anonymous",
    principalId: audit.principal?.id ?? "anonymous",
    initiatedBy: audit.principal ? cancelActor(audit.principal, ctx) : "ghost",
    actor: resolveActorIdentity(
      audit.principal,
      ctx.resolvedUserNames,
      audit.loginIdentity,
    ),
    client: audit.client,
    sourceIp: audit.sourceIp,
    requestId: audit.requestId,
    detail: audit.detail,
  }));
}

/**
 * taken outside the sync gate because the retention pass takes the gate per
 * batch while holding the mutex; the other order would stall both
 */
export function withGcMutex<T>(
  ctx: Pick<ConnectionContext, "gcMutex">,
  fn: () => Promise<T>,
): Promise<T> {
  return ctx.gcMutex ? ctx.gcMutex.run(fn) : fn();
}

export function emitSystemAuditEvent(
  ctx: ConnectionContext,
  action: string,
  detail?: string,
): void {
  if (!ctx.auditEmitter) return;
  ctx.auditEmitter.emit(buildAuditEvent({
    instanceId: ctx.instanceId ?? "unknown",
    category: "system",
    stage: "response",
    outcome: "success",
    action,
    resourceKind: "server",
    resourceName: ctx.instanceId ?? "unknown",
    principalKind: "system",
    principalId: "system",
    initiatedBy: "system",
    sourceIp: "127.0.0.1",
    requestId: crypto.randomUUID(),
    detail,
  }));
}
