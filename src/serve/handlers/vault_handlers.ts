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
 * Vault-domain request handlers (vault.* verbs).
 */

import { consumeStream } from "../../libswamp/stream.ts";
import {
  createVaultAnnotateDeps,
  vaultAnnotate,
} from "../../libswamp/vaults/annotate.ts";
import {
  createVaultAuditTrailDeps,
  vaultAuditTrail,
} from "../../libswamp/vaults/audit_trail.ts";
import {
  createVaultCreateDeps,
  vaultCreate,
} from "../../libswamp/vaults/create.ts";
import {
  createVaultDeleteDeps,
  vaultDelete,
  vaultDeletePreview,
} from "../../libswamp/vaults/delete.ts";
import {
  createVaultDescribeDeps,
  vaultDescribe,
} from "../../libswamp/vaults/describe.ts";
import {
  createVaultEditDeps,
  findVaultByNameOrId,
  vaultEdit,
  type VaultEditConfigInfo,
} from "../../libswamp/vaults/edit.ts";
import { createVaultGetDeps, vaultGet } from "../../libswamp/vaults/get.ts";
import {
  createVaultInspectDeps,
  vaultInspect,
} from "../../libswamp/vaults/inspect.ts";
import {
  createVaultListKeysDeps,
  vaultListKeys,
} from "../../libswamp/vaults/list_keys.ts";
import {
  createVaultPutDeps,
  vaultPut,
  vaultPutPreview,
} from "../../libswamp/vaults/put.ts";
import {
  createVaultReadSecretDeps,
  vaultReadSecret,
} from "../../libswamp/vaults/read_secret.ts";
import { isSwampError, type SwampError } from "../../libswamp/errors.ts";
import {
  vaultSearch,
  type VaultSearchDeps,
} from "../../libswamp/vaults/search.ts";
import {
  vaultTypeSearch,
  type VaultTypeSearchDeps,
} from "../../libswamp/vaults/type_search.ts";
import type {
  VaultAnnotatePayload,
  VaultAuditTrailPayload,
  VaultCreatePayload,
  VaultDeletePayload,
  VaultDescribePayload,
  VaultEditPayload,
  VaultGetPayload,
  VaultInspectPayload,
  VaultListKeysPayload,
  VaultPutPayload,
  VaultReadSecretPayload,
  VaultSearchPayload,
  VaultTypeSearchPayload,
} from "../protocol.ts";
import { acquireVaultSync } from "../../cli/repo_context.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { VaultConfigParseError } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { getVaultTypes } from "../../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  authorizeAnyOrReject,
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  handlerLibSwampContext,
  LibSwampStreamError,
  pushChangedToRemote,
  rejectEditWithoutContent,
  resourceDecider,
  sanitizeErrorForClient,
  send,
  sendError,
  wasRequestErrored,
} from "./shared.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";
import {
  type AccessResource,
  kindResource,
} from "../../domain/access/access_decision_service.ts";
import { runInRootUnitOfWork } from "../../infrastructure/persistence/repo_unit_of_work.ts";

const logger = getSwampLogger(["serve", "connection"]);

export function isReservedVaultName(name: string): boolean {
  return name.startsWith("_");
}

function rejectReservedVault(
  socket: WebSocket,
  requestId: string,
  vaultName: string,
): boolean {
  if (isReservedVaultName(vaultName)) {
    sendError(
      socket,
      requestId,
      "forbidden",
      `Vault '${vaultName}' is reserved for internal use`,
    );
    return true;
  }
  return false;
}

/**
 * Sends a SwampError thrown by a vault preview (e.g. vaultPutPreview,
 * vaultDeletePreview) as an error frame. A missing vault gets a fixed message:
 * libswamp's lists every configured vault, but vault put and delete are
 * authorized by write on data:vault and listing vaults needs read.
 */
function sendVaultSwampError(
  socket: WebSocket,
  requestId: string,
  code: string,
  vaultName: string,
  error: SwampError,
): void {
  const clientError = new LibSwampStreamError(error);
  const missingVault = error.code === "not_found" &&
    (error.details as { entityType?: unknown } | undefined)?.entityType ===
      "Vault";
  sendError(
    socket,
    requestId,
    code,
    missingVault
      ? `Vault not found: ${vaultName}`
      : sanitizeErrorForClient(clientError),
    clientErrorDetails(clientError),
  );
}

