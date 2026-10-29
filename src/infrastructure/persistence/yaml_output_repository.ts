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
import {
  mapBounded,
  SCAN_CONCURRENCY,
  type ScanKind,
  withScanPermit,
} from "./scan_permits.ts";
import { SharedScans } from "./shared_scans.ts";
import type {
  OutputKey,
  OutputRepository,
  SelectReadableOutputs,
} from "../../domain/models/repositories.ts";
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

/**
 * `instant`'s stamp when a name can carry it: one outside years 0000-9999 is
 * signed, so comparing it with a name's does not order them as their
 * instants.
 */
function nameStampOf(instant: Date | undefined): string | undefined {
  if (instant === undefined) return undefined;
  const stamp = fileStamp(instant);
  return /^\d{4}-/.test(stamp) ? stamp : undefined;
}

/** An output with the type and method it was found under. */
type GlobalOutput = { output: ModelOutput; type: ModelType; method: string };

/**
 * An output file a global scan listed, with the method directory it is in
 * and, when its name is in {@link getPath}'s form, the definition id the
 * name carries.
 */
interface ListedOutput {
  modelType: ModelType;
  method: string;
  path: string;
  definitionId?: string;
}

/**
 * The files of `listed` to read: every file when there is no
 * `selectReadable`, otherwise each file whose name carries no key and each
 * whose key it accepts. It is asked once, about the distinct keys.
 */
async function chooseReadable(
  listed: ListedOutput[],
  selectReadable: SelectReadableOutputs | undefined,
): Promise<ListedOutput[]> {
  if (selectReadable === undefined) return listed;
  const keys: OutputKey[] = [];
  const keyIndex = new Map<string, number>();
  const keyOf = (file: ListedOutput): string =>
    JSON.stringify([file.modelType.normalized, file.definitionId, file.method]);
  for (const file of listed) {
    if (file.definitionId === undefined) continue;
    const key = keyOf(file);
    if (keyIndex.has(key)) continue;
    keyIndex.set(key, keys.length);
    keys.push({
      type: file.modelType,
      definitionId: file.definitionId,
      methodName: file.method,
    });
  }
  const readable = keys.length === 0 ? [] : await selectReadable(keys);
  const tally = currentDiagnosticTally();
  return listed.filter((file) => {
    if (file.definitionId === undefined) return true;
    if (readable[keyIndex.get(keyOf(file))!] === true) return true;
    tally.add("skipped_by_authorization");
    return false;
  });
}

/** The window of a definition's history search. */
interface HistoryWindow {
  since?: Date;
  until?: Date;
}

/**
 * Whether a file name's stamp, or an output's start, is in `window`: at or
 * after `since` and before `until`.
 */
function historyWindowOf(window: HistoryWindow | undefined): {
  stampIn: (stamp: string) => boolean;
  startedIn: (startedAt: Date) => boolean;
} {
  const sinceMs = window?.since?.getTime();
  const untilMs = window?.until?.getTime();
  // A bound outside years 0000-9999 has a stamp no name can be compared
  // with, so it skips no file by name.
  const sinceStamp = nameStampOf(window?.since);
  const untilStamp = nameStampOf(window?.until);
  return {
    stampIn: (stamp) =>
      (sinceStamp === undefined || stamp >= sinceStamp) &&
      (untilStamp === undefined || stamp < untilStamp),
    startedIn: (startedAt) => {
      const startedMs = startedAt.getTime();
      return (sinceMs === undefined || startedMs >= sinceMs) &&
        (untilMs === undefined || startedMs < untilMs);
    },
  };
}

