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
import { getLogger } from "@logtape/logtape";
import { parse as parseYaml } from "@std/yaml";
import { isIoError } from "./io_errors.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { isWorkflowDocument } from "../../domain/workflows/workflow_document.ts";
import { MANIFEST_FILENAMES } from "../../domain/extensions/manifest_cross_kind_discovery.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";

const logger = getLogger(["extension-workflow-repo"]);

const WORKFLOW_FILE_PATTERN = /\.ya?ml$/;

/**
 * Yields the path of every file under `dir` that the extension workflow
 * loader reads: `*.yaml` and `*.yml` at any depth, except manifests. Whether
 * a file is actually a workflow (a top-level `jobs` key) is decided by the
 * caller after parsing. Each level is visited in name order, so the same
 * directory yields the same sequence on every filesystem (swamp-club#3067).
 * Paths are yielded as they are found: a caller that stops early, or that
 * catches an error from an unreadable subdirectory, keeps the files before
 * it. Errors, including `Deno.errors.NotFound` for a missing `dir`,
 * propagate to the caller.
 */
export async function* extensionWorkflowFiles(
  dir: string,
): AsyncIterable<string> {
  for (const entry of await readDirSorted(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      yield* extensionWorkflowFiles(path);
    } else if (
      WORKFLOW_FILE_PATTERN.test(entry.name) &&
      !MANIFEST_FILENAMES.has(entry.name)
    ) {
      yield path;
    }
  }
}

/**
 * Read-only WorkflowRepository that discovers YAML workflows from an
 * extension workflows directory (e.g. `extensions/workflows/`).
 *
 * Extension workflows are read-only — save() and delete() throw UserError.
 * A `*.yaml` / `*.yml` file in the directory tree is treated as a workflow
 * definition only if it has a top-level `jobs` key; `manifest.yaml`,
 * `manifest.yml`, and other YAML an extension ships (data files read by its
 * models) are skipped.
 */
export class ExtensionWorkflowRepository implements WorkflowRepository {
  private readonly baseDir: string;
  private workflowsDirs: string[];
  // Broken files already warned about, keyed by path and error, so repeated
  // scans (one per findByName during push, every reload in serve) warn once.
  private readonly warnedBroken = new Set<string>();

  constructor(
    workflowsDir: string,
    additionalDirs?: string[],
  ) {
    this.baseDir = workflowsDir;
    this.workflowsDirs = [workflowsDir, ...(additionalDirs ?? [])];
  }

  updateAdditionalDirs(additionalDirs: string[]): void {
    this.workflowsDirs = [this.baseDir, ...additionalDirs];
  }

  /** The directories this repository reads: the base dir, then additional dirs. */
  getWorkflowDirs(): readonly string[] {
    return this.workflowsDirs;
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    const workflows = await this.findAll();
    return workflows.find((w) => w.id === id) ?? null;
  }

  async findByName(name: string): Promise<Workflow | null> {
    const workflows = await this.findAll();
    return workflows.find((w) => w.name === name) ?? null;
  }

  async findAll(): Promise<Workflow[]> {
    const workflows: Workflow[] = [];
    const seenNames = new Set<string>();

    for (const dir of this.workflowsDirs) {
      try {
        for await (const path of extensionWorkflowFiles(dir)) {
          try {
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as WorkflowData | null;
            if (!data) continue;
            if (!isWorkflowDocument(data)) {
              logger
                .debug`Skipping ${path}: not a workflow (no top-level jobs key)`;
              continue;
            }
            const workflow = Workflow.fromData(data);
            // Deduplicate: first directory wins (user dir before pulled dir)
            if (!seenNames.has(workflow.name)) {
              seenNames.add(workflow.name);
              workflows.push(workflow);
            }
          } catch (error) {
            if (isIoError(error)) {
              throw markErrorPaths(
                new UserError(
                  `Failed to read extension workflow ${path}: ${
                    error instanceof Error ? error.message : error
                  }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
                ),
                [path, ...errorPaths(error)],
              );
            }
            const errorMsg = error instanceof Error
              ? error.message
              : String(error);
            const warnKey = `${path}\0${errorMsg}`;
            if (this.warnedBroken.has(warnKey)) continue;
            this.warnedBroken.add(warnKey);
            logger
              .warn`Skipping broken extension workflow ${path}: ${errorMsg}`;
          }
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          continue; // Directory doesn't exist — skip
        }
        throw error;
      }
    }

    return workflows;
  }

  save(_workflow: Workflow): Promise<void> {
    return Promise.reject(
      new UserError(
        "Extension workflows are read-only. To modify, edit the source file directly.",
      ),
    );
  }

  delete(_id: WorkflowId): Promise<void> {
    return Promise.reject(
      new UserError(
        "Extension workflows are read-only and cannot be deleted via the CLI.",
      ),
    );
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    // Scan the directory to find the file for a given workflow ID
    // This is a synchronous fallback — for display purposes only
    return `${this.workflowsDirs[0]}/workflow-${id}.yaml`;
  }

  /**
   * Finds the actual file path for a workflow by scanning the directory.
   * Returns null if not found.
   */
  async findPath(id: WorkflowId): Promise<string | null> {
    for (const dir of this.workflowsDirs) {
      try {
        for await (const path of extensionWorkflowFiles(dir)) {
          try {
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as WorkflowData | null;
            if (!isWorkflowDocument(data)) continue;
            if (data.id === id) {
              return path;
            }
          } catch (error) {
            if (isIoError(error)) {
              throw markErrorPaths(
                new UserError(
                  `Failed to read extension workflow ${path}: ${
                    error instanceof Error ? error.message : error
                  }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
                ),
                [path, ...errorPaths(error)],
              );
            }
          }
        }
      } catch (error) {
        if (error instanceof UserError) throw error;
      }
    }
    return null;
  }
}
