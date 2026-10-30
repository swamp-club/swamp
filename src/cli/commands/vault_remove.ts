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
import { assertConfigEditCurrent } from "../../infrastructure/persistence/repo_unit_of_work.ts";
import { runAsUserConfigEdit } from "../../infrastructure/datastore_v3/config_edit_scope.ts";
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
  renderVaultRemoveWarnings,
} from "../../presentation/renderers/vault_remove.ts";
import {
  isSwampError,
  userErrorFromSwampError,
} from "../../libswamp/errors.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  libSwampContextForRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import {
  ManagedConfigUnpublishedError,
  publishManagedConfigChanges,
} from "../managed_config_sync.ts";
import { runCommandInRootUnit } from "../command_root_unit.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { RepoMarkerRepository } from "../../infrastructure/persistence/repo_marker_repository.ts";
import { UserError } from "../../domain/errors.ts";
import { promptConfirmation } from "../prompt_helpers.ts";

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

The repository's default vault (defaultVault in .swamp.yaml, or the first vault
when none is set) is never removed. Secrets stored outside this repository are
kept.
A vault that behaviors, workflows or the datastore config reference is refused
unless --force is given. Unlike 'vault delete', --force here does not skip the
confirmation; use --yes for that.

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
    "Remove the vault even while behaviors, workflows or the datastore config reference it (not an alias for --yes)",
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
      if (isSwampError(error)) throw userErrorFromSwampError(error);
      throw error;
    }

    // Before anything is removed (swamp-club#4097).
    await assertConfigEditCurrent(repoContext, "vault", preview.vaultName);

    if (cliCtx.outputMode === "log" && !options.yes) {
      renderVaultRemoveWarnings(preview, cliCtx.outputMode);
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
    try {
      await runAsUserConfigEdit(
        () =>
          runCommandInRootUnit(
            repoContext,
            {
              push: publishes
                ? () =>
                  publishManagedConfigChanges(syncService, datastoreConfig)
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
                  throw userErrorFromSwampError(e.error);
                },
              }),
          ),
        `the vault definition "${vaultName}"`,
        "deleted",
      );
    } catch (error) {
      // The removal is saved locally but unpublished, so its secrets were
      // kept; say where, since a re-run no longer finds the vault.
      const storage = preview.localStorage;
      if (
        error instanceof ManagedConfigUnpublishedError && storage?.removable
      ) {
        throw new ManagedConfigUnpublishedError(
          error.cause,
          `Run 'swamp datastore sync --push' to publish it, then delete ` +
            `${storage.directory}, which still holds the vault's secrets.`,
        );
      }
      throw error;
    }
    const removed = outcome.removed;
    if (!removed) return;

    // Only now that the removal is committed and published: a removal that
    // did not land must never cost the vault its secrets.
    let secrets;
    try {
      secrets = await vaultRemoveStoredSecrets(ctx, deps, preview);
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
      data: { ...removed, secrets },
    });
    cliCtx.logger.debug("Vault remove command completed");
  });
