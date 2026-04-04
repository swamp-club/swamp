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
import { EditorService } from "../../infrastructure/editor/editor_service.ts";
import type { LibSwampContext } from "../context.ts";
import type { SwampError } from "../errors.ts";
import { notFound, validationFailed } from "../errors.ts";

import { withGeneratorSpan } from "../../infrastructure/tracing/mod.ts";
/**
 * UUID v4 regex pattern for detecting if an argument is a UUID.
 */
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

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
  | { kind: "completed"; data: WorkflowEditData }
  | { kind: "error"; error: SwampError };

/** Input for the workflow edit operation. */
export interface WorkflowEditInput {
  workflowIdOrName: string;
  stdinContent?: string | null;
}

/** Dependencies for the workflow edit operation. */
export interface WorkflowEditDeps {
  findById: (id: WorkflowId) => Promise<Workflow | null>;
  findByName: (name: string) => Promise<Workflow | null>;
  getPath: (id: WorkflowId) => string;
  resolveSymlink: (name: string) => Promise<string | null>;
  fileExists: (path: string) => Promise<boolean>;
  openEditor: (path: string) => Promise<{ editor: string }>;
  updateFromStdin: (
    workflow: Workflow,
    content: string,
  ) => Promise<Workflow>;
}

/** Wires real infrastructure into WorkflowEditDeps. */
export function createWorkflowEditDeps(
  repoDir: string,
  workflowRepo: WorkflowRepository,
): WorkflowEditDeps {
  const editorService = new EditorService();
  return {
    findById: (id) => workflowRepo.findById(id),
    findByName: (name) => workflowRepo.findByName(name),
    getPath: (id) => workflowRepo.getPath(id),
    resolveSymlink: async (name) => {
      const symlinkPath = join(repoDir, "workflows", name, "workflow.yaml");
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
    openEditor: async (path) => {
      const result = await editorService.openFile(path);
      return { editor: result.editor };
    },
    updateFromStdin: async (workflow, content) => {
      const yamlData = parseYaml(content) as WorkflowData;
      yamlData.id = workflow.id;
      const updated = Workflow.fromData(yamlData);
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
  yield* withGeneratorSpan(
    "swamp.workflow.edit",
    {},
    (async function* () {
      yield { kind: "resolving" };

      const { workflowIdOrName, stdinContent } = input;

      let workflow: Workflow | null = null;
      let filePath: string | null = null;

      if (isUuid(workflowIdOrName)) {
        ctx.logger.debug`Looking up by ID: ${workflowIdOrName}`;
        try {
          const id: WorkflowId = createWorkflowId(workflowIdOrName);
          workflow = await deps.findById(id);
        } catch (error) {
          ctx.logger
            .debug`Workflow lookup by ID failed, will try symlink fallback: ${error}`;
        }

        if (workflow) {
          filePath = deps.getPath(workflow.id);
        } else {
          yield {
            kind: "error",
            error: notFound("Workflow", workflowIdOrName),
          };
          return;
        }
      } else {
        ctx.logger.debug`Looking up by name: ${workflowIdOrName}`;
        try {
          workflow = await deps.findByName(workflowIdOrName);
        } catch (error) {
          ctx.logger
            .debug`Workflow lookup by name failed, will try symlink fallback: ${error}`;
        }

        if (workflow) {
          filePath = deps.getPath(workflow.id);
        } else {
          const resolvedPath = await deps.resolveSymlink(workflowIdOrName);
          if (resolvedPath) {
            ctx.logger
              .debug`Using symlink fallback for broken workflow: ${resolvedPath}`;
            filePath = resolvedPath;
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
          const updated = await deps.updateFromStdin(workflow, stdinContent);

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
      const result = await deps.openEditor(filePath);

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
  );
}
