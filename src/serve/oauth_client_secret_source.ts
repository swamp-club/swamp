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

import { OAUTH_CLIENT_SECRET_ENV } from "../domain/auth/auth_credentials.ts";
import { UserError } from "../domain/errors.ts";
import { readCredentialFile } from "../infrastructure/persistence/api_key_source.ts";

export const OAUTH_CLIENT_SECRET_FILE_FLAG = "--oauth-client-secret-file";
export const OAUTH_CLIENT_SECRET_FILE_ENV = "SWAMP_OAUTH_CLIENT_SECRET_FILE";

export const OAUTH_CLIENT_SECRET_SOURCES =
  `${OAUTH_CLIENT_SECRET_FILE_FLAG}, ${OAUTH_CLIENT_SECRET_FILE_ENV} or ${OAUTH_CLIENT_SECRET_ENV}`;

function readEnv(name: string): string | undefined {
  const value = Deno.env.get(name);
  return value ? value : undefined;
}

/**
 * the flag wins over both env vars, as --club-api-key-file does; the file is
 * read on every call so the value is never held on the merged serve options
 */
export function resolveOAuthClientSecret(
  secretFileFlag: string | undefined,
): string | undefined {
  if (secretFileFlag !== undefined) {
    return readCredentialFile(secretFileFlag, OAUTH_CLIENT_SECRET_FILE_FLAG);
  }
  const secretFile = readEnv(OAUTH_CLIENT_SECRET_FILE_ENV);
  const secret = readEnv(OAUTH_CLIENT_SECRET_ENV);
  if (secretFile !== undefined && secret !== undefined) {
    throw new UserError(
      `${OAUTH_CLIENT_SECRET_ENV} and ${OAUTH_CLIENT_SECRET_FILE_ENV} are mutually exclusive — unset one of them`,
    );
  }
  if (secretFile !== undefined) {
    return readCredentialFile(secretFile, OAUTH_CLIENT_SECRET_FILE_ENV);
  }
  return secret?.trim() || undefined;
}
