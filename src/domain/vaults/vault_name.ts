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

import { TOKEN_SECRETS_VAULT_NAME } from "./control_plane_vault_provider.ts";

const VAULT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * The vault naming rule, phrased for error messages.
 */
export const VAULT_NAME_RULE =
  "Vault names must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.";

/**
 * Whether `swamp vault create` accepts this name.
 */
export function isValidVaultName(name: string): boolean {
  return VAULT_NAME_PATTERN.test(name);
}

/**
 * Whether this name is reserved for swamp's internal vaults. Reserved names
 * start with an underscore, which the naming rule rejects, so a user-created
 * vault can never collide with one.
 */
export function isReservedVaultName(name: string): boolean {
  return name.startsWith("_");
}

/**
 * Explains why a reserved vault name is unavailable. Written to follow a
 * sentence that names the vault, such as "Vault '_x' not found."
 */
export function reservedVaultNameMessage(name: string): string {
  if (name === TOKEN_SECRETS_VAULT_NAME) {
    return `It is swamp's reserved control-plane vault for token secrets and ` +
      `cannot be created with 'swamp vault create'. It is registered ` +
      `automatically by 'swamp serve' and the access token and worker token ` +
      `commands. To read a token's secret, use ` +
      `'swamp access token reveal <name>'.`;
  }
  return `Names starting with '_' are reserved for swamp's internal vaults ` +
    `and cannot be created with 'swamp vault create'.`;
}

/**
 * Tells the user how to create a missing vault. Suggests `swamp vault create`
 * with their name only when that command would accept it. Callers explain
 * reserved names with {@link reservedVaultNameMessage} before reaching here.
 */
export function vaultCreateHint(name: string): string {
  if (isValidVaultName(name)) {
    return `Create a vault using: swamp vault create <type> ${name}`;
  }
  return `'${name}' is not a valid vault name. ${VAULT_NAME_RULE} ` +
    `Create a vault using: swamp vault create <type> <name>`;
}
