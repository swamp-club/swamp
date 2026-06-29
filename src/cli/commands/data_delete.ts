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
  type BatchDeleteFilter,
  consumeStream,
  createDataDeleteDeps,
  createLibSwampContext,
  dataBatchDelete,
  dataBatchDeletePreview,
  dataDelete,
  dataDeletePreview,
} from "../../libswamp/mod.ts";
import {
  createDataBatchDeleteRenderer,
  createDataDeleteRenderer,
  renderDataDeleteCancelled,
} from "../../presentation/renderers/data_delete.ts";
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

async function promptConfirmation(message: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  await Deno.stdout.write(encoder.encode(`${message} [y/N] `));

  const buf = new Uint8Array(1024);
  const n = await Deno.stdin.read(buf);
  if (n === null) return false;

  const response = decoder.decode(buf.subarray(0, n)).trim().toLowerCase();
  return response === "y" || response === "yes";
}

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataDeleteCommand = new Command()
  .name("delete")
  .description(
    "Delete data artifacts: one by name, many by prefix, or all for a model",
  )
  .example(
    "Delete an artifact (prompts for confirmation)",
    "swamp data delete my-server hetzner-state",
  )
  .example(
    "Delete using flags",
    "swamp data delete --model my-server --name hetzner-state",
  )
  .example(
    "Delete a specific version",
    "swamp data delete my-server hetzner-state --version 2",
  )
  .example(
    "Delete all data matching a prefix",
    "swamp data delete my-server --prefix run-",
  )
  .example(
    "Preview what --prefix would delete",
    "swamp data delete my-server --prefix run- --dry-run",
  )
  .example(
    "Delete all data for a model",
    "swamp data delete my-server --all",
  )
  .example(
    "Skip the confirmation prompt",
    "swamp data delete my-server hetzner-state --force",
  )
  .arguments("[model_id_or_name:string] [data_name:string]")
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
    "Data name (alternative to positional argument)",
  )
  .option("--version <n:integer>", "Delete a specific version")
  .option(
    "--prefix <prefix:string>",
    "Delete all data names starting with this prefix",
  )
  .option("--all", "Delete all data for the model")
  .option("--dry-run", "Show what would be deleted without deleting")
  .option("-f, --force", "Skip confirmation prompt")
  .action(
    async function (
      options: AnyOptions,
      positionalModel?: string,
      positionalName?: string,
    ) {
      const modelIdOrName = (options.model as string | undefined) ??
        positionalModel;
      const dataName = (options.name as string | undefined) ?? positionalName;
      const prefix = options.prefix as string | undefined;
      const all = options.all as boolean | undefined;
      const dryRun = options.dryRun as boolean | undefined;

      const isBatchMode = prefix !== undefined || all;

      if (isBatchMode) {
        if (!modelIdOrName) {
          throw new UserError(
            "Model is required for batch delete. Use positional argument (swamp data delete <model> --prefix <prefix>) or flag (--model <model>).",
          );
        }
        if (dataName) {
          throw new UserError(
            "Cannot combine data name with --prefix or --all. Use --prefix/--all for batch delete, or specify a data name for single delete.",
          );
        }
        if (options.version !== undefined) {
          throw new UserError(
            "Cannot combine --version with --prefix or --all. Version-specific delete only applies to single data names.",
          );
        }
        if (prefix !== undefined && prefix.length === 0) {
          throw new UserError(
            "--prefix value cannot be empty. Use --all to delete all data.",
          );
        }
        if (prefix !== undefined && all) {
          throw new UserError(
            "Cannot combine --prefix and --all. Use one or the other.",
          );
        }
      } else {
        if (!modelIdOrName || !dataName) {
          throw new UserError(
            "Both model and data name are required. Use positional arguments (swamp data delete <model> <name>) or flags (--model <model> --name <name>).",
          );
        }
        if (dryRun) {
          throw new UserError(
            "--dry-run is only supported with --prefix or --all.",
          );
        }
      }

      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "delete",
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
        modelIdOrName!,
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
        const deps = createDataDeleteDeps(repoDir, datastoreResolver);

        if (isBatchMode) {
          const filter: BatchDeleteFilter = all
            ? { kind: "all" }
            : { kind: "prefix", value: prefix! };

          // Phase 1: Preview + Prompt (unless --force or --dry-run).
          if (cliCtx.outputMode === "log" && !options.force && !dryRun) {
            let preview;
            try {
              preview = await dataBatchDeletePreview(ctx, deps, {
                modelIdOrName: modelIdOrName!,
                filter,
              });
            } catch (error) {
              throw new UserError(
                error instanceof Error ? error.message : String(error),
              );
            }

            const filterDesc = filter.kind === "prefix"
              ? `prefix "${filter.value}"`
              : "all data";
            const confirmed = await promptConfirmation(
              `About to delete ${preview.totalItems} data artifact(s) (${preview.totalVersions} version(s)) matching ${filterDesc} from ${preview.modelName}. Proceed?`,
            );
            if (!confirmed) {
              renderDataDeleteCancelled(cliCtx.outputMode);
              return;
            }
          }

          // Phase 2: Execute batch delete.
          const renderer = createDataBatchDeleteRenderer(cliCtx.outputMode);
          await consumeStream(
            dataBatchDelete(ctx, deps, {
              modelIdOrName: modelIdOrName!,
              filter,
              dryRun: dryRun ?? false,
            }),
            renderer.handlers(),
          );
        } else {
          const renderer = createDataDeleteRenderer(cliCtx.outputMode);

          // Phase 1: Preview + Prompt (only in interactive log mode without --force).
          if (cliCtx.outputMode === "log" && !options.force) {
            let preview;
            try {
              preview = await dataDeletePreview(ctx, deps, {
                modelIdOrName: modelIdOrName!,
                dataName: dataName!,
              });
            } catch (error) {
              throw new UserError(
                error instanceof Error ? error.message : String(error),
              );
            }

            const target = options.version !== undefined
              ? `version ${options.version} of "${dataName}"`
              : `${preview.versionsCount} version(s) of "${dataName}"`;
            const confirmed = await promptConfirmation(
              `About to delete ${target} from ${preview.modelName}. Proceed?`,
            );
            if (!confirmed) {
              renderDataDeleteCancelled(cliCtx.outputMode);
              return;
            }
          }

          // Phase 2: Execute single delete.
          await consumeStream(
            dataDelete(ctx, deps, {
              modelIdOrName: modelIdOrName!,
              dataName: dataName!,
              version: options.version,
            }),
            renderer.handlers(),
          );
        }

        cliCtx.logger.debug("Data delete command completed");
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
