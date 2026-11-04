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

import { consumeStream } from "../../libswamp/stream.ts";
import {
  appApprove,
  type AppApproveData,
  appLaunch,
  type AppLaunchData,
  appList,
  type AppListData,
  appRevoke,
  type AppRevokeData,
} from "../../libswamp/apps/apps.ts";
import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type {
  AppApprovePayload,
  AppLaunchPayload,
  AppRevokePayload,
} from "../protocol.ts";
import {
  type Principal,
  principalToString,
} from "../../domain/access/principal.ts";
import {
  authorizeOrReject,
  clientErrorDetails,
  type ConnectionContext,
  handlerLibSwampContext,
  isAllowed,
  LibSwampStreamError,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

/** one record type, so a grant can name who manages apps without `access:*` */
const APP_APPROVAL_RESOURCE: AccessResource = {
  kind: "access",
  name: "swamp/app-approval",
  fields: {},
};

/**
 * one resource per app, so a grant names one app, a collective's
 * (`swamp/apps/@acme/*`) or every app (`swamp/apps/*`), and a deny on one app
 * beats a wider allow
 */
export function appAccessResource(name: string): AccessResource {
  return { kind: "access", name: `swamp/apps/${name}`, fields: {} };
}

/** a manager may list and open every app without a viewer grant */
function canManageApps(
  socket: WebSocket,
  principal: Principal | null,
  ctx: ConnectionContext,
): boolean {
  return isAllowed(socket, principal, "admin", APP_APPROVAL_RESOURCE, ctx);
}

function appsUnavailable(
  socket: WebSocket,
  requestId: string,
  code: string,
): void {
  sendError(socket, requestId, code, "This server does not serve apps.");
}

/**
 * a viewer sees the enabled apps they may read, and nothing else; only a
 * manager sees every app and what is waiting for approval
 */
export async function handleAppList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  const canManage = canManageApps(socket, principal, ctx);
  const deps = ctx.appDeps;
  if (!deps) {
    appsUnavailable(socket, requestId, "app_list_failed");
    return;
  }
  try {
    let data: AppListData | undefined;
    await consumeStream(appList(handlerLibSwampContext(ctx), deps), {
      completed: (e) => {
        data = e.data;
      },
      error: (e) => {
        throw new LibSwampStreamError(e.error);
      },
    });
    if (!data) throw new Error("App list did not complete");
    send(socket, {
      type: "app.list",
      id: requestId,
      payload: {
        data: canManage ? data : {
          apps: data.apps
            .filter((app) =>
              app.state === "enabled" &&
              isAllowed(
                socket,
                principal,
                "read",
                appAccessResource(app.name),
                ctx,
              )
            )
            .map(({ approvedBy: _by, approvedAt: _at, ...app }) => app),
          problems: [],
        },
        canManage,
      },
    });
  } catch (error) {
    sendError(
      socket,
      requestId,
      "app_list_failed",
      sanitizeErrorForClient(error),
      clientErrorDetails(error),
    );
  }
}

export async function handleAppLaunch(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AppLaunchPayload,
  principal: Principal | null,
): Promise<void> {
  if (
    !canManageApps(socket, principal, ctx) &&
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "read",
      appAccessResource(payload.name),
      ctx,
    ).allowed
  ) {
    return;
  }
  const deps = ctx.appDeps;
  if (!deps) {
    appsUnavailable(socket, requestId, "app_launch_failed");
    return;
  }
  try {
    let data: AppLaunchData | undefined;
    await consumeStream(
      appLaunch(handlerLibSwampContext(ctx), deps, { name: payload.name }),
      {
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );
    if (!data) throw new Error("App launch did not complete");
    send(socket, {
      type: "app.launch",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    sendError(
      socket,
      requestId,
      "app_launch_failed",
      sanitizeErrorForClient(error),
      clientErrorDetails(error),
    );
  }
}

export async function handleAppApprove(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AppApprovePayload,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      APP_APPROVAL_RESOURCE,
      ctx,
    ).allowed
  ) return;
  const deps = ctx.appDeps;
  if (!deps) {
    appsUnavailable(socket, requestId, "app_approve_failed");
    return;
  }
  try {
    let data: AppApproveData | undefined;
    await consumeStream(
      appApprove(handlerLibSwampContext(ctx), deps, {
        name: payload.name,
        capabilityKey: payload.capabilityKey,
        approvedBy: principal ? principalToString(principal) : "ghost",
      }),
      {
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );
    if (!data) throw new Error("App approval did not complete");
    send(socket, {
      type: "app.approve",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    sendError(
      socket,
      requestId,
      "app_approve_failed",
      sanitizeErrorForClient(error),
      clientErrorDetails(error),
    );
  }
}

export async function handleAppRevoke(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: AppRevokePayload,
  principal: Principal | null,
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      "admin",
      APP_APPROVAL_RESOURCE,
      ctx,
    ).allowed
  ) return;
  const deps = ctx.appDeps;
  if (!deps) {
    appsUnavailable(socket, requestId, "app_revoke_failed");
    return;
  }
  try {
    let data: AppRevokeData | undefined;
    await consumeStream(
      appRevoke(handlerLibSwampContext(ctx), deps, { name: payload.name }),
      {
        completed: (e) => {
          data = e.data;
        },
        error: (e) => {
          throw new LibSwampStreamError(e.error);
        },
      },
    );
    if (!data) throw new Error("App revoke did not complete");
    send(socket, {
      type: "app.revoke",
      id: requestId,
      payload: { data },
    });
  } catch (error) {
    sendError(
      socket,
      requestId,
      "app_revoke_failed",
      sanitizeErrorForClient(error),
      clientErrorDetails(error),
    );
  }
}
