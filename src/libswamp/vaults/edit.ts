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
  type LocalEncryptionConfig,
  moveLocalEncryptionSecrets,
} from "../../domain/vaults/local_encryption_vault_provider.ts";
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
  /** The vault's previous name, when the edit renamed it. */
  renamedFrom?: string;
  /** Whether a rename moved stored secrets to the new name. */
  secretsMoved?: boolean;
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
   * Called before every stdin update is saved, with the stored and the edited
   * vault. Returning false leaves the file untouched. Serve uses it to
   * authorize the edited vault.
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
  /**
   * Moves the stored secrets of a vault being renamed to `toName`, for vault
   * types that key their storage on the vault name. Returns a callback that
   * moves them back, or null when nothing moved.
   */
  moveSecrets: (
    stored: VaultConfigData,
    toName: string,
  ) => Promise<(() => Promise<void>) | null>;
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
    // Wait for GUI editors too, so a rename made in the editor is seen after
    // it closes and the vault's secrets can move with it (swamp-club#2681).
    prepareEditor: (path) =>
      editorService.prepareOpenFile(path, { wait: true }),
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
    moveSecrets: async (stored, toName) => {
      if (stored.type !== "local_encryption") return null;
      // The storage root comes from the stored config only: over --server
      // the edited config is client-controlled. VaultService falls back to
      // the repo dir when base_dir is unset or empty, so this does too.
      const baseDir = (stored.config as LocalEncryptionConfig).base_dir ||
        repoDir;
      const moved = await moveLocalEncryptionSecrets(
        baseDir,
        stored.name,
        toName,
      );
      if (!moved) return null;
      return async () => {
        await moveLocalEncryptionSecrets(baseDir, toName, stored.name);
      };
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
 * Validates new vault YAML against the existing vault and saves it. The id and
 * createdAt are kept, and the type cannot change because it is part of the
 * storage path.
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
  // id and createdAt are pinned: they record the vault's identity and
  // creation, not configuration the edit may change.
  const parsed = VaultConfigDataSchema.safeParse({
    ...fields,
    id: existing.id,
    createdAt: existing.createdAt,
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

  if (input.authorizeUpdate) {
    const allowed = await input.authorizeUpdate(
      { id: existing.id, name: existing.name, type: existing.type },
      { id: updated.id, name: updated.name, type: updated.type },
    );
    if (!allowed) {
      yield {
        kind: "error",
        error: forbidden(
          `Not allowed to save vault '${existing.name}' as '${updated.name}'`,
        ),
      };
      return;
    }
  }

  // Secrets move before the save, so a failed move leaves the vault as it
  // was, and a failed save moves them back.
  let undoMove: (() => Promise<void>) | null = null;
  if (renamed) {
    try {
      undoMove = await deps.moveSecrets(existing, updated.name);
    } catch (error) {
      yield {
        kind: "error",
        error: validationFailed(
          `Cannot rename vault '${existing.name}' to '${updated.name}': ${
            errorMessage(error)
          }`,
        ),
      };
      return;
    }
  }
  try {
    await deps.saveConfigData(updated);
  } catch (error) {
    if (!undoMove) throw error;
    try {
      await undoMove();
    } catch (undoError) {
      // Report both: the save failure is the cause, and the failed undo
      // tells the user where the secrets now are.
      throw new Error(
        `${errorMessage(error)}. Moving the secrets back to vault name ` +
          `'${existing.name}' also failed: ${errorMessage(undoError)}. ` +
          `They are stored under '${updated.name}'.`,
        { cause: error },
      );
    }
    throw error;
  }
  yield {
    kind: "completed",
    data: {
      path: filePath,
      status: "updated",
      name: updated.name,
      type: updated.type,
      ...(renamed
        ? { renamedFrom: existing.name, secretsMoved: undoMove !== null }
        : {}),
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Checks the vault after an editor session and, when it was renamed, moves
 * its secrets to the new name. A rename that is invalid or whose secrets
 * cannot move is reverted, keeping the user's other edits, so the config and
 * the stored secrets always agree. Returns the error to report, or the new
 * name when the vault was renamed.
 */
async function reconcileEditorRename(
  deps: VaultEditDeps,
  stored: VaultConfigData,
): Promise<
  { error: SwampError } | { renamedTo: string; secretsMoved: boolean } | null
> {
  let edited: VaultConfigData | null;
  try {
    edited = await deps.readConfigData(stored);
  } catch (error) {
    return {
      error: validationFailed(
        `Vault '${stored.name}' is not valid after editing: ${
          errorMessage(error)
        }. Its stored secrets were not moved.`,
      ),
    };
  }
  if (!edited || edited.name === stored.name) return null;

  let reason: string | null = null;
  if (!isValidVaultName(edited.name)) {
    reason = `Invalid vault name: ${edited.name}. ${VAULT_NAME_RULE}`;
  } else {
    const clash = await deps.findByName(edited.name);
    if (clash && clash.id !== stored.id) {
      reason = `A vault named '${edited.name}' already exists.`;
    }
  }
  if (!reason) {
    try {
      const undo = await deps.moveSecrets(stored, edited.name);
      return { renamedTo: edited.name, secretsMoved: undo !== null };
    } catch (error) {
      reason = errorMessage(error);
    }
  }

  try {
    await deps.saveConfigData({ ...edited, name: stored.name });
  } catch (error) {
    return {
      error: validationFailed(
        `Cannot rename vault '${stored.name}' to '${edited.name}': ${reason} ` +
          `Changing the name back to '${stored.name}' also failed: ` +
          `${errorMessage(error)}. The config names the vault ` +
          `'${edited.name}' but its secrets are still stored under ` +
          `'${stored.name}'.`,
      ),
    };
  }
  return {
    error: validationFailed(
      `Cannot rename vault '${stored.name}' to '${edited.name}': ${reason} ` +
        `The name was changed back to '${stored.name}'; other edits were kept.`,
    ),
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

      // A config that no longer parses can still be opened to fix it; there
      // is then no stored name to compare a rename against.
      const stored = await deps.readConfigData(config).catch(() => null);

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

      const rename = stored ? await reconcileEditorRename(deps, stored) : null;
      if (rename && "error" in rename) {
        yield { kind: "error", error: rename.error };
        return;
      }

      yield {
        kind: "completed",
        data: {
          path: filePath,
          editor: result.editor,
          status: "opened",
          name: rename ? rename.renamedTo : config.name,
          type: config.type,
          ...(rename
            ? { renamedFrom: config.name, secretsMoved: rename.secretsMoved }
            : {}),
        },
      };
    })(),
  );
}
