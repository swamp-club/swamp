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
import type { CommandSyntax } from "./command_syntax.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createTypeDescribeDeps,
  typeDescribe,
  type TypeDescribeData,
} from "../../libswamp/types/describe.ts";
import { createTypeDescribeRenderer } from "../../presentation/renderers/type_describe.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelTypeDescribeResponse } from "../../serve/protocol.ts";

// Re-export from libswamp for backward compatibility with existing importers
export {
  buildDataOutputSpecs,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../../libswamp/types/schema_helpers.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * The legacy text of the `swamp model type describe` help examples, which have
 * always read `swamp type describe`. Kept verbatim so the legacy surface does not
 * change; a factory built from another syntax renders that syntax instead.
 */
export const MODEL_TYPE_DESCRIBE_SYNTAX: CommandSyntax = {
  invocation: "swamp type describe",
};

export function createTypeDescribeCommand(syntax: CommandSyntax) {
  return withRemoteOptions(
    new Command()
      .description("Describe a model type with schema details")
      .example("Describe a model type", `${syntax.invocation} aws-ec2`)
      .example(
        "Compact digest for agents",
        `${syntax.invocation} aws-ec2 --compact --json`,
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
        const token = await resolveServerTokenFromOptions(
          server,
          options,
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
}

export const typeDescribeCommand = createTypeDescribeCommand(
  MODEL_TYPE_DESCRIBE_SYNTAX,
);
