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

import type { z } from "zod";
import { parse as parseYaml } from "@std/yaml";
import { YamlVaultConfigRepository } from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
import {
  VaultConfig,
  type VaultConfigData,
  VaultConfigDataSchema,
} from "../../domain/vaults/vault_config.ts";
import { vaultTypeRegistry } from "../../domain/vaults/vault_type_registry.ts";
import {
  isValidVaultName,
  VAULT_NAME_RULE,
} from "../../domain/vaults/vault_name.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import {
  alreadyExists,
  forbidden,
  notFound,
  validationFailed,
} from "../errors.ts";

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
  editor?: string;
  status: "opened" | "updated";
  name: string;
  type: string;
}

export type VaultEditEvent =
  | { kind: "resolving" }
  | {
    kind: "launching";
    data: { editor: string; path: string; waitsForExit: boolean };
  }
  | { kind: "completed"; data: VaultEditData }
  | { kind: "error"; error: SwampError };

/** Input for the vault edit operation. */
export interface VaultEditInput {
  vaultNameOrId: string;
  vaultType?: string;
  /**
   * Treat `vaultNameOrId` as an id already resolved by the caller, and look it
   * up by id only. Requires `vaultType`. Vault names can look like ids, so a
   * name-first lookup could land on a different vault than the one the caller
   * authorized.
   */
  byId?: boolean;
  /** New vault YAML. When set, the vault is updated instead of opened. */
  stdinContent?: string | null;
  /**
   * Called before a stdin update that renames the vault is saved. Returning
   * false leaves the file untouched. Serve uses it to authorize the new name.
   */
  authorizeUpdate?: (
    before: VaultEditConfigInfo,
    after: VaultEditConfigInfo,
  ) => Promise<boolean> | boolean;
}

/** Lookups used to resolve a vault by name or id. */
export interface VaultEditLookupDeps {
  findByName: (name: string) => Promise<VaultEditConfigInfo | null>;
  findById: (type: string, id: string) => Promise<VaultEditConfigInfo | null>;
  findAll: () => Promise<VaultEditConfigInfo[]>;
}

/** Dependencies for the vault edit operation. */
export interface VaultEditDeps extends VaultEditLookupDeps {
  getVaultPath: (config: VaultEditConfigInfo) => string;
  fileExists: (path: string) => Promise<boolean>;
  prepareEditor: (path: string) => Promise<EditorLaunch>;
  readConfigData: (
    config: VaultEditConfigInfo,
  ) => Promise<VaultConfigData | null>;
  saveConfigData: (data: VaultConfigData) => Promise<void>;
  /**
   * The schema a vault type's config must satisfy, or undefined when the type
   * declares none. Mirrors `vault create`: only extension types are checked.
   */
  getConfigSchema: (type: string) => Promise<z.ZodTypeAny | undefined>;
}

/** Wires real infrastructure into VaultEditDeps. */
export function createVaultEditDeps(
  repoDir: string,
  injectedRepo?: YamlVaultConfigRepository,
): VaultEditDeps {
  // The repository resolves the effective vaults dir, which is the datastore
  // config tier under managedConfig (swamp-club#2426).
  const repo = injectedRepo ?? new YamlVaultConfigRepository(repoDir);
  const editorService = new EditorService();
  return {
    findByName: (name) => repo.findByName(name),
    findById: (type, id) => repo.findById(type, id),
    findAll: () => repo.findAll(),
    getVaultPath: (config) => repo.getPath(config.type, config.id),
    fileExists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    prepareEditor: (path) => editorService.prepareOpenFile(path),
    readConfigData: async (config) =>
      (await repo.findById(config.type, config.id))?.toData() ?? null,
    saveConfigData: (data) => repo.save(VaultConfig.fromData(data)),
    getConfigSchema: async (type) => {
      await vaultTypeRegistry.ensureLoaded();
      await vaultTypeRegistry.ensureTypeLoaded(type);
      const typeInfo = vaultTypeRegistry.get(type);
      if (!typeInfo || typeInfo.isBuiltIn || !typeInfo.createProvider) {
        return undefined;
      }
      return typeInfo.configSchema;
    },
  };
}

/**
 * Finds a vault by name, falling back to its id. With a type the id lookup is
 * direct; without one every vault is scanned. Shared by `vault edit` and the
 * serve handler so both resolve the same vault.
 */
