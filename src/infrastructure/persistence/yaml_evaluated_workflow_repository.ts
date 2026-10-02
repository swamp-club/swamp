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

import {
  type DeferredExpression,
  DeferredExpressionSchema,
} from "../../domain/expressions/deferred_expression.ts";
import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import { changeFor, signalChange } from "./unit_of_work_scope.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath, isSinglePathSegment } from "./safe_path.ts";
import {
  isFilenameSafeName,
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  SENSITIVE_FORMAT_VERSION,
  type WrittenReference,
  WrittenReferenceSchema,
} from "../../domain/secrets/mod.ts";
import type {
  RunSnapshotInfo,
  RunSnapshotRepository,
} from "../../domain/workflows/repositories.ts";

export interface EvaluatedWorkflowCache {
  workflow: Workflow;
  /** Expressions the source workflow contained when the cache was written. */
  authoredExpressions: ReadonlySet<string>;
  deferredExpressions: readonly DeferredExpression[];
  /** Where the file holds vault references in place of sensitive values. */
  writtenReferences: readonly WrittenReference[];
  /**
   * Set when the file was written with sensitive values kept as references;
   * absent in caches written before that, which may hold plaintext.
   */
  sensitiveFormat?: number;
}

// Cache metadata is deliberately separate from the source Workflow schema,
// which rejects unknown top-level keys — it must be split off before parsing.
const CacheMetadataSchema = z.object({
  authoredExpressions: z.array(z.string()).optional(),
  deferredExpressions: z.array(DeferredExpressionSchema).optional(),
  writtenReferences: z.array(WrittenReferenceSchema).optional(),
  sensitiveFormat: z.number().int().positive().optional(),
});

function parseCache(content: string): EvaluatedWorkflowCache | null {
  const data = parseYaml(content) as
    | (WorkflowData & {
      authoredExpressions?: unknown;
      deferredExpressions?: unknown;
      writtenReferences?: unknown;
      sensitiveFormat?: unknown;
    })
    | null;
  if (!data) return null;
  const {
    authoredExpressions,
    deferredExpressions,
    writtenReferences,
    sensitiveFormat,
    ...workflowData
  } = data;
  const metadata = CacheMetadataSchema.parse({
    authoredExpressions,
    deferredExpressions,
    writtenReferences,
    sensitiveFormat,
  });
  return {
    workflow: Workflow.fromData(workflowData),
    authoredExpressions: new Set(metadata.authoredExpressions),
    deferredExpressions: metadata.deferredExpressions ?? [],
    writtenReferences: metadata.writtenReferences ?? [],
    sensitiveFormat: metadata.sensitiveFormat,
  };
}

/**
 * Repository for storing evaluated workflows.
 *
 * Writes to {repoDir}/.swamp/workflows-evaluated/workflow-{name}.yaml
 * (or workflow-{uuid}.yaml for legacy/non-filename-safe names).
 * This directory contains workflows with all expressions resolved.
 */
