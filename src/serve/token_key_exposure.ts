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
 * team mode moves the control plane, token secrets and their co-located key
 * into the datastore, so anyone who can read it can decrypt every token secret.
 * Serve says so at start until the key is held in a vault
 */

import { classifyTokenKeyRecord } from "../domain/vaults/token_secrets_key.ts";

export const TOKEN_SECRETS_KEY_RECORD = "token-secrets/encryption-key";

export function coLocatedTokenKeyWarning(
  data: Uint8Array | null,
  team = false,
): string | undefined {
  if (classifyTokenKeyRecord(data).kind !== "legacy") return undefined;
  return "Server token secrets and the key that encrypts them are stored " +
    "together in the datastore's control plane, so anyone who can read the " +
    "datastore can decrypt every token secret. " +
    // in team mode the same key protects the team's peer key, and with it the
    // leader record's proof
    (team
      ? "In team mode the same key protects the team's peer key, which " +
        "signs the leader record: anyone who can read and write the " +
        "datastore can sign a leader record of their own, and followers " +
        "then send every forwarded caller's credentials to its address. "
      : "") +
    "Keep the key in a vault " +
    "instead: add a token-secrets block to serve.yaml naming a vault and key " +
    "(see 'Token secrets key' in the swamp serve documentation).";
}
