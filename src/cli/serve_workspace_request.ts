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

import { redactServerUrl } from "../domain/auth/server_url.ts";
import { UserError } from "../domain/errors.ts";
import { parseWorkspaceName } from "../domain/workspace/workspace_name.ts";
import {
  type RequestResponseOptions,
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  ServerResponseError,
} from "./remote_run.ts";

export type WorkspaceRequestType =
  | "workspace.create"
  | "workspace.list"
  | "workspace.get"
  | "workspace.suspend"
  | "workspace.resume"
  | "workspace.delete";

export type WorkspaceRequest =
  | { type: "workspace.list" }
  | {
    type: Exclude<WorkspaceRequestType, "workspace.list">;
    payload: { name: string };
  };

export interface WorkspaceRequestOptions {
  server?: unknown;
  token?: unknown;
  tokenFile?: unknown;
}

export interface WorkspaceRequestDeps {
  request<T>(
    options: RequestResponseOptions,
    request: WorkspaceRequest,
  ): Promise<T>;
  resolveToken(
    server: string,
    options: WorkspaceRequestOptions,
  ): Promise<string | undefined>;
}

export const defaultWorkspaceRequestDeps: WorkspaceRequestDeps = {
  request: requestServerResponse,
  resolveToken: resolveServerTokenFromOptions,
};

/** the services write these for remote callers, naming no host path */
const ROOT_MESSAGE_CODES: ReadonlySet<string> = new Set([
  "not_found",
  "already_exists",
  "busy",
  "wanted_unreadable",
  "username_unknown",
  "not_a_user",
  "host_error",
  // an older root refuses create in token mode with this code
  "token_mode_create_refused",
]);

// serve refuses a malformed name as invalid_request, read here as an older serve
export function namedWorkspaceRequest(
  type: Exclude<WorkspaceRequestType, "workspace.list">,
  name: string,
): WorkspaceRequest {
  return { type, payload: { name: parseWorkspaceName(name) } };
}

export async function sendWorkspaceRequest<T>(
  options: WorkspaceRequestOptions,
  request: WorkspaceRequest,
  deps: WorkspaceRequestDeps = defaultWorkspaceRequestDeps,
): Promise<T> {
  const server = resolveServeUrl(
    typeof options.server === "string" ? options.server : undefined,
  );
  if (server === undefined) {
    throw new UserError(
      "No server to send this to: pass --server with the swamp serve host's address, or set SWAMP_SERVE_URL.",
      "server_required",
    );
  }
  const token = await deps.resolveToken(server, options);
  try {
    return await deps.request<T>(
      { server, ...(token ? { token } : {}) },
      request,
    );
  } catch (error) {
    throw explainRefusal(error, server);
  }
}

function explainRefusal(error: unknown, server: string): unknown {
  if (!(error instanceof ServerResponseError)) return error;
  const shown = redactServerUrl(server) ?? "the server";
  if (ROOT_MESSAGE_CODES.has(error.code ?? "")) {
    return new UserError(error.serverMessage, error.code);
  }
  switch (error.code) {
    case "unauthorized":
      return new UserError(
        `The root at ${shown} refused the request: ${error.serverMessage}`,
        error.code,
      );
    case "not_a_host_root":
      return new UserError(
        `${shown} is not a host's root, so it answers no workspace requests. Pass --server the swamp serve host's own address, not a workspace's.`,
        error.code,
      );
    case "invalid_request":
      return new UserError(
        `${shown} does not answer workspace requests: it is not a swamp serve host's root, or it runs a swamp that predates them.`,
        "unsupported_by_server",
      );
    default:
      return error;
  }
}
