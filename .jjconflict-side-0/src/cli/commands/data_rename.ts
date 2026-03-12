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
  type DataRenameData,
  renderDataRename,
} from "../../presentation/output/data_rename_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { DataRenameService } from "../../domain/data/data_rename_service.ts";
import { UserError } from "../../domain/errors.ts";

export const dataRenameCommand = new Command()
  .name("rename")
  .description("Rename a data instance with backwards-compatible forwarding")
  .arguments("<model_id_or_name:string> <old_name:string> <new_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    async function (
      options: { repoDir: string; json?: boolean },
      modelIdOrName: string,
      oldName: string,
      newName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, ["data", "rename"]);

      if (oldName === newName) {
        throw new UserError("Old name and new name must be different.");
      }

      const { repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });

      const service = new DataRenameService(
        repoContext.unifiedDataRepo,
        repoContext.definitionRepo,
      );

      try {
        const result = await service.rename(modelIdOrName, oldName, newName);

        const output: DataRenameData = {
          oldName: result.oldName,
          newName: result.newName,
          modelId: result.modelId,
          modelName: result.modelName,
          modelType: result.modelType,
          copiedVersion: result.copiedVersion,
          newVersion: result.newVersion,
          warning:
            `Any workflows or models that produce data under "${result.oldName}" ` +
            `will overwrite the forward reference. Update them to use "${result.newName}" instead.`,
        };

        renderDataRename(output, ctx.outputMode);
      } catch (error) {
        if (error instanceof Error) {
          throw new UserError(error.message);
        }
        throw error;
      }

      ctx.logger.debug("Data rename command completed");
    },
  );
