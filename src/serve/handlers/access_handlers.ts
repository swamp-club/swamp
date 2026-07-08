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
 * Access-control request handlers (access.* verbs).
 */

import { join } from "@std/path";
import type {
  AccessCanIPayload,
  AccessCheckPayload,
  AccessGrantListPayload,
  AccessGroupListPayload,
  AccessReloadFileResult,
} from "../protocol.ts";
import {
  collectErrors,
  type GrantFileError,
  readGrantFiles,
} from "../../domain/access/grant_file.ts";
import {
  createFileGrantStore,
  reconcileAllFileGrants,
} from "../../domain/access/grant_file_reconciler.ts";
import { validateGrantCondition } from "../../infrastructure/cel/grant_condition_environment.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  type Grant,
  GRANT_MODEL_TYPE,
  GrantSchema,
} from "../../domain/models/access/grant_model.ts";
import {
  type Group,
  GROUP_MODEL_TYPE,
  GroupSchema,
} from "../../domain/models/access/group_model.ts";
import {
  parsePrincipal,
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { ActionSchema } from "../../domain/access/action.ts";
import { parseResourceSelector } from "../../domain/access/resource_selector.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

export async function handleAccessGrantList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  payload?: AccessGrantListPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "access",
      name: "grant",
      fields: {},
    }, ctx)
  ) return;

  try {
    await modelRegistry.ensureLoaded();
    const dataItems = await ctx.repoContext.unifiedDataRepo.findAllForType(
      GRANT_MODEL_TYPE,
    );

    let results: { grant: Grant; instanceName: string }[] = [];
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      const content = await ctx.repoContext.unifiedDataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      if (!content) continue;
      let attrs: Record<string, unknown>;
      try {
        attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const parsed = GrantSchema.safeParse(attrs);
      if (parsed.success && parsed.data.state === "active") {
        results.push({
          grant: parsed.data,
          instanceName: data.tags["modelName"] ?? "",
        });
      }
    }

    if (payload?.subject) {
      results = results.filter((r) =>
        `${r.grant.subject.kind}:${r.grant.subject.name}` === payload.subject
      );
    }
    if (payload?.resource) {
      const sel = parseResourceSelector(payload.resource);
      results = results.filter((r) =>
        r.grant.resource.kind === sel.kind &&
        r.grant.resource.pattern === sel.pattern
      );
    }

    send(socket, {
      type: "access.grant.list",
      id: requestId,
      payload: {
        grants: results.map((r) => ({
          ...r.grant,
          instanceName: r.instanceName,
        })) as unknown as Record<string, unknown>[],
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_grant_list_failed", message);
  }
}

export async function handleAccessGroupList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  payload?: AccessGroupListPayload,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "read", {
      kind: "access",
      name: "group",
      fields: {},
    }, ctx)
  ) return;

  try {
    await modelRegistry.ensureLoaded();
    const dataItems = await ctx.repoContext.unifiedDataRepo.findAllForType(
      GROUP_MODEL_TYPE,
    );

    let groups: Group[] = [];
    for (const { data, modelType, modelId } of dataItems) {
      if (data.isRenamed || data.isDeleted) continue;
      const content = await ctx.repoContext.unifiedDataRepo.getContent(
        modelType,
        modelId,
        data.name,
      );
      if (!content) continue;
      let attrs: Record<string, unknown>;
      try {
        attrs = JSON.parse(new TextDecoder().decode(content)) as Record<
          string,
          unknown
        >;
      } catch {
        continue;
      }
      const parsed = GroupSchema.safeParse(attrs);
      if (parsed.success) {
        groups.push(parsed.data);
      }
    }

    if (payload?.name) {
      groups = groups.filter((g) => g.name === payload.name);
    }

    send(socket, {
      type: "access.group.list",
      id: requestId,
      payload: {
        groups: groups as unknown as Record<string, unknown>[],
      },
    });
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_group_list_failed", message);
  }
}

export function handleAccessCheck(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AccessCheckPayload,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return Promise.resolve();

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return Promise.resolve();
    }

    const principal = parsePrincipal(payload.subject);
    const actionResult = ActionSchema.safeParse(payload.action);
    if (!actionResult.success) {
      sendError(
        socket,
        requestId,
        "invalid_action",
        `Invalid action "${payload.action}": must be one of run, read, write, admin`,
      );
      return Promise.resolve();
    }

    const resource = parseResourceSelector(payload.resource);
    const collectives = payload.collectives ?? [];

    const service = ctx.policySnapshotLoader.decisionService;
    const decisions = service.explain(
      { principal, collectives },
      actionResult.data,
      { kind: resource.kind, name: resource.pattern, fields: {} },
    );

    send(socket, {
      type: "access.check",
      id: requestId,
      payload: {
        subject: payload.subject,
        action: payload.action,
        resource: payload.resource,
        collectives,
        decisions: decisions as unknown as Record<string, unknown>[],
      },
    });
    return Promise.resolve();
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_check_failed", message);
    return Promise.resolve();
  }
}

