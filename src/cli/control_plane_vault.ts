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

import type { ControlPlaneStore } from "../domain/datastore/control_plane_store.ts";
import type { DatastoreSyncService } from "../domain/datastore/datastore_sync_service.ts";
import {
  controlPlaneVaultInitError,
  type ControlPlaneVaultInitResult,
  initializeControlPlaneVault,
} from "../domain/vaults/control_plane_vault_init.ts";
import type { TokenSecretsKeyRef } from "../domain/vaults/token_secrets_key.ts";
import { VaultService } from "../domain/vaults/vault_service.ts";
import { FileSystemControlPlaneStore } from "../infrastructure/persistence/fs_control_plane_store.ts";
import { swampPath } from "../infrastructure/persistence/paths.ts";
import {
  parseTokenSecretsKeyConfig,
  readServeConfigFile,
  SERVE_CONFIG_PATH,
} from "../serve/serve_config.ts";

export interface ControlPlaneVaultCliOptions {
  namespace?: string;
  catalogInvalidate?: () => void;
}

export async function initializeControlPlaneVaultForCli(
  repoDir: string,
  syncService?: DatastoreSyncService,
  options?: ControlPlaneVaultCliOptions,
): Promise<ControlPlaneVaultInitResult> {
  const caps = syncService?.capabilities?.();
  const hasRemote = !!(caps?.controlPlane && syncService?.controlPlaneStore);

  // Bind the sync service's namespace before obtaining the control plane
  // store. The S3/GCS extensions irrevocably bind namespace on the first
  // call to any sync or control-plane method — calling controlPlaneStore()
  // without a prior pullChanged({ namespace }) binds to root (undefined),
  // causing all subsequent namespace-aware pushChanged calls to fail with
  // "Namespace mismatch". This mirrors the serve.ts boot sequence.
  if (hasRemote && options?.namespace) {
    try {
      await syncService!.pullChanged({ namespace: options.namespace });
    } catch (err) {
      throw controlPlaneVaultInitError(err, true);
    }
    options.catalogInvalidate?.();
  }

  let store: ControlPlaneStore;
  if (hasRemote) {
    try {
      store = syncService!.controlPlaneStore!();
    } catch (err) {
      throw controlPlaneVaultInitError(err, true);
    }
  } else {
    store = new FileSystemControlPlaneStore(swampPath(repoDir));
  }

  // The key source comes only from the repo's serve.yaml, read quietly so
  // token commands don't repeat serve's config warnings. A control plane
  // already moved to an external key fails closed without it.
  let tokenSecretsKey: TokenSecretsKeyRef | undefined;
  try {
    tokenSecretsKey = parseTokenSecretsKeyConfig(
      await readServeConfigFile(repoDir),
      SERVE_CONFIG_PATH,
    );
  } catch (err) {
    throw controlPlaneVaultInitError(err, hasRemote);
  }

  return await initializeControlPlaneVault(store, hasRemote, {
    tokenSecretsKey,
    vaultService: () => VaultService.fromRepository(repoDir),
  });
}
