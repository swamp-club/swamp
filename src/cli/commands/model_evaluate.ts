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
  type ModelEvaluateData,
  type ModelEvaluateItemData,
  renderModelEvaluate,
  renderModelEvaluateSingle,
} from "../../presentation/output/model_evaluate_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { UserError } from "../../domain/errors.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelEvaluateCommand = new Command()
  .name("evaluate")
  .description("Evaluate expressions in model definitions")
  .arguments("[model_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--all", "Evaluate all model definitions")
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const ctx = createContext(options as GlobalOptions, [
        "model",
        "evaluate",
      ]);
      const { repoDir, repoContext } = await requireInitializedRepo({
        repoDir: options.repoDir ?? ".",
        outputMode: ctx.outputMode,
      });
      const definitionRepo = repoContext.definitionRepo;
      const dataRepo = repoContext.unifiedDataRepo;
      const evaluationService = new ExpressionEvaluationService(
        definitionRepo,
        repoDir,
        { dataRepo },
      );

      // If --all flag or no argument, evaluate all definitions
      if (options.all || !modelIdOrName) {
        ctx.logger.debug`Evaluating all model definitions`;

        const results = await evaluationService.evaluateAllDefinitions();
        const items: ModelEvaluateItemData[] = [];

        for (const result of results) {
          items.push({
            id: result.definition.id,
            name: result.definition.name,
            type: result.type.normalized,
            hadExpressions: result.hadExpressions,
            outputPath: undefined, // Definitions don't use evaluated repo
          });
        }

        const data: ModelEvaluateData = {
          items,
          total: results.length,
          evaluated: results.filter((r) => r.hadExpressions).length,
        };

        renderModelEvaluate(data, ctx.outputMode);
        ctx.logger.debug`Evaluation completed`;
        return;
      }

      // Single model evaluation
      ctx.logger.debug`Evaluating model: ${modelIdOrName}`;

      // Look up the model definition
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const lookupResult = await findDefinitionByIdOrName(
        definitionRepo,
        modelIdOrName,
      );
      if (!lookupResult) {
        throw new UserError(`Model not found: ${modelIdOrName}`);
      }

      const { definition, type } = lookupResult;
      ctx.logger
        .debug`Found model: id=${definition.id}, type=${type.normalized}`;

      // Evaluate the definition
      const result = await evaluationService.evaluateDefinition(
        definition,
        type,
      );

      const item: ModelEvaluateItemData = {
        id: result.definition.id,
        name: result.definition.name,
        type: type.normalized,
        hadExpressions: result.hadExpressions,
        outputPath: undefined, // Definitions don't use evaluated repo
        // Include evaluated globalArguments for JSON output
        globalArguments: result.definition.globalArguments,
      };

      renderModelEvaluateSingle(item, ctx.outputMode);
      ctx.logger.debug`Evaluation completed`;
    },
  );
