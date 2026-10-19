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

import { Command } from "@cliffy/command";
import { consumeStream } from "../../libswamp/stream.ts";
import {
  createVaultRemoveDeps,
  vaultRemove,
  type VaultRemoveData,
  type VaultRemovePreview,
  vaultRemovePreview,
  vaultRemoveStoredSecrets,
} from "../../libswamp/vaults/remove.ts";
import {
  createVaultRemoveRenderer,
  renderVaultRemoveCancelled,
} from "../../presentation/renderers/vault_remove.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { publishManagedConfigChanges } from "../managed_config_sync.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { promptConfirmation } from "../prompt_helpers.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const vaultRemoveCommand = new Command()
  .name("remove")
  .description(
    `Remove a vault.

Removes the vault's config. For a local_encryption vault it then permanently
deletes the vault's stored secrets, annotations, refresh hooks and generated
key; this cannot be undone. For other vault types only the local config is
removed, and the secrets stay with their provider.

The repository's default vault (defaultVault in .swamp.yaml) is never removed.
A vault that behaviors, workflows or the datastore config reference is refused
unless --force is given.

In log mode the command asks for confirmation unless --yes is given. With
--json it does not prompt.

To delete a single secret, use 'swamp vault delete <vault> <key>'.`,
  )
  .arguments("<vault_name:string>")
  .example(
    "Remove a vault (with confirmation)",
    "swamp vault remove trip-planner",
  )
  .example(
    "Remove without confirmation (for scripts/CI)",
    "swamp vault remove trip-planner --yes",
  )
  .example(
    "Remove a vault that is still referenced",
    "swamp vault remove trip-planner --force --yes",
  )
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("-y, --yes", "Skip confirmation prompt")
  .option(
    "-f, --force",
    "Remove the vault even while behaviors, workflows or the datastore config reference it",
  )
  .action(async function (options: AnyOptions, vaultName: string) {
    const cliCtx = createContext(options as GlobalOptions, ["vault", "remove"]);
    cliCtx.logger.debug`Removing vault: ${vaultName}`;

    const { repoDir, repoContext, syncService, datastoreConfig } =
      await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });
    const marker = await new RepoMarkerRepository().read(
      RepoPath.create(repoDir),
    );

    // The hooked vault config repository stages into each use case's unit.
    const ctx = libSwampContextForRepo(repoContext, { logger: cliCtx.logger });
    const deps = createVaultRemoveDeps(repoDir, {
      vaultConfigRepo: repoContext.vaultConfigRepo,
      definitionRepo: repoContext.definitionRepo,
      workflowRepo: repoContext.workflowRepo,
    });
    const input = { vaultName, force: options.force === true };

    let preview: VaultRemovePreview;
    try {
      preview = await vaultRemovePreview(ctx, deps, input);
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    if (cliCtx.outputMode === "log" && !options.yes) {
      warnBeforeRemoval(preview);
      const confirmed = await promptConfirmation(
        `Remove vault '${preview.vaultName}'?`,
      );
      if (!confirmed) {
        renderVaultRemoveCancelled(cliCtx.outputMode);
        return;
      }
    }

    const outcome: { removed?: VaultRemoveData } = {};
    // The hooked repository marks the removed config's path, so the push
    // deletes it on the datastore. runManagedConfigMutation's bare mark would
    // turn the push into a walk that deletes nothing, leaving the vault for
    // other checkouts.
    const publishes = syncService !== undefined &&
      marker?.datastore?.managedConfig === true;
    await runCommandInRootUnit(
      repoContext,
      {
        push: publishes
          ? () => publishManagedConfigChanges(syncService, datastoreConfig)
          : undefined,
        pushWhen: "completed",
      },
      () =>
        consumeStream(vaultRemove(ctx, deps, input), {
          removing: () => {},
          completed: (e) => {
            outcome.removed = e.data;
          },
          error: (e) => {
            throw new UserError(e.error.message);
          },
        }),
    );
    const removed = outcome.removed;
    if (!removed) return;

    // Only now that the removal is committed and published: a removal that
    // did not land must never cost the vault its secrets.
    try {
      removed.secrets = await vaultRemoveStoredSecrets(ctx, deps, preview);
    } catch (error) {
      throw new UserError(
        `Vault '${preview.vaultName}' was removed, but its secrets directory ` +
          `${preview.localStorage?.directory} could not be deleted: ${
            error instanceof Error ? error.message : String(error)
          }. Delete it by hand.`,
      );
    }

    createVaultRemoveRenderer(cliCtx.outputMode).handlers().completed({
      kind: "completed",
      data: removed,
    });
    cliCtx.logger.debug("Vault remove command completed");
  });

/** Says what the removal will destroy, before the confirmation prompt. */
function warnBeforeRemoval(preview: VaultRemovePreview): void {
  const logger = getSwampLogger(["vault", "remove"]);
  const storage = preview.localStorage;
  if (storage) {
    logger
      .warn`This permanently deletes ${storage.secretKeys.length} secret(s) and the vault's key in ${storage.directory}. This cannot be undone.`;
  } else {
    logger
      .info`Only the local config of vault ${preview.vaultName} (${preview.vaultType}) is removed; its secrets stay with the provider.`;
  }
  for (const ref of preview.references) {
    logger
      .warn`Still referenced by ${ref.kind} ${ref.name} (${ref.via}); --force removes the vault anyway.`;
  }
  for (const ref of preview.possibleReferences) {
    logger
      .warn`${ref.kind} ${ref.name} computes a vault name at run time and may use this vault.`;
  }
}
