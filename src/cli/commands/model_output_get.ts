import { Command } from "@cliffy/command";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import {
  createModelOutputId,
  type ModelOutputId,
} from "../../domain/models/model_output.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";
import {
  findInputByIdGlobal,
  isUuid,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

/**
 * Finds an output by ID across all types and methods.
 */
async function findOutputByIdGlobal(
  outputRepo: YamlOutputRepository,
  id: ModelOutputId,
): Promise<
  | {
    output: NonNullable<Awaited<ReturnType<YamlOutputRepository["findById"]>>>;
    type: ModelType;
    method: string;
  }
  | null
> {
  const allOutputs = await outputRepo.findAllGlobal();
  for (const result of allOutputs) {
    if (result.output.id === id) {
      return result;
    }
  }
  return null;
}

export const modelOutputGetCommand = new Command()
  .name("get")
  .description("Show details of a model output")
  .arguments("<output_id_or_model_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const ctx = createContext(options as GlobalOptions, "model-output-get");
    ctx.logger.debug`Getting output: ${outputIdOrModelName}`;

    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);
    const outputRepo = new YamlOutputRepository(repoDir);

    let outputData: ModelOutputGetData;

    if (isUuid(outputIdOrModelName)) {
      // Try to find by output ID first
      ctx.logger.debug`Looking up output by ID: ${outputIdOrModelName}`;
      const outputId = createModelOutputId(outputIdOrModelName);
      const result = await findOutputByIdGlobal(outputRepo, outputId);

      if (result) {
        const { output, type } = result;

        // Try to get model name
        let modelName: string | undefined;
        for (const modelType of modelRegistry.types()) {
          const outputs = await outputRepo.findByModelInput(
            modelType,
            output.modelInputId,
          );
          if (outputs.length > 0) {
            const input = await inputRepo.findById(
              modelType,
              output.modelInputId,
            );
            if (input) {
              modelName = input.name;
              break;
            }
          }
        }

        outputData = {
          id: output.id,
          modelInputId: output.modelInputId,
          modelName,
          type: type.normalized,
          methodName: output.methodName,
          status: output.status,
          startedAt: output.startedAt.toISOString(),
          completedAt: output.completedAt?.toISOString(),
          durationMs: output.durationMs,
          retryCount: output.retryCount,
          provenance: output.provenance,
          artifacts: output.artifacts,
          error: output.error,
        };
      } else {
        // Maybe it's a model input ID - get the latest output for that model
        ctx.logger.debug`Output not found, trying as model input ID`;
        const inputResult = await findInputByIdGlobal(
          inputRepo,
          outputIdOrModelName,
        );
        if (!inputResult) {
          throw new UserError(
            `Output or model not found: ${outputIdOrModelName}`,
          );
        }

        const latestOutput = await outputRepo.findLatestByModelInput(
          inputResult.type,
          inputResult.input.id,
        );
        if (!latestOutput) {
          throw new UserError(
            `No outputs found for model: ${inputResult.input.name}`,
          );
        }

        outputData = {
          id: latestOutput.id,
          modelInputId: latestOutput.modelInputId,
          modelName: inputResult.input.name,
          type: inputResult.type.normalized,
          methodName: latestOutput.methodName,
          status: latestOutput.status,
          startedAt: latestOutput.startedAt.toISOString(),
          completedAt: latestOutput.completedAt?.toISOString(),
          durationMs: latestOutput.durationMs,
          retryCount: latestOutput.retryCount,
          provenance: latestOutput.provenance,
          artifacts: latestOutput.artifacts,
          error: latestOutput.error,
        };
      }
    } else {
      // Look up by model name and get latest output
      ctx.logger.debug`Looking up by model name: ${outputIdOrModelName}`;
      const inputResult = await inputRepo.findByNameGlobal(outputIdOrModelName);
      if (!inputResult) {
        throw new UserError(`Model not found: ${outputIdOrModelName}`);
      }

      const latestOutput = await outputRepo.findLatestByModelInput(
        inputResult.type,
        inputResult.input.id,
      );
      if (!latestOutput) {
        throw new UserError(
          `No outputs found for model: ${inputResult.input.name}`,
        );
      }

      outputData = {
        id: latestOutput.id,
        modelInputId: latestOutput.modelInputId,
        modelName: inputResult.input.name,
        type: inputResult.type.normalized,
        methodName: latestOutput.methodName,
        status: latestOutput.status,
        startedAt: latestOutput.startedAt.toISOString(),
        completedAt: latestOutput.completedAt?.toISOString(),
        durationMs: latestOutput.durationMs,
        retryCount: latestOutput.retryCount,
        provenance: latestOutput.provenance,
        artifacts: latestOutput.artifacts,
        error: latestOutput.error,
      };
    }

    renderModelOutputGet(outputData, ctx.outputMode);
    ctx.logger.debug("Model output get command completed");
  });
