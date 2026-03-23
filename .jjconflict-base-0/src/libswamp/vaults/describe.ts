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
import type { VaultConfigInfo } from "./get.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for vault describe output (full config data).
 */
export interface VaultDescribeData {
  id: string;
  name: string;
  type: string;
  config: Record<string, unknown>;
  createdAt: string;
}

export type VaultDescribeEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultDescribeData }
  | { kind: "error"; error: SwampError };

/** Dependencies for the vault describe operation. */
export interface VaultDescribeDeps {
  findByName: (name: string) => Promise<VaultConfigInfo | null>;
  findById: (type: string, id: string) => Promise<VaultConfigInfo | null>;
  findAll: () => Promise<VaultConfigInfo[]>;
}

/** Wires real infrastructure into VaultDescribeDeps. */
export function createVaultDescribeDeps(repoDir: string): VaultDescribeDeps {
  const repo = new YamlVaultConfigRepository(repoDir);
  return {
    findByName: (name) => repo.findByName(name),
    findById: (type, id) => repo.findById(type, id),
    findAll: () => repo.findAll(),
  };
}

/** Retrieves vault configuration for description. */
export async function* vaultDescribe(
  _ctx: LibSwampContext,
  deps: VaultDescribeDeps,
  vaultNameOrId: string,
  vaultType?: string,
): AsyncIterable<VaultDescribeEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.describe",
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

      yield {
        kind: "completed",
        data: {
          id: config.id,
          name: config.name,
          type: config.type,
          config: config.config,
          createdAt: config.createdAt.toISOString(),
        },
      };
    })(),
  );
}
