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

import type { Action } from "../../domain/access/action.ts";
import { workspaceAccessResource } from "../../domain/access/access_resources.ts";
import { isIntegrationClient } from "../../domain/access/client.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { parseWorkspaceName } from "../../domain/workspace/workspace_name.ts";
import { hostedWorkspaceCreate } from "../../libswamp/hosted_workspace/create.ts";
import { hostedWorkspaceDelete } from "../../libswamp/hosted_workspace/delete.ts";
import type { HostedWorkspaceCaller } from "../../libswamp/hosted_workspace/deps.ts";
import { hostedWorkspaceGet } from "../../libswamp/hosted_workspace/get.ts";
import { hostedWorkspaceList } from "../../libswamp/hosted_workspace/list.ts";
import { hostedWorkspaceResume } from "../../libswamp/hosted_workspace/resume.ts";
import { hostedWorkspaceSuspend } from "../../libswamp/hosted_workspace/suspend.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { HostRootWorkspaces } from "../host_root_workspaces.ts";
import {
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
  type WorkspaceNamePayload,
} from "../protocol.ts";

export {
  NOT_A_HOST_ROOT_CODE,
  SIGN_IN_NOT_OFFERED_CODE,
  SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
  SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
  SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
};
import {
  accessCallerOf,
  authorizeOrReject,
  type ConnectionContext,
  getConnectionTokenExpiresAt,
  handlerLibSwampContext,
  sanitizeErrorForClient,
  send,
  sendError,
  wouldAuthorize,
} from "./shared.ts";

export const TOO_MANY_SIGN_IN_CODES_CODE = "too_many_sign_in_codes";

type ServiceEvent<D> =
  | { kind: "completed"; data: D }
  | { kind: "error"; error: SwampError };

/**
 * a request naming a workspace needs its action on workspace:<name>, which the
 * root's admins pass with no workspace grant; list needs nothing
 */
function admitted(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  need: { readonly action: Action; readonly name: string } | "list",
): HostRootWorkspaces | undefined {
  if (
    need !== "list" &&
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      need.action,
      workspaceAccessResource(need.name),
      ctx,
    ).allowed
  ) return undefined;
  if (ctx.hostedWorkspaces === undefined) {
    sendError(
      socket,
      requestId,
      NOT_A_HOST_ROOT_CODE,
      "This serve answers no workspace requests: only the root of a swamp serve host does.",
    );
    return undefined;
  }
  return ctx.hostedWorkspaces;
}

/** the services' messages name no host path, so they reach the caller as given */
async function outcome<D>(
  socket: WebSocket,
  requestId: string,
  events: AsyncIterable<ServiceEvent<D>>,
): Promise<D | undefined> {
  try {
    for await (const event of events) {
      if (event.kind === "completed") return event.data;
      sendError(socket, requestId, event.error.code, event.error.message);
      return undefined;
    }
  } catch (error) {
    sendError(socket, requestId, "host_error", sanitizeErrorForClient(error));
    return undefined;
  }
  sendError(
    socket,
    requestId,
    "host_error",
    "The host could not complete the request.",
  );
  return undefined;
}

function callerOf(
  principal: Principal | null,
  ctx: ConnectionContext,
): HostedWorkspaceCaller {
  // none mode has no principal; the audit log names the caller the same way
  if (principal === null) return { principal: "anonymous", username: null };
  const names = ctx.resolvedUserNames ?? {};
  const username = ctx.authConfig.mode === "oauth" &&
      principal.kind === "user" && Object.hasOwn(names, principal.id)
    ? names[principal.id]
    : null;
  return { principal: principalToString(principal), username };
}

export async function handleWorkspaceCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkspaceNamePayload,
  principal: Principal | null,
): Promise<void> {
  const root = admitted(socket, requestId, principal, ctx, {
    action: "write",
    name: payload.name,
  });
  if (root === undefined) return;
  const data = await outcome(
    socket,
    requestId,
    hostedWorkspaceCreate(handlerLibSwampContext(ctx), root.services, {
      name: payload.name,
      caller: callerOf(principal, ctx),
      access: root.rootAccess(),
    }),
  );
  if (data === undefined) return;
  send(socket, {
    type: "workspace.create",
    id: requestId,
    payload: { data: { ...data } },
  });
}

export async function handleWorkspaceList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  const root = admitted(socket, requestId, principal, ctx, "list");
  if (root === undefined) return;
  const data = await outcome(
    socket,
    requestId,
    hostedWorkspaceList(handlerLibSwampContext(ctx), root.services),
  );
  if (data === undefined) return;
  const caller = accessCallerOf(socket, principal);
  // a caller under a ceiling sees only the workspaces it could get
  const ceilinged = isIntegrationClient(caller.client) ||
    caller.delegation !== undefined;
  const workspaces = ceilinged
    ? data.workspaces.filter((summary) =>
      wouldAuthorize(
        socket,
        principal,
        "read",
        workspaceAccessResource(summary.name),
        ctx,
      )
    )
    : data.workspaces;
  send(socket, {
    type: "workspace.list",
    id: requestId,
    payload: {
      data: { workspaces: workspaces.map((summary) => ({ ...summary })) },
    },
  });
}