/**
 * The access resource a vault is authorized as. Which name a vault goes by
 * is swamp-club#2676; its fields are complete — a vault has no tags or
 * namespace — so a conditional data deny decides on it rather than failing
 * closed (swamp-club#2675).
 */
export function vaultAccessResource(name: string): AccessResource {
  return { kind: "data", name, fields: { name, ns: "", tags: {} } };
}

export async function handleVaultGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultGetDeps(
      ctx.repoDir,
      ctx.repoContext.vaultConfigRepo,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultGet(libCtx, deps, payload.vaultNameOrId, payload.vaultType),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Vault not found");
      return;
    }

    send(socket, {
      type: "vault.get",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_get_failed", message);
  }
}

export async function handleVaultPut(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultPutPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectReservedVault(socket, requestId, payload.vaultName)) return;

  if (payload.refreshFrom !== undefined || payload.clearRefresh) {
    if (
      !authorizeOrReject(
        socket,
        requestId,
        principal,
        "admin",
        vaultAccessResource("vault"),
        ctx,
      ).allowed
    ) return;
  } else {
    if (
      !authorizeOrReject(
        socket,
        requestId,
        principal,
        "write",
        vaultAccessResource("vault"),
        ctx,
      ).allowed
    ) return;
  }

  let flush: (() => Promise<void>) | undefined;
  try {
    ({ flush } = await acquireVaultSync(
      ctx.datastoreConfig,
      ctx.syncService,
      ctx.repoDir,
    ));
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_put_failed", message);
    return;
  }

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultPutDeps(ctx.repoDir, ctx.repoContext.eventBus);

    const preview = await vaultPutPreview(
      libCtx,
      deps,
      payload.vaultName,
      payload.key,
    );

    if (preview.secretExists && !payload.force) {
      sendError(
        socket,
        requestId,
        "secret_exists",
        `Secret '${payload.key}' already exists in vault '${payload.vaultName}'. Use --force (-f) to overwrite.`,
      );
      return;
    }

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    let result: Record<string, unknown> | undefined;
    const warnings: string[] = [];
    await consumeStream(
      vaultPut(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
        value: payload.value,
        overwritten: preview.secretExists,
        refreshFrom: payload.refreshFrom,
        refreshTtlMs: payload.refreshTtlMs,
        clearRefresh: payload.clearRefresh,
        tags: payload.labels,
      }),
      {
        storing: () => {},
        warning: (e) => {
          warnings.push(e.message);
        },
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.put",
      id: requestId,
      payload: {
        data: result ?? {},
        ...(warnings.length > 0 ? { warnings } : {}),
      },
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else if (isSwampError(error)) {
      sendVaultSwampError(
        socket,
        requestId,
        "vault_put_failed",
        payload.vaultName,
        error,
      );
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "vault_put_failed", message);
    }
  } finally {
    if (flush) await flush();
  }
}

export async function handleVaultDelete(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultDeletePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectReservedVault(socket, requestId, payload.vaultName)) return;

  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "write",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  let flush: (() => Promise<void>) | undefined;
  try {
    ({ flush } = await acquireVaultSync(
      ctx.datastoreConfig,
      ctx.syncService,
      ctx.repoDir,
    ));
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_delete_failed", message);
    return;
  }

  let vaultType = "";
  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultDeleteDeps(ctx.repoDir, ctx.repoContext.eventBus);

    const preview = await vaultDeletePreview(
      libCtx,
      deps,
      payload.vaultName,
      payload.key,
    );

    vaultType = preview.vaultType;

    if (!preview.supportsDelete) {
      sendError(
        socket,
        requestId,
        "unsupported",
        `Vault '${payload.vaultName}' (type: ${preview.vaultType}) does not support deleting secrets`,
      );
      return;
    }

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultDelete(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
      }),
      {
        deleting: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.delete",
      id: requestId,
      payload: { data: result ?? {} },
    });

    // No datastore push: secrets and annotations live in the always-local
    // .swamp/secrets (or an external provider), and vault audit entries go
    // to the repo-local .swamp/audit, so nothing here enters the datastore
    // cache. Like vault.put, this handler has nothing to push; add a
    // per-path mark and push if either ever moves into the cache
    // (swamp-club#2415).
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else if (isSwampError(error)) {
      // Handled before the not-found branch below so force never turns a
      // missing vault into a success.
      sendVaultSwampError(
        socket,
        requestId,
        "vault_delete_failed",
        payload.vaultName,
        error,
      );
    } else if (
      error instanceof Error &&
      /not found|can't find|ResourceNotFoundException/i.test(error.message)
    ) {
      if (payload.force) {
        send(socket, {
          type: "vault.delete",
          id: requestId,
          payload: {
            data: {
              vaultName: payload.vaultName,
              secretKey: payload.key,
              vaultType,
              noOp: true,
              timestamp: new Date().toISOString(),
            },
          },
        });
      } else {
        sendError(
          socket,
          requestId,
          "not_found",
          `Secret '${payload.key}' not found in vault '${payload.vaultName}'`,
        );
      }
    } else {
      const message = sanitizeErrorForClient(error);
      sendError(socket, requestId, "vault_delete_failed", message);
    }
  } finally {
    if (flush) await flush();
  }
}

