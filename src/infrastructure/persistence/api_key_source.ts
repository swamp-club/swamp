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

import { UserError } from "../../domain/errors.ts";

export const API_KEY_ENV = "SWAMP_API_KEY";
export const API_KEY_FILE_ENV = "SWAMP_API_KEY_FILE";
export const CLUB_API_KEY_FILE_FLAG = "--club-api-key-file";

/** Where the collective API key comes from, named as the user supplied it. */
export type ApiKeySourceName =
  | typeof CLUB_API_KEY_FILE_FLAG
  | typeof API_KEY_FILE_ENV
  | typeof API_KEY_ENV;

let apiKeyFileOverride: string | undefined;

/**
 * Sets the key file named by `--club-api-key-file` for the rest of the
 * process. It takes precedence over SWAMP_API_KEY_FILE and SWAMP_API_KEY.
 * Pass `undefined` to clear it.
 */
export function setApiKeyFileOverride(path: string | undefined): void {
  apiKeyFileOverride = path;
}

function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value ? value : undefined;
}

/**
 * Names the source the collective API key is taken from, without reading
 * any file. Precedence: `--club-api-key-file`, then SWAMP_API_KEY_FILE,
 * then SWAMP_API_KEY. Never throws, so it is safe on paths every command
 * takes; `resolveApiKey` reports misconfiguration.
 */
export function apiKeySourceName(): ApiKeySourceName | undefined {
  if (apiKeyFileOverride !== undefined) return CLUB_API_KEY_FILE_FLAG;
  if (readEnv(API_KEY_FILE_ENV) !== undefined) return API_KEY_FILE_ENV;
  if (readEnv(API_KEY_ENV) !== undefined) return API_KEY_ENV;
  return undefined;
}

/** True when any collective API key source is set. Reads no file. */
export function hasApiKeySource(): boolean {
  return apiKeySourceName() !== undefined;
}

function readKeyFile(path: string, source: ApiKeySourceName): string {
  let raw: string;
  try {
    raw = Deno.readTextFileSync(path);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new UserError(`${source} file not found: ${path}`);
    }
    if (err instanceof Deno.errors.PermissionDenied) {
      throw new UserError(`${source} file not readable: ${path}`);
    }
    if (err instanceof Deno.errors.IsADirectory) {
      throw new UserError(`${source} is a directory, not a file: ${path}`);
    }
    throw err;
  }
  // Keys never contain whitespace, so trim all of it (blank lines, trailing
  // spaces, a BOM) rather than only one newline: whitespace left in a key
  // fails later as an opaque invalid-header error.
  const value = raw.trim();
  if (value === "") {
    throw new UserError(`${source} file is empty: ${path}`);
  }
  return value;
}

/**
 * Returns the collective API key, or `undefined` when no source is set.
 * Key files are read on every call, so a rotated file is picked up the
 * same way a changed env var is.
 *
 * @throws UserError when both SWAMP_API_KEY and SWAMP_API_KEY_FILE are set
 *   without `--club-api-key-file`, or when the key file is missing,
 *   unreadable or empty.
 */
export function resolveApiKey(): string | undefined {
  if (apiKeyFileOverride !== undefined) {
    return readKeyFile(apiKeyFileOverride, CLUB_API_KEY_FILE_FLAG);
  }
  const keyFile = readEnv(API_KEY_FILE_ENV);
  const key = readEnv(API_KEY_ENV);
  if (keyFile !== undefined && key !== undefined) {
    throw new UserError(
      `${API_KEY_ENV} and ${API_KEY_FILE_ENV} are mutually exclusive — unset one of them`,
    );
  }
  if (keyFile !== undefined) return readKeyFile(keyFile, API_KEY_FILE_ENV);
  return key;
}
