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
  type CommandSyntax,
  recordDefiningModule,
  typeNameType,
  withPreferredExample,
} from "./command_syntax.ts";
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
 * The legacy spelling: `swamp model type describe`. Its help examples once
 * read `swamp type describe`, a spelling that never ran; they now name the
 * command a user actually types (swamp-club#3409).
 */
export const MODEL_TYPE_DESCRIBE_SYNTAX: CommandSyntax = {
  invocation: "swamp model type describe",
  surface: "model",
  preferred: "swamp behavior type describe aws-ec2",
};

/** The preferred spelling: `swamp behavior type describe`. */
export const BEHAVIOR_TYPE_DESCRIBE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior type describe",
  surface: "behavior",
};

export function createTypeDescribeCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .description(`Describe a ${syntax.surface} type with schema details`)
      .example(
        `Describe a ${syntax.surface} type`,
        `${syntax.invocation} aws-ec2`,
      )
      .example(
        "Compact digest for agents",
        `${syntax.invocation} aws-ec2 --compact --json`,
      )
      .alias("get")
      .option(
        "--compact",
        "Output a compact digest (method names, descriptions, argument types, output spec names)",
      )
      .arguments(`<type:${typeNameType(syntax.surface)}>`),
    syntax,
  )).action(
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
  return recordDefiningModule(command, import.meta.url);
}

export const typeDescribeCommand = createTypeDescribeCommand(
  MODEL_TYPE_DESCRIBE_SYNTAX,
);
