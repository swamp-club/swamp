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
  subcommandSyntax,
  typeNameType,
  withPreferredExample,
} from "./command_syntax.ts";
import { createModelLeaseCommand, MODEL_LEASE_SYNTAX } from "./model_lease.ts";
import { groupCommandAction } from "../group_action.ts";
import { consumeStream } from "../../libswamp/stream.ts";
import { createLibSwampContext } from "../../libswamp/context.ts";
import {
  createModelCreateDeps,
  modelCreate,
  type ModelCreateData,
} from "../../libswamp/models/create.ts";
import { createModelCreateRenderer } from "../../presentation/renderers/model_create.ts";
import {
  createContext,
  type GlobalOptions,
  resolveRepoDir,
} from "../context.ts";
import { requireInitializedRepoUnlocked } from "../repo_context.ts";
import { runManagedConfigMutation } from "../managed_config_sync.ts";
import {
  RepoMarkerRepository,
} from "../../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../../domain/repo/repo_path.ts";
import { join } from "@std/path";
import { parseKeyValueInputs } from "../input_parser.ts";
import {
  createModelValidateCommand,
  modelValidateCommand,
} from "./model_validate.ts";
import {
  createModelMethodCommand,
  modelMethodCommand,
} from "./model_method_run.ts";
import {
  createModelSearchCommand,
  modelSearchCommand,
} from "./model_search.ts";
import { createModelGetCommand, modelGetCommand } from "./model_get.ts";
import {
  createModelDeleteCommand,
  modelDeleteCommand,
} from "./model_delete.ts";
import { createModelEditCommand, modelEditCommand } from "./model_edit.ts";
import {
  createModelEvaluateCommand,
  modelEvaluateCommand,
} from "./model_evaluate.ts";
import {
  createModelOutputCommand,
  modelOutputCommand,
} from "./model_output.ts";
import { createModelTypeCommand, modelTypeCommand } from "./model_type.ts";
import {
  createModelCancelCommand,
  modelCancelCommand,
} from "./model_cancel.ts";
import { unknownCommandErrorHandler } from "../unknown_command_handler.ts";
import {
  requestServerResponse,
  resolveServerTokenFromOptions,
  resolveServeUrl,
  withRemoteOptions,
} from "../remote_run.ts";
import type { ModelCreateResponse } from "../../serve/protocol.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/** The preferred spelling: `swamp behavior create`. */
export const BEHAVIOR_CREATE_SYNTAX: CommandSyntax = {
  invocation: "swamp behavior create",
  surface: "behavior",
};

/** The legacy spelling: `swamp model create`. */
export const MODEL_CREATE_SYNTAX: CommandSyntax = {
  invocation: "swamp model create",
  surface: "model",
  preferred: `${BEHAVIOR_CREATE_SYNTAX.invocation} aws-ec2 my-server`,
};

export function createModelCreateCommand(syntax: CommandSyntax) {
  const command = withRemoteOptions(withPreferredExample(
    new Command()
      .description(`Create a new ${syntax.surface} definition`)
      .example(
        `Create a ${syntax.surface}`,
        `${syntax.invocation} aws-ec2 my-server`,
      )
      .example(
        "With global args",
        `${syntax.invocation} aws-ec2 my-server --global-arg region=us-east-1`,
      )
      .arguments(`<type:${typeNameType(syntax.surface)}> <name:string>`)
      .option(
        "--repo-dir <dir:string>",
        "Repository directory (env: SWAMP_REPO_DIR)",
      )
      .option(
        "--global-arg <arg:string>",
        "Set global argument (key=value, repeatable)",
        { collect: true },
      ),
    syntax,
  )).action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (options: AnyOptions, typeArg: string, name: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "create",
      ]);

      // Parse --global-arg options (needed for both local and remote paths)
      const globalArgEntries: string[] = options.globalArg ?? [];
      const globalArguments = globalArgEntries.length > 0
        ? await parseKeyValueInputs(globalArgEntries)
        : undefined;

      const server = resolveServeUrl(options.server as string | undefined);
      if (server) {
        const token = await resolveServerTokenFromOptions(
          server,
          options,
        );
        const response = await requestServerResponse<ModelCreateResponse>(
          { server, token },
          {
            type: "model.create",
            payload: { typeArg, name, globalArguments },
          },
        );
        const renderer = createModelCreateRenderer(cliCtx.outputMode);
        await consumeStream(
          (async function* () {
            yield {
              kind: "completed" as const,
              data: response.data as unknown as ModelCreateData,
            };
          })(),
          renderer.handlers(),
        );
        return;
      }

      cliCtx.logger
        .debug`Creating model definition: type=${typeArg}, name=${name}`;

      const resolvedRepoDir = resolveRepoDir(options.repoDir);
      const {
        repoDir,
        datastoreConfig,
        datastoreResolver: resolver,
        syncService,
        repoContext,
      } = await requireInitializedRepoUnlocked({
        repoDir: resolvedRepoDir,
        outputMode: cliCtx.outputMode,
      });

      const markerRepo = new RepoMarkerRepository();
      const marker = await markerRepo.read(RepoPath.create(repoDir));
      const managedConfig = marker?.datastore?.managedConfig === true;
      const definitionsDir = managedConfig
        ? join(resolver.resolvePath("config"), "models")
        : undefined;

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = await createModelCreateDeps(repoDir, definitionsDir);
      const renderer = createModelCreateRenderer(cliCtx.outputMode);
      await runManagedConfigMutation(
        repoContext,
        syncService,
        datastoreConfig,
        marker,
        "model create",
        () =>
          consumeStream(
            modelCreate(ctx, deps, { typeArg, name, globalArguments }),
            renderer.handlers(),
          ),
      );

      cliCtx.logger.debug("Model create command completed");
    },
  );
  return recordDefiningModule(command, import.meta.url);
}

