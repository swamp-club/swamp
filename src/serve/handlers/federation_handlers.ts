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

import type { AccessResource } from "../../domain/access/access_decision_service.ts";
import type { Action } from "../../domain/access/action.ts";
import type { Principal } from "../../domain/access/principal.ts";
import type { FederationAdminEvent } from "../../libswamp/serve/federation_admin.ts";
import { memberGet } from "../../libswamp/serve/member_get.ts";
import { memberList } from "../../libswamp/serve/member_list.ts";
import { memberRemove } from "../../libswamp/serve/member_remove.ts";
import { memberTokenCreate } from "../../libswamp/serve/member_token_create.ts";
import { memberTokenList } from "../../libswamp/serve/member_token_list.ts";
import { memberTokenRevoke } from "../../libswamp/serve/member_token_revoke.ts";
import type {
  FederationNamePayload,
  FederationTokenCreatePayload,
  ServerMessage,
} from "../protocol.ts";
import {
  authorizeOrReject,
  type ConnectionContext,
  handlerLibSwampContext,
  sanitizeErrorForClient,
  send,
  sendError,
} from "./shared.ts";

/** one resource for the whole roster, so a grant can name who runs federation without `access:*` */
export const FEDERATION_RESOURCE: AccessResource = {
  kind: "access",
  name: "swamp/federation",
  fields: {},
};

type FederationReply = Extract<
  ServerMessage,
  { type: `federation.${string}` }
>;

async function answer<T, R extends FederationReply>(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
  action: Action,
  type: R["type"],
  run: (
    deps: { admin: NonNullable<ConnectionContext["federationHub"]> },
  ) => AsyncGenerator<FederationAdminEvent<T>>,
  reply: (data: T) => R["payload"],
): Promise<void> {
  if (
    !authorizeOrReject(
      socket,
      requestId,
      principal,
      action,
      FEDERATION_RESOURCE,
      ctx,
    ).allowed
  ) return;
  const hub = ctx.federationHub;
  if (hub === undefined) {
    sendError(
      socket,
      requestId,
      "unsupported_operation",
      "This server is not a federation hub",
    );
    return;
  }
  try {
    for await (const event of run({ admin: hub })) {
      if (event.kind === "error") {
        sendError(
          socket,
          requestId,
          event.error.code,
          sanitizeErrorForClient(new Error(event.error.message)),
        );
        return;
      }
      if (event.kind === "completed") {
        send(socket, {
          type,
          id: requestId,
          payload: reply(event.data),
        } as FederationReply);
        return;
      }
    }
  } catch (error) {
    sendError(
      socket,
      requestId,
      "federation_request_failed",
      sanitizeErrorForClient(error),
    );
  }
}

export function handleFederationMemberList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "read",
    "federation.member.list",
    (deps) => memberList(handlerLibSwampContext(ctx), deps),
    (data) => ({ members: data.members }),
  );
}

export function handleFederationMemberGet(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: FederationNamePayload,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "read",
    "federation.member.get",
    (deps) =>
      memberGet(handlerLibSwampContext(ctx), deps, { name: payload.name }),
    (data) => ({ member: data.member }),
  );
}

/** the hub's own write opens its root unit of work, so this runs outside one */
export function handleFederationMemberRemove(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: FederationNamePayload,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "admin",
    "federation.member.remove",
    (deps) =>
      memberRemove(handlerLibSwampContext(ctx), deps, { name: payload.name }),
    (data) => ({ member: data.member }),
  );
}

export function handleFederationTokenCreate(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: FederationTokenCreatePayload,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "admin",
    "federation.token.create",
    (deps) =>
      memberTokenCreate(handlerLibSwampContext(ctx), deps, {
        name: payload.name,
        durationMs: payload.durationMs,
      }),
    (data) => ({ token: data.token, joinToken: data.joinToken }),
  );
}

export function handleFederationTokenList(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "admin",
    "federation.token.list",
    (deps) => memberTokenList(handlerLibSwampContext(ctx), deps),
    (data) => ({ tokens: data.tokens }),
  );
}

export function handleFederationTokenRevoke(
  socket: WebSocket,
  ctx: ConnectionContext,
  requestId: string,
  payload: FederationNamePayload,
  principal: Principal | null,
): Promise<void> {
  return answer(
    socket,
    ctx,
    requestId,
    principal,
    "admin",
    "federation.token.revoke",
    (deps) =>
      memberTokenRevoke(handlerLibSwampContext(ctx), deps, {
        name: payload.name,
      }),
    (data) => ({ token: data.token }),
  );
}
