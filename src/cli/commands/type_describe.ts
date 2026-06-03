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
  createLibSwampContext,
  createTypeDescribeDeps,
  typeDescribe,
} from "../../libswamp/mod.ts";
import { createTypeDescribeRenderer } from "../../presentation/renderers/type_describe.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";

// Re-export from libswamp for backward compatibility with existing importers
export { toMethodDescribeData, zodToJsonSchema } from "../../libswamp/mod.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const typeDescribeCommand = new Command()
  .description("Describe a model type with schema details")
  .example("Describe a model type", "swamp type describe aws-ec2")
  .alias("get")
  .arguments("<type:model_type>")
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  .action(async function (options: AnyOptions, typeArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "type",
      "describe",
    ]);
    cliCtx.logger.debug`Describing type: ${typeArg}`;

    const modelType = ModelType.create(typeArg);

    await modelRegistry.ensureLoaded();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTypeDescribeDeps();

    const renderer = createTypeDescribeRenderer(cliCtx.outputMode);
    await consumeStream(
      typeDescribe(ctx, deps, modelType),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Type describe command completed");
  });
