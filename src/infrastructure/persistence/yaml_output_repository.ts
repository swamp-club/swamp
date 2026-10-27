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
import {
  currentDiagnosticTally,
  observeDiagnosticPhase,
  utf8ByteLength,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import {
  basename,
  dirname,
  join,
  normalize,
  relative,
  SEPARATOR,
} from "@std/path";
import { stageTyped, withChangeSignalled } from "./unit_of_work_scope.ts";
import type { TypedChange } from "../../domain/datastore_v3/commit_log_unit_of_work.ts";
import { ModelChanges } from "../../domain/datastore_v3/repository_changes.ts";
import type { StagedChange } from "../../domain/datastore/unit_of_work.ts";
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
import { isIoError } from "./io_errors.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import type { OutputRepository } from "../../domain/models/repositories.ts";
import type { DefinitionId } from "../../domain/definitions/definition.ts";
import type {
  MarkDirtyHook,
  UnreadableContentEntry,
  UnreadableContentLookup,
} from "../../domain/datastore/datastore_sync_service.ts";
import {
  mayBeUnreadableError,
  unreadableRecordsUnder,
  warnUnreadableLeftOut,
} from "./unreadable_records.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  createModelOutputId,
  ModelOutput,
  type ModelOutputData,
  type ModelOutputId,
} from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { lifetimeToMs } from "../../domain/data/data_metadata.ts";

const logger = getLogger(["output-repo"]);

/**
 * One-line reason a record could not be loaded: each failed field for a
 * validation error, the first line of anything else (YAML syntax errors
 * append a multi-line excerpt of the file).
 */
