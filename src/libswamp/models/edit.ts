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
import {
  findDefinitionByIdGlobal,
  findDefinitionByIdOrName,
} from "../../domain/models/model_lookup.ts";
import { CalVer } from "../../domain/models/calver.ts";
import { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { behaviorNotFound, wordedSwampError } from "../errors.ts";
import { wordedText } from "../../domain/behavior_wording.ts";

import {
  setActiveSpanAttributes,
  withGeneratorSpan,
} from "../../infrastructure/tracing/mod.ts";
export interface ModelEditData {
  path: string;
  editor?: string;
  /**
   * `updated` when the edit was saved, `unchanged` when the editor closed
   * with nothing to save, `opened` when a file that is not a stored
   * definition was edited in place.
   */
  status: "opened" | "updated" | "unchanged";
  /**
   * With `unchanged`: where the copy was kept, because the editor is not
   * known to wait and may have returned before the person saved.
   */
  keptPath?: string;
  name: string;
  type: string;
  editType: "definition";
  /**
   * problems worth reporting that do not make the edit invalid, currently a
   * typeVersion that will not parse as CalVer; carried on the data so --json
   * callers see it too
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
 * surfaced as the editor closes, where a person is best placed to fix it,
 * rather than when a method run fails on it; an absent typeVersion is
 * legitimate for a hand-written definition
 */
function typeVersionWarning(definition: Definition): string | undefined {
  const recorded = definition.typeVersion;
  if (recorded === undefined || CalVer.isValid(recorded)) return undefined;
  return `typeVersion "${recorded}" is not a valid CalVer version (expected ` +
    `YYYY.MM.DD.MICRO). Running a method against this definition will fail ` +
    `until it is corrected or removed.`;
}

export interface ModelEditTarget {
  name: string;
  modelType: string;
  tags: Record<string, string>;
}

function editTarget(
  definition: Definition,
  type: ModelType,
): ModelEditTarget {
  return {
    name: definition.name,
    modelType: type.normalized,
    tags: { ...definition.tags },
  };
}

export interface ModelEditInput {
  modelIdOrName: string;
  /**
   * the new YAML. Without it, only a file that is not a stored definition (a
   * legacy link) is opened in place; a stored definition is edited on a copy
   * and then saved with this set
   */
  stdinContent?: string | null;
  /**
   * Where `stdinContent` came from: the default `stdin`, or `editor` for a
   * copy edited in the user's editor. An editor edit whose content is the
   * stored definition saves nothing and completes as `unchanged`.
   */
  source?: "stdin" | "editor";
  editor?: string;
  /**
   * Treat `modelIdOrName` as a definition id already resolved by the caller,
   * and look it up by id only, so the edit acts on the model the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a definition with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * The principal that sent the request, as `kind:id`. It is recorded on the
   * span as `auth.principal.id` and is never used to authorize the edit.
   */
  principalId?: string;
  /**
   * lets a stdin update change the model's name; without it a differing name is
   * refused so a content patch cannot rename its target. Intent only: a rename
   * onto a name another model holds is refused either way
   */
  allowRename?: boolean;
  /**
   * called before every stdin update is saved, with the stored and edited
   * definition; false leaves the file untouched. Serve authorizes with it on
   * every save, so a concurrent retag cannot slip past
   */
  authorizeUpdate?: (
    before: ModelEditTarget,
    after: ModelEditTarget,
  ) => Promise<boolean> | boolean;
  /**
   * called before every stdin update is saved, after authorizeUpdate; false
   * leaves the file untouched. Serve uses it to authorize the expressions the
   * edit adds against the writer
   */
  authorizeContent?: (
    before: Definition,
    after: Definition,
  ) => Promise<boolean> | boolean;
}

export interface ModelEditDeps {
  lookupDefinition: (
    idOrName: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  lookupDefinitionById: (
    id: string,
    expectedName?: string,
  ) => Promise<{ definition: Definition; type: ModelType } | null>;
  resolveSymlink: (name: string) => Promise<string | null>;
  getDefinitionPath: (type: ModelType, id: DefinitionId) => string;
  prepareEditor: (path: string) => Promise<EditorLaunch>;
  /**
   * Parses the new YAML and saves it. `beforeSave` runs after parsing; when it
   * returns false nothing is written and the call resolves to null.
   */
  updateFromStdin: (
    definition: Definition,
    type: ModelType,
    content: string,
    beforeSave?: (updated: Definition) => Promise<boolean>,
  ) => Promise<Definition | null>;
}

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
    lookupDefinitionById: (id, expectedName) =>
      findDefinitionByIdGlobal(definitionRepo, id, expectedName),
    resolveSymlink: async (name) => {
      const symlinkPath = join(repoDir, "models", name, "definition.yaml");
      try {
        return await Deno.realPath(symlinkPath);
      } catch {
        return null;
      }
    },
    getDefinitionPath: (type, id) => definitionRepo.getPath(type, id),
    prepareEditor: (path) =>
      editorService.prepareOpenFile(path, { requireWait: true }),
    updateFromStdin: async (definition, type, content, beforeSave) => {
      const yamlData = parseYaml(content) as DefinitionData;
      yamlData.id = definition.id;
      const updated = DefinitionClass.fromData(yamlData);
      if (beforeSave && !(await beforeSave(updated))) return null;
      await definitionRepo.save(type, updated);
      return updated;
    },
  };
}

export type ModelEditFile =
  | {
    kind: "definition";
    path: string;
    definition: Definition;
    type: ModelType;
  }
  | { kind: "file"; path: string };

export async function resolveModelEditFile(
  ctx: LibSwampContext,
  deps: ModelEditDeps,
  input: Pick<ModelEditInput, "modelIdOrName" | "byId" | "expectedName">,
): Promise<ModelEditFile | null> {
  const { modelIdOrName } = input;
  ctx.logger.debug`Looking up model: ${modelIdOrName}`;
  try {
    const result = input.byId
      ? await deps.lookupDefinitionById(modelIdOrName, input.expectedName)
      : await deps.lookupDefinition(modelIdOrName);
    if (result) {
      return {
        kind: "definition",
        path: deps.getDefinitionPath(result.type, result.definition.id),
        definition: result.definition,
        type: result.type,
      };
    }
  } catch (error) {
    ctx.logger
      .debug`Model lookup failed, will try symlink fallback: ${error}`;
  }

  const resolvedPath = await deps.resolveSymlink(modelIdOrName);
  if (resolvedPath) {
    ctx.logger
      .debug`Using symlink fallback for broken model: ${resolvedPath}`;
    return { kind: "file", path: resolvedPath };
  }
  return null;
}

function sameDefinition(a: Definition, b: Definition): boolean {
  return JSON.stringify(a.toData()) === JSON.stringify(b.toData());
}

export async function* modelEdit(
  ctx: LibSwampContext,
  deps: ModelEditDeps,
  input: ModelEditInput,
): AsyncIterable<ModelEditEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.model.edit",
      input.principalId ? { "auth.principal.id": input.principalId } : {},
      (async function* () {
        yield { kind: "resolving" };

        const { modelIdOrName, stdinContent } = input;
        const fromEditor = input.source === "editor";

        const file = await resolveModelEditFile(ctx, deps, input);
        if (!file) {
          yield { kind: "error", error: behaviorNotFound(modelIdOrName) };
          return;
        }
        const filePath = file.path;
        const definition = file.kind === "definition" ? file.definition : null;
        const modelType = file.kind === "definition" ? file.type : null;
        if (definition && modelType) {
          setActiveSpanAttributes({
            "model.name": definition.name,
            "model.type": modelType.normalized,
            "model.id": definition.id,
          });
        }

        ctx.logger.debug`Using file path: ${filePath}`;

        if (stdinContent !== undefined && stdinContent !== null) {
          ctx.logger.debug`Reading model content from stdin`;

          if (!definition || !modelType) {
            yield {
              kind: "error",
              error: wordedSwampError(
                "validation_failed",
                wordedText((w) =>
                  `Cannot update ${w.noun} from stdin: the ${w.noun}'s YAML is broken and must be fixed in an editor first`
                ),
              ),
            };
            return;
          }

          try {
            const type = modelType;
            const before = editTarget(definition, type);
            const stored = definition;
            const { authorizeUpdate, authorizeContent } = input;
            // Set when the rename guard, rather than an authorization hook,
            // is what stopped the save.
            let renameRefusal: SwampError | undefined;
            let unchanged = false;
            const beforeSave = async (candidate: Definition) => {
              if (fromEditor && sameDefinition(candidate, stored)) {
                unchanged = true;
                return false;
              }
              if (candidate.name !== stored.name) {
                if (!input.allowRename) {
                  renameRefusal = wordedSwampError(
                    "validation_failed",
                    wordedText((w) =>
                      `Refusing to rename ${w.noun} '${stored.name}' to '${candidate.name}': the 'name' in the piped definition differs from the ${w.noun} being edited. Pass --allow-rename to rename it, or set 'name: ${stored.name}' to keep the name.`
                    ),
                  );
                  return false;
                }
                // Catches the mistake, not a race: the check and the save are
                // separate steps, so this does not make names unique.
                const holder = await deps.lookupDefinition(candidate.name);
                if (holder && holder.definition.id !== stored.id) {
                  renameRefusal = wordedSwampError(
                    "validation_failed",
                    wordedText((w) =>
                      `Cannot rename ${w.noun} '${stored.name}' to '${candidate.name}': another ${w.noun} already has that name.`
                    ),
                  );
                  return false;
                }
              }
              return (!authorizeUpdate ||
                await authorizeUpdate(before, editTarget(candidate, type))) &&
                (!authorizeContent ||
                  await authorizeContent(stored, candidate));
            };
            const updated = await deps.updateFromStdin(
              definition,
              modelType,
              stdinContent,
              beforeSave,
            );
            if (!updated) {
              if (unchanged) {
                yield {
                  kind: "completed",
                  data: {
                    path: filePath,
                    ...(input.editor ? { editor: input.editor } : {}),
                    status: "unchanged",
                    name: stored.name,
                    type: type.normalized,
                    editType: "definition",
                  },
                };
                return;
              }
              if (renameRefusal) {
                yield { kind: "error", error: renameRefusal };
                return;
              }
              yield {
                kind: "error",
                error: wordedSwampError(
                  "forbidden",
                  wordedText((w) =>
                    `Not allowed to save ${w.noun} '${definition.name}' with the edited name or tags`
                  ),
                ),
              };
              return;
            }

            if (updated.name !== stored.name) {
              setActiveSpanAttributes({ "model.renamed_to": updated.name });
            }

            const warning = typeVersionWarning(updated);
            yield {
              kind: "completed",
              data: {
                path: filePath,
                ...(input.editor ? { editor: input.editor } : {}),
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
              error: wordedSwampError(
                "validation_failed",
                wordedText((w) =>
                  `Invalid ${w.noun} YAML ${
                    fromEditor ? "from the editor" : "from stdin"
                  }: ${error instanceof Error ? error.message : String(error)}`
                ),
              ),
            };
          }
          return;
        }

        // editor mode: only a file that is not a stored definition opens in
        // place; a stored definition edited in place would never be saved
        // through the repository, so never committed
        if (file.kind === "definition") {
          yield {
            kind: "error",
            error: wordedSwampError(
              "validation_failed",
              wordedText((w) =>
                `Cannot open ${w.noun} '${file.definition.name}' in place: edit a copy and save it as the new content`
              ),
            ),
          };
          return;
        }
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

        // re-read only when the launch waited for the editor to close; a
        // non-blocking editor returns before anything is typed. A failed
        // re-read is not worth reporting: the file may be renamed or mid-edit
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
    ));
}
