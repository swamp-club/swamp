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

import { ensureDir } from "@std/fs";
import { join } from "@std/path";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { cleanupEmptyParentDirs } from "./directory_cleanup.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import {
  SWAMP_SUBDIRS,
  swampPath,
  toAbsolutePath,
  toRelativePath,
} from "./paths.ts";
import { assertSafePath } from "./safe_path.ts";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelOutputId,
  ModelOutput,
  type ModelOutputData,
  type ModelOutputId,
} from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";

/**
 * YAML-based implementation of OutputRepository.
 *
 * Stores outputs as YAML files in the directory structure:
 * {repoDir}/.swamp/outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml
 */
export class YamlOutputRepository implements OutputRepository {
  private readonly baseDir: string;

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
  ) {
    this.baseDir = baseDir ?? swampPath(repoDir, SWAMP_SUBDIRS.outputs);
  }

  private async notifyDirty(relPath?: string): Promise<void> {
    if (this.markDirty) await this.markDirty(relPath);
  }

  async findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null> {
    // We need to scan the directory since the filename includes a timestamp
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData;
          if (data.id === id) {
            // Convert logFile back to absolute path
            if (data.logFile) {
              data.logFile = toAbsolutePath(this.repoDir, data.logFile);
            }
            return ModelOutput.fromData(data);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return null;
      }
      throw error;
    }
    return null;
  }

  async findByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput[]> {
    const all = await this.findAll(type);
    return all.filter((output) => output.definitionId === definitionId);
  }

  async findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null> {
    const outputs = await this.findByDefinition(type, definitionId);
    if (outputs.length === 0) {
      return null;
    }

    // Sort by startedAt descending and return the first one
    outputs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    return outputs[0];
  }

  async findAll(type: ModelType): Promise<ModelOutput[]> {
    const typeDir = this.getTypeDir(type);
    const outputs: ModelOutput[] = [];

    try {
      // Iterate over method directories
      for await (const methodEntry of Deno.readDir(typeDir)) {
        if (methodEntry.isDirectory) {
          const methodDir = join(typeDir, methodEntry.name);
          // Iterate over output files in method directory
          for await (const entry of Deno.readDir(methodDir)) {
            if (entry.isFile && entry.name.endsWith(".yaml")) {
              const path = join(methodDir, entry.name);
              const content = await Deno.readTextFile(path);
              const data = parseYaml(content) as ModelOutputData;
              // Convert logFile back to absolute path
              if (data.logFile) {
                data.logFile = toAbsolutePath(this.repoDir, data.logFile);
              }
              outputs.push(ModelOutput.fromData(data));
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return outputs;
  }

  async findAllGlobal(): Promise<
    { output: ModelOutput; type: ModelType; method: string }[]
  > {
    const results: { output: ModelOutput; type: ModelType; method: string }[] =
      [];

    // Iterate over all registered model types
    for (const modelType of modelRegistry.types()) {
      const typeOutputs = await this.findAll(modelType);
      for (const output of typeOutputs) {
        results.push({
          output,
          type: modelType,
          method: output.methodName,
        });
      }
    }

    return results;
  }

  /**
   * Finds all outputs whose `startedAt` is at or after the cutoff using a
   * two-stage filter (mtime pre-filter, then parse-and-verify) so old YAML
   * files are skipped without being parsed. See the matching docstring on
   * `YamlWorkflowRunRepository.findAllGlobalSince` for the invariant.
   *
   * Output YAML is written exactly once at completion (`save()` does not
   * rewrite an existing file), so mtime ≈ startedAt + duration on disk.
   * Files older than the cutoff cannot have a startedAt on or after it.
   */
  async findAllGlobalSince(
    cutoff: Date,
  ): Promise<{ output: ModelOutput; type: ModelType; method: string }[]> {
    const results: { output: ModelOutput; type: ModelType; method: string }[] =
      [];
    const cutoffMs = cutoff.getTime();

    for (const modelType of modelRegistry.types()) {
      const typeDir = this.getTypeDir(modelType);
      try {
        for await (const methodEntry of Deno.readDir(typeDir)) {
          if (!methodEntry.isDirectory) continue;
          const methodDir = join(typeDir, methodEntry.name);
          for await (const entry of Deno.readDir(methodDir)) {
            if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
            const path = join(methodDir, entry.name);

            // Stage A: mtime pre-filter
            const stat = await Deno.stat(path);
            const mtimeMs = stat.mtime?.getTime();
            if (mtimeMs !== undefined && mtimeMs < cutoffMs) continue;

            // Stage B: parse and verify
            const content = await Deno.readTextFile(path);
            const data = parseYaml(content) as ModelOutputData;
            if (data.logFile) {
              data.logFile = toAbsolutePath(this.repoDir, data.logFile);
            }
            const output = ModelOutput.fromData(data);
            if (output.startedAt.getTime() < cutoffMs) continue;

            results.push({
              output,
              type: modelType,
              method: output.methodName,
            });
          }
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }

    return results;
  }

  async save(
    type: ModelType,
    method: string,
    output: ModelOutput,
  ): Promise<void> {
    const path = this.getPath(type, method, output);
    await this.notifyDirty(path);

    const dir = this.getMethodDir(type, method);
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);
    const data = output.toData();
    // Convert logFile to relative path for storage
    if (data.logFile) {
      data.logFile = toRelativePath(this.repoDir, data.logFile);
    }
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(path, content);
  }

  async delete(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<void> {
    // We need to find the file first since filename includes timestamp.
    // Notify per-path inside the loop once the match is found, before
    // the Deno.remove — same crash-safety as the unconditional pre-write
    // notify. When no match is found, nothing is removed and no signal
    // is needed.
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && entry.name.endsWith(".yaml")) {
          const path = join(dir, entry.name);
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData;
          if (data.id === id) {
            await this.notifyDirty(path);
            await Deno.remove(path);

            // Clean up empty parent directories
            const outputsDir = this.baseDir;
            await cleanupEmptyParentDirs(path, outputsDir);
            return;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw error;
      }
    }
  }

  nextId(): ModelOutputId {
    return createModelOutputId(crypto.randomUUID());
  }

  getPath(type: ModelType, method: string, output: ModelOutput): string {
    const timestamp = output.startedAt.toISOString().replace(/[:.]/g, "-");
    const filename = `${output.definitionId}-${timestamp}.yaml`;
    return join(this.getMethodDir(type, method), filename);
  }

  private getOutputsDir(): string {
    return this.baseDir;
  }

  private getTypeDir(type: ModelType): string {
    return join(this.getOutputsDir(), type.normalized);
  }

  private getMethodDir(type: ModelType, method: string): string {
    return join(this.getTypeDir(type), method);
  }
}
