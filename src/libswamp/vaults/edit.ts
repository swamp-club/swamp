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
import { resolve } from "@std/path";
import {
  VaultConfigParseError,
  YamlVaultConfigRepository,
} from "../../infrastructure/persistence/yaml_vault_config_repository.ts";
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
  findChangedKeySourceFields,
  findNonDefaultKeySourceFields,
  isLocalEncryptionType,
  withServerDefaultKeySource,
} from "../../domain/vaults/local_encryption_key_source.ts";
import {
  isValidVaultName,
  VAULT_NAME_RULE,
} from "../../domain/vaults/vault_name.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import {
  alreadyExists,
  forbidden,
  notFound,
  validationFailed,
} from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import {
  describeVaultConfigFields,
  explainVaultConfigIssues,
  type RerunHint,
} from "../../domain/vaults/vault_config_fields.ts";

/** vault edit has no --config: the fix goes into the definition itself. */
const EDIT_RERUN_HINT: RerunHint = (_example, missing) =>
  missing.length > 0
    ? "Add the missing field(s) under config in the vault definition and save again."
    : "Fix the config in the vault definition and save again.";
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
  /**
   * Whether the edit replaced a config that did not parse. Its stored secrets
   * were not moved, since its previous name could not be read.
   */
  repaired?: boolean;
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
  /**
   * Allows a stdin update to replace a vault config that does not parse, when
   * `vaultNameOrId` and `vaultType` name that file. Called with the broken
   * vault's id and type and the edited vault before anything is written;
   * returning false leaves the file untouched. Without it, such a vault is
   * reported as invalid and cannot be updated from stdin.
   */
  authorizeRepair?: (
    target: { id: string; type: string },
    after: VaultEditConfigInfo,
  ) => Promise<boolean> | boolean;
  /**
   * Accept stdin updates that change a local_encryption vault's key source
   * (base_dir, key_file, ssh_key_path, auto_generate). Only a caller that
   * already owns the host sets this: the local CLI. Without it an update
   * must keep the stored values, and a repair gets the server defaults
   * (swamp-club#2690).
   */
  trustKeySource?: boolean;
  /**
   * The repository the server defaults point at. A repair of a
   * local_encryption vault without `trustKeySource` needs it.
   */
  repoDir?: string;
}

