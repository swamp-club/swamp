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
import { createContext, type GlobalOptions } from "../context.ts";
import {
  requireInitializedRepo,
  requireInitializedRepoReadOnly,
} from "../repo_context.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import { resolveModelType } from "../../domain/extensions/extension_auto_resolver.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { getAutoResolver } from "../auto_resolver_context.ts";
import {
  type CheckValidationContext,
  DefaultModelValidationService,
} from "../../domain/models/validation_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  consumeStream,
  createLibSwampContext,
  modelValidate,
} from "../../libswamp/mod.ts";
import { createModelValidateRenderer } from "../../presentation/renderers/model_validate.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelValidateCommand = new Command()
  .name("validate")
  .description("Validate a model definition against its schema")
  .arguments("[model_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option(
    "--label <label:string>",
    "Only run checks with this label",
    { collect: true },
  )
  .option(
    "--method <method:string>",
    "Only run checks that apply to this method",
  )
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const cliCtx = createContext(options as GlobalOptions, [
        "model",
        "validate",
      ]);

      const labels = options.label as string[] | undefined;
      const method = options.method as string | undefined;
      const hasCheckOptions = (labels && labels.length > 0) || method;

      const { repoDir, repoContext } = hasCheckOptions
        ? await requireInitializedRepo({
          repoDir: options.repoDir ?? ".",
          outputMode: cliCtx.outputMode,
        })
        : await requireInitializedRepoReadOnly({
          repoDir: options.repoDir ?? ".",
          outputMode: cliCtx.outputMode,
        });
      const definitionRepo = repoContext.definitionRepo;
      const validationService = new DefaultModelValidationService();

      const buildCheckContext = (): CheckValidationContext | undefined => {
        return {
          repoDir,
          dataRepository: repoContext.unifiedDataRepo,
          definitionRepository: definitionRepo,
          labels,
          method,
        };
      };

      const ctx = createLibSwampContext({ logger: cliCtx.logger });
      const deps = {
        lookupDefinition: (idOrName: string) =>
          findDefinitionByIdOrName(definitionRepo, idOrName),
        findAllDefinitions: () => definitionRepo.findAllGlobal(),
        resolveModelType: (type: ModelType) =>
          resolveModelType(type, getAutoResolver()),
        validateModel: (
          definition: Definition,
          modelDef: unknown,
          _type: ModelType,
        ) =>
          validationService.validateModel(
            definition,
            // deno-lint-ignore no-explicit-any
            modelDef as any,
            definitionRepo,
            buildCheckContext(),
          ),
      };

      const renderer = createModelValidateRenderer(cliCtx.outputMode);
      await consumeStream(
        modelValidate(ctx, deps, { modelIdOrName }),
        renderer.handlers(),
      );

      if (!renderer.passed()) {
        Deno.exit(1);
      }
    },
  );
