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
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  type EditorLaunch,
  EditorService,
} from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import { withUnitOfWork } from "../unit_of_work.ts";
import type { SwampError } from "../errors.ts";
import { forbidden, notFound, validationFailed } from "../errors.ts";
import {
  type BrokenWorkflow,
  findBrokenWorkflow,
  workflowsDirFor,
} from "./broken_workflow.ts";

import {
  setActiveSpanAttributes,
  withGeneratorSpan,
} from "../../infrastructure/tracing/mod.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import { findWorkflowById } from "../../domain/workflows/workflow_lookup.ts";

/**
 * Data structure for the workflow edit output.
 */
export interface WorkflowEditData {
  path: string;
  editor?: string;
  /**
   * `updated` when the edit was saved, `unchanged` when the editor closed
   * with nothing to save, `opened` when a file that is not a stored workflow
   * was edited in place.
   */
  status: "opened" | "updated" | "unchanged";
  name: string;
  id: string;
  /** Set when the edit replaced a workflow file that did not parse. */
  repaired?: boolean;
}

export type WorkflowEditEvent =
  | { kind: "resolving" }
  | {
    kind: "launching";
    data: { editor: string; path: string; waitsForExit: boolean };
  }
  | { kind: "completed"; data: WorkflowEditData }
  | { kind: "error"; error: SwampError };

/** What a grant can match on for a workflow being edited. */
export interface WorkflowEditTarget {
  name: string;
  tags: Record<string, string>;
}

/** Input for the workflow edit operation. */
export interface WorkflowEditInput {
  workflowIdOrName: string;
  /**
   * The new YAML. Without it, only a file that is not a stored workflow (an
   * extension's source, a legacy link) is opened in place; a stored workflow
   * is edited through {@link resolveWorkflowEditFile} and a copy, then saved
   * with this set (swamp-club#4107).
   */
  stdinContent?: string | null;
  /**
   * Where `stdinContent` came from: the default `stdin`, or `editor` for a
   * copy edited in the user's editor. An editor edit whose content is the
   * stored workflow saves nothing and completes as `unchanged`, and only an
   * editor edit may replace a stored workflow file that does not parse.
   */
  source?: "stdin" | "editor";
  /** The editor that produced `stdinContent`, reported on completion. */
  editor?: string;
  /**
   * Treat `workflowIdOrName` as a workflow id the caller already resolved,
   * and look it up by id only, so the edit acts on the workflow the caller
   * authorized.
   */
  byId?: boolean;
  /**
   * With `byId`, the name the caller authorized: ids are not guaranteed
   * unique, so only a workflow with this name and the id is accepted.
   */
  expectedName?: string;
  /**
   * The principal that sent the request, as `kind:id`. It is recorded on the
   * span as `auth.principal.id` and is never used to authorize the edit.
   */
  principalId?: string;
  /**
   * Lets a stdin update change the workflow's name. Without it an update
   * whose `name` differs from the stored one is refused, so a content patch
   * cannot rename its target as a side effect (swamp-club#3302). It states
   * intent only: a rename onto a name another workflow holds is refused
   * either way.
   */
  allowRename?: boolean;
  /**
   * Called before every stdin update is saved, with the stored and the edited
   * workflow. Returning false leaves the file untouched. Serve uses it to
   * authorize the edited workflow; it runs on every save, not only when the
   * name or tags change, so a concurrent retag cannot slip past it.
   */
  authorizeUpdate?: (
    before: WorkflowEditTarget,
    after: WorkflowEditTarget,
  ) => Promise<boolean> | boolean;
  /**
   * Called before every stdin update is saved, after `authorizeUpdate`, with
   * the stored and the edited workflow. Returning false leaves the file
   * untouched. Serve uses it to authorize the expressions and steps the edit
   * adds against the writer (swamp-club#2755).
   */
  authorizeContent?: (
    before: Workflow,
    after: Workflow,
  ) => Promise<boolean> | boolean;
}

function editTarget(workflow: Workflow): WorkflowEditTarget {
  return { name: workflow.name, tags: { ...workflow.tags } };
}

