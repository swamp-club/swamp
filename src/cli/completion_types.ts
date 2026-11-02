// Swamp, an Automation Framework
// Copyright (C) 2026 Elder Swamp Club, Inc.
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
import { isAbsolute, resolve } from "@std/path";
import { YamlDefinitionRepository } from "../infrastructure/persistence/yaml_definition_repository.ts";
import { YamlWorkflowRepository } from "../infrastructure/persistence/yaml_workflow_repository.ts";
import { ExtensionWorkflowRepository } from "../infrastructure/persistence/extension_workflow_repository.ts";
import { CompositeWorkflowRepository } from "../infrastructure/persistence/composite_workflow_repository.ts";
import { RepoMarkerRepository } from "../infrastructure/persistence/repo_marker_repository.ts";
import { RepoPath } from "../domain/repo/repo_path.ts";
import { modelRegistry } from "../domain/models/model.ts";
import { resolveWorkflowsDir } from "./resolve_workflows_dir.ts";

/**
 * completions use the current directory as the repository because shell
 * completions run from the user's CWD; custom Cliffy types infer unknown for
 * action parameters, so the action needs @ts-expect-error
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

export class WorkflowNameType extends Type<string> {
  override parse({ value }: { value: string }): string {
    return value;
  }

  override async complete(): Promise<string[]> {
    try {
      const cwd = ".";
      const yamlRepo = new YamlWorkflowRepository(cwd);

      let extensionRepo: ExtensionWorkflowRepository | null = null;
      try {
        const markerRepo = new RepoMarkerRepository();
        const repoPath = RepoPath.create(cwd);
        const marker = await markerRepo.read(repoPath);
        const workflowsDirRel = resolveWorkflowsDir(marker);
        const workflowsDir = isAbsolute(workflowsDirRel)
          ? workflowsDirRel
          : resolve(cwd, workflowsDirRel);
        extensionRepo = new ExtensionWorkflowRepository(workflowsDir);
      } catch {
        // No marker available — skip extension workflows
      }

      const compositeRepo = new CompositeWorkflowRepository(
        yamlRepo,
        extensionRepo,
      );
      const workflows = await compositeRepo.findAll();
      return workflows.map((w) => w.name);
    } catch (_error) {
      // Graceful degradation: return empty completions if repository
      // is not accessible (e.g., not in a swamp repo, permissions issue).
      // This is expected behavior for shell completions.
      return [];
    }
  }
}

export class ModelTypeType extends Type<string> {
  override parse({ value }: { value: string }): string {
    return value;
  }

  override async complete(): Promise<string[]> {
    await modelRegistry.ensureLoaded();
    return modelRegistry.publicTypes().map((t) => t.normalized);
  }
}

/**
 * behavior and model spellings are both registered, since installed completion
 * scripts call whichever name they were generated with
 */
const COMPLETION_TYPES: ReadonlyArray<readonly [string, () => Type<string>]> = [
  ["model_name", () => new ModelNameType()],
  ["model_type", () => new ModelTypeType()],
  ["workflow_name", () => new WorkflowNameType()],
  ["behavior_name", () => new ModelNameType()],
  ["behavior_type", () => new ModelTypeType()],
];

export const COMPLETION_TYPE_NAMES: readonly string[] = COMPLETION_TYPES.map((
  [name],
) => name);

interface GlobalTypeRegistrar {
  globalType(name: string, handler: Type<string>): unknown;
}

export function registerCompletionTypes<T extends GlobalTypeRegistrar>(
  command: T,
): T {
  for (const [name, create] of COMPLETION_TYPES) {
    command.globalType(name, create());
  }
  return command;
}
