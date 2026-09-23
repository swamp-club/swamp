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

import { join } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import type { Definition } from "../../domain/definitions/definition.ts";
import {
  Definition as DefinitionClass,
  type DefinitionData,
  type DefinitionId,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { findDefinitionByIdOrName } from "../../domain/models/model_lookup.ts";
import { CalVer } from "../../domain/models/calver.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * Data structure for the model edit output.
 */
export interface ModelEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  type: string;
  editType: "definition";
  /**
   * Problems worth reporting that do not make the edit invalid — currently a
   * `typeVersion` that will not parse as CalVer. Carried on the data rather
   * than logged so `--json` callers see it too (swamp-club#2412).
   */
  warnings?: string[];
}

export type ModelEditEvent =
  | { kind: "resolving" }
  | {
    kind: "launching";
    data: { editor: string; path: string; waitsForExit: boolean };
  }
  | { kind: "completed"; data: ModelEditData }
  | { kind: "error"; error: SwampError };

/**
 * Reports a `typeVersion` that will not parse as CalVer.
 *
 * The editor is where a person is most likely to mistype the field and most
 * able to fix it, so the problem is surfaced as the editor closes rather than
 * waiting for a method run to fail on it. Absence is not a problem: it records
 * that nobody stated which version the arguments were authored for, which is a
 * legitimate state for a hand-written definition (swamp-club#2412).
 */
function typeVersionWarning(definition: Definition): string | undefined {
  const recorded = definition.typeVersion;
  if (recorded === undefined || CalVer.isValid(recorded)) return undefined;
  return `typeVersion "${recorded}" is not a valid CalVer version (expected ` +
    `YYYY.MM.DD.MICRO). Running a method against this definition will fail ` +
    `until it is corrected or removed.`;
}

/** Input for the model edit operation. */
export interface ModelEditInput {
  modelIdOrName: string;
  stdinContent?: string | null;
}

/** Dependencies for the model edit operation. */
export interface ModelEditDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  resolveSymlink: (name: string) => Promise<string | null>;
  getDefinitionPath: (type: ModelType, id: DefinitionId) => string;
  prepareEditor: (path: string) => Promise<EditorLaunch>;
  updateFromStdin: (
    definition: Definition,
    type: ModelType,
    content: string,
  ) => Promise<Definition>;
}

/** Wires real infrastructure into ModelEditDeps. */
export function createModelEditDeps(
  repoDir: string,
  injectedDefinitionRepo?: YamlDefinitionRepository,
): ModelEditDeps {
  const definitionRepo = injectedDefinitionRepo ??
    new YamlDefinitionRepository(repoDir);
  const editorService = new EditorService();
  return {
    lookupDefinition: (idOrName) =>
      findDefinitionByIdOrName(definitionRepo, idOrName),
    resolveSymlink: async (name) => {
      const symlinkPath = join(repoDir, "models", name, "definition.yaml");
      try {
        return await Deno.realPath(symlinkPath);
      } catch {
        return null;
      }
    },
    getDefinitionPath: (type, id) => definitionRepo.getPath(type, id),
    prepareEditor: (path) => editorService.prepareOpenFile(path),
    updateFromStdin: async (definition, type, content) => {
      const yamlData = parseYaml(content) as DefinitionData;
      yamlData.id = definition.id;
      const updated = DefinitionClass.fromData(yamlData);
      await definitionRepo.save(type, updated);
      return updated;
    },
  };
}

/** Edits a model definition via stdin update or editor. */
export async function* modelEdit(
  ctx: LibSwampContext,
  deps: ModelEditDeps,
  input: ModelEditInput,
): AsyncIterable<ModelEditEvent> {
  yield* withGeneratorSpan(
    "swamp.model.edit",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const { modelIdOrName, stdinContent } = input;

      // Look up the model definition
      let definition: Definition | null = null;
      let modelType: ModelType | null = null;
      let filePath: string | null = null;

      ctx.logger.debug`Looking up model: ${modelIdOrName}`;
      try {
        const result = await deps.lookupDefinition(modelIdOrName);
        if (result) {
          definition = result.definition;
          modelType = result.type;
          filePath = deps.getDefinitionPath(modelType, definition.id);
        }
      } catch (error) {
        ctx.logger
          .debug`Model lookup failed, will try symlink fallback: ${error}`;
      }

      // If normal lookup didn't find the model, try symlink fallback
      if (!filePath) {
        const resolvedPath = await deps.resolveSymlink(modelIdOrName);
        if (resolvedPath) {
          ctx.logger
            .debug`Using symlink fallback for broken model: ${resolvedPath}`;
          filePath = resolvedPath;
        } else {
          yield { kind: "error", error: notFound("Model", modelIdOrName) };
          return;
        }
      }

      ctx.logger.debug`Using file path: ${filePath}`;

      // Stdin update mode
      if (stdinContent !== undefined && stdinContent !== null) {
        ctx.logger.debug`Reading model content from stdin`;

        if (!definition || !modelType) {
          yield {
            kind: "error",
            error: validationFailed(
              "Cannot update model from stdin: the model's YAML is broken and must be fixed in an editor first",
            ),
          };
          return;
        }

        try {
          const updated = await deps.updateFromStdin(
            definition,
            modelType,
            stdinContent,
          );

          const warning = typeVersionWarning(updated);
          yield {
            kind: "completed",
            data: {
              path: filePath,
              status: "updated",
              name: updated.name,
              type: modelType.normalized,
              editType: "definition",
              ...(warning ? { warnings: [warning] } : {}),
            },
          };
        } catch (error) {
          yield {
            kind: "error",
            error: validationFailed(
              `Invalid model YAML from stdin: ${
                error instanceof Error ? error.message : String(error)
              }`,
            ),
          };
        }
        return;
      }

      // Editor mode
      ctx.logger.debug`Opening file: ${filePath}`;
      const launch = await deps.prepareEditor(filePath);
      yield {
        kind: "launching",
        data: {
          editor: launch.editor,
          path: filePath,
          waitsForExit: launch.waitsForExit,
        },
      };
      const result = await launch.open();

      // Only worth re-reading when the launch actually waited for the editor to
      // close. A non-blocking editor returns before the human has typed
      // anything, so checking here would report on the pre-edit content.
      // A re-read that fails is not itself worth reporting: the file may have
      // been renamed or left mid-edit, and `model edit` already tolerates YAML
      // it cannot parse.
      let warnings: string[] | undefined;
      if (launch.waitsForExit) {
        try {
          const reread = await deps.lookupDefinition(modelIdOrName);
          const warning = reread && typeVersionWarning(reread.definition);
          if (warning) warnings = [warning];
        } catch {
          // Left unreported for the reason above.
        }
      }

      yield {
        kind: "completed",
        data: {
          path: filePath,
          editor: result.editor,
          status: "opened",
          name: definition?.name ?? modelIdOrName,
          type: modelType?.normalized ?? "unknown",
          editType: "definition",
          ...(warnings ? { warnings } : {}),
        },
      };
    })(),
  );
}