export async function findVaultByNameOrId(
  deps: VaultEditLookupDeps,
  vaultNameOrId: string,
  vaultType?: string,
): Promise<VaultEditConfigInfo | null> {
  const byName = await deps.findByName(vaultNameOrId);
  if (byName) return byName;
  if (vaultType) return await deps.findById(vaultType, vaultNameOrId);
  const allVaults = await deps.findAll();
  return allVaults.find((v) => v.id === vaultNameOrId) ?? null;
}

function stdinError(detail: string): SwampError {
  return validationFailed(`Invalid vault YAML from stdin: ${detail}`);
}

/**
 * Validates new vault YAML against the existing vault and saves it. The id is
 * kept, and the type cannot change because it is part of the storage path.
 * Messages carry no file paths: serve replaces any message with a path in it
 * by a generic error.
 */
async function* updateVaultFromStdin(
  deps: VaultEditDeps,
  input: VaultEditInput,
  config: VaultEditConfigInfo,
  filePath: string,
  content: string,
): AsyncIterable<VaultEditEvent> {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    yield {
      kind: "error",
      error: stdinError(error instanceof Error ? error.message : String(error)),
    };
    return;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    yield { kind: "error", error: stdinError("expected a YAML mapping") };
    return;
  }

  const existing = await deps.readConfigData(config);
  if (!existing) {
    yield { kind: "error", error: notFound("Vault", config.name) };
    return;
  }

  const fields = raw as Record<string, unknown>;
  const parsed = VaultConfigDataSchema.safeParse({
    ...fields,
    id: existing.id,
    createdAt: fields.createdAt ?? existing.createdAt,
  });
  if (!parsed.success) {
    yield { kind: "error", error: stdinError(parsed.error.message) };
    return;
  }
  const updated = parsed.data;

  if (updated.type !== existing.type) {
    yield {
      kind: "error",
      error: validationFailed(
        `Cannot change the type of vault '${existing.name}' from '${existing.type}' to '${updated.type}'`,
      ),
    };
    return;
  }

  const renamed = updated.name !== existing.name;
  if (renamed) {
    if (!isValidVaultName(updated.name)) {
      yield {
        kind: "error",
        error: validationFailed(
          `Invalid vault name: ${updated.name}. ${VAULT_NAME_RULE}`,
        ),
      };
      return;
    }
    const clash = await deps.findByName(updated.name);
    if (clash && clash.id !== existing.id) {
      yield { kind: "error", error: alreadyExists("Vault", updated.name) };
      return;
    }
  }

  const schema = await deps.getConfigSchema(updated.type);
  if (schema) {
    const result = schema.safeParse(updated.config);
    if (!result.success) {
      yield {
        kind: "error",
        error: validationFailed(
          `Invalid config for vault type '${updated.type}': ${result.error.message}`,
        ),
      };
      return;
    }
  }

  if (renamed && input.authorizeUpdate) {
    const allowed = await input.authorizeUpdate(
      { id: existing.id, name: existing.name, type: existing.type },
      { id: updated.id, name: updated.name, type: updated.type },
    );
    if (!allowed) {
      yield {
        kind: "error",
        error: forbidden(
          `Not allowed to rename vault '${existing.name}' to '${updated.name}'`,
        ),
      };
      return;
    }
  }

  await deps.saveConfigData(updated);
  yield {
    kind: "completed",
    data: {
      path: filePath,
      status: "updated",
      name: updated.name,
      type: updated.type,
    },
  };
}

/** Edits a vault configuration file via stdin update or editor. */
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

      const config = input.byId && vaultType
        ? await deps.findById(vaultType, vaultNameOrId)
        : await findVaultByNameOrId(deps, vaultNameOrId, vaultType);

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

      if (input.stdinContent !== undefined && input.stdinContent !== null) {
        ctx.logger.debug`Updating vault from stdin: ${config.name}`;
        yield* updateVaultFromStdin(
          deps,
          input,
          config,
          filePath,
          input.stdinContent,
        );
        return;
      }

      ctx.logger.debug`Opening file: ${filePath}`;
      const launch = await deps.prepareEditor(filePath);
      yield {
        kind: "launching",
        data: {
          editor: launch.editor,
          path: filePath,
          waitsForExit: launch.waitsForExit,
        },
      };
      const result = await launch.open();

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
