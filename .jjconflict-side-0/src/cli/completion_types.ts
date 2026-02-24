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

import { Type } from "@cliffy/command";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../infrastructure/persistence/yaml_workflow_repository.ts";
import { modelRegistry } from "../domain/models/model.ts";

/**
 * Custom Cliffy types for shell completion support.
 *
 * These types extend Cliffy's Type<string> to provide dynamic tab-completion
 * for model names, workflow names, and model types based on repository contents.
 *
 * ## Cliffy Type Inference Limitation
 *
 * When using custom types with Cliffy's `.arguments()`, the type inference
 * returns `unknown` instead of `string` for the action handler parameters.
 * This is a known Cliffy limitation. The workaround is to add a
 * `@ts-expect-error` comment before the `.action()` call:
 *
 * ```typescript
 * .arguments("<name:model_name>")
 * // @ts-expect-error - Cliffy custom type returns unknown instead of string
 * .action(async function (options, name: string) { ... })
 * ```
 *
 * ## Repository Directory
 *
 * Completions use "." (current working directory) as the repository path.
 * This is intentional - shell completions run from the user's CWD, and
 * completions should reflect the models/workflows in that directory.
 */

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
      const definitionRepo = new YamlDefinitionRepository(".");
      const definitions = await definitionRepo.findAllGlobal();
      return definitions.map((d) => d.definition.name);
    } catch (_error) {
      // Graceful degradation: return empty completions if repository
      // is not accessible (e.g., not in a swamp repo, permissions issue).
      // This is expected behavior for shell completions.
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
    } catch (_error) {
      // Graceful degradation: return empty completions if repository
      // is not accessible (e.g., not in a swamp repo, permissions issue).
      // This is expected behavior for shell completions.
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