function describeRecordError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "record"}: ${issue.message}`)
      .join("; ");
  }
  const msg = error instanceof Error ? error.message : String(error);
  return msg.split("\n")[0];
}

/**
 * Minimum age before run gc treats an unreferenced run log as orphaned,
 * whatever the retention cutoff. A direct model method run writes its output
 * record only when it finishes, so for its whole duration its log has no
 * record pointing at it. The log's mtime moves with every line written, so
 * only a run that has been silent this long could lose its log.
 */
const ORPHAN_LOG_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** `startedAt` as an output file name spells it. */
function fileStamp(startedAt: Date): string {
  return startedAt.toISOString().replace(/[:.]/g, "-");
}

/** An output file name `<definitionId>-<stamp>.yaml`, as getPath writes it. */
const OUTPUT_FILE_NAME =
  /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.yaml$/;

/** The definition id and `startedAt` stamp an output file's name carries. */
function parseOutputFileName(
  path: string,
): { definitionId: string; stamp: string } | undefined {
  const match = OUTPUT_FILE_NAME.exec(basename(path));
  return match === null
    ? undefined
    : { definitionId: match[1], stamp: match[2] };
}

/** Counts the `candidate_scan` phase always exports, zero included. */
const CANDIDATE_SCAN_COUNTS = [
  "considered",
  "eligible",
  "delete_attempted",
  "deleted",
  "failed",
] as const;

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

  /**
   * `unreadableContent` tells an output record a v3 read model could not
   * materialise from an absent one (swamp-club#3617): a lookup that could
   * be answered by one fails loudly, and a listing warns that it leaves
   * them out.
   */
  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
    readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.localOutputsDir = swampPath(repoDir, SWAMP_SUBDIRS.outputs);
    this.baseDir = baseDir ?? this.localOutputsDir;
  }

  /**
   * Runs a write or remove with its changes signalled before it and, on v2,
   * again once it has settled (swamp-club#2421).
   */
  private staged<T>(
    changes: StagedChange | readonly StagedChange[],
    write: () => Promise<T>,
  ): Promise<T> {
    // Every record write stages its typed change after it (swamp-club#3250),
    // so a v3 unit takes no path change from this repository. Run logs have
    // no typed change: nothing puts them on v3 yet.
    return withChangeSignalled(this.markDirty, changes, { typed: true }, write);
  }

  /**
   * Handles a failure to load one output record during a scan. A file that
   * vanished is skipped silently and an I/O error propagates; anything else
   * (a YAML syntax error, a record that fails validation) is skipped with a
   * warning, so one bad record never fails a read of every other output.
   * Parse and validation errors are recognised before isIoError, which also
   * matches on message text a YAML error can quote from the file.
   */
  private skipUnreadableRecord(path: string, error: unknown): void {
    if (error instanceof Deno.errors.NotFound) return;
    const isParseError = error instanceof SyntaxError ||
      error instanceof z.ZodError;
    if (!isParseError && isIoError(error)) throw error;
    logger.warn`Skipping unreadable output record ${path}: ${
      describeRecordError(error)
    }`;
  }

  /**
   * The output `id` of `type`'s `method`. An output id is not in its file's
   * name, so on a miss every record of the method the datastore could not
   * materialise may be it: the lookup fails as not found, naming them
   * (swamp-club#3617), rather than report the output simply absent. It
   * cannot tell a mistyped id from one of theirs, so the error does not
   * carry the unreadable-content code.
   */
  async findById(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<ModelOutput | null> {
    const found = await this.readById(type, method, id);
    if (found !== null) return found;
    const unreadable = await unreadableRecordsUnder(
      this.unreadableContent,
      this.getMethodDir(type, method),
    );
    if (unreadable.length > 0) {
      throw mayBeUnreadableError(
        `The ${type.normalized} ${method} output ${id}`,
        unreadable,
      );
    }
    return null;
  }

  private async readById(
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
          this.skipUnreadableRecord(path, error);
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

  /**
   * The outputs of `ids` found. Not loud about a record the datastore could
   * not materialise (swamp-club#3617): its callers (the orphaned-run reaper,
   * `model cancel`) read the records as evidence and treat a missing one as
   * none, and failing them would stop the reaping and cancelling that
   * clear the runs.
   */
  async findByIds(
    type: ModelType,
    method: string,
    ids: ReadonlySet<string>,
  ): Promise<Map<string, ModelOutput>> {
    const found = new Map<string, ModelOutput>();
    if (ids.size === 0) return found;
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
        const path = join(dir, entry.name);
        // A file deleted or unreadable mid-scan is skipped, as in findById.
        try {
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData | null;
          if (!data || !ids.has(data.id)) continue;
          if (data.logFile) {
            data.logFile = toAbsolutePath(this.repoDir, data.logFile);
          }
          found.set(data.id, ModelOutput.fromData(data));
          if (found.size === ids.size) break;
        } catch (error) {
          this.skipUnreadableRecord(path, error);
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return found;
      throw error;
    }
    return found;
  }

  async findByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput[]> {
    const all = await this.readAll(type);
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.getTypeDir(type),
      (entry) => parseOutputFileName(entry.path)?.definitionId === definitionId,
    );
    return all.filter((output) => output.definitionId === definitionId);
  }

  /**
   * The definition's latest output. An output file's name carries its
   * definition and start, so when the datastore could not materialise one
   * that started later than the latest readable one, the lookup fails with
   * its error (swamp-club#3617) rather than answer with an older output.
   */
  async findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null> {
    const outputs = (await this.readAll(type)).filter((output) =>
      output.definitionId === definitionId
    );
    // Sort by startedAt descending and take the first one
    outputs.sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
    const latest = outputs.length === 0 ? null : outputs[0];
    let newest: { entry: UnreadableContentEntry; stamp: string } | undefined;
    for (
      const entry of await unreadableRecordsUnder(
        this.unreadableContent,
        this.getTypeDir(type),
      )
    ) {
      const name = parseOutputFileName(entry.path);
      if (name?.definitionId !== definitionId) continue;
      if (newest === undefined || name.stamp > newest.stamp) {
        newest = { entry, stamp: name.stamp };
      }
    }
    if (
      newest !== undefined &&
      (latest === null || newest.stamp > fileStamp(latest.startedAt))
    ) {
      throw newest.entry.error;
    }
    return latest;
  }

  async findAll(type: ModelType): Promise<ModelOutput[]> {
    const outputs = await this.readAll(type);
    await warnUnreadableLeftOut(this.unreadableContent, this.getTypeDir(type));
    return outputs;
  }

  /** {@link findAll} without the unreadable-record warning. */
  private async readAll(type: ModelType): Promise<ModelOutput[]> {
    const typeDir = this.getTypeDir(type);
    const outputs: ModelOutput[] = [];
    // Every record of the type is read, whatever the caller then keeps.
    const tally = currentDiagnosticTally();

    try {
      // Iterate over method directories
      for (const methodEntry of await readDirSorted(typeDir)) {
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
          for (const entry of await readDirSorted(methodDir)) {
            if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
            const path = join(methodDir, entry.name);

            // Per-file try/catch closes the TOCTOU window: a concurrent
            // delete (e.g. GC, output cleanup) can remove the file
            // between readDir and readTextFile. NotFound on a single
            // file means "skip it" — never "abandon the rest of the
            // current method directory."
            try {
              const content = await tally.measure(
                "read",
                () => Deno.readTextFile(path),
              );
              tally.add("files_read");
              if (tally.recording) {
                tally.add("bytes_read", utf8ByteLength(content));
              }
              const data = tally.measureSync(
                "parse",
                () => parseYaml(content),
              ) as ModelOutputData | null;
              if (!data) continue;
              if (data.logFile) {
                data.logFile = toAbsolutePath(this.repoDir, data.logFile);
              }
              outputs.push(ModelOutput.fromData(data));
            } catch (error) {
              this.skipUnreadableRecord(path, error);
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
    // Output directories are found by walking the registered model types. The
    // CLI configures the extension loader but does not run it, so a command
    // that never loaded the registry would walk only built-in types and miss
    // every extension-typed output (swamp-club#2510). ensureLoaded is
    // memoized, so callers that already loaded the registry (serve, model
    // output get) pay nothing.
    await modelRegistry.ensureLoaded();

    const results: { output: ModelOutput; type: ModelType; method: string }[] =
      [];

    // Iterate over all registered model types
    for (const modelType of modelRegistry.types()) {
      const typeOutputs = await this.readAll(modelType);
      for (const output of typeOutputs) {
        results.push({
          output,
          type: modelType,
          method: output.methodName,
        });
      }
    }
    await warnUnreadableLeftOut(this.unreadableContent, this.baseDir);

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
    // Load extension types before walking them; see findAllGlobal.
    await modelRegistry.ensureLoaded();

    const results: { output: ModelOutput; type: ModelType; method: string }[] =
      [];
    const cutoffMs = cutoff.getTime();

    for (const modelType of modelRegistry.types()) {
      const typeDir = this.getTypeDir(modelType);
      try {
        for (const methodEntry of await readDirSorted(typeDir)) {
          if (!methodEntry.isDirectory) continue;
          const methodDir = join(typeDir, methodEntry.name);

          // Per-method-directory try/catch closes the directory-level
          // TOCTOU window: a concurrent bulk delete can remove the
          // method directory between readDir(typeDir) and
          // readDir(methodDir). NotFound on a single method directory
          // means "skip it" — never "abandon results already collected
          // from earlier method directories of this type."
          try {
            for (const entry of await readDirSorted(methodDir)) {
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
                this.skipUnreadableRecord(path, error);
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
    // Only the ones whose file name says they started at or after the
    // cutoff, as this listing's own pre-filter would; one whose name does
    // not say is named too.
    const cutoffStamp = fileStamp(cutoff);
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.baseDir,
      (entry) =>
        (parseOutputFileName(entry.path)?.stamp ?? cutoffStamp) >=
          cutoffStamp,
    );

    return results;
  }

  async save(
    type: ModelType,
    method: string,
    output: ModelOutput,
  ): Promise<void> {
    const path = this.getPath(type, method, output);
    const content = await this.staged({ kind: "write", path }, async () => {
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
      const text = stringifyYaml(cleanData as Record<string, unknown>);
      await atomicWriteTextFile(path, text);
      return text;
    });
    await stageTyped(this.markDirty, () => [
      new ModelChanges(type, output.definitionId).writeOutput(
        output.id,
        method,
        basename(path),
        new TextEncoder().encode(content),
      ),
    ]);
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
    // reach the target. The destructive ops (staged remove + Deno.remove
    // + cleanupEmptyParentDirs) run after the loop, still inside the
    // outer try/catch — preserving the existing semantic that a
    // NotFound from Deno.remove (race: target deleted concurrently) is
    // absorbed and returns successfully (delete is idempotent).
    const dir = this.getMethodDir(type, method);
    // The search reads the method's records until one matches: counted
    // apart from the removal it leads to.
    const tally = currentDiagnosticTally();
    try {
      const match = await tally.measure("search", async () => {
        for await (const entry of Deno.readDir(dir)) {
          if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
          const path = join(dir, entry.name);

          try {
            const content = await Deno.readTextFile(path);
            tally.add("search_files_read");
            const data = parseYaml(content) as ModelOutputData | null;
            if (!data) continue;
            if (data.id === id) return { path, data };
          } catch (error) {
            if (error instanceof Deno.errors.NotFound) continue;
            throw error;
          }
        }
        return null;
      });

      if (match) {
        await this.removeOutputFiles(
          match.path,
          0,
          this.ownedLogPath(match.path, match.data),
          false,
          match.data,
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
    const filename = `${output.definitionId}-${
      fileStamp(output.startedAt)
    }.yaml`;
    return join(this.getMethodDir(type, method), filename);
  }

  async deleteOlderThan(
    cutoff: Date,
    options?: { dryRun?: boolean },
  ): Promise<{ deleted: number; bytesReclaimed: number; more: boolean }> {
    const cutoffMs = cutoff.getTime();
    // An unrepresentable cutoff deletes nothing rather than everything.
    if (!Number.isFinite(cutoffMs)) {
      return { deleted: 0, bytesReclaimed: 0, more: false };
    }
    return await this.deleteExpired(() => cutoffMs, options);
  }

  async deleteByMethodLifetime(
    fallbackCutoff: Date,
    options?: { dryRun?: boolean; limit?: number },
  ): Promise<{ deleted: number; bytesReclaimed: number; more: boolean }> {
    const fallbackCutoffMs = fallbackCutoff.getTime();
    // An unrepresentable cutoff deletes nothing rather than everything.
    if (!Number.isFinite(fallbackCutoffMs)) {
      return { deleted: 0, bytesReclaimed: 0, more: false };
    }
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
   *
   * With `limit`, the scan stops at the first expired output past it and
   * reports `more`; the orphaned-log sweep is then left to the final batch.
   */
  private async deleteExpired(
    cutoffFor: (relativePath: string) => number,
    options?: { dryRun?: boolean; limit?: number },
  ): Promise<{ deleted: number; bytesReclaimed: number; more: boolean }> {
    const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
    const dryRun = options?.dryRun ?? false;
    const limit = options?.limit;
    let deleted = 0;
    let bytesReclaimed = 0;
    let more = false;
    // Outputs this pass deletes (or would delete, on a dry run) and the logs
    // already counted with them, so the orphan sweep neither treats a doomed
    // output as a live reference nor counts its log twice.
    const deletedYamls = new Set<string>();
    const countedLogs = new Set<string>();

    // Every batch lists every output file; the strategy is recorded so a
    // scan-heavy batch can be told from a deletion-heavy one. Phases are
    // exported only inside output retention
    // (design/enablers/serve-phase-telemetry.md).
    const yamlFiles = await observeDiagnosticPhase("candidate_enumeration", {
      "swamp.diagnostic.scan_strategy": "full_listing",
    }, async (phase) => {
      const files = await this.collectFiles(this.baseDir, ".yaml");
      phase.tally.add("files", files.length);
      return files;
    });
    // One phase for the loop: counts and summed work, never a span per file.
    await observeDiagnosticPhase("candidate_scan", {
      "swamp.diagnostic.dry_run": dryRun,
      ...(limit !== undefined ? { "swamp.diagnostic.limit": limit } : {}),
    }, async (phase) => {
      const { tally } = phase;
      // The core counts export as zero on an empty batch, not as absent.
      for (const key of CANDIDATE_SCAN_COUNTS) tally.add(key, 0);
      for (const yamlPath of yamlFiles) {
        tally.add("considered");
        try {
          const cutoffMs = cutoffFor(yamlPath.slice(this.baseDir.length + 1));

          const stat = await tally.measure("stat", () => Deno.stat(yamlPath));
          const mtimeMs = stat.mtime?.getTime();
          if (mtimeMs !== undefined && mtimeMs >= cutoffMs) {
            tally.add("skipped_recent_mtime");
            continue;
          }

          const content = await tally.measure(
            "read",
            () => Deno.readTextFile(yamlPath),
          );
          const data = tally.measureSync(
            "parse",
            () => parseYaml(content),
          ) as ModelOutputData | null;
          if (data) {
            // A run that has not finished keeps its output whatever its age.
            if (!TERMINAL_STATUSES.has(data.status)) {
              tally.add("protected_not_terminal");
              continue;
            }
            const startedAt = data.startedAt
              ? new Date(data.startedAt).getTime()
              : undefined;
            if (
              startedAt === undefined || Number.isNaN(startedAt) ||
              startedAt >= cutoffMs
            ) {
              tally.add("skipped_not_expired");
              continue;
            }
          }

          if (limit !== undefined && deleted >= limit) {
            more = true;
            break;
          }
          tally.add("eligible");

          const logPath = this.ownedLogPath(yamlPath, data);
          tally.add("delete_attempted");
          const bytes = await this.removeOutputFiles(
            yamlPath,
            stat.size ?? 0,
            logPath,
            dryRun,
            data,
          );
          bytesReclaimed += bytes;
          tally.add("bytes_reclaimed", bytes);
          deletedYamls.add(yamlPath);
          if (logPath) countedLogs.add(logPath);
          deleted++;
          tally.add("deleted");
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) {
            tally.add("skipped_not_found");
            continue;
          }
          tally.add("failed");
          throw error;
        }
      }
      phase.attributes({ "swamp.diagnostic.stopped_at_limit": more });
    });

    // A batch that stopped at its limit skips the orphaned-log sweep: it
    // scans every repo-local log, the logs of the outputs this batch deleted
    // went with them, and the final batch (no `more`) runs it.
    if (!more) {
      bytesReclaimed += await observeDiagnosticPhase(
        "orphan_log_sweep",
        { "swamp.diagnostic.dry_run": dryRun },
        () =>
          this.sweepOrphanLogs(
            cutoffFor,
            deletedYamls,
            countedLogs,
            dryRun,
          ),
      );
    }

    return { deleted, bytesReclaimed, more };
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
    record: ModelOutputData | null,
  ): Promise<number> {
    // Measures into the retention phase that called this, if any: removal,
    // empty-directory cleanup and the tombstone are told apart.
    const tally = currentDiagnosticTally();
    let bytes = yamlBytes;
    let logExists = false;
    if (logPath) {
      try {
        const logStat = await tally.measure("remove", () => Deno.stat(logPath));
        bytes += logStat.size ?? 0;
        logExists = true;
      } catch {
        // log file may not exist
      }
    }
    if (dryRun) return bytes;

    const removals: StagedChange[] = [{ kind: "remove", path: yamlPath }];
    if (logPath && logExists && this.inBaseDir(logPath)) {
      removals.push({ kind: "remove", path: logPath });
    }
    await tally.measure("remove", () =>
      this.staged(removals, async () => {
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
          await tally.measure(
            "dir_cleanup",
            () => cleanupEmptyParentDirs(logPath, this.rootFor(logPath)),
          );
        }
      }));
    await tally.measure(
      "dir_cleanup",
      () => cleanupEmptyParentDirs(yamlPath, this.baseDir),
    );
    await tally.measure("tombstone", () =>
      stageTyped(
        this.markDirty,
        () => this.recordTombstone(yamlPath, record),
      ));
    return bytes;
  }

  /**
   * The typed change of a removed record: an output.delete tombstone of its
   * key under `<type>/<method>/<file>`. A record that never parsed carries no
   * output id or model, so no repository ever put it, and it has none.
   */
  private recordTombstone(
    yamlPath: string,
    record: ModelOutputData | null,
  ): TypedChange[] {
    if (record?.id === undefined || record.definitionId === undefined) {
      return [];
    }
    const segments = relative(this.baseDir, yamlPath).split(SEPARATOR);
    if (segments.length < 3) return [];
    const file = segments[segments.length - 1];
    const method = segments[segments.length - 2];
    const type = ModelType.create(segments.slice(0, -2).join("/"));
    return [
      new ModelChanges(type, record.definitionId).removeOutput(
        record.id,
        method,
        file,
      ),
    ];
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
    const tally = currentDiagnosticTally();
    const floorMs = Date.now() - ORPHAN_LOG_MIN_AGE_MS;
    const candidatesByDir = new Map<
      string,
      { path: string; size: number }[]
    >();

    const logFiles = await tally.measure(
      "list",
      () => this.collectFiles(this.localOutputsDir, ".log"),
    );
    tally.add("logs_listed", logFiles.length);
    for (const logPath of logFiles) {
      if (countedLogs.has(logPath)) continue;
      try {
        const stat = await tally.measure("stat", () => Deno.stat(logPath));
        const mtimeMs = stat.mtime?.getTime();
        if (mtimeMs === undefined) continue;
        const cutoffMs = Math.min(
          cutoffFor(logPath.slice(this.localOutputsDir.length + 1)),
          floorMs,
        );
        if (mtimeMs >= cutoffMs) {
          tally.add("logs_skipped_recent");
          continue;
        }
        tally.add("candidates");
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
      tally.add("dirs_checked");
      const referenced = await tally.measure(
        "reference_read",
        () => this.referencedLogs(dir, deletedYamls),
      );
      if (!referenced) {
        tally.add("dirs_unreadable");
        continue;
      }
      for (const candidate of candidates) {
        if (referenced.has(candidate.path)) continue;
        bytes += candidate.size;
        if (!dryRun) {
          const removal: StagedChange[] = this.inBaseDir(candidate.path)
            ? [{ kind: "remove", path: candidate.path }]
            : [];
          await tally.measure("remove", async () => {
            await this.staged(removal, async () => {
              try {
                await Deno.remove(candidate.path);
              } catch (error) {
                if (!(error instanceof Deno.errors.NotFound)) throw error;
              }
            });
            await cleanupEmptyParentDirs(candidate.path, this.localOutputsDir);
          });
        }
        tally.add("removed");
        tally.add("bytes_reclaimed", candidate.size);
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
          // Loop, not push(...): one method directory can hold more outputs
          // than fit in a spread call (swamp-club#2565).
          for (const file of await this.collectFiles(path, extension)) {
            files.push(file);
          }
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