export const modelCreateCommand = createModelCreateCommand(MODEL_CREATE_SYNTAX);

/** The subcommands of `model`, in registration order. */
export interface ModelChildren {
  readonly cancel: ReturnType<typeof createModelCancelCommand>;
  readonly create: ReturnType<typeof createModelCreateCommand>;
  readonly delete: ReturnType<typeof createModelDeleteCommand>;
  readonly edit: ReturnType<typeof createModelEditCommand>;
  readonly evaluate: ReturnType<typeof createModelEvaluateCommand>;
  readonly get: ReturnType<typeof createModelGetCommand>;
  readonly lease: ReturnType<typeof createModelLeaseCommand>;
  readonly search: ReturnType<typeof createModelSearchCommand>;
  readonly validate: ReturnType<typeof createModelValidateCommand>;
  readonly method: ReturnType<typeof createModelMethodCommand>;
  readonly output: ReturnType<typeof createModelOutputCommand>;
  readonly type: ReturnType<typeof createModelTypeCommand>;
}

/** The legacy spelling: `swamp model`. */
export const MODEL_SYNTAX: CommandSyntax = {
  invocation: "swamp model",
  surface: "model",
};

/**
 * Builds the `model` group for one CLI surface (swamp-club#3330). Children
 * not passed are built fresh from `syntax`; Cliffy reparents a command
 * attached under a second parent, so two surfaces must never share an
 * instance.
 */
export function createModelCommand(
  syntax: CommandSyntax,
  children: Partial<ModelChildren> = {},
) {
  const sub = (word: string) => subcommandSyntax(syntax, word);
  const command = new Command()
    .name("model")
    .description(
      syntax.surface === "model"
        ? "Manage models (legacy spelling of 'behavior'; kept, no removal planned)"
        : `Manage ${syntax.surface}s`,
    )
    .error(unknownCommandErrorHandler)
    .action(groupCommandAction)
    .command(
      "cancel",
      children.cancel ?? createModelCancelCommand(sub("cancel")),
    )
    .command(
      "create",
      children.create ?? createModelCreateCommand(sub("create")),
    )
    .command(
      "delete",
      children.delete ?? createModelDeleteCommand(sub("delete")),
    )
    .command("edit", children.edit ?? createModelEditCommand(sub("edit")))
    .command(
      "evaluate",
      children.evaluate ?? createModelEvaluateCommand(sub("evaluate")),
    )
    .command("get", children.get ?? createModelGetCommand(sub("get")))
    .command("lease", children.lease ?? createModelLeaseCommand(sub("lease")))
    .command(
      "search",
      children.search ?? createModelSearchCommand(sub("search")),
    )
    .command(
      "validate",
      children.validate ?? createModelValidateCommand(sub("validate")),
    )
    .command(
      "method",
      children.method ?? createModelMethodCommand(sub("method")),
    )
    .command(
      "output",
      children.output ?? createModelOutputCommand(sub("output")),
    )
    .command("type", children.type ?? createModelTypeCommand(sub("type")));
  return recordDefiningModule(command, import.meta.url);
}

export const modelCommand = createModelCommand(MODEL_SYNTAX, {
  cancel: modelCancelCommand,
  create: modelCreateCommand,
  delete: modelDeleteCommand,
  edit: modelEditCommand,
  evaluate: modelEvaluateCommand,
  get: modelGetCommand,
  lease: createModelLeaseCommand(MODEL_LEASE_SYNTAX),
  search: modelSearchCommand,
  validate: modelValidateCommand,
  method: modelMethodCommand,
  output: modelOutputCommand,
  type: modelTypeCommand,
});
