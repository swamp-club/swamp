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

import { VaultService } from "../../domain/vaults/vault_service.ts";
import { createVaultSecretUpdated } from "../../domain/events/types.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Minimal vault config shape needed by the generator. */
export interface VaultPutConfigInfo {
  id: string;
  name: string;
  type: string;
}

/** Preview data returned before confirmation. */
export interface VaultPutPreview {
  vaultName: string;
  vaultType: string;
  secretKey: string;
  secretExists: boolean;
}

/** Data structure for the vault put completed event. */
export interface VaultPutData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  overwritten: boolean;
  timestamp: string;
}

export type VaultPutEvent =
  | { kind: "storing" }
  | { kind: "completed"; data: VaultPutData }
  | { kind: "error"; error: SwampError };

/** Input for the vault put operation. */
export interface VaultPutInput {
  vaultName: string;
  key: string;
  value: string;
  overwritten: boolean;
}

/** Dependencies for the vault put operation. */
export interface VaultPutDeps {
  findVault: (name: string) => Promise<VaultPutConfigInfo | null>;
  listVaultNames: () => Promise<string[]>;
  secretExists: (vaultName: string, key: string) => Promise<boolean>;
  putSecret: (vaultName: string, key: string, value: string) => Promise<void>;
  publishSecretUpdated: (
    vaultId: string,
    vaultType: string,
    vaultName: string,
    key: string,
  ) => Promise<void>;
}

/** Wires real infrastructure into VaultPutDeps. */
export function createVaultPutDeps(
  repoDir: string,
  eventBus: EventBus,
): VaultPutDeps {
  const vaultConfigRepo = new YamlVaultConfigRepository(repoDir);
  let vaultServicePromise: Promise<VaultService> | null = null;

  const getVaultService = () => {
    if (!vaultServicePromise) {
      vaultServicePromise = VaultService.fromRepository(repoDir);
    }
    return vaultServicePromise;
  };

  return {
    findVault: (name) => vaultConfigRepo.findByName(name),
    listVaultNames: async () => {
      const all = await vaultConfigRepo.findAll();
      return all.map((v) => v.name);
    },
    secretExists: async (vaultName, key) => {
      const svc = await getVaultService();
      const keys = await svc.list(vaultName);
      return keys.includes(key);
    },
    putSecret: async (vaultName, key, value) => {
      const svc = await getVaultService();
      await svc.put(vaultName, key, value);
    },
    publishSecretUpdated: async (vaultId, vaultType, vaultName, key) => {
      const event = createVaultSecretUpdated(
        vaultId,
        vaultType,
        vaultName,
        key,
      );
      await eventBus.publish(event);
    },
  };
}

/** Gathers preview info for the vault put operation. */
export async function vaultPutPreview(
  ctx: LibSwampContext,
  deps: VaultPutDeps,
  vaultName: string,
  key: string,
): Promise<VaultPutPreview> {
  ctx.logger.debug`Checking vault: ${vaultName}`;
  const config = await deps.findVault(vaultName);
  if (!config) {
    const names = await deps.listVaultNames();
    if (names.length === 0) {
      throw notFound(
        "Vault",
        `${vaultName}. No vaults are configured. Create a vault using: swamp vault create <type> ${vaultName}`,
      );
    }
    throw notFound(
      "Vault",
      `${vaultName}. Available vaults: ${names.join(", ")}`,
    );
  }

  const exists = await deps.secretExists(vaultName, key);
  ctx.logger.debug`Secret exists: ${exists}`;

  return {
    vaultName: config.name,
    vaultType: config.type,
    secretKey: key,
    secretExists: exists,
  };
}

/** Stores a secret in a vault. */
export async function* vaultPut(
  ctx: LibSwampContext,
  deps: VaultPutDeps,
  input: VaultPutInput,
): AsyncIterable<VaultPutEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.put",
    {},
    (async function* () {
      yield { kind: "storing" };

      const config = await deps.findVault(input.vaultName);
      if (!config) {
        yield {
          kind: "error",
          error: notFound("Vault", input.vaultName),
        };
        return;
      }

      await deps.putSecret(input.vaultName, input.key, input.value);
      ctx.logger.debug`Secret stored successfully`;

      await deps.publishSecretUpdated(
        config.id,
        config.type,
        config.name,
        input.key,
      );
      ctx.logger.debug`Emitted VaultSecretUpdated event`;

      yield {
        kind: "completed",
        data: {
          vaultName: input.vaultName,
          secretKey: input.key,
          vaultType: config.type,
          overwritten: input.overwritten,
          timestamp: new Date().toISOString(),
        },
      };
    })(),
  );
}
