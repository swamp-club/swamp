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
 * The vault `swamp repo init` creates for every new repository, so secrets
 * and sensitive outputs have somewhere to go without setup
 * (swamp-club#3259).
 *
 * @module
 */

import { createVaultConfigId, VaultConfig } from "./vault_config.ts";
import { defaultLocalEncryptionConfig } from "./local_encryption_key_source.ts";

/** The name of the vault `swamp repo init` creates. */
export const DEFAULT_VAULT_NAME = "default";

/** The type of the vault `swamp repo init` creates. */
export const DEFAULT_VAULT_TYPE = "local_encryption";

/**
 * Where the default vault's config is read and written. Repo init only needs
 * to find a vault by name and save a new one.
 */
export interface DefaultVaultStore {
  findByName(name: string): Promise<VaultConfig | null>;
  save(config: VaultConfig): Promise<void>;
}

/**
 * A new default vault config: a local_encryption vault named `default`
 * whose key is generated on first use. Its config names no host path, so
 * the committed file works in every clone.
 */
export function createDefaultVaultConfig(): VaultConfig {
  return VaultConfig.create(
    createVaultConfigId(crypto.randomUUID()),
    DEFAULT_VAULT_NAME,
    DEFAULT_VAULT_TYPE,
    defaultLocalEncryptionConfig(),
  );
}
