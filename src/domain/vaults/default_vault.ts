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
 * the vault swamp repo init creates so secrets and sensitive outputs have
 * somewhere to go without setup
 */

import { createVaultConfigId, VaultConfig } from "./vault_config.ts";
import { defaultLocalEncryptionConfig } from "./local_encryption_key_source.ts";

export const DEFAULT_VAULT_NAME = "default";

export const DEFAULT_VAULT_TYPE = "local_encryption";

export interface DefaultVaultStore {
  findByName(name: string): Promise<VaultConfig | null>;
  save(config: VaultConfig): Promise<void>;
}

/** its config names no host path, so the committed file works in every clone */
export function createDefaultVaultConfig(): VaultConfig {
  return VaultConfig.create(
    createVaultConfigId(crypto.randomUUID()),
    DEFAULT_VAULT_NAME,
    DEFAULT_VAULT_TYPE,
    defaultLocalEncryptionConfig(),
  );
}
