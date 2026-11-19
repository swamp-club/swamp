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

import { normalizeServerUrl } from "./server_url.ts";

/**
 * a command resolving its own serve address takes --server or SWAMP_SERVE_URL;
 * a v3 datastore whose upstream is serve takes only SWAMP_SERVE_URL, since
 * --server would run the command on serve
 */
export type WithheldTokenFileRemedy = "flag-or-env" | "env";

/**
 * lives beside serverLoginHint because the remote-run and datastore API clients
 * build their 401 message from it and cannot see how the CLI resolved the
 * token; grows only with distinct addresses
 */
const withheldTokenFiles = new Map<string, WithheldTokenFileRemedy>();

export function recordWithheldTokenFile(
  key: string,
  remedy: WithheldTokenFileRemedy,
): boolean {
  if (withheldTokenFiles.has(key)) return false;
  withheldTokenFiles.set(key, remedy);
  return true;
}

export function resetWithheldTokenFiles(): void {
  withheldTokenFiles.clear();
}

export type WorkspaceSignInGap = "no-host-token" | "env-host-token";

/**
 * how this process signed in to a workspace through its host, or why it could
 * not though the workspace offers it; keyed by the workspace's normalized
 * address
 */
const workspaceSignInGaps = new Map<
  string,
  {
    readonly hostAddress: string;
    readonly gap: WorkspaceSignInGap | "exchanged-token";
  }
>();

export function recordWorkspaceSignInGap(
  workspaceAddress: string,
  hostAddress: string,
  gap: WorkspaceSignInGap,
): void {
  const key = normalizedOrUndefined(workspaceAddress);
  if (key !== undefined) workspaceSignInGaps.set(key, { hostAddress, gap });
}

/** the token sent to the workspace came from a sign-in through its host */
export function recordExchangedWorkspaceToken(
  workspaceAddress: string,
  hostAddress: string,
): void {
  const key = normalizedOrUndefined(workspaceAddress);
  if (key !== undefined) {
    workspaceSignInGaps.set(key, { hostAddress, gap: "exchanged-token" });
  }
}

export function hasWorkspaceSignInGap(workspaceAddress: string): boolean {
  const key = normalizedOrUndefined(workspaceAddress);
  const recorded = key === undefined ? undefined : workspaceSignInGaps.get(key);
  return recorded !== undefined && recorded.gap !== "exchanged-token";
}

/**
 * a host's router answers 502 for a workspace that refused the socket, so a
 * server error there may be a refused token signing in to the host again cures
 */
export function workspaceTokenRefusalHint(
  serverUrl: string,
): string | undefined {
  const key = normalizedOrUndefined(serverUrl);
  const recorded = key === undefined ? undefined : workspaceSignInGaps.get(key);
  if (recorded?.gap !== "exchanged-token") return undefined;
  return `Behind a host this is also how a workspace refusing your token reads; signing in to the host again replaces it: swamp auth server-login --server ${recorded.hostAddress}`;
}

export function resetWorkspaceSignInGaps(): void {
  workspaceSignInGaps.clear();
}

/** names the normalized address only, never the file's path or contents */
export function withheldTokenFileMessage(
  key: string,
  remedy: WithheldTokenFileRemedy,
): string {
  const how = remedy === "env"
    ? "set SWAMP_SERVE_URL to it to send it"
    : "set SWAMP_SERVE_URL to it or pass --server to send it";
  return `SWAMP_SERVER_TOKEN_FILE was not sent to ${key} because only .swamp.yaml names that address; ${how}`;
}

/**
 * when this process withheld SWAMP_SERVER_TOKEN_FILE from the serve, the
 * message says so first, since signing in is then the wrong fix
 */
export function serverLoginHint(serverUrl: string): string {
  const key = normalizedOrUndefined(serverUrl);
  const signIn = key === undefined ? undefined : workspaceSignInGaps.get(key);
  const login = `swamp auth server-login --server ${
    signIn?.hostAddress ?? serverUrl
  }`;
  const remedy = key === undefined ? undefined : withheldTokenFiles.get(key);
  if (key !== undefined && remedy !== undefined) {
    return `Authentication failed — ${
      withheldTokenFileMessage(key, remedy)
    }, or run: ${login}`;
  }
  switch (signIn?.gap) {
    case "env-host-token":
      return `Authentication failed — a host token from SWAMP_SERVER_TOKEN is not used to sign in to workspaces; run: ${login}`;
    case "no-host-token":
      return `Authentication failed — run: ${login} (one sign-in to the host covers its workspaces)`;
    case "exchanged-token":
      return `Authentication failed — the workspace refused the token from your host sign-in; sign in to the host again to replace it: ${login}`;
    default:
      return `Authentication failed — run: ${login}`;
  }
}

function normalizedOrUndefined(serverUrl: string): string | undefined {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
}
