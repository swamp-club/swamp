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
  withPreferredExample,
} from "./command_syntax.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";
import { runInCoordinatorRoot } from "../coordinator_root.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelValidateDeps,
  modelValidate,
  type ModelValidateAllData,
  type ModelValidateData,
} from "../../libswamp/models/validate.ts";
import { createModelValidateRenderer } from "../../presentation/renderers/model_validate.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelValidateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior validate`. */
export const BEHAVIOR_VALIDATE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior validate",
  surface: "behavior",
};

/** The legacy spelling: `swamp model validate`. */
export const MODEL_VALIDATE_SYNTAX: CommandSyntax = {
  invocation: "swamp model validate",
  surface: "model",
  preferred: `${BEHAVIOR_VALIDATE_SYNTAX.invocation} my-server`,
};

export function createModelValidateCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .name("validate")
      .description(
        `Validate a ${syntax.surface} definition against its schema`,
      )
      .example(`Validate a ${syntax.surface}`, `${syntax.invocation} my-server`)
      .example(`Validate all ${syntax.surface}s`, syntax.invocation)
      .example(
        "Filter by label",
        `${syntax.invocation} --label production`,
      )
      .arguments("[model_id_or_name:string]")
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .option(
        "--label <label:string>",
        "Only run checks with this label",
        { collect: true },
      )
      .option(
        "--method <method:string>",
        "Only run checks that apply to this method",
      ),
    syntax,
  )).action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "validate",
      ]);

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const labels = options.label as string[] | undefined;
        const method = options.method as string | undefined;
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const response = await requestServerResponse<ModelValidateResponse>(
          { server, token },
          {
            type: "model.validate",
            payload: { modelIdOrName, labels, method },
          },
        );
        const renderer = createModelValidateRenderer(
          cliCtx.outputMode,
          syntax.surface,
        );
        await consumeStream(
          (async function* () {
            yield {
              kind: "completed" as const,
              data: response
                .data as unknown as ModelValidateData | ModelValidateAllData,
            };
          })(),
          renderer.handlers(),
        );
        if (!renderer.passed()) {
          Deno.exitCode = 1;
        }
        return;
      }

      const labels = options.label as string[] | undefined;
      const method = options.method as string | undefined;
      const hasCheckOptions = (labels && labels.length > 0) || method;

      const { repoDir, repoContext, datastoreResolver } = hasCheckOptions
        ? await requireInitializedRepo({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        })
        : await requireInitializedRepoReadOnly({
          repoDir: resolveRepoDir(options.repoDir),
          outputMode: cliCtx.outputMode,
        });

      // Pushes and releases the global lock when the command ends, as the
      // teardown flush did (swamp-club#3055).
      await runInCoordinatorRoot(repoContext, async () => {
        await modelRegistry.ensureLoaded();
        const ctx = createLibSwampContext({ logger: cliCtx.logger });
        const deps = createModelValidateDeps(
          repoDir,
          { labels, method },
          datastoreResolver,
          undefined,
          undefined,
          undefined,
          repoContext.unifiedDataRepo.fetchForeignContent,
        );

        const renderer = createModelValidateRenderer(
          cliCtx.outputMode,
          syntax.surface,
        );
        await consumeStream(
          modelValidate(ctx, deps, { modelIdOrName }),
          renderer.handlers(),
        );

        if (!renderer.passed()) {
          Deno.exitCode = 1;
        }
      });
    },
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelValidateCommand = createModelValidateCommand(
  MODEL_VALIDATE_SYNTAX,
);
