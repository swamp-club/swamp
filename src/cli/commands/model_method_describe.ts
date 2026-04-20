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
  createModelMethodDescribeDeps,
  modelMethodDescribe,
} from "../../libswamp/mod.ts";
import { createModelMethodDescribeRenderer } from "../../presentation/renderers/model_method_describe.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoReadOnly } from "../repo_context.ts";
import { modelRegistry } from "../../domain/models/model.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodDescribeCommand = new Command()
  .name("describe")
  .description("Describe a method on a model with argument details")
  .example(
    "Describe a method",
    "swamp model method describe my-server getSystemInfo",
  )
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option(
    "--repo-dir <dir:string>",
    "Repository directory (env: SWAMP_REPO_DIR)",
  )
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "method",
        "describe",
      ]);

      const { repoDir } = await requireInitializedRepoReadOnly({
        repoDir: resolveRepoDir(options.repoDir),
        outputMode: cliCtx.outputMode,
      });

      await modelRegistry.ensureLoaded();

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = createModelMethodDescribeDeps(repoDir);

      const renderer = createModelMethodDescribeRenderer(cliCtx.outputMode);
      await consumeStream(
        modelMethodDescribe(ctx, deps, modelIdOrName, methodName),
        renderer.handlers(),
      );

      cliCtx.logger.debug("Method describe command completed");
    },
  );
