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

import {
  consumeStream,
  createLibSwampContext,
  createVaultAnnotateDeps,
  createVaultAuditTrailDeps,
  createVaultCreateDeps,
  createVaultDeleteDeps,
  createVaultDescribeDeps,
  createVaultEditDeps,
  createVaultGetDeps,
  createVaultInspectDeps,
  createVaultListKeysDeps,
  createVaultPutDeps,
  createVaultReadSecretDeps,
  findVaultByNameOrId,
  isSwampError,
  vaultAnnotate,
  vaultAuditTrail,
  vaultCreate,
  type VaultCreateData,
  vaultDelete,
  vaultDeletePreview,
  vaultDescribe,
  vaultEdit,
  type VaultEditConfigInfo,
  vaultGet,
  vaultInspect,
  vaultListKeys,
  vaultPut,
  vaultPutPreview,
  vaultReadSecret,
  vaultSearch,
  type VaultSearchDeps,
  vaultTypeSearch,
  type VaultTypeSearchDeps,
} from "../../libswamp/mod.ts";
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
import { isCustomDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { VaultConfigParseError } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import { getVaultTypes } from "../../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  LibSwampStreamError,
  rejectEditWithoutContent,
  sanitizeErrorForClient,
  send,
  sendError,
  wasRequestErrored,
} from "./shared.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

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

export async function handleVaultGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultGetPayload,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
      !authorizeOrReject(socket, requestId, principal, "admin", {
        kind: "data",
        name: "vault",
        fields: {},
      }, ctx).allowed
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "data",
        name: "vault",
        fields: {},
      }, ctx).allowed
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
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
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
    const libCtx = createLibSwampContext();
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
      // vaultDeletePreview throws a SwampError for a missing vault. Its message
      // lists every configured vault, but this request is authorized by write
      // on data:vault and listing vaults needs read, so send a fixed message.
      // Handled before the not-found branch below so force never turns a
      // missing vault into a success.
      const clientError = new LibSwampStreamError(error);
      const missingVault = error.code === "not_found" &&
        (error.details as { entityType?: unknown } | undefined)?.entityType ===
          "Vault";
      sendError(
        socket,
        requestId,
        "vault_delete_failed",
        missingVault
          ? `Vault not found: ${payload.vaultName}`
          : sanitizeErrorForClient(clientError),
        clientErrorDetails(clientError),
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: "vault",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.name,
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createVaultCreateDeps(ctx.repoDir);

    let created: VaultCreateData | undefined;
    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultCreate(libCtx, deps, {
        vaultType: payload.vaultType,
        name: payload.name,
        config: payload.config,
        repoDir: ctx.repoDir,
        auditReads: payload.auditReads,
      }),
      {
        creating: () => {},
        completed: (e) => {
          created = e.data;
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

    if (ctx.syncService) {
      const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
        ? ctx.datastoreConfig.namespace
        : undefined;
      try {
        // The vault config repository has no markDirty hook, so mark the
        // file it wrote, by path: a bare markDirty() turns the push into a
        // walk of the whole cache (swamp-club#2415). Under managedConfig the
        // file is in the datastore's config tier; otherwise it is repo-local
        // and the hook drops the mark.
        if (created) {
          await ctx.repoContext.markDirty?.(
            ctx.repoContext.vaultConfigRepo.getPath(created.type, created.id),
          );
        }
        await ctx.syncService.pushChanged({ namespace });
      } catch (pushError) {
        logger.warn(
          "Failed to push vault create to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_create_failed", message);
  }
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
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: vaultName,
      fields: {},
    }, ctx).allowed
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

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultEditDeps(ctx.repoDir, vaultConfigRepo);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultEdit(libCtx, deps, {
        vaultNameOrId: target.id,
        vaultType: target.type,
        byId: true,
        stdinContent: payload.content,
        // Every save is authorized against the edited vault too, so a rename
        // needs write on the new name, as vault.create requires for the name
        // it creates. A repair request was authorized by id only, so if the
        // file parses again by now its stored name is checked as well.
        authorizeUpdate: (before, after) =>
          (!repairTarget ||
            authorizeOrReject(socket, requestId, principal, "write", {
              kind: "data",
              name: before.name,
              fields: {},
            }, ctx).allowed) &&
          authorizeOrReject(socket, requestId, principal, "write", {
            kind: "data",
            name: after.name,
            fields: {},
          }, ctx).allowed,
        ...(repairTarget
          ? {
            authorizeRepair: (_target, after) =>
              authorizeOrReject(socket, requestId, principal, "admin", {
                kind: "access",
                name: "*",
                fields: {},
              }, ctx).allowed &&
              !rejectReservedVault(socket, requestId, after.name) &&
              authorizeOrReject(socket, requestId, principal, "write", {
                kind: "data",
                name: after.name,
                fields: {},
              }, ctx).allowed,
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

    if (ctx.syncService) {
      const namespace = isCustomDatastoreConfig(ctx.datastoreConfig)
        ? ctx.datastoreConfig.namespace
        : undefined;
      try {
        // Mark the file the edit wrote, by path, as handleVaultCreate does: a
        // bare markDirty() turns the push into a walk of the whole cache
        // (swamp-club#2415). Under managedConfig the file is in the
        // datastore's config tier; otherwise it is repo-local and the hook
        // drops the mark.
        await ctx.repoContext.markDirty?.(
          vaultConfigRepo.getPath(target.type, target.id),
        );
        await ctx.syncService.pushChanged({ namespace });
      } catch (pushError) {
        logger.warn(
          "Failed to push vault edit to remote datastore: {error}",
          {
            error: pushError instanceof Error
              ? pushError.message
              : String(pushError),
          },
        );
      }
    }
  } catch (error) {
    // A denied rename was already reported by authorizeOrReject.
    if (wasRequestErrored(socket, requestId)) return;
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "vault_edit_failed", message);
  }
}

export async function handleVaultAuditTrail(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: VaultAuditTrailPayload | undefined,
  controller: AbortController,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: payload?.vaultName ?? "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
      kind: "data",
      name: payload.vaultName,
      fields: { key: payload.secretKey },
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "data",
      name: "*",
      fields: {},
    }, ctx).allowed
  ) return;

  try {
    const libCtx = createLibSwampContext();
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
