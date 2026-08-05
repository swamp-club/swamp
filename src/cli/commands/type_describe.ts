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
  type TypeDescribeData,
} from "../../libswamp/mod.ts";
import { createTypeDescribeRenderer } from "../../presentation/renderers/type_describe.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  requestServerResponse,
  resolveServerToken,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelTypeDescribeResponse } from "../../serve/protocol.ts";

// Re-export from libswamp for backward compatibility with existing importers
export {
  buildDataOutputSpecs,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../../libswamp/mod.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const typeDescribeCommand = withRemoteOptions(
  new Command()
    .description("Describe a model type with schema details")
    .example("Describe a model type", "swamp type describe aws-ec2")
    .example(
      "Compact digest for agents",
      "swamp type describe aws-ec2 --compact --json",
    )
    .alias("get")
    .option(
      "--compact",
      "Output a compact digest (method names, descriptions, argument types, output spec names)",
    )
    .arguments("<type:model_type>"),
).action(
  // @ts-expect-error - Cliffy custom type returns unknown instead of string
  async function (options: AnyOptions, typeArg: string) {
    const cliCtx = createContext(options as GlobalOptions, [
      "type",
      "describe",
    ]);
    cliCtx.logger.debug`Describing type: ${typeArg}`;

    const server = resolveServeUrl(options.server as string | undefined);
    if (server) {
      const token = await resolveServerToken(
        server,
        options.token as string | undefined,
      );
      const response = await requestServerResponse<ModelTypeDescribeResponse>(
        { server, token },
        { type: "model.type.describe", payload: { typeArg } },
      );
      const compact = options.compact as boolean | undefined;
      const renderer = createTypeDescribeRenderer(
        cliCtx.outputMode,
        compact ?? false,
      );
      renderer.handlers().completed({
        kind: "completed",
        data: response.data as unknown as TypeDescribeData,
      });
      return;
    }

    const modelType = ModelType.create(typeArg);

    await modelRegistry.ensureLoaded();

    const ctx = createLibSwampContext({ logger: cliCtx.logger });
    const deps = createTypeDescribeDeps();

    const compact = !!(options as Record<string, unknown>).compact;
    const renderer = createTypeDescribeRenderer(cliCtx.outputMode, compact);
    await consumeStream(
      typeDescribe(ctx, deps, modelType),
      renderer.handlers(),
    );

    cliCtx.logger.debug("Type describe command completed");
  },
);