export async function handleVaultDescribe(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultDescribePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultDescribeDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultDescribe(libCtx, deps, payload.vaultNameOrId, payload.vaultType),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Vault not found");
      return;
    }

    send(socket, {
      type: "vault.describe",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_describe_failed", message);
  }
}

export async function handleVaultInspect(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultInspectPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectReservedVault(socket, requestId, payload.vaultName)) return;

  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultInspectDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultInspect(libCtx, deps, payload.vaultName, payload.key),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(socket, requestId, "not_found", "Secret not found");
      return;
    }

    send(socket, {
      type: "vault.inspect",
      id: requestId,
      payload: { data: result },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_inspect_failed", message);
  }
}

export async function handleVaultListKeys(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: VaultListKeysPayload,
): Promise<void> {
  if (
    payload?.vaultName &&
    rejectReservedVault(socket, requestId, payload.vaultName)
  ) return;

  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = await createVaultListKeysDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultListKeys(libCtx, deps, {
        vaultName: payload?.vaultName ?? "",
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.list-keys",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_list_keys_failed", message);
  }
}

export async function handleVaultSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: VaultSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps: VaultSearchDeps = {
      findAllVaults: () => ctx.repoContext.vaultConfigRepo.findAll(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_search_failed", message);
  }
}

export async function handleVaultAnnotate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultAnnotatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectReservedVault(socket, requestId, payload.vaultName)) return;

  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "write",
      vaultAccessResource("vault"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultAnnotateDeps(
      ctx.repoDir,
      ctx.repoContext.eventBus,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultAnnotate(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
        url: payload.url,
        notes: payload.notes,
        labels: payload.labels,
        removeLabels: payload.removeLabels,
        clear: payload.clear ?? false,
      }),
      {
        annotating: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    if (!result) {
      sendError(
        socket,
        requestId,
        "vault_annotate_failed",
        "Vault annotation failed",
      );
      return;
    }

    send(socket, {
      type: "vault.annotate",
      id: requestId,
      payload: { data: result },
    });

    // No datastore push: secrets and annotations live in the always-local
    // .swamp/secrets (or an external provider), and vault audit entries go
    // to the repo-local .swamp/audit, so nothing here enters the datastore
    // cache. Like vault.put, this handler has nothing to push; add a
    // per-path mark and push if either ever moves into the cache
    // (swamp-club#2415).
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_annotate_failed", message);
  }
}

export async function handleVaultCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultCreatePayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "write",
      vaultAccessResource(payload.name),
      ctx,
    ).allowed
  ) return;

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push vault create to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        // The shared repository's mark hook signals the config it writes.
        const deps = await createVaultCreateDeps(
          ctx.repoDir,
          ctx.repoContext.vaultConfigRepo,
        );

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          vaultCreate(libCtx, deps, {
            vaultType: payload.vaultType,
            name: payload.name,
            config: payload.config,
            repoDir: ctx.repoDir,
            auditReads: payload.auditReads,
            // No trustKeySource: the client does not own this host, so a
            // local_encryption vault gets the server's key source
            // (swamp-club#2690).
          }),
          {
            creating: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        send(socket, {
          type: "vault.create",
          id: requestId,
          payload: { data: result ?? {} },
        });
        replied = true;
      } catch (error) {
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "vault_create_failed", message);
      }
    },
  );
}

