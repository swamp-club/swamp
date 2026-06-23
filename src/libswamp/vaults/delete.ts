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
import { createVaultSecretDeleted } from "../../domain/events/types.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultDeleteConfigInfo {
  id: string;
  name: string;
  type: string;
}

export interface VaultDeletePreview {
  vaultName: string;
  vaultType: string;
  secretKey: string;
  secretExists: boolean;
  supportsDelete: boolean;
}

export interface VaultDeleteData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  timestamp: string;
  noOp?: boolean;
}

export type VaultDeleteEvent =
  | { kind: "deleting" }
  | { kind: "completed"; data: VaultDeleteData }
  | { kind: "error"; error: SwampError };

export interface VaultDeleteInput {
  vaultName: string;
  key: string;
}

export interface VaultDeleteDeps {
  findVault: (name: string) => Promise<VaultDeleteConfigInfo | null>;
  listVaultNames: () => Promise<string[]>;
  secretExists: (vaultName: string, key: string) => Promise<boolean>;
  supportsDelete: (vaultName: string) => Promise<boolean>;
  deleteSecret: (vaultName: string, key: string) => Promise<void>;
  publishSecretDeleted: (
    vaultId: string,
    vaultType: string,
    vaultName: string,
    key: string,
  ) => Promise<void>;
}

export function createVaultDeleteDeps(
  repoDir: string,
  eventBus: EventBus,
): VaultDeleteDeps {
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
    supportsDelete: async (vaultName) => {
      const svc = await getVaultService();
      return svc.supportsDelete(vaultName);
    },
    deleteSecret: async (vaultName, key) => {
      const svc = await getVaultService();
      await svc.delete(vaultName, key);
    },
    publishSecretDeleted: async (vaultId, vaultType, vaultName, key) => {
      const event = createVaultSecretDeleted(
        vaultId,
        vaultType,
        vaultName,
        key,
      );
      await eventBus.publish(event);
    },
  };
}

export async function vaultDeletePreview(
  ctx: LibSwampContext,
  deps: VaultDeleteDeps,
  vaultName: string,
  key: string,
): Promise<VaultDeletePreview> {
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

  const supports = await deps.supportsDelete(vaultName);
  const exists = supports ? await deps.secretExists(vaultName, key) : false;
  ctx.logger.debug`Secret exists: ${exists}, supports delete: ${supports}`;

  return {
    vaultName: config.name,
    vaultType: config.type,
    secretKey: key,
    secretExists: exists,
    supportsDelete: supports,
  };
}

export async function* vaultDelete(
  ctx: LibSwampContext,
  deps: VaultDeleteDeps,
  input: VaultDeleteInput,
): AsyncIterable<VaultDeleteEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.delete",
    {},
    (async function* () {
      yield { kind: "deleting" };

      const config = await deps.findVault(input.vaultName);
      if (!config) {
        yield {
          kind: "error",
          error: notFound("Vault", input.vaultName),
        };
        return;
      }

      await deps.deleteSecret(input.vaultName, input.key);
      ctx.logger.debug`Secret deleted successfully`;

      await deps.publishSecretDeleted(
        config.id,
        config.type,
        config.name,
        input.key,
      );
      ctx.logger.debug`Emitted VaultSecretDeleted event`;

      yield {
        kind: "completed",
        data: {
          vaultName: input.vaultName,
          secretKey: input.key,
          vaultType: config.type,
          timestamp: new Date().toISOString(),
        },
      };
    })(),
  );
}
