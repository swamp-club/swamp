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
 * The normalized addresses this process withheld `SWAMP_SERVER_TOKEN_FILE`
 * from because only `.swamp.yaml` named them (swamp-club#4012).
 */
const withheldTokenFiles = new Set<string>();

/**
 * Records that `SWAMP_SERVER_TOKEN_FILE` was not sent to `key`, a normalized
 * server URL, so a 401 from it says why.
 *
 * @returns true the first time `key` is recorded, so the caller warns once.
 */
export function recordWithheldTokenFile(key: string): boolean {
  if (withheldTokenFiles.has(key)) return false;
  withheldTokenFiles.add(key);
  return true;
}

/** Test-only: forgets every recorded address. */
export function resetWithheldTokenFiles(): void {
  withheldTokenFiles.clear();
}

/**
 * Why `SWAMP_SERVER_TOKEN_FILE` was not sent to `key`, and how to send it.
 * Names the normalized address only: never the file's path or contents.
 */
export function withheldTokenFileMessage(key: string): string {
  return `SWAMP_SERVER_TOKEN_FILE was not sent to ${key} because only .swamp.yaml names that address; set SWAMP_SERVE_URL to it or pass --server to send it`;
}

/**
 * The message for a request a swamp serve refused because the caller is not
 * authenticated, naming the command that signs in to that serve. Shared by
 * the remote-run client and the datastore API client so both say the same
 * thing. When this process withheld `SWAMP_SERVER_TOKEN_FILE` from the
 * serve, the message says so first, since signing in is then the wrong fix
 * for a caller that meant to use the token file.
 *
 * @param serverUrl - The serve URL as the client connected to it (`ws(s)://`
 *   or `http(s)://`), shown in the command verbatim.
 */
export function serverLoginHint(serverUrl: string): string {
  const login = `swamp auth server-login --server ${serverUrl}`;
  const key = normalizedOrUndefined(serverUrl);
  if (key !== undefined && withheldTokenFiles.has(key)) {
    return `Authentication failed — ${
      withheldTokenFileMessage(key)
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