export async function handleVaultEdit(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultEditPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectEditWithoutContent(socket, requestId, payload.content)) return;

  const vaultConfigRepo = ctx.repoContext.vaultConfigRepo;

  // Authorize the vault the edit will act on, by its name, not the raw
  // name-or-id: a grant matches the resource name, so an id would sidestep
  // name-scoped denies (swamp-club#2426, swamp-club#2674).
  let resolved: VaultEditConfigInfo | null = null;
  // Set when the requested vault's own file does not parse. Its stored name
  // cannot be read, so replacing it needs admin authority as well as write
  // on the name it is given.
  let repairTarget: { id: string; type: string } | null = null;
  try {
    resolved = await findVaultByNameOrId(
      vaultConfigRepo,
      payload.vaultNameOrId,
      payload.vaultType,
    );
  } catch (error) {
    // Any other vault that cannot be loaded is authorized by the requested
    // name and then reported as not found.
    if (
      error instanceof VaultConfigParseError &&
      payload.vaultType !== undefined &&
      error.vaultType === payload.vaultType &&
      error.vaultId === payload.vaultNameOrId
    ) {
      repairTarget = { id: error.vaultId, type: error.vaultType };
    }
  }
  const vaultName = resolved?.name ?? payload.vaultNameOrId;
  if (rejectReservedVault(socket, requestId, vaultName)) return;
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "write",
      vaultAccessResource(vaultName),
      ctx,
    ).allowed
  ) return;
  const target: VaultEditConfigInfo | null = resolved ??
    (repairTarget
      ? { id: repairTarget.id, name: repairTarget.id, type: repairTarget.type }
      : null);
  if (!target) {
    const typeHint = payload.vaultType ? ` of type '${payload.vaultType}'` : "";
    sendError(
      socket,
      requestId,
      "not_found",
      `Vault not found: ${payload.vaultNameOrId}${typeHint}`,
    );
    return;
  }
  if (resolved && payload.vaultType && resolved.type !== payload.vaultType) {
    sendError(
      socket,
      requestId,
      "vault_edit_failed",
      `Vault '${payload.vaultNameOrId}' found but has type '${resolved.type}', not '${payload.vaultType}'`,
    );
    return;
  }

  // The root pushes only once the success reply was sent (swamp-club#3035).
  let replied = false;
  await runInRootUnitOfWork(
    ctx.repoContext,
    {
      flush: () =>
        replied
          ? pushChangedToRemote(ctx, {
            onError: (error) =>
              logger.warn(
                "Failed to push vault edit to remote datastore: {error}",
                { error },
              ),
          })
          : Promise.resolve(),
    },
    async () => {
      try {
        const libCtx = handlerLibSwampContext(ctx);
        const deps = createVaultEditDeps(ctx.repoDir, vaultConfigRepo);

        let result: Record<string, unknown> | undefined;
        await consumeStream(
          vaultEdit(libCtx, deps, {
            vaultNameOrId: target.id,
            vaultType: target.type,
            byId: true,
            stdinContent: payload.content,
            // No trustKeySource: the client does not own this host, so a
            // local_encryption vault keeps its stored key source, and a repair
            // gets the defaults under this repo (swamp-club#2690).
            repoDir: ctx.repoDir,
            // Every save is authorized against the edited vault too, so a
            // rename needs write on the new name, as vault.create requires for
            // the name it creates. A repair request was authorized by id only,
            // so if the file parses again by now its stored name is checked as
            // well.
            authorizeUpdate: (before, after) =>
              (!repairTarget ||
                authorizeOrReject(
                  socket,
                  requestId,
                  principal,
                  "write",
                  vaultAccessResource(before.name),
                  ctx,
                ).allowed) &&
              authorizeOrReject(
                socket,
                requestId,
                principal,
                "write",
                vaultAccessResource(after.name),
                ctx,
              ).allowed,
            ...(repairTarget
              ? {
                authorizeRepair: (_target, after) =>
                  authorizeOrReject(socket, requestId, principal, "admin", {
                    kind: "access",
                    name: "*",
                    fields: {},
                  }, ctx).allowed &&
                  !rejectReservedVault(socket, requestId, after.name) &&
                  authorizeOrReject(
                    socket,
                    requestId,
                    principal,
                    "write",
                    vaultAccessResource(after.name),
                    ctx,
                  ).allowed,
              }
              : {}),
          }),
          {
            resolving: () => {},
            launching: () => {},
            completed: (e) => {
              result = e.data as unknown as Record<string, unknown>;
            },
            error: (e) => {
              throw new Error(e.error.message);
            },
          },
        );

        if (controller.signal.aborted) {
          sendError(socket, requestId, "cancelled", "Operation was cancelled");
          return;
        }

        if (repairTarget && result?.repaired === true) {
          // vault.edit is audited against every vault, so record which one an
          // admin replaced.
          logger.info(
            "Repaired vault {type}/{id} as {name} for {principal}",
            {
              type: target.type,
              id: target.id,
              name: result.name,
              principal: principal ? principalToString(principal) : "(none)",
            },
          );
        }

        send(socket, {
          type: "vault.edit",
          id: requestId,
          payload: { data: result ?? {} },
        });
        replied = true;
      } catch (error) {
        // A denied rename was already reported by authorizeOrReject.
        if (wasRequestErrored(socket, requestId)) return;
        const message = sanitizeErrorForClient(error);
        sendError(socket, requestId, "vault_edit_failed", message);
      }
    },
  );
}