export class YamlEvaluatedWorkflowRepository implements RunSnapshotRepository {
  private readonly baseDir: string;
  private readonly idToActualPath = new Map<WorkflowId, string>();

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirtyHook?: MarkDirtyHook,
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.workflowsEvaluated);
  }

  private async notifyDirty(relPath?: string): Promise<void> {
    await signalChange(
      this.markDirtyHook,
      changeFor(relPath, "YamlEvaluatedWorkflowRepository.notifyDirty"),
    );
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    // Fast path: try UUID-based filename (legacy)
    const legacyPath = this.getLegacyPath(id);
    try {
      const content = await Deno.readTextFile(legacyPath);
      const cached = parseCache(content);
      if (cached) {
        this.idToActualPath.set(id, legacyPath);
        return cached.workflow;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }

    // Try cached path
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      try {
        const content = await Deno.readTextFile(cachedPath);
        const cached = parseCache(content);
        if (cached) {
          return cached.workflow;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Slow path: scan all files
    const workflows = await this.findAll();
    return workflows.find((w) => w.id === id) ?? null;
  }

  async findAll(): Promise<Workflow[]> {
    const dir = this.getWorkflowsDir();
    const workflows: Workflow[] = [];

    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("workflow-") &&
          entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const cached = parseCache(content);
          if (!cached) continue;
          const workflow = cached.workflow;
          this.idToActualPath.set(workflow.id as WorkflowId, path);
          workflows.push(workflow);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return workflows;
  }

  /**
   * Finds an evaluated workflow by its name.
   *
   * @param name - The workflow name
   * @returns The evaluated workflow if found, or null
   */
  async findByName(name: string): Promise<Workflow | null> {
    return (await this.findByNameWithProvenance(name))?.workflow ?? null;
  }

  /**
   * Finds an evaluated workflow by name together with the authored
   * expressions persisted alongside it. Caches written before provenance was
   * recorded yield an empty set.
   */
  async findByNameWithProvenance(
    name: string,
  ): Promise<EvaluatedWorkflowCache | null> {
    if (isFilenameSafeName(name)) {
      const namePath = this.getNamePath(name);
      try {
        const content = await Deno.readTextFile(namePath);
        const cached = parseCache(content);
        if (cached) {
          if (cached.workflow.name !== name) {
            // File content doesn't match filename — fall through to slow path
          } else {
            this.idToActualPath.set(
              cached.workflow.id as WorkflowId,
              namePath,
            );
            return cached;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    const dir = this.getWorkflowsDir();
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (
          entry.isFile && entry.name.startsWith("workflow-") &&
          entry.name.endsWith(".yaml")
        ) {
          const path = join(dir, entry.name);
          const cached = parseCache(await Deno.readTextFile(path));
          if (!cached) continue;
          this.idToActualPath.set(cached.workflow.id as WorkflowId, path);
          if (cached.workflow.name === name) return cached;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return null;
  }

  /**
   * Saves an evaluated workflow.
   *
   * @param workflow - The evaluated workflow
   * @param authoredExpressions - Expressions collected from the source
   *   workflow before evaluation, restored by
   *   {@link findByNameWithProvenance}
   */
  async save(
    workflow: Workflow,
    authoredExpressions?: ReadonlySet<string>,
    deferredExpressions?: readonly DeferredExpression[],
    writtenReferences: readonly WrittenReference[] = [],
  ): Promise<void> {
    const dir = this.getWorkflowsDir();
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(workflow);
    await this.notifyDirty(targetPath);
    const data = {
      ...workflow.toData(),
      deferredExpressions: deferredExpressions?.length
        ? deferredExpressions
        : undefined,
      authoredExpressions: authoredExpressions === undefined
        ? undefined
        : [...authoredExpressions],
      writtenReferences: writtenReferences.length
        ? writtenReferences
        : undefined,
      sensitiveFormat: SENSITIVE_FORMAT_VERSION,
    };
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);

    // Clean up old file if it's at a different path
    const previousPath = this.idToActualPath.get(workflow.id);
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Also check legacy UUID path
    const legacyPath = this.getLegacyPath(workflow.id);
    if (targetPath !== legacyPath && previousPath !== legacyPath) {
      try {
        await Deno.remove(legacyPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.set(workflow.id, targetPath);
  }

  async delete(id: WorkflowId): Promise<void> {
    // Populate cache so we discover name-based files on a cold instance
    const workflow = await this.findById(id);

    const pathsToTry = new Set([this.getLegacyPath(id)]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);
    if (workflow && isFilenameSafeName(workflow.name)) {
      pathsToTry.add(this.getNamePath(workflow.name));
    }

    const resolvedPath = cachedPath ?? this.getLegacyPath(id);
    await this.notifyDirty(resolvedPath);

    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.delete(id);
  }

  /**
   * Clears all evaluated workflows.
   */
  async clear(): Promise<void> {
    const dir = this.getWorkflowsDir();
    await this.notifyDirty(dir);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    this.idToActualPath.clear();
  }

  getPath(id: WorkflowId): string {
    return this.idToActualPath.get(id) ?? this.getLegacyPath(id);
  }

  async saveForRun(
    runId: string,
    workflow: Workflow,
    writtenReferences: readonly WrittenReference[] = [],
  ): Promise<void> {
    const dir = await this.runDir(runId);
    await ensureDir(dir);

    const targetPath = join(dir, "evaluated-workflow.yaml");
    await this.notifyDirty(targetPath);
    const data = {
      ...workflow.toData(),
      writtenReferences: writtenReferences.length
        ? writtenReferences
        : undefined,
      sensitiveFormat: SENSITIVE_FORMAT_VERSION,
    };
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);
  }

  async findByRunId(runId: string): Promise<Workflow | null> {
    const dir = await this.runDir(runId);
    const targetPath = join(dir, "evaluated-workflow.yaml");
    try {
      const content = await Deno.readTextFile(targetPath);
      const cached = parseCache(content);
      if (cached) {
        return cached.workflow;
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    return null;
  }

  async listRunSnapshots(): Promise<RunSnapshotInfo[]> {
    const runsDir = join(this.baseDir, "runs");
    const snapshots: RunSnapshotInfo[] = [];
    try {
      for await (const entry of Deno.readDir(runsDir)) {
        if (
          !entry.isDirectory || entry.name.startsWith(".") ||
          !isSinglePathSegment(entry.name)
        ) continue;
        // An unknown mtime counts as fresh, so the orphan age guard never
        // collects a snapshot whose age it cannot establish.
        try {
          const stat = await Deno.stat(
            join(runsDir, entry.name, "evaluated-workflow.yaml"),
          );
          snapshots.push({
            runId: entry.name,
            modifiedAt: stat.mtime ?? new Date(),
            sizeBytes: stat.size,
          });
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          // The snapshot file is missing (partial write or concurrent
          // delete) — fall back to the directory itself so the empty
          // directory is still collectable.
          try {
            const dirStat = await Deno.stat(join(runsDir, entry.name));
            snapshots.push({
              runId: entry.name,
              modifiedAt: dirStat.mtime ?? new Date(),
              sizeBytes: 0,
            });
          } catch (dirError) {
            if (!(dirError instanceof Deno.errors.NotFound)) throw dirError;
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }
    return snapshots;
  }

  async deleteForRun(runId: string): Promise<void> {
    const dir = await this.runDir(runId);
    await this.notifyDirty(dir);
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  /**
   * Resolves `runs/<runId>/`. The run ID must be a single path segment:
   * `""`, `.` or `..` would resolve to `runs/` or the repository base itself,
   * which `assertSafePath` accepts because it equals or sits inside the base.
   */
  private async runDir(runId: string): Promise<string> {
    if (!isSinglePathSegment(runId)) {
      throw new Error(
        `Invalid run ID for a workflow snapshot path: ${JSON.stringify(runId)}`,
      );
    }
    const dir = join(this.baseDir, "runs", runId);
    await assertSafePath(dir, this.baseDir);
    return dir;
  }

  private resolveWritePath(workflow: Workflow): string {
    if (isFilenameSafeName(workflow.name)) {
      return this.getNamePath(workflow.name);
    }
    return this.getLegacyPath(workflow.id);
  }

  private getNamePath(name: string): string {
    return join(this.getWorkflowsDir(), `workflow-${name}.yaml`);
  }

  private getLegacyPath(id: WorkflowId): string {
    return join(this.getWorkflowsDir(), `workflow-${id}.yaml`);
  }

  private getWorkflowsDir(): string {
    return this.baseDir;
  }
}
