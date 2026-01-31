import { Command } from "@cliffy/command";
import {
  type ArtifactInfo,
  type ModelMethodRunData,
  renderModelMethodRun,
} from "../../presentation/output/model_method_run_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { findByIdOrName } from "../../domain/models/model_lookup.ts";
import {
  computeInputHash,
  ModelOutput,
} from "../../domain/models/model_output.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { YamlResourceRepository } from "../../infrastructure/persistence/yaml_resource_repository.ts";
import { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import { YamlDataRepository } from "../../infrastructure/persistence/yaml_data_repository.ts";
import { StreamingLogRepository } from "../../infrastructure/persistence/streaming_log_repository.ts";
import { FileSystemFileRepository } from "../../infrastructure/persistence/fs_file_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { DefaultMethodExecutionService } from "../../domain/models/method_execution_service.ts";

// Cliffy's custom type system returns `unknown` for custom types like `model_name`,
// but we need to pass `options` to functions expecting specific types. Using `any`
// here is the pragmatic workaround for Cliffy's type inference limitations.
// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelMethodRunCommand = new Command()
  .name("run")
  .description("Execute a method on a model")
  .arguments("<model_id_or_name:model_name> <method_name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(
    // @ts-expect-error - Cliffy custom type returns unknown instead of string
    async function (
      options: AnyOptions,
      modelIdOrName: string,
      methodName: string,
    ) {
      const ctx = createContext(options as GlobalOptions, "model-method-run");
      const repoDir = options.repoDir ?? ".";
      const inputRepo = new YamlInputRepository(repoDir);
      const resourceRepo = new YamlResourceRepository(repoDir);
      const dataRepo = new YamlDataRepository(repoDir);
      const outputRepo = new YamlOutputRepository(repoDir);
      const logRepo = new StreamingLogRepository(repoDir);
      const fileRepo = new FileSystemFileRepository(repoDir);
      const executionService = new DefaultMethodExecutionService();

      ctx.logger
        .debug`Running method '${methodName}' on model: ${modelIdOrName}`;

      // Look up the model input
      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      const result = await findByIdOrName(inputRepo, modelIdOrName);
      if (!result) {
        throw new Error(`Model not found: ${modelIdOrName}`);
      }
      const { input, type: modelType } = result;

      ctx.logger
        .debug`Found model: id=${input.id}, type=${modelType.normalized}`;

      // Get the model definition
      const definition = modelRegistry.get(modelType);
      if (!definition) {
        throw new Error(`Unknown model type: ${modelType.normalized}`);
      }

      // Validate method exists on the model
      const method = definition.methods[methodName];
      if (!method) {
        const availableMethods = Object.keys(definition.methods).join(", ");
        throw new Error(
          `Unknown method '${methodName}' for type '${modelType.normalized}'. Available methods: ${
            availableMethods || "none"
          }`,
        );
      }

      ctx.logger.debug`Executing method '${methodName}'`;

      // Create ModelOutput for tracking
      const inputHash = await computeInputHash(input.attributes);
      const output = ModelOutput.create({
        modelInputId: input.id,
        methodName,
        provenance: {
          inputHash,
          modelVersion: input.version,
          triggeredBy: "manual",
        },
      });

      // Mark as running and save
      output.markRunning();
      await outputRepo.save(modelType, methodName, output);

      // Track artifacts for output
      let resourceArtifact: ArtifactInfo | undefined;
      let dataArtifact: ArtifactInfo | undefined;
      let fileArtifact: ArtifactInfo | undefined;
      const logArtifacts: ArtifactInfo[] = [];

      try {
        // Execute the method (use workflow execution to handle follow-up actions)
        const result = await executionService.executeWorkflow(
          input,
          definition,
          methodName,
          {
            repoDir,
            resourceRepository: resourceRepo,
            logRepository: logRepo,
            fileRepository: fileRepo,
          },
        );

        ctx.logger.debug`Method executed`;

        // Handle resource persistence based on operation type
        if (result.resource) {
          ctx.logger.debug`Resource created: ${result.resource.id}`;
          if (result.deleteResource) {
            // Delete the resource file
            await resourceRepo.delete(modelType, result.resource.id);
            ctx.logger.debug`Resource deleted: ${result.resource.id}`;
          } else {
            // Save the resource
            await resourceRepo.save(modelType, result.resource);
            const resourcePath = resourceRepo.getPath(
              modelType,
              result.resource.id,
            );
            ctx.logger.debug`Resource saved to: ${resourcePath}`;

            // Track artifact in output
            output.setResourceId(result.resource.id);
            resourceArtifact = {
              id: result.resource.id,
              path: resourcePath,
              attributes: result.resource.attributes,
            };
          }
        }

        // Handle data artifact persistence
        if (result.data) {
          ctx.logger.debug`Data created: ${result.data.id}`;
          if (result.deleteData) {
            await dataRepo.delete(modelType, result.data.id);
            ctx.logger.debug`Data deleted: ${result.data.id}`;
          } else {
            await dataRepo.save(modelType, result.data);
            const dataPath = dataRepo.getPath(modelType, result.data.id);
            ctx.logger.debug`Data saved to: ${dataPath}`;
            output.setDataId(result.data.id);

            // Track artifact for output
            dataArtifact = {
              id: result.data.id,
              path: dataPath,
              attributes: result.data.attributes,
            };
          }

          // Update input's dataId based on operation type
          if (result.deleteData) {
            if (input.dataId) {
              input.setDataId(undefined);
              await inputRepo.save(modelType, input);
              ctx.logger.debug`Input dataId cleared after deletion`;
            }
          } else {
            if (!input.dataId) {
              input.setDataId(result.data.id);
              await inputRepo.save(modelType, input);
              ctx.logger.debug`Input updated with dataId: ${result.data.id}`;
            } else {
              ctx.logger.debug`Input already has dataId: ${input.dataId}`;
            }
          }
        }

        // Handle log persistence
        if (result.logs && result.logs.length > 0) {
          if (result.deleteLogs) {
            for (const log of result.logs) {
              await logRepo.delete(modelType, log.id);
              ctx.logger.debug`Log deleted: ${log.id}`;
            }
          } else {
            const logIds: string[] = [];
            for (const log of result.logs) {
              await logRepo.save(modelType, log);
              const logPath = logRepo.getPath(modelType, log.id);
              ctx.logger.debug`Log saved to: ${logPath}`;
              logIds.push(log.id);
              logArtifacts.push({ id: log.id, path: logPath });
            }
            output.setLogIds(logIds);
          }
        }

        // Handle file artifact persistence
        if (result.file) {
          if (result.deleteFile) {
            await fileRepo.delete(
              modelType,
              input.id,
              methodName,
              result.file.metadata,
            );
            ctx.logger.debug`File deleted: ${result.file.metadata.id}`;
          } else {
            await fileRepo.save(
              modelType,
              input.id,
              methodName,
              result.file.metadata,
              result.file.content,
            );
            const filePath = fileRepo.getPath(
              modelType,
              input.id,
              methodName,
              result.file.metadata.id,
            );
            ctx.logger.debug`File saved to: ${filePath}`;
            output.setFileId(result.file.metadata.id);
            fileArtifact = {
              id: result.file.metadata.id,
              path: filePath,
            };
          }
        }

        // Mark output as succeeded and save
        output.markSucceeded();
        await outputRepo.save(modelType, methodName, output);
      } catch (error) {
        // Mark output as failed and save
        const errorMessage = error instanceof Error
          ? error.message
          : String(error);
        const errorStack = error instanceof Error ? error.stack : undefined;
        output.markFailed({ message: errorMessage, stack: errorStack });
        await outputRepo.save(modelType, methodName, output);
        throw error;
      }

      // Render output based on output mode
      if (ctx.outputMode === "stream") {
        // Stream mode: print simple colored success message
        // Note: standalone model method runs don't support real-time streaming
        // (streaming is only available in workflow context)
        const GREEN = "\x1b[32m";
        const RESET = "\x1b[0m";
        const prefix = `${GREEN}[${input.name}/${methodName}]${RESET}`;
        console.log(`${prefix} Method completed successfully`);
        if (resourceArtifact) {
          console.log(`${prefix} Resource: ${resourceArtifact.path}`);
        }
        if (dataArtifact) {
          console.log(`${prefix} Data: ${dataArtifact.path}`);
        }
        if (fileArtifact) {
          console.log(`${prefix} File: ${fileArtifact.path}`);
        }
      } else {
        const data: ModelMethodRunData = {
          modelId: input.id,
          modelName: input.name,
          type: modelType.normalized,
          methodName,
          resource: resourceArtifact,
          data: dataArtifact,
          file: fileArtifact,
          logs: logArtifacts.length > 0 ? logArtifacts : undefined,
        };

        renderModelMethodRun(data, ctx.outputMode);
      }
      ctx.logger.debug("Method run command completed");
    },
  );

export const modelMethodCommand = new Command()
  .name("method")
  .description("Execute model methods")
  .action(function () {
    this.showHelp();
  })
  .command("run", modelMethodRunCommand);