/** The window covering `a` and `b`: unbounded on a side either is. */
function widenHistoryWindow(a: HistoryWindow, b: HistoryWindow): HistoryWindow {
  return {
    since: a.since === undefined || b.since === undefined
      ? undefined
      : earlier(a.since, b.since),
    until: a.until === undefined || b.until === undefined
      ? undefined
      : (a.until.getTime() >= b.until.getTime() ? a.until : b.until),
  };
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

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
   * Concurrent identical history, `since` and full searches share one read
   * (swamp-club#4074), so the memory they take together is bounded by the
   * repository's size rather than by how many clients poll.
   */
  private readonly historyScans = new SharedScans<
    HistoryWindow,
    ModelOutput[]
  >(widenHistoryWindow);
  private readonly listingScans = new SharedScans<
    Date | undefined,
    ListedOutput[]
  >((a, b) => a === undefined || b === undefined ? undefined : earlier(a, b));
  /**
   * The global scans' reads, shared by the callers of the same kind of scan
   * whatever each listed: a caller joining adds the files it chose to the
   * pending reads.
   */
  private readonly readScans = new SharedScans<
    Map<string, ListedOutput>,
    Map<string, GlobalOutput>
  >((pending, joining) => {
    for (const [path, file] of joining) pending.set(path, file);
    return pending;
  });

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
    const all = await this.readAll(type, "lookup");
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
    const outputs = (await this.readAll(type, "lookup")).filter((output) =>
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
    const outputs = await this.readAll(type, "lookup");
    await warnUnreadableLeftOut(this.unreadableContent, this.getTypeDir(type));
    return outputs;
  }

  /**
   * The outputs of `definitionId`, for listing its history: like
   * {@link findByDefinition}, but a file whose name says it belongs to
   * another definition is skipped without being read (swamp-club#4056), as
   * {@link findAllGlobalSince} trusts a name's stamp. A name not in
   * {@link getPath}'s form is read. Callers that must find every record of
   * the definition whatever its file is named (deleting it, authorizing a
   * read) use {@link findByDefinition}.
   *
   * With a `window`, only outputs started at or after `since` and before
   * `until` are returned, and a file whose name is stamped outside it is
   * skipped without being read (swamp-club#4058). A name not in that form
   * whose mtime is before `since` is skipped after a stat, as in
   * {@link findAllGlobalSince}; its mtime says nothing about `until`, so
   * otherwise it is read. Every record read is checked against the window
   * again.
   *
   * Concurrent searches of the definition share one scan (swamp-club#4074):
   * a search joins one that has not started yet, widening its window to
   * cover its own, and keeps only its own window of what it reads. The
   * outputs are shared with those searches, so callers must not mutate
   * them. One search on a scan counts its reads (the one that started it,
   * or the earliest still waiting if that one left); the others count
   * `scans_joined`.
   *
   * Once `signal` aborts, the search rejects with its reason, and a scan no
   * other search waits on starts no further listing or read
   * (swamp-club#4070); one that had already started its last read returns
   * as usual.
   */
  async findHistoryByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
    window?: HistoryWindow,
    signal?: AbortSignal,
  ): Promise<ModelOutput[]> {
    const { value: outputs, joined } = await this.historyScans.run(
      JSON.stringify([type.normalized, definitionId]),
      window ?? {},
      (scanWindow, scanSignal) =>
        this.readHistory(type, definitionId, scanWindow, scanSignal),
      signal,
    );
    if (joined) currentDiagnosticTally().add("scans_joined");
    const { stampIn, startedIn } = historyWindowOf(window);
    // Only the ones whose file name says they are this definition's and
    // started in the window, as the listing's own pre-filter would.
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.getTypeDir(type),
      (entry) => {
        const name = parseOutputFileName(entry.path);
        return name?.definitionId === definitionId && stampIn(name.stamp);
      },
    );
    return outputs.filter((output) =>
      output.definitionId === definitionId && startedIn(output.startedAt)
    );
  }

  /**
   * The scan {@link findHistoryByDefinition} shares: the type's outputs,
   * skipping unread every file whose name is another definition's or is
   * stamped outside `window`.
   */
  private readHistory(
    type: ModelType,
    definitionId: DefinitionId,
    window: HistoryWindow,
    signal: AbortSignal,
  ): Promise<ModelOutput[]> {
    const { stampIn } = historyWindowOf(window);
    return this.readAll(
      type,
      "search",
      (name) => {
        const match = OUTPUT_FILE_NAME.exec(name);
        if (match === null) return true;
        return match[1] === definitionId && stampIn(match[2]);
      },
      window.since,
      signal,
    );
  }

  /**
   * {@link findAll} without the unreadable-record warning, its listings and
   * reads drawing on `kind`'s share of the scan permits. With `readsName`,
   * a file whose name it refuses is skipped without being read. With
   * `unnamedSince`, a file whose name is not in {@link getPath}'s form and
   * whose mtime is before it is skipped after a stat. Once `signal` aborts,
   * the scan starts no further listing or read and rejects with its reason.
   */
  private async readAll(
    type: ModelType,
    kind: ScanKind,
    readsName?: (name: string) => boolean,
    unnamedSince?: Date,
    signal?: AbortSignal,
  ): Promise<ModelOutput[]> {
    const typeDir = this.getTypeDir(type);
    // Every record of the type is read, whatever the caller then keeps.
    const tally = currentDiagnosticTally();

    let methodEntries: Deno.DirEntry[];
    try {
      methodEntries = await withScanPermit(
        kind,
        () => readDirSorted(typeDir),
        signal,
      );
    } catch (error) {
      // The type directory itself doesn't exist.
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }

    // Method directories are listed, and files read, SCAN_CONCURRENCY at a
    // time, as in findAllGlobalSince; each stage keeps its items in walk
    // order, so the result is in the order a sequential walk returns it.
    const files = (await mapBounded(
      methodEntries
        .filter((entry) => entry.isDirectory)
        .map((entry) => join(typeDir, entry.name)),
      SCAN_CONCURRENCY,
      async (methodDir) => {
        // Per-method-directory try/catch closes the directory-level
        // TOCTOU window: a concurrent bulk delete can remove the
        // method directory between readDir(typeDir) and
        // readDir(methodDir). NotFound on a single method directory
        // means "skip it" — never "abandon outputs already collected
        // from other method directories of this type."
        let entries: Deno.DirEntry[];
        try {
          entries = await withScanPermit(
            kind,
            () => readDirSorted(methodDir),
            signal,
          );
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return [];
          throw error;
        }
        const found: { path: string; named: boolean }[] = [];
        for (const entry of entries) {
          if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
          if (readsName && !readsName(entry.name)) {
            tally.add("skipped_by_name");
            continue;
          }
          found.push({
            path: join(methodDir, entry.name),
            named: OUTPUT_FILE_NAME.test(entry.name),
          });
        }
        return found;
      },
      signal,
    )).flat();

    const outputs = await mapBounded(
      files,
      SCAN_CONCURRENCY,
      async ({ path, named }) => {
        // Per-file try/catch closes the TOCTOU window: a concurrent
        // delete (e.g. GC, output cleanup) can remove the file
        // between readDir and readTextFile. NotFound on a single
        // file means "skip it" — never "abandon the rest of the scan."
        try {
          if (unnamedSince !== undefined && !named) {
            const stat = await withScanPermit(
              kind,
              () => tally.measure("stat", () => Deno.stat(path)),
              signal,
            );
            tally.add("stats");
            const mtimeMs = stat.mtime?.getTime();
            if (mtimeMs !== undefined && mtimeMs < unnamedSince.getTime()) {
              tally.add("skipped_by_mtime");
              return undefined;
            }
          }
          const content = await withScanPermit(
            kind,
            () => tally.measure("read", () => Deno.readTextFile(path)),
            signal,
          );
          tally.add("files_read");
          if (tally.recording) {
            tally.add("bytes_read", utf8ByteLength(content));
          }
          const data = tally.measureSync(
            "parse",
            () => parseYaml(content),
          ) as ModelOutputData | null;
          if (!data) return undefined;
          if (data.logFile) {
            data.logFile = toAbsolutePath(this.repoDir, data.logFile);
          }
          return ModelOutput.fromData(data);
        } catch (error) {
          // A cancelled scan is not an unreadable record: it ends the scan.
          signal?.throwIfAborted();
          this.skipUnreadableRecord(path, error);
          return undefined;
        }
      },
      signal,
    );
    return outputs.filter((output) => output !== undefined);
  }

  /**
   * Every output of every registered type. Concurrent calls share their
   * listing and their reads as {@link findAllGlobalSince}'s do
   * (swamp-club#4074): each gets its own array, but the outputs in it are
   * shared, so callers must not mutate them. With `selectReadable`, a file
   * whose name carries a key it refuses is not read, as in
   * {@link findAllGlobalSince}. Once `signal` aborts, the call rejects with
   * its reason, and a scan no other call waits on starts no further listing
   * or read (swamp-club#4070); one that had already started its last read
   * returns as usual.
   */
  async findAllGlobal(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<GlobalOutput[]> {
    const found = await this.findGlobal(
      "all",
      undefined,
      selectReadable,
      signal,
    );
    await warnUnreadableLeftOut(this.unreadableContent, this.baseDir);
    return found;
  }

  /**
   * Finds all outputs whose `startedAt` is at or after the cutoff, skipping
   * old records without reading them (swamp-club#4056). A file's name carries
   * the `startedAt` its record was saved with (see {@link getPath}), and
   * `startedAt` never changes, so a name stamped before the cutoff is skipped
   * without even a stat; that holds however recently the file was written,
   * which matters because a v3 read-model replay rewrites every record. A name
   * not in that form falls back to the mtime pre-filter: a record is saved
   * when its run starts and again when it ends, both at or after its
   * `startedAt`, so a file last modified before the cutoff cannot have started
   * on or after it. Every record read is checked against the cutoff again.
   *
   * With `selectReadable`, a file is read only when the key its location
   * carries (type and method directories, definition id from its name) is
   * one `selectReadable` accepts (swamp-club#4142). It is asked once, in
   * the caller's own context, about the distinct keys the listing found. A
   * file whose name is not in {@link getPath}'s form carries no key, and is
   * read and returned for the caller to judge.
   *
   * Directories are listed and files read {@link SCAN_CONCURRENCY} at a
   * time: every awaited listing or read waits for a turn of the event loop,
   * so on a busy serve a scan that awaited them one by one took as long as
   * the turns added up. The result is in walk order all the same.
   *
   * Inside a diagnostic phase the scan is counted (directories, entries,
   * names skipped, stats, reads) into that phase's tally.
   *
   * Concurrent calls share one listing and one read (swamp-club#4074): a
   * call joining a listing that has not started moves its cutoff back to
   * its own if that is earlier, and a call joining reads that have not
   * started adds the files it chose to them, so callers that may read
   * different files read the union once. Each keeps only its own files, and
   * the outputs at or after its own cutoff. Each gets its own array, but the
   * outputs in it are shared, so callers must not mutate them.
   *
   * Once `signal` aborts, the call rejects with its reason, and a scan no
   * other call waits on starts no further listing or read
   * (swamp-club#4070); one that had already started its last read returns
   * as usual.
   */
  async findAllGlobalSince(
    cutoff: Date,
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<GlobalOutput[]> {
    const found = await this.findGlobal(
      "since",
      cutoff,
      selectReadable,
      signal,
    );
    const cutoffMs = cutoff.getTime();
    // A cutoff outside years 0000-9999 has a signed stamp, which sorts
    // before every name's.
    const cutoffStamp = fileStamp(cutoff);

    // Only the ones whose file name says they started at or after the
    // cutoff, as this listing's own pre-filter would; one whose name does
    // not say is named too.
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.baseDir,
      (entry) =>
        (parseOutputFileName(entry.path)?.stamp ?? cutoffStamp) >=
          cutoffStamp,
    );

    return found.filter((found) =>
      found.output.startedAt.getTime() >= cutoffMs
    );
  }

  /**
   * The shared listing, the caller's own choice of files from it, then the
   * shared reads of them: the outputs of the files chosen, in walk order.
   */
  private async findGlobal(
    key: "all" | "since",
    cutoff: Date | undefined,
    selectReadable: SelectReadableOutputs | undefined,
    signal: AbortSignal | undefined,
  ): Promise<GlobalOutput[]> {
    const listing = await this.listingScans.run(
      key,
      cutoff,
      (scanCutoff, scanSignal) => this.listAllGlobal(scanCutoff, scanSignal),
      signal,
    );
    const chosen = await chooseReadable(listing.value, selectReadable);
    // A caller with nothing to read waits behind no one's reads.
    if (chosen.length === 0) {
      signal?.throwIfAborted();
      if (listing.joined) currentDiagnosticTally().add("scans_joined");
      return [];
    }
    // Reads share a flight only with the same kind of scan, so a full read
    // never holds up a `since` search's few reads.
    const reads = await this.readScans.run(
      key,
      new Map(chosen.map((file) => [file.path, file])),
      (files, scanSignal) => this.readListed(files, scanSignal),
      signal,
    );
    if (listing.joined || reads.joined) {
      currentDiagnosticTally().add("scans_joined");
    }
    const found: GlobalOutput[] = [];
    for (const file of chosen) {
      const output = reads.value.get(file.path);
      if (output !== undefined) found.push(output);
    }
    return found;
  }

  /**
   * The output files of every registered type, in walk order: with a
   * `cutoff`, leaving out unread a file whose name is stamped before it,
   * or, when its name is not in {@link getPath}'s form, whose mtime is.
   */
  private async listAllGlobal(
    cutoff: Date | undefined,
    signal: AbortSignal,
  ): Promise<ListedOutput[]> {
    // Output directories are found by walking the registered model types. The
    // CLI configures the extension loader but does not run it, so a command
    // that never loaded the registry would walk only built-in types and miss
    // every extension-typed output (swamp-club#2510). ensureLoaded is
    // memoized, so callers that already loaded the registry (serve, model
    // output get) pay nothing.
    await modelRegistry.ensureLoaded();

    const cutoffMs = cutoff?.getTime();
    // A cutoff outside years 0000-9999 has a signed stamp, which sorts
    // before every name's: then no name is skipped, only stat'ed.
    const cutoffStamp = cutoff === undefined ? undefined : fileStamp(cutoff);
    const tally = currentDiagnosticTally();

    // Each stage keeps its items in walk order, so the result is in the
    // order a sequential walk returns it (swamp-club#3067).
    const methodDirs = (await mapBounded(
      [...modelRegistry.types()],
      SCAN_CONCURRENCY,
      async (modelType) => {
        const typeDir = this.getTypeDir(modelType);
        try {
          const methodEntries = await withScanPermit(
            "search",
            () => readDirSorted(typeDir),
            signal,
          );
          tally.add("type_dirs");
          return methodEntries
            .filter((entry) => entry.isDirectory)
            .map((entry) => ({
              modelType,
              method: entry.name,
              dir: join(typeDir, entry.name),
            }));
        } catch (error) {
          // The type directory itself doesn't exist.
          if (error instanceof Deno.errors.NotFound) return [];
          throw error;
        }
      },
      signal,
    )).flat();

    const named = (await mapBounded(
      methodDirs,
      SCAN_CONCURRENCY,
      async ({ modelType, method, dir }) => {
        // A concurrent bulk delete can remove the method directory between
        // listing its type and listing it. NotFound on a single method
        // directory means "skip it" — never "abandon results already
        // collected from other method directories."
        let entries: Deno.DirEntry[];
        try {
          entries = await withScanPermit(
            "search",
            () => readDirSorted(dir),
            signal,
          );
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) return [];
          throw error;
        }
        tally.add("method_dirs");
        const found: ListedOutput[] = [];
        for (const entry of entries) {
          if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
          tally.add("entries");
          // Stage A: the name's stamp, or the mtime when the name has none
          const match = OUTPUT_FILE_NAME.exec(entry.name);
          if (
            match !== null && cutoffStamp !== undefined &&
            match[2] < cutoffStamp
          ) {
            tally.add("skipped_by_name");
            continue;
          }
          found.push({
            modelType,
            method,
            path: join(dir, entry.name),
            definitionId: match?.[1],
          });
        }
        return found;
      },
      signal,
    )).flat();
    if (cutoffMs === undefined) return named;

    const listed = await mapBounded(
      named,
      SCAN_CONCURRENCY,
      async (file) => {
        if (file.definitionId !== undefined) return file;
        // A file that cannot be stat'ed is skipped as a read of it would
        // be: one deleted since its listing silently, any other with a
        // warning, and only an I/O error fails the scan.
        try {
          const stat = await withScanPermit(
            "search",
            () => tally.measure("stat", () => Deno.stat(file.path)),
            signal,
          );
          tally.add("stats");
          const mtimeMs = stat.mtime?.getTime();
          if (mtimeMs !== undefined && mtimeMs < cutoffMs) {
            tally.add("skipped_by_mtime");
            return undefined;
          }
          return file;
        } catch (error) {
          signal.throwIfAborted();
          this.skipUnreadableRecord(file.path, error);
          return undefined;
        }
      },
      signal,
    );
    return listed.filter((file) => file !== undefined);
  }

  /**
   * The reads {@link findGlobal} shares: each of `files` read and parsed,
   * by path. A record whose type, method or definition differs from what
   * its file's location says counts `key_mismatch`, so a layout that would
   * make a caller's choice of files wrong shows in its traces.
   */
  private async readListed(
    files: ReadonlyMap<string, ListedOutput>,
    signal: AbortSignal,
  ): Promise<Map<string, GlobalOutput>> {
    const tally = currentDiagnosticTally();
    const read = await mapBounded(
      [...files.values()],
      SCAN_CONCURRENCY,
      async ({ modelType, method, path, definitionId }) => {
        // Per-file try/catch closes the TOCTOU window: a concurrent delete
        // can remove the file between its listing and readTextFile.
        // NotFound on a single file means "skip it" — never "abandon the
        // rest of the scan."
        try {
          // Stage B: parse and verify
          const content = await withScanPermit(
            "search",
            () => tally.measure("read", () => Deno.readTextFile(path)),
            signal,
          );
          tally.add("files_read");
          if (tally.recording) {
            tally.add("bytes_read", utf8ByteLength(content));
          }
          const data = tally.measureSync(
            "parse",
            () => parseYaml(content),
          ) as ModelOutputData | null;
          if (!data) return undefined;
          if (data.logFile) {
            data.logFile = toAbsolutePath(this.repoDir, data.logFile);
          }
          const output = ModelOutput.fromData(data);
          if (
            definitionId !== undefined &&
            (output.definitionId !== definitionId ||
              output.methodName !== method)
          ) {
            tally.add("key_mismatch");
          }
          return [
            path,
            { output, type: modelType, method: output.methodName },
          ] as const;
        } catch (error) {
          // A cancelled scan is not an unreadable record: it ends the scan.
          signal?.throwIfAborted();
          this.skipUnreadableRecord(path, error);
          return undefined;
        }
      },
      signal,
    );
    return new Map(read.filter((entry) => entry !== undefined));
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
