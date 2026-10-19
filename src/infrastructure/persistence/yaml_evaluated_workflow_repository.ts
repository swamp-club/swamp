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
import { ensureDir, walk } from "@std/fs";
import { join, relative, SEPARATOR } from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { z } from "zod";
import {
  signalChange,
  stageTyped,
  typedStagingActive,
} from "./unit_of_work_scope.ts";
import {
  keyUnder,
  type PriorFile,
  readPriorFile,
  readPriors,
  unlessUnpartitionable,
} from "./config_staging.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import {
  ConfigChanges,
  RunSnapshotChanges,
} from "../../domain/datastore_v3/repository_changes.ts";
import { atomicWriteTextFile } from "./atomic_write.ts";
import type { WorkflowId } from "../../domain/workflows/workflow_id.ts";
import { SWAMP_SUBDIRS, swampPath } from "./paths.ts";
import { assertSafePath, isSinglePathSegment } from "./safe_path.ts";
import {
  isFilenameSafeName,
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import type {
  MarkDirtyHook,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  SENSITIVE_FORMAT_VERSION,
  type WrittenReference,
  WrittenReferenceSchema,
} from "../../domain/secrets/mod.ts";
import type {
  RunSnapshotInfo,
  RunSnapshotRepository,
} from "../../domain/workflows/repositories.ts";
import { ProvenanceMap } from "../../domain/expressions/provenance_map.ts";

export interface EvaluatedWorkflowCache {
  workflow: Workflow;
  /**
   * Where data sits in the workflow, in the coordinates of the raw copy
   * rehydrate restores (swamp-club#3205). Absent in caches written before
   * provenance was recorded; `"unreadable"` when present but malformed, which
   * replay refuses.
   */
  provenance?: ProvenanceMap | "unreadable";
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
  /**
   * The workflow inputs the cache was evaluated with, which a run replaying
   * it records as its own (swamp-club#3583). Absent in caches written before
   * they were recorded. Kept apart from the workflow's `inputs`, its schema.
   */
  evaluatedInputs?: Record<string, unknown>;
  /**
   * The authored expressions evaluation substituted into the workflow when
   * the cache was written; the others resolve when it is replayed. Absent in
   * caches written before it was recorded.
   */
  resolvedExpressions?: ReadonlySet<string>;
}

// Cache metadata is deliberately separate from the source Workflow schema,
// which rejects unknown top-level keys — it must be split off before parsing.
const CacheMetadataSchema = z.object({
  authoredExpressions: z.array(z.string()).optional(),
  deferredExpressions: z.array(DeferredExpressionSchema).optional(),
  writtenReferences: z.array(WrittenReferenceSchema).optional(),
  sensitiveFormat: z.number().int().positive().optional(),
  provenance: z.unknown().optional(),
  evaluatedInputs: z.record(z.string(), z.unknown()).optional(),
  resolvedExpressions: z.array(z.string()).optional(),
});

function parseCache(content: string): EvaluatedWorkflowCache | null {
  const data = parseYaml(content) as
    | (WorkflowData & {
      authoredExpressions?: unknown;
      deferredExpressions?: unknown;
      writtenReferences?: unknown;
      sensitiveFormat?: unknown;
      provenance?: unknown;
      evaluatedInputs?: unknown;
      resolvedExpressions?: unknown;
    })
    | null;
  if (!data) return null;
  const {
    authoredExpressions,
    deferredExpressions,
    writtenReferences,
    sensitiveFormat,
    provenance: provenanceData,
    evaluatedInputs,
    resolvedExpressions,
    ...workflowData
  } = data;
  const metadata = CacheMetadataSchema.parse({
    authoredExpressions,
    deferredExpressions,
    writtenReferences,
    sensitiveFormat,
    provenance: provenanceData,
    evaluatedInputs,
    resolvedExpressions,
  });
  let provenance: ProvenanceMap | "unreadable" | undefined;
  if (metadata.provenance !== undefined) {
    try {
      provenance = ProvenanceMap.fromData(metadata.provenance);
    } catch {
      provenance = "unreadable";
    }
  }
  return {
    workflow: Workflow.fromData(workflowData),
    provenance,
    authoredExpressions: new Set(metadata.authoredExpressions),
    deferredExpressions: metadata.deferredExpressions ?? [],
    writtenReferences: metadata.writtenReferences ?? [],
    sensitiveFormat: metadata.sensitiveFormat,
    evaluatedInputs: metadata.evaluatedInputs,
    resolvedExpressions: metadata.resolvedExpressions === undefined
      ? undefined
      : new Set(metadata.resolvedExpressions),
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

  /**
   * `unreadableContent` tells an evaluated workflow a v3 read model could not
   * materialise from an absent one (swamp-club#3617), so `--last-evaluated`
   * fails loudly on it instead of finding no evaluation. A run's snapshot
   * ({@link findByRunId}) is not loud: every reader settles against the
   * workflow definition when it cannot read one.
   */
  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirtyHook?: MarkDirtyHook,
    private readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.baseDir = baseDir ??
      swampPath(repoDir, SWAMP_SUBDIRS.workflowsEvaluated);
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
    if (isFilenameSafeName(name)) {
      const error = await this.unreadableContent?.(this.getNamePath(name));
      if (error !== undefined) throw error;
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
   * @param evaluatedInputs - The workflow inputs `workflow` was evaluated
   *   with, restored as {@link EvaluatedWorkflowCache.evaluatedInputs}
   * @param resolvedExpressions - The authored expressions evaluation
   *   substituted, restored as
   *   {@link EvaluatedWorkflowCache.resolvedExpressions}
   */
  async save(
    workflow: Workflow,
    /**
     * Where data sits in the raw copy of `workflow` (swamp-club#3205).
     * Required so every writer states it; `undefined` writes the legacy
     * format, which replays with the raw-text rule alone.
     */
    provenance: ProvenanceMap | undefined,
    authoredExpressions?: ReadonlySet<string>,
    deferredExpressions?: readonly DeferredExpression[],
    writtenReferences: readonly WrittenReference[] = [],
    evaluatedInputs?: Record<string, unknown>,
    resolvedExpressions?: ReadonlySet<string>,
  ): Promise<void> {
    const dir = this.getWorkflowsDir();
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(workflow);
    await signalChange(
      this.markDirtyHook,
      { kind: "write", path: targetPath },
      { typed: true },
    );
    const previousPath = this.idToActualPath.get(workflow.id);
    const legacyPath = this.getLegacyPath(workflow.id);
    // On v3, the names the files declared before this save, read before it
    // replaces or removes them: a fresh repository's id cache is cold, so a
    // rename is known only from them (swamp-club#3256).
    const priors = typedStagingActive(this.markDirtyHook)
      ? await readPriors([targetPath, previousPath, legacyPath])
      : new Map<string, PriorFile>();
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
      provenance: provenance?.toData(),
      evaluatedInputs,
      resolvedExpressions: resolvedExpressions === undefined
        ? undefined
        : [...resolvedExpressions],
    };
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);
    // The paths a removal below actually removed, for their v3 tombstones.
    const removed: string[] = [];

    // Clean up old file if it's at a different path
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
        removed.push(previousPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    // Also check legacy UUID path
    if (targetPath !== legacyPath && previousPath !== legacyPath) {
      try {
        await Deno.remove(legacyPath);
        removed.push(legacyPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.set(workflow.id, targetPath);
    await this.stageSave(workflow.name, targetPath, content, removed, priors);
  }

  /**
   * Stages a save on v3 (swamp-club#3256). The evaluated workflow is derived,
   * so nothing carries a precondition. The save, and the removal of any file
   * that declared the same name, is one batch in the workflow's partition.
   * Each removed file that declared another name, and a target that held
   * another name (a same-key rename between two names stored at the uuid
   * path), is tombstoned in that name's partition in a later batch, so the
   * new name lands first.
   */
  private async stageSave(
    name: string,
    targetPath: string,
    content: string,
    removed: readonly string[],
    priors: ReadonlyMap<string, PriorFile>,
  ): Promise<void> {
    const elsewhere = new Map<string, string[]>();
    const here: string[] = [];
    for (const path of removed) {
      const declared = priors.get(path)?.name ?? name;
      if (declared === name) here.push(path);
      else elsewhere.set(declared, [...(elsewhere.get(declared) ?? []), path]);
    }
    const targetName = priors.get(targetPath)?.name;
    if (targetName !== undefined && targetName !== name) {
      elsewhere.set(targetName, [
        ...(elsewhere.get(targetName) ?? []),
        targetPath,
      ]);
    }
    await stageTyped(this.markDirtyHook, () => {
      const changes = new ConfigChanges("workflow", name);
      return [
        changes.write(
          "evaluated-workflow.save",
          this.keyOf(targetPath),
          new TextEncoder().encode(content),
        ),
        ...here.map((path) =>
          changes.remove("evaluated-workflow.delete", this.keyOf(path))
        ),
      ];
    });
    for (const [oldName, paths] of elsewhere) {
      await stageTyped(this.markDirtyHook, () => {
        const changes = new ConfigChanges("workflow", oldName);
        return paths.map((path) =>
          changes.remove("evaluated-workflow.delete", this.keyOf(path))
        );
      });
    }
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
    await signalChange(this.markDirtyHook, {
      kind: "remove",
      path: resolvedPath,
    }, { typed: true });
    const priors = typedStagingActive(this.markDirtyHook)
      ? await readPriors([...pathsToTry])
      : new Map<string, PriorFile>();

    const removed: string[] = [];
    for (const path of pathsToTry) {
      try {
        await Deno.remove(path);
        removed.push(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    this.idToActualPath.delete(id);
    // On v3: a tombstone of each removed file in the partition of the name it
    // declared; a file that names no workflow stages nothing.
    await stageTyped(this.markDirtyHook, () =>
      removed.flatMap((path) => {
        const name = priors.get(path)?.name ?? workflow?.name;
        const change = name === undefined
          ? undefined
          : unlessUnpartitionable(() =>
            new ConfigChanges("workflow", name).remove(
              "evaluated-workflow.delete",
              this.keyOf(path),
            )
          );
        return change === undefined ? [] : [change];
      }));
  }

  /**
   * Clears all evaluated workflows.
   */
  async clear(): Promise<void> {
    const dir = this.getWorkflowsDir();
    await signalChange(this.markDirtyHook, { kind: "remove", path: dir }, {
      typed: true,
    });
    // On v3, each file's partition is read before the removal destroys it,
    // so the directory removal stages one tombstone per file.
    const tombstones = typedStagingActive(this.markDirtyHook)
      ? await this.tombstonesOfAll()
      : [];
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    this.idToActualPath.clear();
    await stageTyped(this.markDirtyHook, () => tombstones);
  }

  /**
   * A tombstone for every file under the base: an evaluated workflow in the
   * partition of the name it declares, a run snapshot in its run's
   * partition. Fields come from the raw YAML, never a schema parse; a file
   * that names no valid aggregate stages nothing, as no repository put it.
   */
  private async tombstonesOfAll(): Promise<TypedChange[]> {
    const tombstones: TypedChange[] = [];
    try {
      for await (
        const entry of walk(this.baseDir, {
          includeDirs: false,
          exts: [".yaml"],
        })
      ) {
        const prior = await readPriorFile(entry.path);
        const segments = relative(this.baseDir, entry.path).split(SEPARATOR);
        const change = unlessUnpartitionable(() => {
          if (segments.length === 3 && segments[0] === "runs") {
            return prior?.id === undefined
              ? undefined
              : new RunSnapshotChanges(prior.id, segments[1]).remove(
                this.keyOf(entry.path),
              );
          }
          return segments.length !== 1 || prior?.name === undefined
            ? undefined
            : new ConfigChanges("workflow", prior.name).remove(
              "evaluated-workflow.delete",
              this.keyOf(entry.path),
            );
        });
        if (change !== undefined) tombstones.push(change);
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return tombstones;
  }

  /** The record key of a file under the base. */
  private keyOf(path: string) {
    return keyUnder(SWAMP_SUBDIRS.workflowsEvaluated, this.baseDir, path);
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
    await signalChange(
      this.markDirtyHook,
      { kind: "write", path: targetPath },
      { typed: true },
    );
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
    // On v3, the run's snapshot, which is derived: no precondition.
    await stageTyped(this.markDirtyHook, () => [
      new RunSnapshotChanges(workflow.id, runId).write(
        this.keyOf(targetPath),
        new TextEncoder().encode(content),
      ),
    ]);
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
    await signalChange(this.markDirtyHook, { kind: "remove", path: dir }, {
      typed: true,
    });
    // On v3, the snapshot's workflow id, read before the removal: run GC
    // passes directory names, so a run id that is not a UUID, or a snapshot
    // that is missing or names no workflow, stages nothing (no repository put
    // it) rather than abort the collection.
    const snapshotPath = join(dir, "evaluated-workflow.yaml");
    const snapshot = typedStagingActive(this.markDirtyHook)
      ? await readPriorFile(snapshotPath)
      : undefined;
    try {
      await Deno.remove(dir, { recursive: true });
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
    await stageTyped(this.markDirtyHook, () => {
      const workflowId = snapshot?.id;
      const change = workflowId === undefined
        ? undefined
        : unlessUnpartitionable(() =>
          new RunSnapshotChanges(workflowId, runId).remove(
            this.keyOf(snapshotPath),
          )
        );
      return change === undefined ? [] : [change];
    });
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
