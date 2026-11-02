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

import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

export interface VaultConfigRepository {
  findByName: (name: string) => Promise<VaultConfigInfo | null>;
  findById: (
    type: string,
    id: string,
  ) => Promise<VaultConfigInfo | null>;
  findAll: () => Promise<VaultConfigInfo[]>;
}

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
export interface VaultGetData {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
  storagePath: string;
}

export interface VaultConfigInfo {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: Date;
}

export type VaultGetEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultGetData }
  | { kind: "error"; error: SwampError };

export interface VaultGetDeps {
  findByName: (name: string) => Promise<VaultConfigInfo | null>;
  findById: (type: string, id: string) => Promise<VaultConfigInfo | null>;
  findAll: () => Promise<VaultConfigInfo[]>;
  storagePath: (config: VaultConfigInfo) => string;
}

export function createVaultGetDeps(
  repoDir: string,
  injectedVaultConfigRepo?: VaultConfigRepository,
): VaultGetDeps {
  const repo = injectedVaultConfigRepo ??
    new YamlVaultConfigRepository(repoDir);
  return {
    findByName: (name) => repo.findByName(name),
    findById: (type, id) => repo.findById(type, id),
    findAll: () => repo.findAll(),
    storagePath: (config) => `vaults/${config.type}/${config.id}.yaml`,
  };
}

export async function* vaultGet(
  _ctx: LibSwampContext,
  deps: VaultGetDeps,
  vaultNameOrId: string,
  vaultType?: string,
): AsyncIterable<VaultGetEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.get",
    {},
    (async function* () {
      yield { kind: "resolving" };

      let config = await deps.findByName(vaultNameOrId);

      if (!config) {
        if (vaultType) {
          config = await deps.findById(vaultType, vaultNameOrId);
        } else {
          const allVaults = await deps.findAll();
          config = allVaults.find((v) => v.id === vaultNameOrId) ?? null;
        }
      }

      if (config && vaultType && config.type !== vaultType) {
        yield {
          kind: "error",
          error: validationFailed(
            `Vault '${vaultNameOrId}' found but has type '${config.type}', not '${vaultType}'`,
          ),
        };
        return;
      }

      if (!config) {
        const typeHint = vaultType ? ` of type '${vaultType}'` : "";
        yield {
          kind: "error",
          error: notFound("Vault", `${vaultNameOrId}${typeHint}`),
        };
        return;
      }

      const data: VaultGetData = {
        id: config.id,
        name: config.name,
        type: config.type,
        config: config.config,
        createdAt: config.createdAt.toISOString(),
        storagePath: deps.storagePath(config),
      };

      yield { kind: "completed", data };
    })(),
  );
}
