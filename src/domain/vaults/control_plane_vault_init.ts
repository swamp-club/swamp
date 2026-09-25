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
import { UserError } from "../errors.ts";
import {
  ControlPlaneVaultProvider,
  type ExternalTokenKey,
  TOKEN_SECRETS_VAULT_NAME,
} from "./control_plane_vault_provider.ts";
import {
  parseTokenSecretsKeyMaterial,
  TokenSecretsKeyError,
  type TokenSecretsKeyRef,
} from "./token_secrets_key.ts";
import { VaultService } from "./vault_service.ts";

const logger = getLogger(["vaults", "control-plane-init"]);

export interface ControlPlaneVaultInitResult {
  provider: ControlPlaneVaultProvider;
  isRemote: boolean;
}

/**
 * Builds the UserError reported when the control-plane vault cannot be
 * initialized, keeping the cause's message and logging the original error
 * (with its stack) at debug level.
 */
export function controlPlaneVaultInitError(
  err: unknown,
  isRemote: boolean,
): UserError {
  logger.debug`Control-plane vault initialization error: ${err}`;
  // Key configuration errors already say what to fix; the datastore hint
  // below would point the operator at the wrong thing.
  if (err instanceof TokenSecretsKeyError) return err;
  const hint = isRemote
    ? "Check the datastore credentials and endpoint, then rerun."
    : "Check that the local control-plane store is readable and intact, then rerun.";
  return new UserError(
    `Failed to initialize the ${TOKEN_SECRETS_VAULT_NAME} control-plane vault (${
      isRemote ? "remote datastore" : "local control plane"
    }): ${err instanceof Error ? err.message : String(err)}\n${hint}`,
  );
}

/** Reads secrets from the vault that holds the external token key. */
export interface TokenSecretsKeyVaultReader {
  get(
    vaultName: string,
    secretKey: string,
    callerContext?: string,
  ): Promise<string>;
}

/**
 * Reads and decodes the external token key named by serve.yaml
 * `token-secrets`. Fails closed with a UserError when the vault or secret is
 * missing or the value is not a usable key; messages never include the value.
 */
export async function resolveTokenSecretsKey(
  ref: TokenSecretsKeyRef,
  vaultService: TokenSecretsKeyVaultReader,
): Promise<ExternalTokenKey> {
  const location = `vault '${ref.vault}', key '${ref.key}'`;
  let value: string;
  try {
    value = await vaultService.get(
      ref.vault,
      ref.key,
      "serve:token-secrets-key",
    );
  } catch (err) {
    throw new TokenSecretsKeyError(
      `Could not read the token secrets key from ${location}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    return { ref, key: parseTokenSecretsKeyMaterial(value) };
  } catch (err) {
    throw new TokenSecretsKeyError(
      `Token secrets key in ${location} is not usable: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

export interface ControlPlaneVaultInitOptions {
  /**
   * The serve.yaml `token-secrets` reference. When set, the key is read from
   * that vault and the control plane never stores key bytes. It must come
   * from local configuration only, never from datastore content.
   */
  readonly tokenSecretsKey?: TokenSecretsKeyRef;
  /** Builds the vault service used to read the key; only called when needed. */
  readonly vaultService?: () => Promise<TokenSecretsKeyVaultReader>;
  /** Passed to the provider; the token commands set false. */
  readonly migrate?: boolean;
}

/**
 * Initializes the `_token-secrets` control-plane vault and registers it as a
 * global vault provider.
 *
 * Throws a UserError carrying the underlying cause when the provider cannot
 * initialize. There is deliberately no fallback to a user vault: serve only
 * reads token secrets from `_token-secrets`, so a secret written anywhere else
 * produces a token that never authenticates.
 */
export async function initializeControlPlaneVault(
  store: ControlPlaneStore,
  isRemote: boolean,
  options?: ControlPlaneVaultInitOptions,
): Promise<ControlPlaneVaultInitResult> {
  let provider: ControlPlaneVaultProvider;
  try {
    let externalKey: ExternalTokenKey | undefined;
    if (options?.tokenSecretsKey) {
      if (!options.vaultService) {
        throw new Error(
          "A token secrets key is configured but no vault service was provided",
        );
      }
      externalKey = await resolveTokenSecretsKey(
        options.tokenSecretsKey,
        await options.vaultService(),
      );
    }
    provider = new ControlPlaneVaultProvider(store, {
      externalKey,
      migrate: options?.migrate,
    });
    await provider.initialize();
  } catch (err) {
    throw controlPlaneVaultInitError(err, isRemote);
  }

  VaultService.registerGlobalProvider(
    TOKEN_SECRETS_VAULT_NAME,
    "control_plane",
    provider,
  );

  logger.info`Initialized ${TOKEN_SECRETS_VAULT_NAME} vault (${
    isRemote ? "remote" : "local"
  } control plane)`;

  return { provider, isRemote };
}
