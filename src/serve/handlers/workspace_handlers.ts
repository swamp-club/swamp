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
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import { hostedWorkspaceCreate } from "../../libswamp/hosted_workspace/create.ts";
import { hostedWorkspaceDelete } from "../../libswamp/hosted_workspace/delete.ts";
import type { HostedWorkspaceCaller } from "../../libswamp/hosted_workspace/deps.ts";
import { hostedWorkspaceGet } from "../../libswamp/hosted_workspace/get.ts";
import { hostedWorkspaceList } from "../../libswamp/hosted_workspace/list.ts";
import { hostedWorkspaceResume } from "../../libswamp/hosted_workspace/resume.ts";
import { hostedWorkspaceSuspend } from "../../libswamp/hosted_workspace/suspend.ts";
import type { SwampError } from "../../libswamp/errors.ts";
import type { HostRootWorkspaces } from "../host_root_workspaces.ts";
import type { WorkspaceNamePayload } from "../protocol.ts";
import {
  accessCallerOf,
  authorizeOrReject,
  type ConnectionContext,
  handlerLibSwampContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

export const NOT_A_HOST_ROOT_CODE = "not_a_host_root";
export const TOKEN_MODE_CREATE_REFUSED_CODE = "token_mode_create_refused";

const ROOT_ADMIN = { kind: "access", name: "*", fields: {} } as const;

type ServiceEvent<D> =
  | { kind: "completed"; data: D }
  | { kind: "error"; error: SwampError };

/**
 * the root's admins make every request; list is open to any caller, but one
 * acting through an integration or a delegation is held to its ceiling, which
 * cannot name a workspace yet
 */
function admitted(
  socket: WebSocket,
  requestId: string,
  principal: Principal | null,
  ctx: ConnectionContext,
  openToCallers: boolean,
): HostRootWorkspaces | undefined {
  const caller = accessCallerOf(socket, principal);
  const ceilinged = caller.client !== undefined ||
    caller.delegation !== undefined;
  if (
    (!openToCallers || ceilinged) &&
    !authorizeOrReject(socket, requestId, principal, "admin", ROOT_ADMIN, ctx)
      .allowed
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
  const root = admitted(socket, requestId, principal, ctx, false);
  if (root === undefined) return;
  if (ctx.authConfig.mode === "token") {
    sendError(
      socket,
      requestId,
      TOKEN_MODE_CREATE_REFUSED_CODE,
      "A root in token mode cannot create a workspace yet: its creator would have no way to get a token inside it until signing in to a workspace through the root exists.",
    );
    return;
  }
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
  const root = admitted(socket, requestId, principal, ctx, true);
  if (root === undefined) return;
  const data = await outcome(
    socket,
    requestId,
    hostedWorkspaceList(handlerLibSwampContext(ctx), root.services),
  );
  if (data === undefined) return;
  send(socket, {
    type: "workspace.list",
    id: requestId,
    payload: {
      data: { workspaces: data.workspaces.map((summary) => ({ ...summary })) },
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
  const root = admitted(socket, requestId, principal, ctx, false);
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
  const root = admitted(socket, requestId, principal, ctx, false);
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
