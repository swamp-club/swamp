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
import { requireInitializedRepo } from "../repo_context.ts";

export const dataRenameCommand = new Command()
  .name("rename")
  .description("Rename a data instance with backwards-compatible forwarding")
  .example(
    "Rename with forwarding",
    "swamp data rename my-server old-name new-name",
  )
  .arguments("<model_id_or_name:string> <old_name:string> <new_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(
    async function (
      options: { repoDir?: string; json?: boolean },
      modelIdOrName: string,
      oldName: string,
      newName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "rename",
      ]);

      const { repoDir, datastoreResolver } = await requireInitializedRepo({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createDataRenameDeps(repoDir, datastoreResolver);
      const renderer = createDataRenameRenderer(cliCtx.outputMode);
      await consumeStream(
        dataRename(ctx, deps, { modelIdOrName, oldName, newName }),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Data rename command completed");
    },
  );
