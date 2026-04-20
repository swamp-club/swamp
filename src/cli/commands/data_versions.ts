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
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import {
  consumeStream,
  createDataVersionsDeps,
  createLibSwampContext,
  dataVersions,
} from "../../libswamp/mod.ts";
import { createDataVersionsRenderer } from "../../presentation/renderers/data_versions.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const dataVersionsCommand = new Command()
  .name("versions")
  .description("List all versions of specific data")
  .example("List all versions", "swamp data versions my-server system-info")
  .arguments("<model_id_or_name:model_name> <data_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      dataName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "data",
        "versions",
      ]);
      cliCtx.logger
        .debug`Listing versions: model=${modelIdOrName}, name=${dataName}`;

      const { repoDir, datastoreResolver } =
        await requireInitializedRepoReadOnly({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createDataVersionsDeps(repoDir, datastoreResolver);

      const renderer = createDataVersionsRenderer(cliCtx.outputMode);
      await consumeStream(
        dataVersions(ctx, deps, { modelIdOrName, dataName }),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Data versions command completed");
    },
  );
