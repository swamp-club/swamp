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
 * How a caller can bind `SWAMP_SERVER_TOKEN_FILE` to an address it withheld
 * the file from: a command that resolves its own serve address takes
 * `--server` or `SWAMP_SERVE_URL`; a v3 datastore whose upstream is serve
 * takes only `SWAMP_SERVE_URL`, since `--server` would run the command on
 * serve instead.
 */
export type WithheldTokenFileRemedy = "flag-or-env" | "env";

/**
 * The normalized addresses this process sent no token to although
 * `SWAMP_SERVER_TOKEN_FILE` was set, because only `.swamp.yaml` named them
 * (swamp-club#4012). It lives here, beside {@link serverLoginHint}, because
 * the remote-run client and the datastore API client both build their 401
 * message from that function and neither can see how the CLI resolved the
 * token. It only grows with distinct addresses, and lasts the process.
 */
const withheldTokenFiles = new Map<string, WithheldTokenFileRemedy>();

/**
 * Records that no token was sent to `key`, a normalized server URL, because
 * `SWAMP_SERVER_TOKEN_FILE` was withheld from it, so a 401 from it says why.
 *
 * @returns true the first time `key` is recorded, so the caller warns once.
 */
export function recordWithheldTokenFile(
  key: string,
  remedy: WithheldTokenFileRemedy,
): boolean {
  if (withheldTokenFiles.has(key)) return false;
  withheldTokenFiles.set(key, remedy);
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
