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
/**
 * Data structure for the model edit output.
 */
export interface ModelEditData {
  path: string;
  editor?: string;
  /**
   * `updated` when the edit was saved, `unchanged` when the editor closed
   * with nothing to save, `opened` when a file that is not a stored
   * definition was edited in place.
   */
  status: "opened" | "updated" | "unchanged";
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

/** What a grant can match on for a model definition being edited. */
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

/** Input for the model edit operation. */
export interface ModelEditInput {
  modelIdOrName: string;
  /**
   * The new YAML. Without it, only a file that is not a stored definition
   * (a legacy `models/<name>/definition.yaml` link) is opened in place; a
   * stored definition is edited through {@link resolveModelEditFile} and a
   * copy, then saved with this set (swamp-club#4107).
   */
  stdinContent?: string | null;
  /**
   * Where `stdinContent` came from: the default `stdin`, or `editor` for a
   * copy edited in the user's editor. An editor edit whose content is the
   * stored definition saves nothing and completes as `unchanged`.
   */
  source?: "stdin" | "editor";
  /** The editor that produced `stdinContent`, reported on completion. */
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
   * Lets a stdin update change the model's name. Without it an update whose
   * `name` differs from the stored one is refused, so a content patch cannot
   * rename its target as a side effect (swamp-club#3302). It states intent
   * only: a rename onto a name another model holds is refused either way.
   */
  allowRename?: boolean;
  /**
   * Called before every stdin update is saved, with the stored and the edited
   * definition. Returning false leaves the file untouched. Serve uses it to
   * authorize the edited definition; it runs on every save, not only when the
   * name or tags change, so a concurrent retag cannot slip past it.
   */
  authorizeUpdate?: (
    before: ModelEditTarget,
    after: ModelEditTarget,
  ) => Promise<boolean> | boolean;
  /**
   * Called before every stdin update is saved, after `authorizeUpdate`, with
   * the stored and the edited definition. Returning false leaves the file
   * untouched. Serve uses it to authorize the expressions the edit adds
   * against the writer (swamp-club#2755).
   */
  authorizeContent?: (
    before: Definition,
    after: Definition,
  ) => Promise<boolean> | boolean;
}

/** Dependencies for the model edit operation. */
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

/**
 * The file a model edit acts on: a stored definition, saved through the
 * repository, or a file that is not one (a legacy link to a definition
 * whose YAML is broken), which can only be edited in place.
 */
export type ModelEditFile =
  | {
    kind: "definition";
    path: string;
    definition: Definition;
    type: ModelType;
  }
  | { kind: "file"; path: string };

/** Resolves the file a model edit acts on, or null when there is none. */
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

  // If normal lookup didn't find the model, try symlink fallback
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

/** Edits a model definition via stdin update or editor. */
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

        // Stdin update mode
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
            // Set when an editor closed on content equal to the stored one.
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

        // Editor mode: only a file that is not a stored definition opens in
        // place. A stored definition edited in place would never be saved
        // through the repository, so it would never be committed
        // (swamp-club#4107).
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
    ));
}
