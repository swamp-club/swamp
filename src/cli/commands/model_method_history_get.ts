import { Command } from "@cliffy/command";
import {
  type ModelOutputGetData,
  renderModelOutputGet,
} from "../../presentation/output/model_output_get_output.ts";
import { createContext, type GlobalOptions } from "../context.ts";
import { requireInitializedRepo } from "../repo_context.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { UserError } from "../../domain/errors.ts";
import {
  findDefinitionByIdOrName,
  isPartialId,
  matchByPartialId,
} from "../../domain/models/model_lookup.ts";

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodHistoryGetCommand = new Command()
  .name("get")
  .description("Show details of a model method run")
  .arguments("<output_id_or_model_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, outputIdOrModelName: string) {
    const ctx = createContext(options as GlobalOptions, [
      "model",
      "method",
      "history",
      "get",
    ]);
    ctx.logger.debug`Getting method run: ${outputIdOrModelName}`;

    const { repoContext } = await requireInitializedRepo({
      repoDir: options.repoDir ?? ".",
      outputMode: ctx.outputMode,
    });
    const definitionRepo = repoContext.definitionRepo;
    const outputRepo = repoContext.outputRepo;

    let outputData: ModelOutputGetData;

    if (isPartialId(outputIdOrModelName)) {
      // Try to find by output ID (partial or full)
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
          const outputs = await outputRepo.findByDefinition(
            modelType,
            output.definitionId,
          );
          if (outputs.length > 0) {
            const definition = await definitionRepo.findById(
              modelType,
              output.definitionId,
            );
            if (definition) {
              modelName = definition.name;
              break;
            }
          }
        }

        outputData = {
          id: output.id,
          definitionId: output.definitionId,
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
        // not_found - try as definition name
        ctx.logger.debug`Output not found, trying as model definition`;
        const definitionResult = await findDefinitionByIdOrName(
          definitionRepo,
          outputIdOrModelName,
        );
        if (!definitionResult) {
          throw new UserError(
            `Output or model not found: ${outputIdOrModelName}`,
          );
        }

        const latestOutput = await outputRepo.findLatestByDefinition(
          definitionResult.type,
          definitionResult.definition.id,
        );
        if (!latestOutput) {
          throw new UserError(
            `No runs found for model: ${definitionResult.definition.name}`,
          );
        }

        outputData = {
          id: latestOutput.id,
          definitionId: latestOutput.definitionId,
          modelName: definitionResult.definition.name,
          type: definitionResult.type.normalized,
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
      // Look up by model name or ID and get latest output
      ctx.logger.debug`Looking up model: ${outputIdOrModelName}`;
      const definitionResult = await findDefinitionByIdOrName(
        definitionRepo,
        outputIdOrModelName,
      );
      if (!definitionResult) {
        throw new UserError(`Model not found: ${outputIdOrModelName}`);
      }

      const latestOutput = await outputRepo.findLatestByDefinition(
        definitionResult.type,
        definitionResult.definition.id,
      );
      if (!latestOutput) {
        throw new UserError(
          `No runs found for model: ${definitionResult.definition.name}`,
        );
      }

      outputData = {
        id: latestOutput.id,
        definitionId: latestOutput.definitionId,
        modelName: definitionResult.definition.name,
        type: definitionResult.type.normalized,
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
    ctx.logger.debug("Model method history get command completed");
  });
