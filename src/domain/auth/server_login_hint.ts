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
  const login = `swamp auth server-login --server ${serverUrl}`;
  const key = normalizedOrUndefined(serverUrl);
  const remedy = key === undefined ? undefined : withheldTokenFiles.get(key);
  if (key !== undefined && remedy !== undefined) {
    return `Authentication failed — ${
      withheldTokenFileMessage(key, remedy)
    }, or run: ${login}`;
  }
  return `Authentication failed — run: ${login}`;
}

function normalizedOrUndefined(serverUrl: string): string | undefined {
  try {
    return normalizeServerUrl(serverUrl);
  } catch {
    return undefined;
  }
}
