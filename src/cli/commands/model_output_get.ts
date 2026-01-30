import { Command } from "@cliffy/command";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";
import {
  findInputByIdGlobal,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

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

    if (isPartialId(outputIdOrModelName)) {
      // Try to find by output ID (partial or full) using partial ID matching
      ctx.logger.debug`Looking up output by partial ID: ${outputIdOrModelName}`;
      const allOutputs = await outputRepo.findAllGlobal();
      const matchResult = matchByPartialId(
        allOutputs.map((o) => ({ id: o.output.id, item: o })),
        outputIdOrModelName,
      );

      if (matchResult.status === "found") {
        const { output, type } = matchResult.match;

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
      } else if (matchResult.status === "ambiguous") {
        throw new UserError(
          `Ambiguous ID prefix "${outputIdOrModelName}" matches:\n` +
            matchResult.matches.map((m) => `  ${m.id}`).join("\n"),
        );
      } else {
        // not_found - try as model input ID
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
