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
export type WithheldTokenFileRemedy = "flag-or-env" | "env" | PairedRemedy;

export interface PairedRemedy {
  readonly invalidUrl: boolean;
  readonly unsetBinds: boolean;
}

export type WithheldTokenVariable =
  | "SWAMP_SERVER_TOKEN_FILE"
  | "SWAMP_SERVER_TOKEN";

interface WithheldToken {
  readonly remedy: WithheldTokenFileRemedy;
  readonly variable: WithheldTokenVariable;
}

/**
 * lives beside serverLoginHint because the remote-run and datastore API clients
 * build their 401 message from it and cannot see how the CLI resolved the
 * token; grows only with distinct addresses
 */
const withheldTokenFiles = new Map<string, WithheldToken>();

export function recordWithheldTokenFile(
  key: string,
  remedy: WithheldTokenFileRemedy,
  variable: WithheldTokenVariable = "SWAMP_SERVER_TOKEN_FILE",
): boolean {
  if (withheldTokenFiles.has(key)) return false;
  withheldTokenFiles.set(key, { remedy, variable });
  return true;
}

export function resetWithheldTokenFiles(): void {
  withheldTokenFiles.clear();
}

/** how a process signed in to a workspace through its host, or why it could not */
export interface WorkspaceSignInNote {
  readonly hostAddress: string;
  readonly kind: "no-host-token" | "env-host-token" | "exchanged-token";
}

/**
 * an older host's router answers 502 for a workspace that refused the socket,
 * so a server error there may be a refused token signing in to the host again cures
 */
export function workspaceTokenRefusalHint(
  note: WorkspaceSignInNote | undefined,
): string | undefined {
  if (note?.kind !== "exchanged-token") return undefined;
  return `Behind a host this is also how a workspace refusing your token reads; signing in to the host again replaces it: swamp auth server-login --server ${note.hostAddress}`;
}

/** names the normalized address only, never the token or the file's path */
export function withheldTokenFileMessage(
  key: string,
  remedy: WithheldTokenFileRemedy,
  variable: WithheldTokenVariable = "SWAMP_SERVER_TOKEN_FILE",
): string {
  if (typeof remedy === "object") {
    const why = remedy.invalidUrl
      ? "SWAMP_SERVER_URL is not a valid http(s) or ws(s) URL"
      : "SWAMP_SERVER_URL pairs it with another server";
    const unset = remedy.unsetBinds ? " or unset it" : "";
    return `${variable} was not sent to ${key} because ${why}; set SWAMP_SERVER_URL to ${key}${unset} to send it`;
  }
  const how = remedy === "env"
    ? "set SWAMP_SERVE_URL to it to send it"
    : "set SWAMP_SERVE_URL to it or pass --server to send it";
  return `${variable} was not sent to ${key} because only .swamp.yaml names that address; ${how}`;
}

/**
 * when this process withheld SWAMP_SERVER_TOKEN_FILE or SWAMP_SERVER_TOKEN
 * from the serve, the message says so first, since signing in is then the
 * wrong fix
 */
export function serverLoginHint(
  serverUrl: string,
  signIn?: WorkspaceSignInNote,
): string {
  const key = normalizedOrUndefined(serverUrl);
  const login = `swamp auth server-login --server ${
    signIn?.hostAddress ?? serverUrl
  }`;
  const withheld = key === undefined ? undefined : withheldTokenFiles.get(key);
  if (key !== undefined && withheld !== undefined) {
    return `Authentication failed — ${
      withheldTokenFileMessage(key, withheld.remedy, withheld.variable)
    }, or run: ${login}`;
  }
  switch (signIn?.kind) {
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

/**
 * the token may come from --token, a token file or a login, so both fixes are
 * named; a workspace signed in through its host keeps the host's remedy
 */
export function serverTokenRefusedHint(
  serverUrl: string,
  signIn?: WorkspaceSignInNote,
): string {
  if (signIn !== undefined) return serverLoginHint(serverUrl, signIn);
  return `Authentication failed — the server likely refused the token sent to ${serverUrl}; check the token, or run: swamp auth server-login --server ${serverUrl}`;
}

function normalizedOrUndefined(serverUrl: string): string | undefined {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
}
