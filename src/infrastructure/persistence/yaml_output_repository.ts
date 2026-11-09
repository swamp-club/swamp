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
  inTimeSlices,
  inTimeSlicesFromNow,
  mapBounded,
  SCAN_CONCURRENCY,
  type ScanKind,
  sortInTimeSlices,
  withScanPermit,
} from "./scan_permits.ts";
import { type SharedScanOutcome, SharedScans } from "./shared_scans.ts";
import { runOutsideAmbientContext } from "../runtime/ambient_context.ts";
import type {
  NewestFirstOutput,
  OutputKey,
  OutputRepository,
  OutputsNewestFirst,
  OutputSummaryOptions,
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
  isSettledStatus,
  ModelOutput,
  type ModelOutputData,
  type ModelOutputId,
} from "../../domain/models/model_output.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import {
  type OutputSummary,
  outputSummaryOf,
} from "../../domain/models/output_summary.ts";
import { lifetimeToMs } from "../../domain/data/data_metadata.ts";
import {
  outputFileStamp as fileStamp,
  OutputSummaryIndex,
  outputSummaryKey,
  type OutputSummaryRow,
  shardDayOf,
} from "./output_summary_index.ts";
import {
  fingerprintMatches,
  fingerprintOf,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

const logger = getLogger(["output-repo"]);

type PositionedOutput = ListedOutput & { position: number };

/** a name without a stamp sorts first: only reading it says when it started */
function newestFileFirst(a: PositionedOutput, b: PositionedOutput): number {
  if (a.stamp !== b.stamp) {
    if (a.stamp === undefined) return -1;
    if (b.stamp === undefined) return 1;
    return a.stamp < b.stamp ? 1 : -1;
  }
  return a.position - b.position;
}

interface ListingOrder {
  readonly sorted: Promise<PositionedOutput[]>;
  readonly controller: AbortController;
  waiting: number;
  settled: boolean;
}

async function pickInTimeSlices<T, R>(
  items: readonly T[],
  pick: (item: T, index: number) => R | undefined,
  signal: AbortSignal | undefined,
): Promise<R[]> {
  const picked: R[] = [];
  let at = 0;
  await inTimeSlices(
    () => at < items.length,
    (until) => {
      do {
        const value = pick(items[at], at);
        if (value !== undefined) picked.push(value);
        at++;
      } while (at < items.length && performance.now() < until);
    },
    signal,
  );
  return picked;
}

function untilAborted<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

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
 * a direct run writes its output record only when it finishes, so its log has
 * no record meanwhile; the log's mtime moves with every line, so only a
 * long-silent run could lose its log
 */
const ORPHAN_LOG_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const SUMMARY_BACKFILL_BATCH = 1024;

const SUMMARY_QUIET_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * shard bytes a read may parse per wanted file before reading the records
 * instead, so one model's few runs do not parse a whole day of its type
 */
const SUMMARY_SHARD_BYTES_PER_FILE = 16 * 1024;

const OUTPUT_FILE_NAME =
  /^(.+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.yaml$/;

/**
 * a year outside 0000-9999 makes a signed stamp, so comparing it with a name's
 * does not order them as their instants
 */
function nameStampOf(instant: Date | undefined): string | undefined {
  if (instant === undefined) return undefined;
  const stamp = fileStamp(instant);
  return /^\d{4}-/.test(stamp) ? stamp : undefined;
}

type GlobalOutput = { output: ModelOutput; type: ModelType; method: string };

type GlobalSummary = { output: OutputSummary; type: ModelType; method: string };

interface OpenShards {
  generation: string | undefined;
  readonly rows: Map<string, Promise<Map<string, OutputSummaryRow>>>;
}

interface ListedOutput {
  modelType: ModelType;
  method: string;
  path: string;
  definitionId?: string;
  stamp?: string;
}

async function chooseReadable<T extends ListedOutput>(
  listed: T[],
  selectReadable: SelectReadableOutputs | undefined,
  signal: AbortSignal | undefined,
): Promise<T[]> {
  if (selectReadable === undefined) return listed;
  const keys: OutputKey[] = [];
  const keyIndex = new Map<string, number>();
  // A file without a key is always read: its slot stays -1.
  const keyOfFile = new Int32Array(listed.length).fill(-1);
  let at = 0;
  const indexing = inTimeSlicesFromNow(
    () => at < listed.length,
    (until) => {
      do {
        const file = listed[at];
        if (file.definitionId !== undefined) {
          const key = JSON.stringify([
            file.modelType.normalized,
            file.definitionId,
            file.method,
          ]);
          let index = keyIndex.get(key);
          if (index === undefined) {
            index = keys.length;
            keyIndex.set(key, index);
            keys.push({
              type: file.modelType,
              definitionId: file.definitionId,
              methodName: file.method,
            });
          }
          keyOfFile[at] = index;
        }
        at++;
      } while (at < listed.length && performance.now() < until);
    },
    signal,
  );
  if (indexing !== undefined) await indexing;
  const readable = keys.length === 0 ? [] : await selectReadable(keys);
  const tally = currentDiagnosticTally();
  const kept: T[] = [];
  at = 0;
  const filtering = inTimeSlicesFromNow(
    () => at < listed.length,
    (until) => {
      do {
        const key = keyOfFile[at];
        if (key === -1 || readable[key] === true) kept.push(listed[at]);
        else tally.add("skipped_by_authorization");
        at++;
      } while (at < listed.length && performance.now() < until);
    },
    signal,
  );
  if (filtering !== undefined) await filtering;
  return kept;
}

interface HistoryWindow {
  since?: Date;
  until?: Date;
}

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

function joinPendingReads(
  pending: Map<string, ListedOutput>,
  joining: Map<string, ListedOutput>,
): Map<string, ListedOutput> {
  for (const [path, file] of joining) pending.set(path, file);
  return pending;
}

function earlier(a: Date, b: Date): Date {
  return a.getTime() <= b.getTime() ? a : b;
}

function parseOutputFileName(
  path: string,
): { definitionId: string; stamp: string } | undefined {
  const match = OUTPUT_FILE_NAME.exec(basename(path));
  return match === null
    ? undefined
    : { definitionId: match[1], stamp: match[2] };
}

const CANDIDATE_SCAN_COUNTS = [
  "considered",
  "eligible",
  "delete_attempted",
  "deleted",
  "failed",
] as const;

export class YamlOutputRepository implements OutputRepository {
  private readonly baseDir: string;
  /**
   * always repo-local, so it differs from baseDir when outputs are stored in a
   * datastore
   */
  private readonly localOutputsDir: string;

  /**
   * concurrent identical searches share one read, so memory is bounded by the
   * repository's size rather than by how many clients poll
   */
  private readonly historyScans = new SharedScans<
    HistoryWindow,
    OutputSummary[]
  >(widenHistoryWindow);
  private readonly listingScans = new SharedScans<
    Date | undefined,
    ListedOutput[]
  >((a, b) => a === undefined || b === undefined ? undefined : earlier(a, b));
  /**
   * shared by callers of the same kind of scan whatever each listed: a caller
   * joining adds the files it chose to the pending reads
   */
  private readonly readScans = new SharedScans<
    Map<string, ListedOutput>,
    Map<string, GlobalOutput>
  >(joinPendingReads);
  private readonly summaryScans = new SharedScans<
    Map<string, ListedOutput>,
    Map<string, GlobalSummary>
  >(joinPendingReads);

  private readonly summaries: OutputSummaryIndex;

  private recordsInCheckout?: Promise<boolean>;

  private readonly listingOrders = new WeakMap<
    readonly ListedOutput[],
    ListingOrder
  >();

  constructor(
    private readonly repoDir: string,
    baseDir?: string,
    private readonly markDirty?: MarkDirtyHook,
    readonly unreadableContent?: UnreadableContentLookup,
  ) {
    this.localOutputsDir = swampPath(repoDir, SWAMP_SUBDIRS.outputs);
    this.baseDir = baseDir ?? this.localOutputsDir;
    this.summaries = new OutputSummaryIndex(repoDir, this.baseDir);
  }

  private staged<T>(
    changes: StagedChange | readonly StagedChange[],
    write: () => Promise<T>,
  ): Promise<T> {
    // every record write stages its typed change after it, so a v3 unit takes
    // no path change from here; run logs have no typed change since nothing
    // puts them on v3 yet
    return withChangeSignalled(this.markDirty, changes, { typed: true }, write);
  }

  /**
   * a vanished file is skipped, an I/O error propagates, anything else is
   * warned and skipped; parse errors are checked before isIoError, which
   * matches message text a YAML error can quote
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
   * an output id is not in its file name, so on a miss the datastore's
   * unmaterialised records may be it: fail as not found naming them, without
   * the unreadable-content code since a mistyped id looks the same
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
    const dir = this.getMethodDir(type, method);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
        const path = join(dir, entry.name);

        // per-file try/catch closes the TOCTOU window: a concurrent delete can
        // remove a file between readDir and read; NotFound skips it, never
        // aborting a search whose target comes later
        try {
          const content = await Deno.readTextFile(path);
          const data = parseYaml(content) as ModelOutputData | null;
          if (!data) continue;
          if (data.id === id) {
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
   * not loud about unmaterialised records: callers (the orphaned-run reaper,
   * model cancel) treat a missing record as none, and failing them would stop
   * the reaping and cancelling that clear the runs
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

  /** from file names alone; an unmaterialised record counts as an output */
  async definitionIdsWithOutputs(type: ModelType): Promise<Set<string>> {
    const ids = new Set<string>();
    const typeDir = this.getTypeDir(type);
    let methodDirs: Deno.DirEntry[];
    try {
      methodDirs = await readDirSorted(typeDir);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      methodDirs = [];
    }
    for (const methodDir of methodDirs) {
      if (!methodDir.isDirectory) continue;
      let files: Deno.DirEntry[];
      try {
        files = await readDirSorted(join(typeDir, methodDir.name));
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
      for (const file of files) {
        const name = parseOutputFileName(file.name);
        if (name) ids.add(name.definitionId);
      }
    }
    for (
      const entry of await unreadableRecordsUnder(
        this.unreadableContent,
        typeDir,
      )
    ) {
      const name = parseOutputFileName(entry.path);
      if (name) ids.add(name.definitionId);
    }
    return ids;
  }

  /**
   * a file name carries its definition and start, so an unmaterialised record
   * that started after the latest readable one fails the lookup rather than
   * answering with an older output
   */
  async findLatestByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
  ): Promise<ModelOutput | null> {
    const outputs = (await this.readAll(type)).filter((output) =>
      output.definitionId === definitionId
    );
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

  /**
   * skips files named for another definition or stamped outside the window
   * unread; a name not in getPath form is read. Scans are shared, so callers
   * must not mutate the outputs.
   */
  async findHistoryByDefinition(
    type: ModelType,
    definitionId: DefinitionId,
    window?: HistoryWindow,
    signal?: AbortSignal,
  ): Promise<OutputSummary[]> {
    const { value: outputs, joined } = await this.historyScans.run(
      JSON.stringify([type.normalized, definitionId]),
      window ?? {},
      (scanWindow, scanSignal) =>
        this.readHistory(type, definitionId, scanWindow, scanSignal),
      signal,
    );
    if (joined) currentDiagnosticTally().add("scans_joined");
    const { stampIn, startedIn } = historyWindowOf(window);
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

  private async readHistory(
    type: ModelType,
    definitionId: DefinitionId,
    window: HistoryWindow,
    signal: AbortSignal,
  ): Promise<OutputSummary[]> {
    const { stampIn } = historyWindowOf(window);
    const listed = await this.listType(
      type,
      "bulk",
      (name) => {
        const match = OUTPUT_FILE_NAME.exec(name);
        if (match === null) return true;
        return match[1] === definitionId && stampIn(match[2]);
      },
      signal,
    );
    const files = window.since === undefined
      ? listed
      : await this.leaveOutOldUnnamed(listed, window.since.getTime(), signal);
    const read = await this.readSummaries(
      new Map(files.map((file) => [file.path, file])),
      {},
      signal,
    );
    const outputs: OutputSummary[] = [];
    for (const file of files) {
      const found = read.get(file.path);
      if (found !== undefined) outputs.push(found.output);
    }
    return outputs;
  }

  private async listType(
    type: ModelType,
    kind: ScanKind,
    readsName?: (name: string) => boolean,
    signal?: AbortSignal,
  ): Promise<ListedOutput[]> {
    const typeDir = this.getTypeDir(type);
    const tally = currentDiagnosticTally();

    let methodEntries: Deno.DirEntry[];
    try {
      methodEntries = await withScanPermit(
        kind,
        () => readDirSorted(typeDir),
        signal,
      );
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return [];
      throw error;
    }

    // Method directories are listed SCAN_CONCURRENCY at a time, as in
    // findAllGlobalSince; the result is in the order a sequential walk
    // returns it.
    return (await mapBounded(
      methodEntries.filter((entry) => entry.isDirectory),
      SCAN_CONCURRENCY,
      async ({ name: method }) => {
        const methodDir = join(typeDir, method);
        // per-method-directory try/catch closes the TOCTOU window: a concurrent
        // bulk delete can remove a method directory mid-walk; NotFound skips
        // it, never abandoning outputs already collected
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
        const found: ListedOutput[] = [];
        for (const entry of entries) {
          if (!entry.isFile || !entry.name.endsWith(".yaml")) continue;
          if (readsName && !readsName(entry.name)) {
            tally.add("skipped_by_name");
            continue;
          }
          const match = OUTPUT_FILE_NAME.exec(entry.name);
          found.push({
            modelType: type,
            method,
            path: join(methodDir, entry.name),
            definitionId: match?.[1],
            stamp: match?.[2],
          });
        }
        return found;
      },
      signal,
    )).flat();
  }

  private async readAll(type: ModelType): Promise<ModelOutput[]> {
    const files = await this.listType(type, "lookup");
    return await this.readOutputFiles(files);
  }

  private async readOutputFiles(
    files: readonly ListedOutput[],
  ): Promise<ModelOutput[]> {
    const tally = currentDiagnosticTally();
    const outputs = await mapBounded(
      files,
      SCAN_CONCURRENCY,
      async ({ path }) => {
        // per-file try/catch closes the TOCTOU window: a concurrent delete can
        // remove a file between readDir and read; NotFound skips it, never
        // abandoning the rest of the scan
        try {
          const content = await withScanPermit(
            "lookup",
            () => tally.measure("read", () => Deno.readTextFile(path)),
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
          this.skipUnreadableRecord(path, error);
          return undefined;
        }
      },
    );
    return outputs.filter((output) => output !== undefined);
  }

  /**
   * the listing is taken once, so a file written after it is not read; a file
   * named for another definition is skipped unread, as findHistoryByDefinition
   * does, while a name not in getPath form is read and filtered on content
   */
  async *findPages(
    type: ModelType,
    options: { definitionId?: DefinitionId; pageSize: number },
  ): AsyncGenerator<ModelOutput[]> {
    const { definitionId } = options;
    const pageSize = Math.max(1, Math.floor(options.pageSize));
    const files = await this.listType(
      type,
      "lookup",
      definitionId === undefined ? undefined : (name) => {
        const match = OUTPUT_FILE_NAME.exec(name);
        return match === null || match[1] === definitionId;
      },
    );
    for (let start = 0; start < files.length; start += pageSize) {
      const read = await this.readOutputFiles(
        files.slice(start, start + pageSize),
      );
      const page = definitionId === undefined
        ? read
        : read.filter((output) => output.definitionId === definitionId);
      if (page.length > 0) yield page;
    }
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.getTypeDir(type),
      definitionId === undefined
        ? undefined
        : (entry) =>
          parseOutputFileName(entry.path)?.definitionId === definitionId,
    );
  }

  /**
   * concurrent calls share listing and reads; each gets its own array but the
   * outputs in it are shared, so callers must not mutate them
   */
  async findAllGlobal(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<GlobalOutput[]> {
    const listed = await this.listReadable(
      "all",
      undefined,
      selectReadable,
      signal,
    );
    const found = await this.readChosen(
      this.readScans,
      "all",
      listed,
      (files, scanSignal) => this.readListed(files, scanSignal),
      signal,
    );
    await warnUnreadableLeftOut(this.unreadableContent, this.baseDir);
    return found;
  }

  async findAllGlobalSummaries(
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<GlobalSummary[]> {
    const listed = await this.listReadable(
      "all",
      undefined,
      selectReadable,
      signal,
    );
    const found = await this.readChosen(
      this.summaryScans,
      "all",
      listed,
      (files, scanSignal) => this.readSummaries(files, {}, scanSignal),
      signal,
    );
    await warnUnreadableLeftOut(this.unreadableContent, this.baseDir);
    return found;
  }

  /**
   * a name stamped before the cutoff is skipped without a stat, since startedAt
   * never changes (a v3 replay rewrites every mtime); other names use an mtime
   * pre-filter; every record read is rechecked
   */
  async findAllGlobalSince(
    cutoff: Date,
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
    options: OutputSummaryOptions = {},
  ): Promise<GlobalSummary[]> {
    const listed = await this.listReadable(
      "since",
      cutoff,
      selectReadable,
      signal,
    );
    const found = await this.readChosen(
      this.summaryScans,
      options.errorMessages ? "since-with-errors" : "since",
      listed,
      (files, scanSignal) => this.readSummaries(files, options, scanSignal),
      signal,
    );
    const cutoffMs = cutoff.getTime();
    // A cutoff outside years 0000-9999 has a signed stamp, which sorts
    // before every name's.
    const cutoffStamp = fileStamp(cutoff);

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
   * files are ordered by name, newest first; a name not in getPath form is read
   * first; selectReadable is asked only about files next reaches, in chunks
   * that double within a call
   */
  async findGlobalNewestFirst(
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst> {
    const listing = await this.listingScans.run(
      window.since === undefined ? "all" : "since",
      window.since,
      (scanCutoff, scanSignal) => this.listAllGlobal(scanCutoff, scanSignal),
      signal,
    );
    const { stampIn } = historyWindowOf(window);
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.baseDir,
      (entry) => {
        const stamp = parseOutputFileName(entry.path)?.stamp;
        return stamp === undefined || stampIn(stamp);
      },
    );
    const tally = currentDiagnosticTally();
    const ordered = await pickInTimeSlices(
      await this.sharedOrder(listing.value, signal),
      (file) => {
        if (file.stamp === undefined || stampIn(file.stamp)) return file;
        tally.add("skipped_by_name");
        return undefined;
      },
      signal,
    );
    return this.newestFirst(
      listing,
      ordered,
      () => true,
      signal,
      selectReadable,
    );
  }

  async findHistoryNewestFirst(
    type: ModelType,
    definitionId: DefinitionId,
    window: { since?: Date; until?: Date },
    signal?: AbortSignal,
    selectReadable?: SelectReadableOutputs,
  ): Promise<OutputsNewestFirst> {
    const listing = await this.listingScans.run(
      JSON.stringify([type.normalized]),
      window.since,
      (scanCutoff, scanSignal) =>
        this.listTypes([type], scanCutoff, scanSignal),
      signal,
    );
    const { stampIn } = historyWindowOf(window);
    await warnUnreadableLeftOut(
      this.unreadableContent,
      this.getTypeDir(type),
      (entry) => {
        const name = parseOutputFileName(entry.path);
        return name?.definitionId === definitionId && stampIn(name.stamp);
      },
    );
    // A definition's files are few of its type's, so it sorts only those.
    const tally = currentDiagnosticTally();
    const mine = await pickInTimeSlices(
      listing.value,
      (file, position): PositionedOutput | undefined => {
        if (
          file.stamp === undefined ||
          (file.definitionId === definitionId && stampIn(file.stamp))
        ) return { ...file, position };
        tally.add("skipped_by_name");
        return undefined;
      },
      signal,
    );
    return this.newestFirst(
      listing,
      await sortInTimeSlices(mine, newestFileFirst, signal),
      (output) => output.definitionId === definitionId,
      signal,
      selectReadable,
    );
  }

  /**
   * one sort per shared listing for every caller on it; once the last caller
   * leaves an unsettled sort, it is forgotten before it is aborted, so a later
   * caller sorts afresh rather than inheriting the abort
   */
  private async sharedOrder(
    listing: readonly ListedOutput[],
    signal: AbortSignal | undefined,
  ): Promise<PositionedOutput[]> {
    signal?.throwIfAborted();
    let order = this.listingOrders.get(listing);
    if (order === undefined) {
      const controller = new AbortController();
      const sorted = runOutsideAmbientContext(() =>
        sortInTimeSlices(
          listing.map((file, position) => ({ ...file, position })),
          newestFileFirst,
          controller.signal,
        )
      );
      const created: ListingOrder = {
        sorted,
        controller,
        waiting: 0,
        settled: false,
      };
      // Handled here: an aborted sort has no caller left to see it reject, and
      // a sort that failed must not answer the next caller on this listing.
      sorted.then(() => created.settled = true, () => {
        created.settled = true;
        if (this.listingOrders.get(listing) === created) {
          this.listingOrders.delete(listing);
        }
      });
      order = created;
      this.listingOrders.set(listing, order);
    }
    const waited = order;
    waited.waiting++;
    try {
      return await untilAborted(waited.sorted, signal);
    } finally {
      waited.waiting--;
      if (waited.waiting === 0 && !waited.settled) {
        this.listingOrders.delete(listing);
        waited.controller.abort();
      }
    }
  }

  private newestFirst(
    listing: SharedScanOutcome<ListedOutput[]>,
    ordered: readonly PositionedOutput[],
    accepted: (output: OutputSummary) => boolean,
    signal: AbortSignal | undefined,
    selectReadable: SelectReadableOutputs | undefined,
  ): OutputsNewestFirst {
    let reportedJoined = false;
    const reportJoined = (joined: boolean) => {
      if (!joined || reportedJoined) return;
      currentDiagnosticTally().add("scans_joined");
      reportedJoined = true;
    };
    let examined = 0;
    let chosen: PositionedOutput[] = [];
    let chosenAt = 0;
    // Kept for this read: its batches would otherwise parse one shard each.
    const shards: OpenShards = { generation: undefined, rows: new Map() };
    const readFiles = (
      pending: ReadonlyMap<string, ListedOutput>,
      scanSignal: AbortSignal,
    ) => this.readSummaries(pending, {}, scanSignal, shards);
    const summaryScans = this.summaryScans;
    return {
      get unread() {
        return ordered.length - examined + chosen.length - chosenAt;
      },
      unreadStartedBefore(instant) {
        const stamp = nameStampOf(instant);
        if (stamp === undefined) return false;
        const head = chosen[chosenAt] ?? ordered[examined];
        if (head === undefined) return true;
        return head.stamp !== undefined && head.stamp < stamp;
      },
      async next(count): Promise<NewestFirstOutput[]> {
        while (true) {
          signal?.throwIfAborted();
          let chunk = count;
          while (
            chosen.length - chosenAt < count && examined < ordered.length
          ) {
            const files = ordered.slice(examined, examined + chunk);
            examined += files.length;
            const picked = await chooseReadable(
              files,
              selectReadable,
              signal,
            );
            chosen = [...chosen.slice(chosenAt), ...picked];
            chosenAt = 0;
            chunk *= 2;
          }
          const files = chosen.slice(chosenAt, chosenAt + count);
          chosenAt += files.length;
          if (files.length === 0) {
            reportJoined(listing.joined);
            return [];
          }
          const reads = await summaryScans.run(
            "newest",
            new Map(files.map((file) => [file.path, file])),
            readFiles,
            signal,
          );
          reportJoined(listing.joined || reads.joined);
          const batch: NewestFirstOutput[] = [];
          for (const file of files) {
            const found = reads.value.get(file.path);
            if (found && accepted(found.output)) {
              batch.push({ ...found, position: file.position });
            }
          }
          if (batch.length > 0) return batch;
        }
      },
    };
  }

  private async listReadable(
    key: "all" | "since",
    cutoff: Date | undefined,
    selectReadable: SelectReadableOutputs | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ chosen: ListedOutput[]; joined: boolean }> {
    const listing = await this.listingScans.run(
      key,
      cutoff,
      (scanCutoff, scanSignal) => this.listAllGlobal(scanCutoff, scanSignal),
      signal,
    );
    return {
      chosen: await chooseReadable(listing.value, selectReadable, signal),
      joined: listing.joined,
    };
  }

  private async readChosen<T>(
    scans: SharedScans<Map<string, ListedOutput>, Map<string, T>>,
    key: string,
    listed: { chosen: ListedOutput[]; joined: boolean },
    read: (
      files: Map<string, ListedOutput>,
      signal: AbortSignal,
    ) => Promise<Map<string, T>>,
    signal: AbortSignal | undefined,
  ): Promise<T[]> {
    const { chosen } = listed;
    // A caller with nothing to read waits behind no one's reads.
    if (chosen.length === 0) {
      signal?.throwIfAborted();
      if (listed.joined) currentDiagnosticTally().add("scans_joined");
      return [];
    }
    // Reads share a flight only with the same kind of scan, so a full read
    // never holds up a `since` search's few reads.
    const reads = await scans.run(
      key,
      new Map(chosen.map((file) => [file.path, file])),
      read,
      signal,
    );
    if (listed.joined || reads.joined) {
      currentDiagnosticTally().add("scans_joined");
    }
    const found: T[] = [];
    for (const file of chosen) {
      const output = reads.value.get(file.path);
      if (output !== undefined) found.push(output);
    }
    return found;
  }

  private async listAllGlobal(
    cutoff: Date | undefined,
    signal: AbortSignal,
  ): Promise<ListedOutput[]> {
    // the CLI configures but does not run the extension loader, so load the
    // registry first or extension-typed outputs are missed; ensureLoaded is
    // memoized
    await modelRegistry.ensureLoaded();
    return await this.listTypes([...modelRegistry.types()], cutoff, signal);
  }

  private async listTypes(
    types: readonly ModelType[],
    cutoff: Date | undefined,
    signal: AbortSignal,
  ): Promise<ListedOutput[]> {
    const cutoffMs = cutoff?.getTime();
    // A cutoff outside years 0000-9999 has a signed stamp, which sorts
    // before every name's: then no name is skipped, only stat'ed.
    const cutoffStamp = cutoff === undefined ? undefined : fileStamp(cutoff);
    const tally = currentDiagnosticTally();

    // each stage keeps its items in walk order, so the result matches a
    // sequential walk
    const methodDirs = (await mapBounded(
      types,
      SCAN_CONCURRENCY,
      async (modelType) => {
        const typeDir = this.getTypeDir(modelType);
        try {
          const methodEntries = await withScanPermit(
            "bulk",
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
        // a concurrent bulk delete can remove the method directory; NotFound
        // skips it without abandoning results already collected from other
        // directories
        let entries: Deno.DirEntry[];
        try {
          entries = await withScanPermit(
            "bulk",
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
            stamp: match?.[2],
          });
        }
        return found;
      },
      signal,
    )).flat();
    if (cutoffMs === undefined) return named;
    return await this.leaveOutOldUnnamed(named, cutoffMs, signal);
  }

  /**
   * a record is saved at or after its startedAt, so an unnamed file whose mtime
   * is before the cutoff cannot have started on or after it
   */
  private async leaveOutOldUnnamed(
    listed: ListedOutput[],
    cutoffMs: number,
    signal: AbortSignal,
  ): Promise<ListedOutput[]> {
    const tally = currentDiagnosticTally();
    const kept = await mapBounded(
      listed,
      SCAN_CONCURRENCY,
      async (file) => {
        if (file.definitionId !== undefined) return file;
        // A file that cannot be stat'ed is skipped as a read of it would
        // be: one deleted since its listing silently, any other with a
        // warning, and only an I/O error fails the scan.
        try {
          const stat = await withScanPermit(
            "bulk",
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
    return kept.filter((file) => file !== undefined);
  }

  /**
   * a summary row answers only while the record's stat says it is that version;
   * a damaged or replaced record is read again, so results match reading every
   * file
   */
  private async readSummaries(
    files: ReadonlyMap<string, ListedOutput>,
    options: OutputSummaryOptions,
    signal: AbortSignal,
    shards: OpenShards = { generation: undefined, rows: new Map() },
  ): Promise<Map<string, GlobalSummary>> {
    const tally = currentDiagnosticTally();
    const current = await this.summaries.generation();
    if (shards.generation !== current) {
      shards.generation = current;
      shards.rows.clear();
    }
    const wanted = new Map<
      string,
      { type: ModelType; day: string; files: number }
    >();
    for (const { modelType, stamp } of files.values()) {
      if (stamp === undefined) continue;
      const day = shardDayOf(stamp);
      const key = JSON.stringify([modelType.normalized, day]);
      const shard = wanted.get(key) ?? { type: modelType, day, files: 0 };
      shard.files++;
      wanted.set(key, shard);
    }
    const unopened = new Set<string>();
    await mapBounded(
      [...wanted].filter(([key]) => !shards.rows.has(key)),
      SCAN_CONCURRENCY,
      async ([key, { type, day, files: count }]) => {
        const bytes = await this.summaries.shardBytes(type.normalized, day);
        if (bytes > count * SUMMARY_SHARD_BYTES_PER_FILE) {
          unopened.add(key);
          tally.add("summary_shards_left_unopened");
          return;
        }
        const opened = withScanPermit(
          "bulk",
          () =>
            tally.measure(
              "summary_read",
              () => this.summaries.read(type.normalized, day, signal),
            ),
          signal,
        );
        shards.rows.set(key, opened);
        try {
          await opened;
          tally.add("summary_shards_read");
        } catch (error) {
          shards.rows.delete(key);
          throw error;
        }
      },
      signal,
    );

    const rows = new Map<string, Map<string, OutputSummaryRow>>();
    for (const key of wanted.keys()) {
      const opened = shards.rows.get(key);
      if (opened !== undefined) rows.set(key, await opened);
    }

    const found = new Map<string, GlobalSummary>();
    const unanswered: Array<[string, ListedOutput, boolean]> = [];
    const answerable: Array<[string, ListedOutput, OutputSummaryRow]> = [];
    const listed = [...files];
    let joined = 0;
    await inTimeSlices(
      () => joined < listed.length,
      (until) => {
        do {
          const [path, file] = listed[joined++];
          const { modelType, method, definitionId, stamp } = file;
          const shard = stamp === undefined
            ? undefined
            : JSON.stringify([modelType.normalized, shardDayOf(stamp)]);
          const row = shard === undefined || definitionId === undefined
            ? undefined
            : rows.get(shard)?.get(
              outputSummaryKey(method, definitionId, stamp!),
            );
          if (
            row !== undefined &&
            (!options.errorMessages || row.summary.status === "succeeded")
          ) {
            answerable.push([path, file, row]);
          } else {
            const unopenedShard = shard !== undefined && unopened.has(shard);
            unanswered.push([path, file, row !== undefined || unopenedShard]);
          }
        } while (joined < listed.length && performance.now() < until);
      },
      signal,
    );

    const versions = await this.recordFingerprints(
      answerable.map(([path]) => path),
      signal,
    );
    let checked = 0;
    await inTimeSlices(
      () => checked < answerable.length,
      (until) => {
        do {
          const [path, file, row] = answerable[checked++];
          const fingerprint = versions.get(path);
          if (
            fingerprint !== undefined &&
            fingerprintMatches(row.record, fingerprint)
          ) {
            found.set(path, {
              output: row.summary,
              type: file.modelType,
              method: row.summary.methodName,
            });
            tally.add("summary_rows_used");
          } else {
            tally.add("summary_rows_outdated");
            unanswered.push([path, file, false]);
          }
        } while (checked < answerable.length && performance.now() < until);
      },
      signal,
    );

    for (let i = 0; i < unanswered.length; i += SUMMARY_BACKFILL_BATCH) {
      const batch = unanswered.slice(i, i + SUMMARY_BACKFILL_BATCH);
      const generation = await this.summaries.generation();
      // Before the reads: a record replaced between the two has a row naming
      // the older version, which does not match it, so it is read again.
      const fingerprints = await this.recordFingerprints(
        batch.filter(([, , mayHaveRow]) => !mayHaveRow).map(([path]) => path),
        signal,
      );
      const read = await this.readListed(
        new Map(batch.map(([path, file]) => [path, file])),
        signal,
      );
      const backfill = new Map<ModelType, OutputSummaryRow[]>();
      for (const [path, file] of batch) {
        const record = read.get(path);
        if (record === undefined) continue;
        const summary = outputSummaryOf(record.output);
        found.set(path, {
          output: summary,
          type: record.type,
          method: record.method,
        });
        const fingerprint = fingerprints.get(path);
        if (
          fingerprint !== undefined && isSettledStatus(summary.status) &&
          file.definitionId === summary.definitionId &&
          file.method === summary.methodName &&
          file.stamp === fileStamp(summary.startedAt)
        ) {
          const added = backfill.get(file.modelType) ?? [];
          added.push({ summary, record: fingerprint });
          backfill.set(file.modelType, added);
        }
      }
      // Summaries cleared since these records were read may be what they
      // were cleared of: a recovery rewinds records, then clears.
      if (await this.summaries.generation() !== generation) continue;
      for (const [type, added] of backfill) {
        tally.add(
          "summary_rows_backfilled",
          await this.summaries.append(type.normalized, added),
        );
      }
    }
    return found;
  }

  /**
   * records under the checkout's .swamp are stat'ed synchronously in slices,
   * since an awaited stat waits a turn of a busy loop; others may be on a
   * network mount, so they are awaited on scan permits
   */
  private async recordFingerprints(
    paths: readonly string[],
    signal: AbortSignal,
  ): Promise<Map<string, RecordFingerprint>> {
    const tally = currentDiagnosticTally();
    const fingerprints = new Map<string, RecordFingerprint>();
    if (paths.length === 0) return fingerprints;
    this.recordsInCheckout ??= assertSafePath(
      this.baseDir,
      swampPath(this.repoDir),
    ).then(() => true, () => false);
    if (await this.recordsInCheckout) {
      let next = 0;
      await inTimeSlices(
        () => next < paths.length,
        (until) =>
          tally.measureSync("summary_stat", () => {
            do {
              const path = paths[next++];
              try {
                const fingerprint = fingerprintOf(Deno.statSync(path));
                if (fingerprint !== undefined) {
                  fingerprints.set(path, fingerprint);
                }
              } catch {
                // Its read reports what is wrong with it.
              }
            } while (next < paths.length && performance.now() < until);
          }),
        signal,
      );
    } else {
      await mapBounded(
        paths,
        SCAN_CONCURRENCY,
        async (path) => {
          try {
            const info = await withScanPermit(
              "bulk",
              () => tally.measure("summary_stat", () => Deno.stat(path)),
              signal,
            );
            const fingerprint = fingerprintOf(info);
            if (fingerprint !== undefined) fingerprints.set(path, fingerprint);
          } catch {
            signal.throwIfAborted();
          }
        },
        signal,
      );
    }
    tally.add("summary_stats", paths.length);
    return fingerprints;
  }

  private async readListed(
    files: ReadonlyMap<string, ListedOutput>,
    signal: AbortSignal,
  ): Promise<Map<string, GlobalOutput>> {
    const tally = currentDiagnosticTally();
    const read = await mapBounded(
      [...files.values()],
      SCAN_CONCURRENCY,
      async ({ modelType, method, path, definitionId, stamp }) => {
        // per-file try/catch: a concurrent delete can remove the file after
        // listing; NotFound skips it rather than abandoning the rest of the
        // scan
        try {
          const content = await withScanPermit(
            "bulk",
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
          if (stamp !== undefined && fileStamp(output.startedAt) !== stamp) {
            tally.add("stamp_mismatch");
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
      if (data.logFile) {
        data.logFile = toRelativePath(this.repoDir, data.logFile);
      }
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
    if (method === output.methodName && isSettledStatus(output.status)) {
      // Not this save's size: another writer has replaced the record since, so
      // it gets no row and the next read reads whichever is there.
      const record = await statRecord(path).catch(() => undefined);
      if (record && record.size === utf8ByteLength(content)) {
        await this.summaries.append(type.normalized, [
          { summary: outputSummaryOf(output), record },
        ]);
      }
    }
  }

  async delete(
    type: ModelType,
    method: string,
    id: ModelOutputId,
  ): Promise<void> {
    // try/catch wraps only the search so a concurrent delete of another file
    // cannot abort it; NotFound from the final remove is absorbed, keeping
    // delete idempotent
    const dir = this.getMethodDir(type, method);
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
   * with limit, the scan stops at the first expired output past it and reports
   * more; the orphaned-log sweep is left to the final batch
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

    // every batch lists every output file; the strategy is recorded so a
    // scan-heavy batch can be told from a deletion-heavy one
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
      // Rows another deleter left are never returned, so they can wait for a
      // pass that deletes something.
      if (!dryRun && deletedYamls.size > 0) {
        await observeDiagnosticPhase(
          "summary_compaction",
          {},
          async (phase) => {
            const { shardsRewritten, shardsRemoved } = await phase.tally
              .measure(
                "compact",
                () =>
                  this.summaries.compact(
                    this.liveSummaryKeys(yamlFiles, deletedYamls),
                    new Date(Date.now() - SUMMARY_QUIET_DAYS * DAY_MS)
                      .toISOString().slice(0, 10),
                  ),
              );
            phase.tally.add("shards_rewritten", shardsRewritten);
            phase.tally.add("shards_removed", shardsRemoved);
          },
        );
      }
    }

    return { deleted, bytesReclaimed, more };
  }

  private liveSummaryKeys(
    yamlFiles: readonly string[],
    deletedYamls: ReadonlySet<string>,
  ): Map<string, Set<string>> {
    const live = new Map<string, Set<string>>();
    for (const path of yamlFiles) {
      if (deletedYamls.has(path)) continue;
      const name = parseOutputFileName(path);
      const segments = relative(this.baseDir, path).split(SEPARATOR);
      if (name === undefined || segments.length < 3) continue;
      const type = segments.slice(0, -2).join("/");
      const keys = live.get(type) ?? new Set();
      keys.add(
        outputSummaryKey(segments.at(-2)!, name.definitionId, name.stamp),
      );
      live.set(type, keys);
    }
    return live;
  }

  /**
   * paths under baseDir are marked dirty before removal so datastore sync
   * propagates the deletion; a repo-local log beside a datastore is never
   * synced
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
   * a record that never parsed carries no output id or model, so no repository
   * ever put it and it gets no tombstone
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
   * a log must be older than both its method's cutoff and
   * ORPHAN_LOG_MIN_AGE_MS, since a run still in progress has no output record
   * yet
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
   * returns null when a record cannot be read, so the caller keeps every log
   * rather than guess which one it claims
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
   * a logFile outside the output's own method directory is not its to delete
   * (workflow-step outputs point at their run's log); records without one fall
   * back to the yaml's stem
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
          // loop, not push(...): one method directory can hold more outputs
          // than fit in a spread call
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
