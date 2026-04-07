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

import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the vault get output.
 */
export interface VaultGetData {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
  storagePath: string;
}

/** Minimal vault config shape needed by the generator. */
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

/** Dependencies for the vault get operation. */
export interface VaultGetDeps {
  findByName: (name: string) => Promise<VaultConfigInfo | null>;
  findById: (type: string, id: string) => Promise<VaultConfigInfo | null>;
  findAll: () => Promise<VaultConfigInfo[]>;
  storagePath: (config: VaultConfigInfo) => string;
}

/** Wires real infrastructure into VaultGetDeps. */
export function createVaultGetDeps(repoDir: string): VaultGetDeps {
  const repo = new YamlVaultConfigRepository(repoDir);
  return {
    findByName: (name) => repo.findByName(name),
    findById: (type, id) => repo.findById(type, id),
    findAll: () => repo.findAll(),
    storagePath: (config) => `vaults/${config.type}/${config.id}.yaml`,
  };
}

/** Retrieves vault configuration details. */
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

      // Try to find by name first
      let config = await deps.findByName(vaultNameOrId);

      // If not found by name, try to find by ID
      if (!config) {
        if (vaultType) {
          config = await deps.findById(vaultType, vaultNameOrId);
        } else {
          const allVaults = await deps.findAll();
          config = allVaults.find((v) => v.id === vaultNameOrId) ?? null;
        }
      }

      // If type was specified, verify it matches
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