export async function handleVaultAuditTrail(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultAuditTrailPayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  // A named vault is authorized as that vault. Without one the trail covers
  // every vault, so each entry is kept only when its vault is readable, as a
  // named read of it would be (swamp-club#2675).
  let include: ((entry: { vaultName: string }) => boolean) | undefined;
  if (payload?.vaultName) {
    if (
      !authorizeOrReject(
        socket,
        requestId,
        principal,
        "read",
        vaultAccessResource(payload.vaultName),
        ctx,
      ).allowed
    ) return;
  } else {
    if (
      !authorizeAnyOrReject(socket, requestId, principal, "read", "data", ctx)
    ) return;
    const readable = resourceDecider(socket, principal, "read", ctx);
    include = (entry) => readable(vaultAccessResource(entry.vaultName));
  }

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultAuditTrailDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultAuditTrail(libCtx, deps, {
        vaultName: payload?.vaultName,
        secretKey: payload?.secretKey,
        action: payload?.action,
        since: payload?.since ? new Date(payload.since) : undefined,
        until: payload?.until ? new Date(payload.until) : undefined,
        limit: payload?.limit,
        include,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.audit-trail",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_audit_trail_failed", message);
  }
}

export async function handleVaultReadSecret(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultReadSecretPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (rejectReservedVault(socket, requestId, payload.vaultName)) return;

  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      ...vaultAccessResource(payload.vaultName),
      fields: {
        ...vaultAccessResource(payload.vaultName).fields,
        key: payload.secretKey,
      },
    }, ctx).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    const deps = createVaultReadSecretDeps(
      ctx.repoDir,
      ctx.repoContext.eventBus,
    );

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultReadSecret(libCtx, deps, {
        vaultName: payload.vaultName,
        secretKey: payload.secretKey,
      }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.read-secret",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_read_secret_failed", message);
  }
}

export async function handleVaultTypeSearch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  controller: AbortController,
  principal: Principal | null,
  payload?: VaultTypeSearchPayload,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      kindResource("data"),
      ctx,
    ).allowed
  ) return;

  try {
    const libCtx = handlerLibSwampContext(ctx);
    await vaultTypeRegistry.ensureLoaded();
    const deps: VaultTypeSearchDeps = {
      getVaultTypes: () => getVaultTypes(),
    };

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultTypeSearch(libCtx, deps, { query: payload?.query }),
      {
        resolving: () => {},
        completed: (e) => {
          result = e.data as unknown as Record<string, unknown>;
        },
        error: (e) => {
          throw new Error(e.error.message);
        },
      },
    );

    if (controller.signal.aborted) {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
      return;
    }

    send(socket, {
      type: "vault.type.search",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_type_search_failed", message);
  }
}
