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

import { Command } from "@cliffy/command";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  acquireModelLocks,
  requireInitializedRepo,
  requireInitializedRepoUnlocked,
} from "../repo_context.ts";
import {
  consumeStream,
  createLibSwampContext,
  createModelEvaluateDeps,
  modelEvaluate,
} from "../../libswamp/mod.ts";
import { createModelEvaluateRenderer } from "../../presentation/renderers/model_evaluate.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelEvaluateCommand = new Command()
  .name("evaluate")
  .description("Evaluate expressions in model definitions")
  .example("Evaluate a model", "swamp model evaluate my-server")
  .example("Evaluate all models", "swamp model evaluate --all")
  .arguments("[model_id_or_name:string]")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option("--all", "Evaluate all model definitions")
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "evaluate",
      ]);

      // If --all flag or no argument, evaluate all definitions (global lock)
      if (options.all || !modelIdOrName) {
        const { repoDir, datastoreResolver } = await requireInitializedRepo({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

        const ctx = createLibSwampContext({ logger: cliCtx.logger });
        const deps = createModelEvaluateDeps(repoDir, datastoreResolver);
        const renderer = createModelEvaluateRenderer(cliCtx.outputMode);

        await consumeStream(
          modelEvaluate(ctx, deps, {}),
          renderer.handlers(),
        );
        return;
      }

      // Single model evaluation — use per-model lock
      const { repoDir, repoContext, datastoreConfig, datastoreResolver } =
        await requireInitializedRepoUnlocked({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

      // Pre-lookup for lock target
      const lookupResult = await findDefinitionByIdOrName(
        repoContext.definitionRepo,
        modelIdOrName,
      );
      if (!lookupResult) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }

      const { definition, type } = lookupResult;

      // Acquire per-model lock (for S3, also pulls model-scoped files)
      const lockResult = await acquireModelLocks(datastoreConfig, [
        { modelType: type.normalized, modelId: definition.id },
      ], repoDir);
      if (lockResult.synced) repoContext.catalogStore.invalidate();
      const flushModelLocks = lockResult.flush;

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createModelEvaluateDeps(repoDir, datastoreResolver);
      const renderer = createModelEvaluateRenderer(cliCtx.outputMode);

      try {
        await consumeStream(
          modelEvaluate(ctx, deps, { modelIdOrName }),
          renderer.handlers(),
        );
      } finally {
        await flushModelLocks();
      }
    },
  );