/** Dependencies for the workflow edit operation. */
export interface WorkflowEditDeps {
  findById: (id: WorkflowId) => Promise<Workflow | null>;
  findByName: (name: string) => Promise<Workflow | null>;
  findBrokenWorkflow: (idOrName: string) => Promise<BrokenWorkflow | null>;
  getPath: (id: WorkflowId) => string;
  resolveSymlink: (name: string) => Promise<string | null>;
  fileExists: (path: string) => Promise<boolean>;
  prepareEditor: (path: string) => Promise<EditorLaunch>;
  /** Saves a workflow whose stored file did not parse. */
  saveRepaired: (workflow: Workflow) => Promise<void>;
  /**
   * Parses the new YAML and saves it. `beforeSave` runs after parsing; when it
   * returns false nothing is written and the call resolves to null.
   */
  updateFromStdin: (
    workflow: Workflow,
    content: string,
    beforeSave?: (updated: Workflow) => Promise<boolean>,
  ) => Promise<Workflow | null>;
}

/** Wires real infrastructure into WorkflowEditDeps. */
export function createWorkflowEditDeps(
  repoDir: string,
  workflowRepo: WorkflowRepository,
): WorkflowEditDeps {
  const editorService = new EditorService();
  const workflowsDir = workflowsDirFor(repoDir);
  return {
    findById: (id) => workflowRepo.findById(id),
    findByName: (name) => workflowRepo.findByName(name),
    findBrokenWorkflow: (idOrName) =>
      findBrokenWorkflow(workflowsDir, idOrName),
    getPath: (id) => workflowRepo.getPath(id),
    resolveSymlink: async (name) => {
      const symlinkPath = join(workflowsDir, name, "workflow.yaml");
      try {
        return await Deno.realPath(symlinkPath);
      } catch {
        return null;
      }
    },
    fileExists: async (path) => {
      try {
        await Deno.stat(path);
        return true;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) return false;
        throw error;
      }
    },
    prepareEditor: (path) =>
      editorService.prepareOpenFile(path, { requireWait: true }),
    saveRepaired: (workflow) => workflowRepo.save(workflow),
    updateFromStdin: async (workflow, content, beforeSave) => {
      const yamlData = parseYaml(content) as WorkflowData;
      yamlData.id = workflow.id;
      const updated = Workflow.fromData(yamlData);
      if (beforeSave && !(await beforeSave(updated))) return null;
      await workflowRepo.save(updated);
      return updated;
    },
  };
}

/**
 * The file a workflow edit acts on: a stored workflow, saved through the
 * repository; a stored workflow file that does not parse, which an editor
 * edit may replace; or a file that is not a stored workflow (an extension's
 * source, a legacy link), which can only be edited in place.
 */
export type WorkflowEditFile =
  | { kind: "workflow"; path: string; workflow: Workflow }
  | { kind: "broken"; path: string; id: string; name: string | null }
  | { kind: "file"; path: string };

