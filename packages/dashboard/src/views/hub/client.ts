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

import { LOCAL_TOKEN_HEADER } from "../../client/workspace_path.ts";
import { type HubOverview, parseOverview } from "./helpers.ts";

export type OverviewResult =
  | { kind: "ok"; overview: HubOverview }
  /** no token, or one the hub no longer holds */
  | { kind: "unauthorized" }
  /** a swamp start or swamp dashboard token, which can't manage the hub */
  | { kind: "forbidden" }
  /** a server without the overview: the TypeScript hub, or an old swampd */
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

export async function fetchOverview(
  token: string,
  signal: AbortSignal,
): Promise<OverviewResult> {
  let response: Response;
  try {
    response = await fetch("/api/local/hub", {
      headers: { [LOCAL_TOKEN_HEADER]: token },
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    return { kind: "error", message: "The swamp hub isn't answering." };
  }
  switch (response.status) {
    case 200:
      return { kind: "ok", overview: parseOverview(await response.json()) };
    case 401:
      await response.body?.cancel();
      return { kind: "unauthorized" };
    case 403:
      await response.body?.cancel();
      return { kind: "forbidden" };
    case 404:
      await response.body?.cancel();
      return { kind: "unavailable" };
    default:
      await response.body?.cancel();
      return {
        kind: "error",
        message: `The swamp hub answered ${response.status}.`,
      };
  }
}

/** Refusals an action can meet, worded for the page. */
const ACTION_ERRORS: Record<string, string> = {
  hub_is_service:
    "This hub runs as a user service. Stop it with `swamp hub daemon disable`.",
  own_lease: "That is this page's own session.",
  unknown_engine: "That serve has already stopped.",
  unknown_workspace: "That workspace isn't available any more.",
  workspace_untrusted:
    "That workspace's datastore is extension code, which an untrusted workspace can't load.",
  engine_unavailable: "That serve didn't start. See the hub log below.",
  unknown_lease: "That session has already ended.",
  origin_mismatch: "The hub refused a request from another page.",
  manage_required: "This page can't manage the hub. Run `swamp hub open`.",
};

/** null when the hub did it, else why not */
export async function postAction(
  token: string,
  path: string,
  body?: unknown,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: {
        [LOCAL_TOKEN_HEADER]: token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      // A cold start can take as long as the hub's startup timeout.
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    return "The swamp hub isn't answering.";
  }
  if (response.ok) {
    await response.body?.cancel();
    return null;
  }
  let code = "";
  try {
    code = String((await response.json())?.error ?? "");
  } catch {
    // Not a JSON refusal.
  }
  return ACTION_ERRORS[code] ?? `The swamp hub refused (${response.status}).`;
}

export function stopEnginePath(id: string): string {
  return `/api/local/hub/engines/${encodeURIComponent(id)}/stop`;
}

export function revokeLeasePath(id: string): string {
  return `/api/local/hub/leases/${encodeURIComponent(id)}/revoke`;
}

export const STOP_HUB_PATH = "/api/local/hub/stop";

export const START_SERVE_PATH = "/api/local/hub/workspaces/start";

/** the body that starts a workspace's serve; a lease-bound folder names its path */
export function startServeBody(
  name: string,
  path: string | undefined,
): { name: string; path?: string } {
  return path === undefined ? { name } : { name, path };
}
