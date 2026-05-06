// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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
import { createVaultSecretRead } from "../../domain/events/types.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import { notFound, type SwampError, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";

export interface VaultReadSecretData {
  vaultName: string;
  secretKey: string;
  vaultType: string;
  value: string;
}

export type VaultReadSecretEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultReadSecretData }
  | { kind: "error"; error: SwampError };

export interface VaultReadSecretInput {
  vaultName: string;
  secretKey: string;
}

interface VaultConfigInfo {
  id: string;
  name: string;
  type: string;
}

export interface VaultReadSecretDeps {
  findVault: (name: string) => Promise<VaultConfigInfo | null>;
  listVaultNames: () => Promise<string[]>;
  readSecret: (vaultName: string, secretKey: string) => Promise<string>;
  publishSecretRead: (
    vaultId: string,
    vaultType: string,
    vaultName: string,
    secretKey: string,
  ) => Promise<void>;
}

export function createVaultReadSecretDeps(
  repoDir: string,
  eventBus: EventBus,
): VaultReadSecretDeps {
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
    readSecret: async (vaultName, secretKey) => {
      const svc = await getVaultService();
      return await svc.get(vaultName, secretKey);
    },
    publishSecretRead: async (vaultId, vaultType, vaultName, secretKey) => {
      const event = createVaultSecretRead(
        vaultId,
        vaultType,
        vaultName,
        secretKey,
      );
      await eventBus.publish(event);
    },
  };
}

export async function* vaultReadSecret(
  ctx: LibSwampContext,
  deps: VaultReadSecretDeps,
  input: VaultReadSecretInput,
): AsyncIterable<VaultReadSecretEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.read_secret",
    {},
    (async function* () {
      yield { kind: "resolving" };

      if (!input.vaultName) {
        yield {
          kind: "error",
          error: validationFailed(
            "Missing required argument: vault_name\n\n" +
              "Usage: swamp vault read-secret <vault_name> <key>\n\n" +
              "Use 'swamp vault search' to see available vaults.",
          ),
        };
        return;
      }

      if (!input.secretKey) {
        yield {
          kind: "error",
          error: validationFailed(
            "Missing required argument: key\n\n" +
              "Usage: swamp vault read-secret <vault_name> <key>\n\n" +
              "Use 'swamp vault list-keys <vault_name>' to see available keys.",
          ),
        };
        return;
      }

      const vaultConfig = await deps.findVault(input.vaultName);
      if (!vaultConfig) {
        const names = await deps.listVaultNames();
        if (names.length === 0) {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `'${input.vaultName}'. No vaults are configured.\n` +
                `Create a vault using: swamp vault create <type> ${input.vaultName}`,
            ),
          };
        } else {
          yield {
            kind: "error",
            error: notFound(
              "Vault",
              `'${input.vaultName}'. Available vaults: ${names.join(", ")}`,
            ),
          };
        }
        return;
      }

      let value: string;
      try {
        value = await deps.readSecret(input.vaultName, input.secretKey);
      } catch (err) {
        yield {
          kind: "error",
          error: notFound(
            "Secret",
            `'${input.secretKey}' in vault '${input.vaultName}'. ` +
              `Use 'swamp vault list-keys ${input.vaultName}' to see available keys.\n` +
              `Original error: ${
                err instanceof Error ? err.message : String(err)
              }`,
          ),
        };
        return;
      }

      await deps.publishSecretRead(
        vaultConfig.id,
        vaultConfig.type,
        vaultConfig.name,
        input.secretKey,
      );
      ctx.logger.debug`Emitted VaultSecretRead event`;

      yield {
        kind: "completed",
        data: {
          vaultName: input.vaultName,
          secretKey: input.secretKey,
          vaultType: vaultConfig.type,
          value,
        },
      };
    })(),
  );
}
