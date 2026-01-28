import { Command } from "@cliffy/command";
import {
  type ModelCreateData,
  renderModelCreate,
} from "../../presentation/output/model_create_output.tsx";
import { createContext, type GlobalOptions } from "../context.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import { ModelInput } from "../../domain/models/model_input.ts";
import { YamlInputRepository } from "../../infrastructure/persistence/yaml_input_repository.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { echoModel } from "../../domain/models/echo/echo_model.ts";

// Register the echo model
modelRegistry.register(echoModel);

// deno-lint-ignore no-explicit-any
type AnyOptions = any;

export const modelCreateCommand = new Command()
  .description("Create a new model input")
  .arguments("<type:string> <name:string>")
  .option("--repo-dir <dir:string>", "Repository directory", { default: "." })
  .action(async function (options: AnyOptions, typeArg: string, name: string) {
    const ctx = createContext(options as GlobalOptions, "model-create");
    ctx.logger.debug`Creating model input: type=${typeArg}, name=${name}`;

    // Validate the model type
    const modelType = ModelType.create(typeArg);
    ctx.logger.debug`Normalized type: ${modelType.normalized}`;

    // Check if model type is registered
    if (!modelRegistry.has(modelType)) {
      const availableTypes = modelRegistry.types().map((t) => t.normalized)
        .join(", ");
      throw new Error(
        `Unknown model type: ${typeArg}. Available types: ${
          availableTypes || "none"
        }`,
      );
    }

    // Create the repository and input
    const repoDir = options.repoDir ?? ".";
    const inputRepo = new YamlInputRepository(repoDir);

    // Check if name already exists (globally unique across all types)
    const existing = await inputRepo.findByNameGlobal(name);
    if (existing) {
      throw new Error(
        `Model input with name '${name}' already exists (type: '${existing.type.normalized}')`,
      );
    }

    // Create and save the input
    const input = ModelInput.create({ name });
    await inputRepo.save(modelType, input);

    ctx.logger.debug`Created input with ID: ${input.id}`;

    const data: ModelCreateData = {
      id: input.id,
      type: modelType.normalized,
      name: input.name,
      path: inputRepo.getPath(modelType, input.id),
    };

    renderModelCreate(data, ctx.outputMode);
    ctx.logger.debug("Model create command completed");
  });

export const modelCommand = new Command()
  .name("model")
  .description("Manage models")
  .action(function () {
    this.showHelp();
  })
  .command("create", modelCreateCommand);
