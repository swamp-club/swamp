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
 * Shared utilities for serve WebSocket request handlers: the connection context, response senders, error sanitization, and the authorization gate every handler routes through.
 */

import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { DatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import type { DatastoreSyncService } from "../../domain/datastore/datastore_sync_service.ts";
import type { RunCancelRegistry } from "../run_cancel_registry.ts";
import type { RunTrackerRepository } from "../../domain/models/run_tracker_repository.ts";
import type { ServerMessage } from "../protocol.ts";
import type { WorkerGateway } from "../worker_gateway.ts";
import type { PolicySnapshotLoader } from "../../domain/access/policy_snapshot_loader.ts";
import type { ServeAuthConfig } from "../../domain/access/serve_auth_config.ts";
import { GRANT_MODEL_TYPE } from "../../domain/models/access/grant_model.ts";
import { GROUP_MODEL_TYPE } from "../../domain/models/access/group_model.ts";
import { SERVER_TOKEN_MODEL_TYPE } from "../../domain/models/access/server_token_model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import type { Action } from "../../domain/access/action.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";

export const MAX_CLIENT_ERROR_LENGTH = 200;

export const ABSOLUTE_PATH_PATTERN =
  /(?:^|[\s"'`(])\/(?:opt|home|var|tmp|etc|usr|root|Users|private|proc|sys|mnt|srv|run)\//;

export const WINDOWS_PATH_PATTERN = /[A-Z]:\\/i;

export const SWAMP_INTERNAL_PATH_PATTERN = /\/.swamp\//;

export function sanitizeErrorForClient(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (
    ABSOLUTE_PATH_PATTERN.test(raw) ||
    WINDOWS_PATH_PATTERN.test(raw) ||
    SWAMP_INTERNAL_PATH_PATTERN.test(raw)
  ) {
    return "An internal error occurred";
  }
  if (raw.length > MAX_CLIENT_ERROR_LENGTH) {
    return raw.slice(0, MAX_CLIENT_ERROR_LENGTH) + "...";
  }
  return raw;
}

export const MAX_PREDICATE_LENGTH = 4096;

export const MAX_QUERY_RESULTS = 10_000;

export const DEFAULT_QUERY_LIMIT = 1000;

export interface ConnectionContext {
  repoDir: string;
  repoContext: RepositoryContext;
  datastoreConfig: DatastoreConfig;
  datastoreResolver: DatastorePathResolver;
  /**
   * Shared sync service instance. Same one the repo context's markDirty hook
   * references — see `design/datastores.md`. Undefined for filesystem
   * datastores or custom datastores without a cache.
   */
  syncService?: DatastoreSyncService;
  /**
   * Remote-execution worker gateway. When present, `rpc.*` frames on this
   * socket are routed to it (worker enrollment and capability verbs); the
   * legacy client protocol on the same listener is unaffected. See
   * design/remote-execution.md.
   */
  workerGateway?: WorkerGateway;
  policySnapshotLoader?: PolicySnapshotLoader;
  authConfig: ServeAuthConfig;
  cancelRegistry?: RunCancelRegistry;
  runTracker?: RunTrackerRepository;
  dispatchService?: import("../dispatch_service.ts").DispatchService;
}

// SECURITY: Authorization must operate on canonical (normalized) model types,
// never raw client input. ModelType.normalize() applies lowercasing, separator
// canonicalization (:: . whitespace → /), and deduplication. Any raw typeArg
// that normalizes to an access-control model type must require admin authority.
export function isAccessModelType(
  typeArg: string | undefined,
  resolvedType: string | undefined,
): boolean {
  const grantType = GRANT_MODEL_TYPE.normalized;
  const groupType = GROUP_MODEL_TYPE.normalized;
  const serverTokenType = SERVER_TOKEN_MODEL_TYPE.normalized;
  if (typeArg) {
    const stripped = typeArg.startsWith("@") ? typeArg.slice(1) : typeArg;
    const normalized = ModelType.create(stripped).normalized;
    if (
      normalized === grantType || normalized === groupType ||
      normalized === serverTokenType
    ) return true;
  }
  if (resolvedType) {
    if (
      resolvedType === grantType || resolvedType === groupType ||
      resolvedType === serverTokenType
    ) return true;
  }
  return false;
}

const connectionCollectives = new WeakMap<WebSocket, readonly string[]>();
const connectionGroups = new WeakMap<WebSocket, readonly string[]>();
const connectionPrincipalId = new WeakMap<WebSocket, string>();
const principalSockets = new Map<string, Set<WebSocket>>();

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
}

export function updateCollectivesForPrincipal(
  principalId: string,
  collectives: readonly string[],
  groups: readonly string[],
): void {
  const sockets = principalSockets.get(principalId);
  if (!sockets) return;
  for (const socket of sockets) {
    connectionCollectives.set(socket, collectives);
    connectionGroups.set(socket, groups);
  }
}

export function getConnectionCollectives(
  socket: WebSocket,
): readonly string[] {
  return connectionCollectives.get(socket) ?? [];
}

export function getConnectionGroups(socket: WebSocket): readonly string[] {
  return connectionGroups.get(socket) ?? [];
}

export function authorizeOrReject(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  action: Action,
  resource: AccessResource,
  ctx: ConnectionContext,
): boolean {
  if (ctx.authConfig.mode === "none") return true;

  if (!ctx.policySnapshotLoader) {
    sendError(
      socket,
      requestId,
      "access_not_configured",
      "Authorization enforcement is enabled but no policy snapshot is available",
    );
    return false;
  }

  if (!principal) {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: no authenticated principal for '${action}' on ${resource.kind}:${resource.name}`,
    );
    return false;
  }

  const collectives = connectionCollectives.get(socket) ?? [];
  const groups = connectionGroups.get(socket) ?? [];
  const service = ctx.policySnapshotLoader.decisionService;
  const decision = service.decide(
    { principal, collectives, groups },
    action,
    resource,
  );

  if (decision && decision.effect === "allow") return true;

  if (!decision) {
    const adminDecision = service.decide(
      { principal, collectives, groups },
      "admin",
      { kind: "access", name: "*", fields: {} },
    );
    if (adminDecision && adminDecision.effect === "allow") return true;
  }

  const principalStr = principalToString(principal);
  if (decision && decision.effect === "deny") {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: ${principalStr} is explicitly denied '${action}' on ${resource.kind}:${resource.name}`,
    );
  } else {
    sendError(
      socket,
      requestId,
      "unauthorized",
      `Access denied: ${principalStr} does not have '${action}' on ${resource.kind}:${resource.name}`,
    );
  }
  return false;
}

export function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}

export function sendError(
  socket: WebSocket,
  id: string,
  code: string,
  message: string,
): void {
  send(socket, { type: "error", id, error: { code, message } });
}
