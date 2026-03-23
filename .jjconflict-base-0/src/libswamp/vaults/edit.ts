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
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/** Minimal vault config shape needed by the generator. */
export interface VaultEditConfigInfo {
  id: string;
  name: string;
  type: string;
}

/**
 * Data structure for the vault edit output.
 */
export interface VaultEditData {
  path: string;
  editor: string;
  status: "opened";
  name: string;
  type: string;
}

export type VaultEditEvent =
  | { kind: "resolving" }
  | { kind: "completed"; data: VaultEditData }
  | { kind: "error"; error: SwampError };

/** Input for the vault edit operation. */
export interface VaultEditInput {
  vaultNameOrId: string;
  vaultType?: string;
}

/** Dependencies for the vault edit operation. */
export interface VaultEditDeps {
  findByName: (name: string) => Promise<VaultEditConfigInfo | null>;
  findById: (type: string, id: string) => Promise<VaultEditConfigInfo | null>;
  findAll: () => Promise<VaultEditConfigInfo[]>;
  getVaultPath: (config: VaultEditConfigInfo) => string;
  fileExists: (path: string) => Promise<boolean>;
  openEditor: (path: string) => Promise<{ editor: string }>;
}

/** Wires real infrastructure into VaultEditDeps. */
export function createVaultEditDeps(repoDir: string): VaultEditDeps {
  const repo = new YamlVaultConfigRepository(repoDir);
  const editorService = new EditorService();
  return {
    findByName: (name) => repo.findByName(name),
    findById: (type, id) => repo.findById(type, id),
    findAll: () => repo.findAll(),
    getVaultPath: (config) =>
      swampPath(
        repoDir,
        SWAMP_SUBDIRS.vault,
        config.type,
        `${config.id}.yaml`,
      ),
    fileExists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    openEditor: async (path) => {
      const result = await editorService.openFile(path);
      return { editor: result.editor };
    },
  };
}

/** Edits a vault configuration file in the user's editor. */
export async function* vaultEdit(
  ctx: LibSwampContext,
  deps: VaultEditDeps,
  input: VaultEditInput,
): AsyncIterable<VaultEditEvent> {
  yield* withGeneratorSpan(
    "swamp.vault.edit",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const { vaultNameOrId, vaultType } = input;

      ctx.logger.debug`Looking up vault: ${vaultNameOrId}`;

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

      ctx.logger
        .debug`Found vault: id=${config.id}, name=${config.name}, type=${config.type}`;

      const filePath = deps.getVaultPath(config);

      // Check if file exists
      const exists = await deps.fileExists(filePath);
      if (!exists) {
        yield {
          kind: "error",
          error: notFound(
            "Vault configuration file",
            filePath,
          ),
        };
        return;
      }

      ctx.logger.debug`Opening file: ${filePath}`;
      const result = await deps.openEditor(filePath);

      yield {
        kind: "completed",
        data: {
          path: filePath,
          editor: result.editor,
          status: "opened",
          name: config.name,
          type: config.type,
        },
      };
    })(),
  );
}
