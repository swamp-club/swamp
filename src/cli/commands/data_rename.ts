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
import {
  consumeStream,
  createDataRenameDeps,
  createLibSwampContext,
  dataRename,
} from "../../libswamp/mod.ts";
import { createDataRenameRenderer } from "../../presentation/renderers/data_rename.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

export const dataRenameCommand = new Command()
  .name("rename")
  .description("Rename a data instance with backwards-compatible forwarding")
  .example(
    "Rename with forwarding",
    "swamp data rename my-server old-name new-name",
  )
  .example(
    "Rename using flags",
    "swamp data rename --model my-server --name old-name --new-name new-name",
  )
  .arguments("[model_id_or_name:string] [old_name:string] [new_name:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "--model <model:string>",
    "Model name or ID (alternative to positional argument)",
  )
  .option(
    "--name <name:string>",
    "Current data name (alternative to positional argument)",
  )
  .option(
    "--new-name <newName:string>",
    "New data name (alternative to positional argument)",
  )
  .action(
    async function (
      options: {
        repoDir?: string;
        json?: boolean;
        model?: string;
        name?: string;
        newName?: string;
      },
      positionalModel?: string,
      positionalOldName?: string,
      positionalNewName?: string,
    ) {
      const modelIdOrName = options.model ?? positionalModel;
      const oldName = options.name ?? positionalOldName;
      const newName = options.newName ?? positionalNewName;

      if (!modelIdOrName || !oldName || !newName) {
        throw new UserError(
          "Model, current name, and new name are all required. Use positional arguments (swamp data rename <model> <old-name> <new-name>) or flags (--model <model> --name <name> --new-name <new-name>).",
        );
      }
      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "rename",
      ]);

      const {
        repoDir,
        repoContext,
        datastoreResolver,
        datastoreConfig,
        syncService,
      } = await requireInitializedRepoUnlocked({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      const preResult = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        modelIdOrName,
      );
      if (!preResult) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }

      const lockResult = await acquireModelLocks(
        datastoreConfig,
        [
          {
            modelType: preResult.type.normalized,
            modelId: preResult.definition.id,
          },
        ],
        repoDir,
        syncService,
        repoContext.catalogStore,
      );
      if (lockResult.synced) repoContext.catalogStore.invalidate();

      try {
        const ctx = createLibSwampContext({ logger: cliCtx.logger });
        const deps = createDataRenameDeps(repoDir, datastoreResolver);
        const renderer = createDataRenameRenderer(cliCtx.outputMode);
        await consumeStream(
          dataRename(ctx, deps, { modelIdOrName, oldName, newName }),
          renderer.handlers(),
        );

        cliCtx.logger.debug("Data rename command completed");
      } finally {
        try {
          await lockResult.flush();
        } catch (releaseError) {
          cliCtx.logger.warn(
            "Failed to release locks during cleanup: {error}",
            {
              error: releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
            },
          );
        }
      }
    },
  );
