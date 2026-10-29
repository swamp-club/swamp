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

/**
 * Whether serve's token-secrets key sits beside the secrets in a v3
 * datastore's control plane (swamp-club#4096). Team mode moves serve's
 * control plane, token secrets and their co-located key included, from the
 * checkout into the datastore: from then on anyone who can read the
 * datastore can decrypt every server token secret. Serve says so at start
 * until the key is held in a vault (a `token-secrets` block in serve.yaml,
 * which leaves only a marker in the datastore).
 *
 * @module
 */

import { classifyTokenKeyRecord } from "../domain/vaults/token_secrets_key.ts";

/** The control-plane key the token-secrets key record lives at. */
export const TOKEN_SECRETS_KEY_RECORD = "token-secrets/encryption-key";

/**
 * The warning serve logs at start on a v3 datastore for the token-secrets
 * key record `data`, or undefined when there is nothing to warn about: no
 * key yet, or a marker naming a key held in a vault.
 */
export function coLocatedTokenKeyWarning(
  data: Uint8Array | null,
): string | undefined {
  if (classifyTokenKeyRecord(data).kind !== "legacy") return undefined;
  return "Server token secrets and the key that encrypts them are stored " +
    "together in the datastore's control plane, so anyone who can read the " +
    "datastore can decrypt every token secret. Keep the key in a vault " +
    "instead: add a token-secrets block to serve.yaml naming a vault and key " +
    "(see 'Token secrets key' in the swamp serve documentation).";
}
