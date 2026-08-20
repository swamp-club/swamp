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

import { getLogger } from "@logtape/logtape";
import type { ControlPlaneStore } from "../datastore/control_plane_store.ts";
import {
  ControlPlaneVaultProvider,
  TOKEN_SECRETS_VAULT_NAME,
} from "./control_plane_vault_provider.ts";
import { VaultService } from "./vault_service.ts";

const logger = getLogger(["vaults", "control-plane-init"]);

export interface ControlPlaneVaultInitResult {
  provider: ControlPlaneVaultProvider;
  isRemote: boolean;
}

export async function initializeControlPlaneVault(
  store: ControlPlaneStore,
  isRemote: boolean,
): Promise<ControlPlaneVaultInitResult | null> {
  try {
    const provider = new ControlPlaneVaultProvider(store);
    await provider.initialize();

    VaultService.registerGlobalProvider(
      TOKEN_SECRETS_VAULT_NAME,
      "control_plane",
      provider,
    );

    logger.info`Initialized ${TOKEN_SECRETS_VAULT_NAME} vault (${
      isRemote ? "remote" : "local"
    } control plane)`;

    return { provider, isRemote };
  } catch (err) {
    logger.warn`Failed to initialize control-plane vault: ${
      err instanceof Error ? err.message : String(err)
    }. Token secrets will be stored in the user vault.`;
    return null;
  }
}
