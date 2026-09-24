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

import { ensureDir } from "@std/fs";
import { dirname, join, normalize, relative, SEPARATOR } from "@std/path";
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
import { lifetimeToMs } from "../../domain/data/data_metadata.ts";

/**
 * Minimum age before run gc treats an unreferenced run log as orphaned,
 * whatever the retention cutoff. A direct model method run writes its output
 * record only when it finishes, so for its whole duration its log has no
 * record pointing at it. The log's mtime moves with every line written, so
 * only a run that has been silent this long could lose its log.
 */
const ORPHAN_LOG_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * YAML-based implementation of OutputRepository.
 *
 * Stores outputs as YAML files in the directory structure:
 * {repoDir}/.swamp/outputs/{normalized-type}/{method}/{definition-id}-{timestamp}.yaml
 */
export class YamlOutputRepository implements OutputRepository {
  private readonly baseDir: string;
  /**
   * Where run logs are written. Always repo-local, so it differs from
   * baseDir when outputs are stored in a datastore.
   */
  private readonly localOutputsDir: string;

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
  ) {
    this.localOutputsDir = swampPath(repoDir, SWAMP_SUBDIRS.outputs);
    this.baseDir = baseDir ?? this.localOutputsDir;
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
        if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
        const path = join(dir, entry.name);

        // Per-file try/catch closes the TOCTOU window: a concurrent
        // delete can remove a non-target file between readDir and
        // readTextFile. NotFound on a single file means "skip it" —
        // never "abort the search and return null when the target
        // exists later in the directory."
        try {
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData | null;
          if (!data) continue;
          if (data.id === id) {
            // Convert logFile back to absolute path
            if (data.logFile) {
              data.logFile = toAbsolutePath(this.repoDir, data.logFile);
            }
            return ModelOutput.fromData(data);
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
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
        if (!methodEntry.isDirectory) continue;
        const methodDir = join(typeDir, methodEntry.name);

        // Per-method-directory try/catch closes the directory-level
        // TOCTOU window: a concurrent bulk delete can remove the
        // method directory between readDir(typeDir) and
        // readDir(methodDir). NotFound on a single method directory
        // means "skip it" — never "abandon outputs already collected
        // from earlier method directories of this type."
        try {
          // Iterate over output files in method directory
          for await (const entry of Deno.readDir(methodDir)) {
            if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
            const path = join(methodDir, entry.name);

            // Per-file try/catch closes the TOCTOU window: a concurrent
            // delete (e.g. GC, output cleanup) can remove the file
            // between readDir and readTextFile. NotFound on a single
            // file means "skip it" — never "abandon the rest of the
            // current method directory."
            try {
              const content = await Deno.readTextFile(path);
              const data = parseYaml(content) as ModelOutputData | null;
              if (!data) continue;
              if (data.logFile) {
                data.logFile = toAbsolutePath(this.repoDir, data.logFile);
              }
              outputs.push(ModelOutput.fromData(data));
            } catch (error) {
              if (error instanceof Deno.errors.NotFound) continue;
              throw error;
            }
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }
    } catch (error) {
      // Outer catch handles "type directory itself doesn't exist."
      // Per-method-dir and per-file NotFound are handled above.
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

          // Per-method-directory try/catch closes the directory-level
          // TOCTOU window: a concurrent bulk delete can remove the
          // method directory between readDir(typeDir) and
          // readDir(methodDir). NotFound on a single method directory
          // means "skip it" — never "abandon results already collected
          // from earlier method directories of this type."
          try {
            for await (const entry of Deno.readDir(methodDir)) {
              if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
              const path = join(methodDir, entry.name);

              // Per-file try/catch closes the TOCTOU window: a concurrent
              // delete can remove the file between readDir and stat or
              // between stat and readTextFile. NotFound on a single file
              // means "skip it" — never "abandon the rest of the current
              // method directory or model type."
              try {
                // Stage A: mtime pre-filter
                const stat = await Deno.stat(path);
                const mtimeMs = stat.mtime?.getTime();
                if (mtimeMs !== undefined && mtimeMs < cutoffMs) continue;

                // Stage B: parse and verify
                const content = await Deno.readTextFile(path);
                const data = parseYaml(content) as ModelOutputData | null;
                if (!data) continue;
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
              } catch (error) {
                if (error instanceof Deno.errors.NotFound) continue;
                throw error;
              }
            }
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
          }
        }
      } catch (error) {
        // Outer catch handles "type directory itself doesn't exist."
        // Per-method-dir and per-file NotFound are handled above.
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
    // Notify per-path once the match is found, before the Deno.remove —
    // same crash-safety as the unconditional pre-write notify. When no
    // match is found, nothing is removed and no signal is needed.
    //
    // Find-then-act structure: the per-file try/catch wraps only the
    // search (readTextFile + parseYaml + match check) so a concurrent
    // delete of a non-target file doesn't abort the search before we
    // reach the target. The destructive ops (notifyDirty + Deno.remove
    // + cleanupEmptyParentDirs) run after the loop, still inside the
    // outer try/catch — preserving the existing semantic that a
    // NotFound from Deno.remove (race: target deleted concurrently) is
    // absorbed and returns successfully (delete is idempotent).
    const dir = this.getMethodDir(type, method);
    try {
      let matchPath: string | null = null;
      let matchData: ModelOutputData | null = null;
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
        const path = join(dir, entry.name);

        try {
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData | null;
          if (!data) continue;
          if (data.id === id) {
            matchPath = path;
            matchData = data;
            break;
          }
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
      }

      if (matchPath) {
        await this.removeOutputFiles(
          matchPath,
          0,
          this.ownedLogPath(matchPath, matchData),
          false,
        );
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

  async deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    const cutoffMs = cutoff.getTime();
    return await this.deleteExpired(() => cutoffMs, options);
  }

  async deleteByMethodLifetime(
    fallbackCutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    const fallbackCutoffMs = fallbackCutoff.getTime();
    const nowMs = Date.now();

    const registeredTypes: {
      normalized: string;
      def: NonNullable<ReturnType<typeof modelRegistry.get>>;
    }[] = [];
    for (const modelType of modelRegistry.types()) {
      const def = modelRegistry.get(modelType);
      if (def) registeredTypes.push({ normalized: modelType.normalized, def });
    }
    registeredTypes.sort((a, b) => b.normalized.length - a.normalized.length);

    const cutoffFor = (relativePath: string): number => {
      let cutoffMs = fallbackCutoffMs;
      for (const { normalized, def } of registeredTypes) {
        const typePrefix = normalized.replaceAll("/", SEPARATOR);
        if (
          relativePath.startsWith(typePrefix + SEPARATOR)
        ) {
          const afterType = relativePath.slice(typePrefix.length + 1);
          const methodName = afterType.split(SEPARATOR)[0];
          const method = def.methods[methodName];
          if (method?.outputLifetime) {
            const lifetimeMs = lifetimeToMs(method.outputLifetime);
            if (lifetimeMs !== null) {
              const methodCutoffMs = nowMs - lifetimeMs;
              cutoffMs = Math.max(cutoffMs, methodCutoffMs);
            }
          }
          break;
        }
      }
      return cutoffMs;
    };

    return await this.deleteExpired(cutoffFor, options);
  }

  /**
   * Deletes terminal outputs whose startedAt is older than the cutoff for
   * their method directory, together with each output's own run log, then
   * sweeps run logs no remaining output references. `cutoffFor` takes a path
   * relative to an outputs root and returns the cutoff in epoch ms.
   */
  private async deleteExpired(
    cutoffFor: (relativePath: string) => number,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number }> {
    const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
    const dryRun = options?.dryRun ?? false;
    let deleted = 0;
    let bytesReclaimed = 0;
    // Outputs this pass deletes (or would delete, on a dry run) and the logs
    // already counted with them, so the orphan sweep neither treats a doomed
    // output as a live reference nor counts its log twice.
    const deletedYamls = new Set<string>();
    const countedLogs = new Set<string>();

    const yamlFiles = await this.collectFiles(this.baseDir, ".yaml");
    for (const yamlPath of yamlFiles) {
      try {
        const cutoffMs = cutoffFor(yamlPath.slice(this.baseDir.length + 1));

        const stat = await Deno.stat(yamlPath);
        const mtimeMs = stat.mtime?.getTime();
        if (mtimeMs !== undefined && mtimeMs >= cutoffMs) continue;

        const content = await Deno.readTextFile(yamlPath);
        const data = parseYaml(content) as ModelOutputData | null;
        if (data) {
          if (!TERMINAL_STATUSES.has(data.status)) continue;
          const startedAt = data.startedAt
            ? new Date(data.startedAt).getTime()
            : undefined;
          if (
            startedAt === undefined || Number.isNaN(startedAt) ||
            startedAt >= cutoffMs
          ) continue;
        }

        const logPath = this.ownedLogPath(yamlPath, data);
        bytesReclaimed += await this.removeOutputFiles(
          yamlPath,
          stat.size ?? 0,
          logPath,
          dryRun,
        );
        deletedYamls.add(yamlPath);
        if (logPath) countedLogs.add(logPath);
        deleted++;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }

    bytesReclaimed += await this.sweepOrphanLogs(
      cutoffFor,
      deletedYamls,
      countedLogs,
      dryRun,
    );

    return { deleted, bytesReclaimed };
  }

  /**
   * Removes an output record and its run log, returning the bytes reclaimed.
   * Paths under baseDir are marked dirty before removal so datastore sync
   * propagates the deletions; a repo-local log beside a datastore is never
   * synced. On a dry run nothing is touched and only bytes are counted.
   */
  private async removeOutputFiles(
    yamlPath: string,
    yamlBytes: number,
    logPath: string | null,
    dryRun: boolean,
  ): Promise<number> {
    let bytes = yamlBytes;
    let logExists = false;
    if (logPath) {
      try {
        const logStat = await Deno.stat(logPath);
        bytes += logStat.size ?? 0;
        logExists = true;
      } catch {
        // log file may not exist
      }
    }
    if (dryRun) return bytes;

    await this.notifyDirty(yamlPath);
    if (logPath && logExists && this.inBaseDir(logPath)) {
      await this.notifyDirty(logPath);
    }
    try {
      await Deno.remove(yamlPath);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    if (logPath && logExists) {
      try {
        await Deno.remove(logPath);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
      await cleanupEmptyParentDirs(logPath, this.rootFor(logPath));
    }
    await cleanupEmptyParentDirs(yamlPath, this.baseDir);
    return bytes;
  }

  /**
   * Removes run logs in the repo-local outputs root that no remaining output
   * references: logs left behind before outputs were deleted by their
   * recorded logFile, and logs of runs that failed before their output was
   * saved. A log must be older than both its method's cutoff and
   * ORPHAN_LOG_MIN_AGE_MS, since a run still in progress has no output record
   * yet. A method directory whose records cannot all be read is skipped.
   */
  private async sweepOrphanLogs(
    cutoffFor: (relativePath: string) => number,
    deletedYamls: Set<string>,
    countedLogs: Set<string>,
    dryRun: boolean,
  ): Promise<number> {
    const floorMs = Date.now() - ORPHAN_LOG_MIN_AGE_MS;
    const candidatesByDir = new Map<
      string,
      { path: string; size: number }[]
    >();

    const logFiles = await this.collectFiles(this.localOutputsDir, ".log");
    for (const logPath of logFiles) {
      if (countedLogs.has(logPath)) continue;
      try {
        const stat = await Deno.stat(logPath);
        const mtimeMs = stat.mtime?.getTime();
        if (mtimeMs === undefined) continue;
        const cutoffMs = Math.min(
          cutoffFor(logPath.slice(this.localOutputsDir.length + 1)),
          floorMs,
        );
        if (mtimeMs >= cutoffMs) continue;
        const dir = dirname(logPath);
        const candidates = candidatesByDir.get(dir) ?? [];
        candidates.push({ path: logPath, size: stat.size ?? 0 });
        candidatesByDir.set(dir, candidates);
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }

    let bytes = 0;
    for (const [dir, candidates] of candidatesByDir) {
      const referenced = await this.referencedLogs(dir, deletedYamls);
      if (!referenced) continue;
      for (const candidate of candidates) {
        if (referenced.has(candidate.path)) continue;
        bytes += candidate.size;
        if (dryRun) continue;
        if (this.inBaseDir(candidate.path)) {
          await this.notifyDirty(candidate.path);
        }
        try {
          await Deno.remove(candidate.path);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        }
        await cleanupEmptyParentDirs(candidate.path, this.localOutputsDir);
      }
    }
    return bytes;
  }

  /**
   * Collects the run logs claimed by the outputs that remain for the method
   * directory `localDir`, reading YAMLs from that directory and from its
   * counterpart under baseDir. Returns null when a record cannot be read, so
   * the caller keeps every log rather than guess which one it claims.
   */
  private async referencedLogs(
    localDir: string,
    deletedYamls: Set<string>,
  ): Promise<Set<string> | null> {
    const referenced = new Set<string>();
    const dirs = new Set([
      localDir,
      join(this.baseDir, relative(this.localOutputsDir, localDir)),
    ]);
    for (const dir of dirs) {
      try {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
          const yamlPath = join(dir, entry.name);
          if (deletedYamls.has(yamlPath)) continue;
          try {
            const content = await Deno.readTextFile(yamlPath);
            const data = parseYaml(content) as ModelOutputData | null;
            const logPath = this.ownedLogPath(yamlPath, data);
            if (logPath) referenced.add(logPath);
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            return null;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) throw error;
      }
    }
    return referenced;
  }

  /**
   * Resolves the run log an output owns. The recorded logFile is used when it
   * points into the output's own method directory, either under baseDir or
   * under the repo-local outputs root, where every run log is written. Any
   * other logFile is not the output's to delete: workflow-step outputs point
   * at their workflow run's log. Records without a logFile (or unparseable
   * ones) fall back to the log sharing the YAML's filename stem.
   */
  private ownedLogPath(
    yamlPath: string,
    data: ModelOutputData | null,
  ): string | null {
    if (!data?.logFile) return yamlPath.replace(/\.yaml$/, ".log");
    const logPath = normalize(toAbsolutePath(this.repoDir, data.logFile));
    if (!logPath.endsWith(".log")) return null;
    const logDir = dirname(logPath);
    const yamlDir = normalize(dirname(yamlPath));
    const localYamlDir = join(
      this.localOutputsDir,
      relative(this.baseDir, yamlDir),
    );
    return logDir === yamlDir || logDir === localYamlDir ? logPath : null;
  }

  private inBaseDir(path: string): boolean {
    return path.startsWith(this.baseDir + SEPARATOR);
  }

  /** The outputs root a file lives under, for empty-directory cleanup. */
  private rootFor(path: string): string {
    return this.inBaseDir(path) ? this.baseDir : this.localOutputsDir;
  }

  private async collectFiles(
    dir: string,
    extension: string,
  ): Promise<string[]> {
    const files: string[] = [];
    try {
      for await (const entry of Deno.readDir(dir)) {
        const path = join(dir, entry.name);
        if (entry.isDirectory) {
          files.push(...await this.collectFiles(path, extension));
        } else if (entry.isFile && entry.name.endsWith(extension)) {
          files.push(path);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
    return files;
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