/** Resolves the file a workflow edit acts on, or null when there is none. */
export async function resolveWorkflowEditFile(
  ctx: LibSwampContext,
  deps: WorkflowEditDeps,
  input: Pick<WorkflowEditInput, "workflowIdOrName" | "byId" | "expectedName">,
): Promise<WorkflowEditFile | null> {
  const { workflowIdOrName } = input;
  let workflow: Workflow | null = null;

  // Name first, then exact id — or id only when the caller resolved it.
  if (!input.byId) {
    ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
    try {
      workflow = await deps.findByName(workflowIdOrName);
    } catch (error) {
      ctx.logger
        .debug`Workflow lookup by name failed, will try symlink fallback: ${error}`;
    }
  }
  if (!workflow && isUuid(workflowIdOrName)) {
    ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
    try {
      const id: WorkflowId = createWorkflowId(workflowIdOrName);
      workflow = input.byId && input.expectedName !== undefined
        ? await findWorkflowById(
          deps,
          workflowIdOrName,
          input.expectedName,
        )
        : await deps.findById(id);
    } catch (error) {
      ctx.logger
        .debug`Workflow lookup by ID failed, will try symlink fallback: ${error}`;
    }
  }

  if (workflow) {
    const path = deps.getPath(workflow.id);
    if (await deps.fileExists(path)) {
      return { kind: "workflow", path, workflow };
    }
    // The primary path does not exist, so it is an extension workflow:
    // its source file is edited where it is.
    const resolvedPath = await deps.resolveSymlink(workflow.name);
    return { kind: "file", path: resolvedPath ?? path };
  }

  const resolvedPath = input.byId
    ? null
    : await deps.resolveSymlink(workflowIdOrName);
  if (resolvedPath) {
    ctx.logger
      .debug`Using symlink fallback for broken workflow: ${resolvedPath}`;
    return { kind: "file", path: resolvedPath };
  }
  const broken = await deps.findBrokenWorkflow(workflowIdOrName);
  if (
    broken &&
    (!input.byId ||
      (broken.id === workflowIdOrName &&
        (input.expectedName === undefined ||
          broken.name === input.expectedName)))
  ) {
    ctx.logger.debug`Found broken workflow, opening file: ${broken.file}`;
    // Only the file the repository would write for its id is a stored
    // workflow; any other broken file is edited where it is.
    if (broken.id !== null && isUuid(broken.id)) {
      const path = deps.getPath(createWorkflowId(broken.id));
      if (path === broken.file) {
        return { kind: "broken", path, id: broken.id, name: broken.name };
      }
    }
    return { kind: "file", path: broken.file };
  }
  return null;
}

function sameWorkflow(a: Workflow, b: Workflow): boolean {
  return JSON.stringify(a.toData()) === JSON.stringify(b.toData());
}

/** Edits a workflow file via stdin update or editor. */
export async function* workflowEdit(
  ctx: LibSwampContext,
  deps: WorkflowEditDeps,
  input: WorkflowEditInput,
): AsyncIterable<WorkflowEditEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.edit",
      input.principalId ? { "auth.principal.id": input.principalId } : {},
      (async function* () {
        yield { kind: "resolving" };

        const { workflowIdOrName, stdinContent } = input;
        const fromEditor = input.source === "editor";

        const file = await resolveWorkflowEditFile(ctx, deps, input);
        if (!file) {
          yield {
            kind: "error",
            error: notFound("Workflow", workflowIdOrName),
          };
          return;
        }
        const filePath = file.path;
        const workflow = file.kind === "workflow" ? file.workflow : null;
        if (workflow) {
          setActiveSpanAttributes({
            "workflow.name": workflow.name,
            "workflow.id": workflow.id,
          });
        }

        ctx.logger.debug`Using file path: ${filePath}`;

        // Stdin update mode
        if (stdinContent !== undefined && stdinContent !== null) {
          ctx.logger.debug`Reading workflow content from stdin`;

          if (!workflow) {
            if (fromEditor && file.kind === "broken") {
              yield* repairBrokenWorkflow(deps, input, file, stdinContent);
              return;
            }
            yield {
              kind: "error",
              error: validationFailed(
                "Cannot update workflow from stdin: the workflow's YAML is broken and must be fixed in an editor first",
              ),
            };
            return;
          }

          try {
            const before = editTarget(workflow);
            const stored = workflow;
            const { authorizeUpdate, authorizeContent } = input;
            // Set when the rename guard, rather than an authorization hook,
            // is what stopped the save.
            let renameRefusal: SwampError | undefined;
            // Set when an editor closed on content equal to the stored one.
            let unchanged = false;
            const beforeSave = async (candidate: Workflow) => {
              if (fromEditor && sameWorkflow(candidate, stored)) {
                unchanged = true;
                return false;
              }
              if (candidate.name !== stored.name) {
                if (!input.allowRename) {
                  renameRefusal = validationFailed(
                    `Refusing to rename workflow '${stored.name}' to '${candidate.name}': the 'name' in the piped workflow differs from the workflow being edited. Pass --allow-rename to rename it, or set 'name: ${stored.name}' to keep the name.`,
                  );
                  return false;
                }
                // Catches the mistake, not a race: the check and the save are
                // separate steps, so this does not make names unique.
                const holder = await deps.findByName(candidate.name);
                if (holder && holder.id !== stored.id) {
                  renameRefusal = validationFailed(
                    `Cannot rename workflow '${stored.name}' to '${candidate.name}': another workflow already has that name.`,
                  );
                  return false;
                }
              }
              return (!authorizeUpdate ||
                await authorizeUpdate(before, editTarget(candidate))) &&
                (!authorizeContent ||
                  await authorizeContent(stored, candidate));
            };
            const updated = await deps.updateFromStdin(
              workflow,
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
                    id: stored.id,
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
                error: forbidden(
                  `Not allowed to save workflow '${workflow.name}' with the edited name or tags`,
                ),
              };
              return;
            }

            if (updated.name !== stored.name) {
              setActiveSpanAttributes({ "workflow.renamed_to": updated.name });
            }

            yield {
              kind: "completed",
              data: {
                path: filePath,
                ...(input.editor ? { editor: input.editor } : {}),
                status: "updated",
                name: updated.name,
                id: updated.id,
              },
            };
          } catch (error) {
            yield {
              kind: "error",
              error: validationFailed(
                `Invalid workflow YAML ${
                  fromEditor ? "from the editor" : "from stdin"
                }: ${error instanceof Error ? error.message : String(error)}`,
              ),
            };
          }
          return;
        }

        // Editor mode: only a file that is not a stored workflow opens in
        // place. A stored workflow edited in place would never be saved
        // through the repository, so it would never be committed
        // (swamp-club#4107).
        if (file.kind !== "file") {
          yield {
            kind: "error",
            error: validationFailed(
              `Cannot open workflow '${workflowIdOrName}' in place: edit a copy and save it as the new content`,
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

        yield {
          kind: "completed",
          data: {
            path: filePath,
            editor: result.editor,
            status: "opened",
            name: workflow?.name ?? workflowIdOrName,
            id: workflow?.id ?? "unknown",
          },
        };
      })(),
    ));
}