export async function handleWorkspaceGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkspaceNamePayload,
  principal: Principal | null,
): Promise<void> {
  const root = admitted(socket, requestId, principal, ctx, {
    action: "read",
    name: payload.name,
  });
  if (root === undefined) return;
  const data = await outcome(
    socket,
    requestId,
    hostedWorkspaceGet(handlerLibSwampContext(ctx), root.services, {
      name: payload.name,
    }),
  );
  if (data === undefined) return;
  send(socket, {
    type: "workspace.get",
    id: requestId,
    payload: { data: { ...data } },
  });
}

const CHANGES = {
  "workspace.suspend": hostedWorkspaceSuspend,
  "workspace.resume": hostedWorkspaceResume,
  "workspace.delete": hostedWorkspaceDelete,
} as const;

/** suspend, resume and delete each write the wanted file and answer alike */
export async function handleWorkspaceChange(
  type: keyof typeof CHANGES,
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkspaceNamePayload,
  principal: Principal | null,
): Promise<void> {
  const root = admitted(socket, requestId, principal, ctx, {
    action: "admin",
    name: payload.name,
  });
  if (root === undefined) return;
  const data = await outcome(
    socket,
    requestId,
    CHANGES[type](handlerLibSwampContext(ctx), root.services, {
      name: payload.name,
    }),
  );
  if (data === undefined) return;
  send(socket, { type, id: requestId, payload: { data: { ...data } } });
}

// the workspace applies its own admission lists when it redeems the code
export async function handleWorkspaceSignIn(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: WorkspaceNamePayload,
  principal: Principal | null,
): Promise<void> {
  const root = ctx.hostedWorkspaces;
  if (root === undefined) {
    sendError(
      socket,
      requestId,
      NOT_A_HOST_ROOT_CODE,
      "This serve issues no sign-in codes: only the root of a swamp serve host does.",
    );
    return;
  }
  if (ctx.authConfig.mode === "none" || principal === null) {
    sendError(
      socket,
      requestId,
      SIGN_IN_NOT_OFFERED_CODE,
      "This host's workspaces need no sign-in: its root runs with no authentication.",
    );
    return;
  }
  const caller = accessCallerOf(socket, principal);
  // a workspace token would not carry the caller's ceiling
  if (isIntegrationClient(caller.client) || caller.delegation !== undefined) {
    sendError(
      socket,
      requestId,
      SIGN_IN_REFUSED_FOR_INTEGRATION_CODE,
      "A caller acting through an integration or a delegation cannot sign in to a workspace.",
    );
    return;
  }
  // a worker's root credential must not reach into every workspace
  if (principal.kind !== "user") {
    sendError(
      socket,
      requestId,
      SIGN_IN_REFUSED_FOR_PRINCIPAL_CODE,
      "Only a person signs in to a workspace through the root.",
    );
    return;
  }
  const tokenExpiresAt = getConnectionTokenExpiresAt(socket);
  if (tokenExpiresAt === undefined) {
    sendError(
      socket,
      requestId,
      SIGN_IN_REFUSED_FOR_CREDENTIAL_CODE,
      "Sign in to the root with a server token, then ask again.",
    );
    return;
  }
  // never looked up, so a caller cannot probe which workspaces exist
  let workspace: string;
  try {
    workspace = parseWorkspaceName(payload.name);
  } catch (error) {
    sendError(
      socket,
      requestId,
      "user_error",
      error instanceof Error ? error.message : String(error),
    );
    return;
  }
  const issued = await root.signInCodes.issue(workspace, {
    principal: principalToString(principal),
    username: callerOf(principal, ctx).username ??
      caller.loginIdentity?.username ?? null,
    email: caller.loginIdentity?.email ?? null,
    collectives: caller.collectives,
    groups: caller.groups,
    expiresAt: tokenExpiresAt,
  });
  if (!issued.ok) {
    sendError(
      socket,
      requestId,
      TOO_MANY_SIGN_IN_CODES_CODE,
      issued.reason === "principal_limit"
        ? "You hold too many unused sign-in codes. Wait a minute, then ask again."
        : "The root holds too many unused sign-in codes. Wait a minute, then ask again.",
    );
    return;
  }
  send(socket, {
    type: "workspace.sign-in",
    id: requestId,
    payload: {
      data: {
        name: workspace,
        code: issued.code,
        expiresAt: issued.expiresAt,
      },
    },
  });
}
