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

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
import { isUuid } from "../../domain/models/model_lookup.ts";
import { findWorkflowById } from "../../domain/workflows/workflow_lookup.ts";

/**
 * Data structure for the workflow edit output.
 */
export interface WorkflowEditData {
  path: string;
  editor?: string;
  status: "opened" | "updated";
  name: string;
  id: string;
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
  stdinContent?: string | null;
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
   * Called before every stdin update is saved, with the stored and the edited
   * workflow. Returning false leaves the file untouched. Serve uses it to
   * authorize the edited workflow; it runs on every save, not only when the
   * name or tags change, so a concurrent retag cannot slip past it.
   */
  authorizeUpdate?: (
    before: WorkflowEditTarget,
    after: WorkflowEditTarget,
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
    prepareEditor: (path) => editorService.prepareOpenFile(path),
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

/** Edits a workflow file via stdin update or editor. */
export async function* workflowEdit(
  ctx: LibSwampContext,
  deps: WorkflowEditDeps,
  input: WorkflowEditInput,
): AsyncIterable<WorkflowEditEvent> {
  yield* withUnitOfWork(ctx, () =>
    withGeneratorSpan(
      "swamp.workflow.edit",
      {},
      (async function* () {
        yield { kind: "resolving" };

        const { workflowIdOrName, stdinContent } = input;

        let workflow: Workflow | null = null;
        let filePath: string | null = null;

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
          filePath = deps.getPath(workflow.id);
        } else {
          const resolvedPath = input.byId
            ? null
            : await deps.resolveSymlink(workflowIdOrName);
          if (resolvedPath) {
            ctx.logger
              .debug`Using symlink fallback for broken workflow: ${resolvedPath}`;
            filePath = resolvedPath;
          } else {
            const broken = await deps.findBrokenWorkflow(workflowIdOrName);
            if (
              broken &&
              (!input.byId ||
                (broken.id === workflowIdOrName &&
                  (input.expectedName === undefined ||
                    broken.name === input.expectedName)))
            ) {
              ctx.logger
                .debug`Found broken workflow, opening file: ${broken.file}`;
              filePath = broken.file;
            } else {
              yield {
                kind: "error",
                error: notFound("Workflow", workflowIdOrName),
              };
              return;
            }
          }
        }

        // If the primary path doesn't exist but we found the workflow,
        // it's an extension workflow — try to find its actual source file.
        if (filePath && workflow) {
          const exists = await deps.fileExists(filePath);
          if (!exists) {
            const resolvedPath = await deps.resolveSymlink(workflow.name);
            if (resolvedPath) {
              filePath = resolvedPath;
            }
          }
        }

        ctx.logger.debug`Using file path: ${filePath}`;

        // Stdin update mode
        if (stdinContent !== undefined && stdinContent !== null) {
          ctx.logger.debug`Reading workflow content from stdin`;

          if (!workflow) {
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
            const authorizeUpdate = input.authorizeUpdate;
            const beforeSave = authorizeUpdate
              ? (candidate: Workflow) =>
                Promise.resolve(authorizeUpdate(before, editTarget(candidate)))
              : undefined;
            const updated = await deps.updateFromStdin(
              workflow,
              stdinContent,
              beforeSave,
            );
            if (!updated) {
              yield {
                kind: "error",
                error: forbidden(
                  `Not allowed to save workflow '${workflow.name}' with the edited name or tags`,
                ),
              };
              return;
            }

            yield {
              kind: "completed",
              data: {
                path: filePath,
                status: "updated",
                name: updated.name,
                id: updated.id,
              },
            };
          } catch (error) {
            yield {
              kind: "error",
              error: validationFailed(
                `Invalid workflow YAML from stdin: ${
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