/** Lookups used to resolve a vault by name or id. */
export interface VaultEditLookupDeps {
  /**
   * Finds a vault by name. With `skipUnparseable`, vault files that do not
   * parse never fail the lookup.
   */
  findByName: (
    name: string,
    skipUnparseable?: boolean,
  ) => Promise<VaultEditConfigInfo | null>;
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
    findByName: (name, skipUnparseable) =>
      repo.findByName(name, skipUnparseable),
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
  let byName: VaultEditConfigInfo | null;
  try {
    byName = await deps.findByName(vaultNameOrId);
  } catch (error) {
    // A vault file that does not parse stops the name lookup. With a type,
    // the id can still be looked up directly; if that finds nothing, the
    // broken file may be the vault that was named, so report it.
    if (!(error instanceof VaultConfigParseError) || !vaultType) throw error;
    let byId: VaultEditConfigInfo | null;
    try {
      byId = await deps.findById(vaultType, vaultNameOrId);
    } catch (idError) {
      // The requested file's own parse error names it; anything else (such
      // as an argument that is not a valid id) says less than the first.
      if (idError instanceof VaultConfigParseError) throw idError;
      throw error;
    }
    if (byId) return byId;
    throw error;
  }
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
          explainVaultConfigIssues({
            vaultType: updated.type,
            config: updated.config,
            issues: result.error.issues,
            fields: describeVaultConfigFields(schema),
            rerunHint: EDIT_RERUN_HINT,
          }),
        ),
      };
      return;
    }
  }

  if (!input.trustKeySource && isLocalEncryptionType(existing.type)) {
    // The key source names files on this host, so a caller that does not
    // own it must leave it as stored.
    const changed = findChangedKeySourceFields(
      updated.config,
      existing.config,
    );
    if (changed.length > 0) {
      yield {
        kind: "error",
        error: validationFailed(
          `Cannot change ${changed.join(", ")} of vault '${existing.name}' ` +
            `remotely: keep the stored values, or edit the vault on the ` +
            `host running swamp.`,
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

/**
 * Whether a lookup failed because the requested vault's own file does not
 * parse: the error names the file at the requested type and id.
 */
function isBrokenTarget(
  deps: VaultEditDeps,
  error: unknown,
  vaultNameOrId: string,
  vaultType: string | undefined,
): vaultType is string {
  if (!(error instanceof VaultConfigParseError) || !vaultType) return false;
  let path: string;
  try {
    path = deps.getVaultPath({
      id: vaultNameOrId,
      name: vaultNameOrId,
      type: vaultType,
    });
  } catch {
    return false;
  }
  return resolve(error.path) === resolve(path);
}

/**
 * Replaces a vault config that does not parse with new vault YAML. The id
 * comes from the file name and the type from its directory. Secrets are not
 * moved: the vault's previous name cannot be read.
 * Messages carry no file paths: serve replaces any message with a path in it
 * by a generic error.
 */
async function* repairVaultFromStdin(
  deps: VaultEditDeps,
  input: VaultEditInput,
  authorizeRepair: NonNullable<VaultEditInput["authorizeRepair"]>,
  target: VaultEditConfigInfo,
  filePath: string,
  content: string,
): AsyncIterable<VaultEditEvent> {
  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    yield { kind: "error", error: stdinError(errorMessage(error)) };
    return;
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    yield { kind: "error", error: stdinError("expected a YAML mapping") };
    return;
  }

  const fields = raw as Record<string, unknown>;
  // The stored createdAt cannot be read; keep the one given if it is a date.
  const createdAt = typeof fields.createdAt === "string" &&
      !Number.isNaN(Date.parse(fields.createdAt))
    ? fields.createdAt
    : new Date().toISOString();
  const parsed = VaultConfigDataSchema.safeParse({
    ...fields,
    id: target.id,
    createdAt,
  });
  if (!parsed.success) {
    yield { kind: "error", error: stdinError(parsed.error.message) };
    return;
  }
  let repaired = parsed.data;

  if (repaired.type !== target.type) {
    yield {
      kind: "error",
      error: validationFailed(
        `Cannot change the type of vault '${target.id}' from '${target.type}' to '${repaired.type}'`,
      ),
    };
    return;
  }
  if (!isValidVaultName(repaired.name)) {
    yield {
      kind: "error",
      error: validationFailed(
        `Invalid vault name: ${repaired.name}. ${VAULT_NAME_RULE}`,
      ),
    };
    return;
  }
  // Files that do not parse, this one included, cannot hold the name;
  // reporting them would stop any repair while another vault is broken.
  const clash = await deps.findByName(repaired.name, true);
  if (clash && clash.id !== target.id) {
    yield { kind: "error", error: alreadyExists("Vault", repaired.name) };
    return;
  }

  const schema = await deps.getConfigSchema(repaired.type);
  if (schema) {
    const result = schema.safeParse(repaired.config);
    if (!result.success) {
      yield {
        kind: "error",
        error: validationFailed(
          explainVaultConfigIssues({
            vaultType: repaired.type,
            config: repaired.config,
            issues: result.error.issues,
            fields: describeVaultConfigFields(schema),
            rerunHint: EDIT_RERUN_HINT,
          }),
        ),
      };
      return;
    }
  }

  if (!input.trustKeySource && isLocalEncryptionType(repaired.type)) {
    // The stored key source cannot be read, so a caller that does not own
    // the host gets the server defaults. Without the repository they point
    // at, nothing is written.
    if (input.repoDir === undefined) {
      yield {
        kind: "error",
        error: validationFailed(
          `Cannot repair vault '${target.id}' remotely: the server's key ` +
            `source is not known. Repair it on the host running swamp.`,
        ),
      };
      return;
    }
    const refused = findNonDefaultKeySourceFields(
      repaired.config,
      input.repoDir,
    );
    if (refused.length > 0) {
      yield {
        kind: "error",
        error: validationFailed(
          `Cannot set ${refused.join(", ")} when repairing vault ` +
            `'${target.id}' remotely: the server's key source is used. ` +
            `Leave these fields out, or repair the vault on the host ` +
            `running swamp.`,
        ),
      };
      return;
    }
    repaired = {
      ...repaired,
      config: withServerDefaultKeySource(repaired.config, input.repoDir),
    };
  }

  const allowed = await authorizeRepair(
    { id: target.id, type: target.type },
    { id: repaired.id, name: repaired.name, type: repaired.type },
  );
  if (!allowed) {
    yield {
      kind: "error",
      error: forbidden(`Not allowed to repair vault '${target.id}'`),
    };
    return;
  }

  // Only a file that still does not parse is replaced: one repaired
  // meanwhile is left as it is.
  try {
    const current = await deps.readConfigData(target);
    if (!current) {
      yield { kind: "error", error: notFound("Vault", target.id) };
      return;
    }
    yield {
      kind: "error",
      error: validationFailed(
        `Vault '${target.id}' was repaired while this edit ran; nothing was written.`,
      ),
    };
    return;
  } catch (error) {
    if (!(error instanceof VaultConfigParseError)) throw error;
  }

  await deps.saveConfigData(repaired);
  yield {
    kind: "completed",
    data: {
      path: filePath,
      status: "updated",
      name: repaired.name,
      type: repaired.type,
      repaired: true,
      secretsMoved: false,
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
    // The config is already saved, so a lookup failure (such as another
    // vault file that does not parse) reverts the rename rather than
    // escaping with the config and the secrets disagreeing.
    try {
      const clash = await deps.findByName(edited.name);
      if (clash && clash.id !== stored.id) {
        reason = `A vault named '${edited.name}' already exists.`;
      }
    } catch (error) {
      reason = `Could not check that the name is free: ${errorMessage(error)}`;
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
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.vault.edit",
      {},
      (async function* () {
        yield { kind: "resolving" };

        const { vaultNameOrId, vaultType } = input;

        ctx.logger.debug`Looking up vault: ${vaultNameOrId}`;

        const stdinContent = input.stdinContent ?? null;
        let config: VaultEditConfigInfo | null;
        // Set when the requested vault's own file does not parse: it can
        // still be opened to fix it, or replaced when repair is authorized.
        let broken = false;
        try {
          config = input.byId && vaultType
            ? await deps.findById(vaultType, vaultNameOrId)
            : await findVaultByNameOrId(deps, vaultNameOrId, vaultType);
        } catch (error) {
          if (
            !isBrokenTarget(deps, error, vaultNameOrId, vaultType) ||
            (stdinContent !== null && !input.authorizeRepair)
          ) {
            throw error;
          }
          broken = true;
          config = { id: vaultNameOrId, name: vaultNameOrId, type: vaultType };
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

        if (broken && stdinContent !== null && input.authorizeRepair) {
          ctx.logger.debug`Repairing vault from stdin: ${config.id}`;
          yield* repairVaultFromStdin(
            deps,
            input,
            input.authorizeRepair,
            config,
            filePath,
            stdinContent,
          );
          return;
        }

        if (stdinContent !== null) {
          ctx.logger.debug`Updating vault from stdin: ${config.name}`;
          yield* updateVaultFromStdin(
            deps,
            input,
            config,
            filePath,
            stdinContent,
          );
          return;
        }

        // A config that no longer parses can still be opened to fix it; there
        // is then no stored name to compare a rename against.
        const stored = broken
          ? null
          : await deps.readConfigData(config).catch(() => null);

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

        const rename = stored
          ? await reconcileEditorRename(deps, stored)
          : null;
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
    ));
}
