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
  consumeStream,
  createLibSwampContext,
  createModelDeleteDeps,
  modelDelete,
  modelDeletePreview,
} from "../../libswamp/mod.ts";
import {
  createModelDeleteRenderer,
  renderModelDeleteCancelled,
} from "../../presentation/renderers/model_delete.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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

export const modelDeleteCommand = new Command()
  .name("delete")
  .description("Delete a model and all related artifacts")
  .example("Delete a model", "swamp model delete my-server")
  .example("Force delete", "swamp model delete my-server --force")
  .arguments("<model_id_or_name:model_name>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .option(
    "-f, --force",
    "Skip confirmation and allow deletion when data artifacts exist",
  )
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, modelIdOrName: string) {
    const cliCtx = createContext(options as GlobalOptions, ["model", "delete"]);
    cliCtx.logger.debug`Deleting model: ${modelIdOrName}`;

    const { repoDir, datastoreResolver } = await requireInitializedRepo({
      repoDir: resolveRepoDir(options.repoDir),
      outputMode: cliCtx.outputMode,
    });

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createModelDeleteDeps(repoDir, datastoreResolver);
    const force = !!options.force;

    // Phase 1: Preview — gather what will be affected
    let preview;
    try {
      preview = await modelDeletePreview(ctx, deps, {
        modelIdOrName,
        force,
      });
    } catch (error) {
      if ("code" in (error as Record<string, unknown>)) {
        throw new UserError((error as { message: string }).message);
      }
      throw error;
    }

    // Block if referenced by workflows
    if (preview.referencingWorkflows.length > 0) {
      throw new UserError(
        `Model '${preview.name}' is referenced by workflow(s): ${
          preview.referencingWorkflows.join(", ")
        }. ` +
          `Remove the model from these workflows before deleting.`,
      );
    }

    // Block if data artifacts exist and no --force
    if (preview.dataArtifactCount > 0 && !force) {
      throw new UserError(
        `Model '${preview.name}' has ${preview.dataArtifactCount} associated data artifact(s). ` +
          `Delete the data first, or use --force to delete all.`,
      );
    }

    // Phase 2: Prompt (CLI concern)
    if (cliCtx.outputMode === "log" && !force) {
      let deleteDetails = "";
      if (preview.outputCount > 0) {
        deleteDetails += ` ${preview.outputCount} output(s),`;
      }
      if (preview.dataArtifactCount > 0) {
        deleteDetails += ` ${preview.dataArtifactCount} data artifact(s),`;
      }
      if (deleteDetails) {
        deleteDetails = ` This will also delete:${deleteDetails.slice(0, -1)}.`;
      }

      const confirmed = await promptConfirmation(
        `Delete model '${preview.name}' (${preview.id})?${deleteDetails}`,
      );
      if (!confirmed) {
        renderModelDeleteCancelled(cliCtx.outputMode);
        return;
      }
    }

    // Phase 3: Execute mutation
    const renderer = createModelDeleteRenderer(cliCtx.outputMode);
    await consumeStream(
      modelDelete(ctx, deps, { modelIdOrName, force }),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Model delete command completed");
  });
