import { Command } from "@cliffy/command";
import {
  type ModelEvaluateData,
  type ModelEvaluateItemData,
  renderModelEvaluate,
  renderModelEvaluateSingle,
} from "../../presentation/output/model_evaluate_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { YamlEvaluatedInputRepository } from "../../infrastructure/persistence/yaml_evaluated_input_repository.ts";
import { ExpressionEvaluationService } from "../../domain/expressions/expression_evaluation_service.ts";
import { findByIdOrName } from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelEvaluateCommand = new Command()
  .name("evaluate")
  .description("Evaluate expressions in model inputs")
  .arguments("[model_id_or_name:string]")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .option("--all", "Evaluate all model inputs")
  .action(
    async function (options: AnyOptions, modelIdOrName?: string) {
      const ctx = createContext(options as GlobalOptions, "model-evaluate");
      const repoDir = options.repoDir ?? ".";
      const inputRepo = new YamlInputRepository(repoDir);
      const resourceRepo = new YamlResourceRepository(repoDir);
      const evaluatedRepo = new YamlEvaluatedInputRepository(repoDir);
      const evaluationService = new ExpressionEvaluationService(
        inputRepo,
        resourceRepo,
        repoDir,
      );

      // If --all flag or no argument, evaluate all inputs
      if (options.all || !modelIdOrName) {
        ctx.logger.debug`Evaluating all model inputs`;

        const results = await evaluationService.evaluateAllInputs();
        const items: ModelEvaluateItemData[] = [];

        for (const result of results) {
          // Save evaluated input
          await evaluatedRepo.save(result.type, result.input);
          const outputPath = evaluatedRepo.getPath(
            result.type,
            result.input.id,
          );

          items.push({
            id: result.input.id,
            name: result.input.name,
            type: result.type.normalized,
            hadExpressions: result.hadExpressions,
            outputPath: result.hadExpressions ? outputPath : undefined,
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

      // Look up the model input
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const lookupResult = await findByIdOrName(inputRepo, modelIdOrName);
      if (!lookupResult) {
        throw new Error(`Model not found: ${modelIdOrName}`);
      }

      const { input, type } = lookupResult;
      ctx.logger.debug`Found model: id=${input.id}, type=${type.normalized}`;

      // Evaluate the input
      const result = await evaluationService.evaluateInput(input, type);

      // Save evaluated input
      await evaluatedRepo.save(type, result.input);
      const outputPath = evaluatedRepo.getPath(type, result.input.id);

      const item: ModelEvaluateItemData = {
        id: result.input.id,
        name: result.input.name,
        type: type.normalized,
        hadExpressions: result.hadExpressions,
        outputPath: result.hadExpressions ? outputPath : undefined,
      };

      renderModelEvaluateSingle(item, ctx.outputMode);
      ctx.logger.debug`Evaluation completed`;
    },
  );
