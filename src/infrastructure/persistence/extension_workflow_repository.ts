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
 * visits each level in name order for the same sequence on every filesystem;
 * yields as found so an early stop or caught error keeps earlier files; errors,
 * including NotFound for dir, propagate
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
 * read-only; a YAML file counts as a workflow only with a top-level jobs key,
 * so manifests and data files an extension ships are skipped
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

  /**
   * A read-only view that walks the extension workflows on its first lookup
   * and answers every later lookup from that walk, a failed walk included.
   * Creating the view reads nothing.
   */
  memoizedView(): WorkflowRepository {
    return new MemoizedExtensionWorkflows(this);
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
          continue;
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
    // synchronous fallback for display purposes only
    return `${this.workflowsDirs[0]}/workflow-${id}.yaml`;
  }

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

/**
 * reads the source's findAll at most once; every lookup returns the same
 * Workflow instances, so callers must not mutate them
 */
class MemoizedExtensionWorkflows implements WorkflowRepository {
  #all: Promise<Workflow[]> | undefined;

  constructor(private readonly source: ExtensionWorkflowRepository) {}

  // Assigned before any await, so lookups started together share one walk.
  #read(): Promise<Workflow[]> {
    this.#all ??= this.source.findAll();
    return this.#all;
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    return (await this.#read()).find((w) => w.id === id) ?? null;
  }

  async findByName(name: string): Promise<Workflow | null> {
    return (await this.#read()).find((w) => w.name === name) ?? null;
  }

  async findAll(): Promise<Workflow[]> {
    return [...await this.#read()];
  }

  save(workflow: Workflow): Promise<void> {
    return this.source.save(workflow);
  }

  delete(id: WorkflowId): Promise<void> {
    return this.source.delete(id);
  }

  nextId(): WorkflowId {
    return this.source.nextId();
  }

  getPath(id: WorkflowId): string {
    return this.source.getPath(id);
  }
}
