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

import { UserError } from "../errors.ts";

export const SECRET_NOT_FOUND_CODE = "secret_not_found";

const MAX_CAUSE_DEPTH = 8;

export interface SecretNotFoundErrorOptions {
  message?: string;
  cause?: unknown;
}

/** a vault store raises this from get() only when the key is absent */
export class SecretNotFoundError extends UserError {
  constructor(
    readonly vaultName: string,
    readonly key: string,
    options?: SecretNotFoundErrorOptions,
  ) {
    super(
      options?.message ?? `Secret '${key}' not found in vault '${vaultName}'`,
      SECRET_NOT_FOUND_CODE,
    );
    this.name = "SecretNotFoundError";
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/**
 * matches by code, never instanceof: extension bundles carry their own copy of
 * the class and RPC rebuilds errors
 */
export function isSecretNotFoundError(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (typeof current !== "object" || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    if ((current as { code?: unknown }).code === SECRET_NOT_FOUND_CODE) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}
