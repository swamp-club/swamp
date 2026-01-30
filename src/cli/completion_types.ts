import { Type } from "@cliffy/command";
import { YamlInputRepository } from "../infrastructure/persistence/yaml_input_repository.ts";
import { YamlWorkflowRepository } from "../infrastructure/persistence/yaml_workflow_repository.ts";
import { modelRegistry } from "../domain/models/model.ts";

/**
 * Custom type for model name arguments with shell completion support.
 * Parses as string but provides completion for model names.
 */
export class ModelNameType extends Type<string> {
  override parse({ value }: { value: string }): string {
    return value;
  }

  override async complete(): Promise<string[]> {
    try {
      const inputRepo = new YamlInputRepository(".");
      const models = await inputRepo.findAllGlobal();
      return models.map((m) => m.input.name);
    } catch {
      return [];
    }
  }
}

/**
 * Custom type for workflow name arguments with shell completion support.
 * Parses as string but provides completion for workflow names.
 */
export class WorkflowNameType extends Type<string> {
  override parse({ value }: { value: string }): string {
    return value;
  }

  override async complete(): Promise<string[]> {
    try {
      const workflowRepo = new YamlWorkflowRepository(".");
      const workflows = await workflowRepo.findAll();
      return workflows.map((w) => w.name);
    } catch {
      return [];
    }
  }
}

/**
 * Custom type for model type arguments with shell completion support.
 * Parses as string but provides completion for registered model types.
 */
export class ModelTypeType extends Type<string> {
  override parse({ value }: { value: string }): string {
    return value;
  }

  override complete(): string[] {
    return modelRegistry.types().map((t) => t.normalized);
  }
}
