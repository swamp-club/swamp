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
  vaultAnnotate,
  vaultAuditTrail,
  vaultCreate,
  vaultDelete,
  vaultDeletePreview,
  vaultDescribe,
  vaultEdit,
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
import type { Principal } from "../../domain/access/principal.ts";
import { getVaultTypes } from "../../domain/vaults/vault_types.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultGetDeps(ctx.repoDir);

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
      }, ctx)
    ) return;
  } else {
    if (
      !authorizeOrReject(socket, requestId, principal, "write", {
        kind: "data",
        name: "vault",
        fields: {},
      }, ctx)
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
    }, ctx)
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
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      sendError(socket, requestId, "cancelled", "Operation was cancelled");
    } else if (
      payload.force &&
      error instanceof Error &&
      /not found|can't find|ResourceNotFoundException/i.test(error.message)
    ) {
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultAnnotateDeps(
      ctx.repoDir,
      ctx.repoContext.eventBus,
    );

    // Convert labels from string[] to Record<string,string> if provided
    const labelsRecord: Record<string, string> | undefined = payload.labels
      ? Object.fromEntries(payload.labels.map((l) => [l, ""]))
      : undefined;

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultAnnotate(libCtx, deps, {
        vaultName: payload.vaultName,
        key: payload.key,
        url: payload.url,
        notes: payload.notes,
        labels: labelsRecord,
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = await createVaultCreateDeps(ctx.repoDir);

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
  if (
    !authorizeOrReject(socket, requestId, principal, "write", {
      kind: "data",
      name: payload.vaultNameOrId,
      fields: {},
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultEditDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultEdit(libCtx, deps, {
        vaultNameOrId: payload.vaultNameOrId,
        vaultType: payload.vaultType,
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
      type: "vault.edit",
      id: requestId,
      payload: { data: result ?? {} },
    });
  } catch (error) {
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
    }, ctx)
  ) return;

  try {
    const libCtx = createLibSwampContext();
    const deps = createVaultAuditTrailDeps(ctx.repoDir);

    let result: Record<string, unknown> | undefined;
    await consumeStream(
      vaultAuditTrail(libCtx, deps, {
        vaultName: payload?.vaultName,
        secretKey: payload?.secretKey,
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
    }, ctx)
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
    }, ctx)
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
