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
import { judgeAutoDefinition } from "../../domain/retention/auto_definition_reaper.ts";
import { isRetentionExempt } from "../../domain/retention/retention_exemptions.ts";
import type {
  Definition,
  DefinitionId,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { Workflow } from "../../domain/workflows/workflow.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import type { YamlDefinitionRepository } from "../../infrastructure/persistence/yaml_definition_repository.ts";
import type { RepositoryContext } from "../../infrastructure/persistence/repository_factory.ts";
import type { YamlOutputRepository } from "../../infrastructure/persistence/yaml_output_repository.ts";
import type { YamlEvaluatedDefinitionRepository } from "../../infrastructure/persistence/yaml_evaluated_definition_repository.ts";
import type { Data } from "../../domain/data/data.ts";
import { readDirSorted } from "../../infrastructure/persistence/sorted_dir_entries.ts";
import { createAutoDefinitionLock } from "../models/direct_execution.ts";
import { getSwampLogger } from "../../infrastructure/logging/logger.ts";

const logger = getSwampLogger(["retention", "auto-definitions"]);

/** the pass holds serve's sync gate, so a lock being taken is never waited out */
export const AUTO_DEFINITION_RETENTION_LOCK_WAIT_MS = 250;

export interface AutoDefinitionLockHandle {
  release(): Promise<void>;
}

export interface AutoDefinitionRetentionSources {
  autoDefinitionsDir: string;
  autoDefinitionRepo: Pick<
    YamlDefinitionRepository,
    "readDefinitionFile" | "delete"
  >;
  outputRepo: Pick<YamlOutputRepository, "definitionIdsWithOutputs">;
  dataRepo: {
    findAllForModel(type: ModelType, modelId: string): Promise<Data[]>;
  };
  evaluatedDefinitionRepo: Pick<YamlEvaluatedDefinitionRepository, "delete">;
  workflowRepo: Pick<WorkflowRepository, "findAll">;
  /**
   * null when a run holds the model's lock. Omitted where the caller already
   * excludes runs, as the CLI pass does by holding the datastore lock.
   */
  tryLockModel?(
    type: ModelType,
    id: string,
  ): Promise<AutoDefinitionLockHandle | null>;
}

export interface AutoDefinitionCandidate {
  type: ModelType;
  definition: Definition;
  path: string;
}

export interface AutoDefinitionBatchResult {
  removed: AutoDefinitionCandidate[];
  bytesReclaimed: number;
  more: boolean;
}

export interface AutoDefinitionReaper {
  /** judges up to limit more candidates; removes the idle ones unless dryRun */
  collectBatch(
    cutoff: Date,
    limit: number,
    options?: { dryRun?: boolean },
  ): Promise<AutoDefinitionBatchResult>;
}

interface ScannedFile {
  path: string;
  typeSegments: string[];
  modifiedAt: Date | null;
  size: number;
}

/** state lives for one pass: the file list is taken once, then walked in batches */
export function createAutoDefinitionReaper(
  sources: AutoDefinitionRetentionSources,
): AutoDefinitionReaper {
  const repo = sources.autoDefinitionRepo;
  let scan: { files: ScannedFile[]; next: number } | undefined;
  let references: Set<string> | undefined;

  const scanOnce = async (cutoff: Date) => {
    if (!scan) {
      const files: ScannedFile[] = [];
      await walk(sources.autoDefinitionsDir, [], files);
      // only an old file can be removed, so younger ones are never parsed
      scan = {
        files: files.filter((file) =>
          file.modifiedAt !== null &&
          file.modifiedAt.getTime() < cutoff.getTime() &&
          !isRetentionExempt(file.typeSegments.join("/"))
        ),
        next: 0,
      };
    }
    return scan;
  };

  const referencedNames = async (): Promise<Set<string>> => {
    references ??= literalModelReferences(await sources.workflowRepo.findAll());
    return references;
  };

  return {
    async collectBatch(cutoff, limit, options = {}) {
      const state = await scanOnce(cutoff);
      const slice = state.files.slice(state.next, state.next + limit);
      state.next += slice.length;
      const referenced = await referencedNames();
      const outputIds = new Map<string, Set<string>>();
      const idle: { candidate: AutoDefinitionCandidate; size: number }[] = [];
      for (const file of slice) {
        const read = await repo.readDefinitionFile(
          file.path,
          file.typeSegments,
          false,
        );
        if (!read) continue;
        // a retyped file is found under its declared type, never this path
        if (read.type.toDirectoryPath() !== file.typeSegments.join("/")) {
          continue;
        }
        const candidate = { ...read, path: file.path };
        const ids = await outputIdsOf(outputIds, sources, read.type);
        const facts = {
          modelType: read.type.normalized,
          modifiedAt: file.modifiedAt,
          hasData: false,
          hasOutputs: ids.has(read.definition.id),
          referencedByWorkflow: referenced.has(read.definition.id) ||
            referenced.has(read.definition.name),
        };
        if (!judgeAutoDefinition(facts, cutoff).removable) continue;
        if (await hasData(sources, candidate)) continue;
        idle.push({ candidate, size: file.size });
      }

      const more = state.next < state.files.length;
      if (options.dryRun) {
        return {
          removed: idle.map((i) => i.candidate),
          bytesReclaimed: 0,
          more,
        };
      }
      const removed: AutoDefinitionCandidate[] = [];
      let bytesReclaimed = 0;
      // the batch's locks are taken first, so the outputs are listed again
      // once per type rather than once per definition
      const held: {
        candidate: AutoDefinitionCandidate;
        size: number;
        release: () => Promise<void>;
      }[] = [];
      try {
        for (const entry of idle) {
          const release = await lockCandidate(sources, entry.candidate);
          if (release) held.push({ ...entry, release });
        }
        const fresh = new Map<string, Set<string>>();
        for (const { candidate, size } of held) {
          if (
            await removeIfStillIdle(sources, repo, candidate, cutoff, fresh)
          ) {
            removed.push(candidate);
            bytesReclaimed += size;
          }
        }
      } finally {
        for (const { release } of held.reverse()) await release();
      }
      return { removed, bytesReclaimed, more };
    },
  };
}

async function outputIdsOf(
  cache: Map<string, Set<string>>,
  sources: AutoDefinitionRetentionSources,
  type: ModelType,
): Promise<Set<string>> {
  let ids = cache.get(type.normalized);
  if (!ids) {
    ids = await sources.outputRepo.definitionIdsWithOutputs(type);
    cache.set(type.normalized, ids);
  }
  return ids;
}

async function hasData(
  sources: AutoDefinitionRetentionSources,
  candidate: AutoDefinitionCandidate,
): Promise<boolean> {
  return (await sources.dataRepo.findAllForModel(
    candidate.type,
    candidate.definition.id,
  )).length > 0;
}

/**
 * the create lock keeps a by-name run from adopting the file mid-delete; the
 * model lock keeps a run of this id out; both are tried, never waited on
 */
async function lockCandidate(
  sources: AutoDefinitionRetentionSources,
  candidate: AutoDefinitionCandidate,
): Promise<(() => Promise<void>) | null> {
  const createLock = createAutoDefinitionLock(
    sources.autoDefinitionsDir,
    candidate.definition.name,
  );
  if (!(await createLock.tryAcquire())) return null;
  try {
    const modelLock = sources.tryLockModel
      ? await sources.tryLockModel(candidate.type, candidate.definition.id)
      : undefined;
    if (modelLock === null) {
      await createLock.release();
      return null;
    }
    return async () => {
      try {
        await modelLock?.release();
      } finally {
        await createLock.release();
      }
    };
  } catch (error) {
    await createLock.release();
    throw error;
  }
}

/** checked again under the locks: a run may have written since the scan */
async function removeIfStillIdle(
  sources: AutoDefinitionRetentionSources,
  repo: AutoDefinitionRetentionSources["autoDefinitionRepo"],
  candidate: AutoDefinitionCandidate,
  cutoff: Date,
  freshOutputIds: Map<string, Set<string>>,
): Promise<boolean> {
  const { type, definition } = candidate;
  try {
    const current = await repo.readDefinitionFile(
      candidate.path,
      type.toDirectoryPath().split("/"),
      false,
    );
    if (current?.definition.id !== definition.id) return false;
    const stat = await Deno.lstat(candidate.path);
    if (!stat.mtime || stat.mtime.getTime() >= cutoff.getTime()) return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  if (
    (await outputIdsOf(freshOutputIds, sources, type)).has(definition.id) ||
    await hasData(sources, candidate)
  ) {
    return false;
  }
  await sources.evaluatedDefinitionRepo.delete(type, definition.id);
  await repo.delete(type, definition.id as DefinitionId, definition.name);
  logger
    .debug`Removed idle auto-definition ${definition.name} (${type.normalized})`;
  return true;
}

/** expression-named steps are not seen; their definition is re-created by name */
function literalModelReferences(workflows: Workflow[]): Set<string> {
  const refs = new Set<string>();
  for (const workflow of workflows) {
    for (const job of workflow.jobs) {
      for (const step of job.steps) {
        const data = step.task.data;
        if (data.type !== "model_method") continue;
        if (data.modelIdOrName) refs.add(data.modelIdOrName);
        if (data.modelName) refs.add(data.modelName);
      }
    }
  }
  return refs;
}

async function walk(
  dir: string,
  segments: string[],
  out: ScannedFile[],
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = await readDirSorted(dir);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    throw error;
  }
  for (const entry of entries) {
    // dot entries are lock directories, never definitions
    if (entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      await walk(path, [...segments, entry.name], out);
    } else if (entry.isFile && entry.name.endsWith(".yaml")) {
      try {
        const stat = await Deno.lstat(path);
        out.push({
          path,
          typeSegments: segments,
          modifiedAt: stat.mtime,
          size: stat.size,
        });
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
  }
}

export function autoDefinitionRetentionSourcesOf(
  repoContext: Pick<
    RepositoryContext,
    | "autoDefinitionsDir"
    | "autoDefinitionRepo"
    | "outputRepo"
    | "unifiedDataRepo"
    | "evaluatedDefinitionRepo"
    | "workflowRepo"
  >,
  tryLockModel?: AutoDefinitionRetentionSources["tryLockModel"],
): AutoDefinitionRetentionSources {
  return {
    autoDefinitionsDir: repoContext.autoDefinitionsDir,
    autoDefinitionRepo: repoContext.autoDefinitionRepo,
    outputRepo: repoContext.outputRepo,
    dataRepo: repoContext.unifiedDataRepo,
    evaluatedDefinitionRepo: repoContext.evaluatedDefinitionRepo,
    workflowRepo: repoContext.workflowRepo,
    ...(tryLockModel ? { tryLockModel } : {}),
  };
}