export function handleAccessCanI(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AccessCanIPayload,
  principal: Principal | null,
): Promise<void> {
  if (!principal) {
    sendError(
      socket,
      requestId,
      "unauthorized",
      "can-i requires an authenticated connection — use --token or swamp auth server-login",
    );
    return Promise.resolve();
  }

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return Promise.resolve();
    }

    const snapshot = ctx.policySnapshotLoader.snapshot;
    const collectives = payload.collectives ?? [];
    const accessPrincipal = { principal, collectives };
    const principalStr = principalToString(principal);

    if (payload.action && payload.resource) {
      const actionResult = ActionSchema.safeParse(payload.action);
      if (!actionResult.success) {
        sendError(
          socket,
          requestId,
          "invalid_action",
          `Invalid action "${payload.action}": must be one of run, read, write, admin`,
        );
        return Promise.resolve();
      }

      const resource = parseResourceSelector(payload.resource);
      const service = ctx.policySnapshotLoader.decisionService;
      const decisions = service.explain(
        accessPrincipal,
        actionResult.data,
        { kind: resource.kind, name: resource.pattern, fields: {} },
      );

      send(socket, {
        type: "access.can-i",
        id: requestId,
        payload: {
          principal: principalStr,
          decisions: decisions.map((d) => ({
            action: payload.action!,
            resource: payload.resource!,
            effect: d.effect,
            grantId: d.grantId,
            via: `${d.subject.kind}:${d.subject.name}`,
            ...(d.condition ? { condition: d.condition } : {}),
          })),
        },
      });
    } else {
      const subjects: string[] = [principalStr];
      const localGroups = snapshot.groupsForPrincipal(principalStr);
      for (const groupName of localGroups) {
        subjects.push(`group:${groupName}`);
      }
      for (const collective of collectives) {
        subjects.push(`idp-group:${collective}`);
      }

      const grants = snapshot.grantsForSubjects(subjects);
      send(socket, {
        type: "access.can-i",
        id: requestId,
        payload: {
          principal: principalStr,
          decisions: grants.flatMap((g) =>
            g.actions.map((a) => ({
              action: a,
              resource: `${g.resource.kind}:${g.resource.pattern}`,
              effect: g.effect,
              grantId: g.id,
              via: `${g.subject.kind}:${g.subject.name}`,
              ...(g.condition ? { condition: g.condition } : {}),
            }))
          ),
        },
      });
    }
    return Promise.resolve();
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_can_i_failed", message);
    return Promise.resolve();
  }
}

function formatGrantFileErrors(errors: GrantFileError[]): string[] {
  return errors.map((e) => {
    const loc = e.entryIndex !== undefined
      ? `${e.filename} entry ${e.entryIndex + 1}`
      : e.filename;
    return `${loc}: ${e.message}`;
  });
}

export async function handleAccessReload(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(socket, requestId, principal, "admin", {
      kind: "access",
      name: "*",
      fields: {},
    }, ctx)
  ) return;

  try {
    if (!ctx.policySnapshotLoader) {
      sendError(
        socket,
        requestId,
        "access_not_configured",
        "Access control is not configured on this server",
      );
      return;
    }

    const grantsDir = join(ctx.repoDir, "grants");
    const fileResults = await readGrantFiles(grantsDir, validateGrantCondition);
    const allErrors = collectErrors(fileResults);

    if (allErrors.length > 0) {
      send(socket, {
        type: "access.reload",
        id: requestId,
        payload: {
          success: false,
          grantCount: 0,
          groupCount: 0,
          errors: formatGrantFileErrors(allErrors),
        },
      });
      return;
    }

    if (fileResults.size > 0) {
      const validEntries = new Map<
        string,
        import("../../domain/access/grant_file.ts").GrantFileEntry[]
      >();
      for (const [filename, result] of fileResults) {
        validEntries.set(filename, result.entries);
      }

      const autoDefDir = join(ctx.repoDir, ".swamp", "auto-definitions");
      const autoDefRepo = new YamlDefinitionRepository(
        ctx.repoDir,
        undefined,
        autoDefDir,
        false,
      );
      const fileGrantStore = createFileGrantStore(
        ctx.repoContext.definitionRepo,
        autoDefRepo,
        ctx.repoContext.unifiedDataRepo,
      );

      const reconcileResult = await reconcileAllFileGrants(
        validEntries,
        fileGrantStore,
      );

      const fileResultList: AccessReloadFileResult[] = [];
      for (const [filename, result] of fileResults) {
        const perFile = reconcileResult.perFile.get(filename);
        fileResultList.push({
          filename,
          entryCount: result.entries.length,
          created: perFile?.created ?? 0,
          revoked: perFile?.revoked ?? 0,
          reactivated: perFile?.reactivated ?? 0,
          unchanged: perFile?.unchanged ?? 0,
        });
      }

      const snapshotResult = await ctx.policySnapshotLoader.loadWithCounts();

      send(socket, {
        type: "access.reload",
        id: requestId,
        payload: {
          success: true,
          grantCount: snapshotResult.grantCount,
          groupCount: snapshotResult.groupCount,
          filesProcessed: reconcileResult.filesProcessed,
          fileResults: fileResultList,
        },
      });
    } else {
      const result = await ctx.policySnapshotLoader.loadWithCounts();

      send(socket, {
        type: "access.reload",
        id: requestId,
        payload: {
          success: true,
          grantCount: result.grantCount,
          groupCount: result.groupCount,
        },
      });
    }
  } catch (error) {
    const message = sanitizeErrorForClient(error);
    sendError(socket, requestId, "access_reload_failed", message);
  }
}