/**
 * Replaces a stored workflow file that does not parse with YAML edited in
 * the editor (swamp-club#4107). The id comes from the broken file; the new
 * YAML must parse, and must not take a name another workflow holds. Only a
 * file that still does not parse is replaced.
 */
async function* repairBrokenWorkflow(
  deps: WorkflowEditDeps,
  input: WorkflowEditInput,
  file: Extract<WorkflowEditFile, { kind: "broken" }>,
  content: string,
): AsyncIterable<WorkflowEditEvent> {
  // A repair is a local editor action; a caller that authorizes edits
  // cannot authorize a file whose name and tags cannot be read.
  if (input.authorizeUpdate || input.authorizeContent) {
    yield {
      kind: "error",
      error: forbidden(`Not allowed to repair workflow '${file.id}'`),
    };
    return;
  }
  let repaired: Workflow;
  try {
    const yamlData = parseYaml(content) as WorkflowData;
    yamlData.id = file.id;
    repaired = Workflow.fromData(yamlData);
  } catch (error) {
    yield {
      kind: "error",
      error: validationFailed(
        `Invalid workflow YAML from the editor: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    };
    return;
  }
  const holder = await deps.findByName(repaired.name).catch(() => null);
  if (holder && holder.id !== repaired.id) {
    yield {
      kind: "error",
      error: validationFailed(
        `Cannot name the repaired workflow '${repaired.name}': another workflow already has that name.`,
      ),
    };
    return;
  }
  const stillBroken = await deps.findBrokenWorkflow(file.id);
  if (!stillBroken || stillBroken.file !== file.path) {
    yield {
      kind: "error",
      error: validationFailed(
        `Workflow '${file.id}' was repaired while this edit ran; nothing was written.`,
      ),
    };
    return;
  }
  await deps.saveRepaired(repaired);
  yield {
    kind: "completed",
    data: {
      path: file.path,
      ...(input.editor ? { editor: input.editor } : {}),
      status: "updated",
      name: repaired.name,
      id: repaired.id,
      repaired: true,
    },
  };
}
