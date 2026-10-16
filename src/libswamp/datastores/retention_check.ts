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

import { join, SEPARATOR } from "@std/path";
import { parse as parseYaml } from "@std/yaml";
import {
  RETENTION_KINDS,
  type RetentionKind,
  type RetentionPolicy,
} from "../../domain/retention/retention_policy.ts";
import type {
  RetentionWatermark,
  RetentionWatermarkRepository,
} from "../../domain/retention/retention_watermark.ts";
import { isRetentionExempt } from "../../domain/retention/retention_exemptions.ts";
import {
  NestedRunRefSchema,
  ParentRunRefSchema,
} from "../../domain/workflows/nested_run_ref.ts";
import { MIN_ORPHAN_SNAPSHOT_AGE_MS } from "../../domain/data/run_lifecycle_service.ts";
import type { UnifiedDataRepository } from "../../domain/data/repositories.ts";
import type { DatastorePathResolver } from "../../domain/datastore/datastore_path_resolver.ts";
import { AUDIT_FILENAME_PATTERN } from "../../domain/audit/audit_path.ts";
import { modelRegistry } from "../../domain/models/model.ts";
import { lifetimeToMs } from "../../domain/data/data_metadata.ts";
import {
  SWAMP_SUBDIRS,
  swampPath,
} from "../../infrastructure/persistence/paths.ts";
import { YamlEvaluatedWorkflowRepository } from "../../infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import {
  type DatastoreConfig,
  isCustomDatastoreConfig,
} from "../../domain/datastore/datastore_config.ts";
import { resolverEngine } from "../../domain/datastore/datastore_path_resolver.ts";
import {
  type V3RetentionHistory,
  v3RetentionHistory,
} from "../../infrastructure/datastore_v3/v3_repo_context.ts";

/** Most overdue items listed per kind; the count covers the rest. */
export const RETENTION_CHECK_ITEM_LIMIT = 50;

/**
 * Grace past the v3 compaction bound before history older than it fails the
 * check: the pass that removes an item cannot fold its own remove, and the
 * next hourly pass may not have run yet.
 */
export const V3_HISTORY_GRACE_MS = 24 * 60 * 60 * 1000;

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled"]);

/** One item still stored past its kind's retention. */
export interface RetentionOverdueItem {
  /** What the item is: a run id, a path relative to its kind's root, a day. */
  id: string;
  /** The time it was judged by (ISO-8601). */
  at: string;
}

/** The last retention pass recorded for a kind. */
export interface RetentionCheckWatermark {
  lastPassAt: string;
  cutoff: string;
  complete: boolean;
}

/** What a storage scan found for one kind. */
export interface RetentionKindCheck {
  kind: RetentionKind;
  /** The configured duration, or null when the kind has no retention. */
  retention: string | null;
  /** now − retention (ISO-8601), or null when the kind has no retention. */
  cutoff: string | null;
  /**
   * False when storage was not scanned for the kind: no retention, or the
   * kind (serve bookkeeping) lives in serve's control plane, not here.
   */
  scanned: boolean;
  /** Items older than the cutoff that retention would have removed. */
  overdue: number;
  /** The first {@link RETENTION_CHECK_ITEM_LIMIT} of them. */
  items: RetentionOverdueItem[];
  /**
   * Items older than the cutoff that retention keeps by design: unfinished
   * runs and their snapshots, finished runs a related unfinished run still
   * reads, exempt access/serve state, names with an in-flight write.
   */
  kept: number;
  watermark: RetentionCheckWatermark | null;
}

/** The v3 commit history that still holds removed content. */
export interface RetentionV3HistoryCheck {
  /** The oldest commit still stored (ISO-8601), or null when none is. */
  oldestCommitAt: string | null;
  /**
   * Commits written before this are folded by each retention pass: the
   * earlier of the retention cutoff and the 7-day safety window.
   */
  compactionBound: string;
  /** History older than this fails the check: the bound less a day's grace. */
  failBefore: string;
  overdue: boolean;
}

/** Outcome of `swamp doctor datastores --retention`. */
export interface RetentionCheckSummary {
  /** True when any kind has a retention. */
  configured: boolean;
  /** True when retention runs on its own (serve timer, CLI end of command). */
  automatic: boolean;
  checkedAt: string;
  kinds: RetentionKindCheck[];
  /** Present only for a v3 datastore. */
  v3History?: RetentionV3HistoryCheck;
}

/** Where a retention scan reads storage. */
export interface RetentionScanSources {
  repoDir: string;
  /** Resolves the datastore directories; absent, the repo's own `.swamp`. */
  datastoreResolver?: DatastorePathResolver;
  /** The data repository whose files the data scan walks. */
  dataRepo?: Pick<
    UnifiedDataRepository,
    "findAllGlobal" | "listVersions" | "findByName" | "hasPendingVersions"
  >;
  /** The agent command log directory; defaults to `.swamp/audit`. */
  auditDir?: string;
  watermarks?: RetentionWatermarkRepository;
  /** v3 only: how far back the commit history reaches at `now`. */
  v3History?: (now: Date) => Promise<V3RetentionHistory>;
}

/**
 * The scan sources of an opened repository: its datastore directories, its
 * data repository and watermarks, and on a v3 filesystem datastore its
 * commit history.
 */
export function retentionScanSourcesFor(input: {
  repoDir: string;
  datastoreConfig: DatastoreConfig;
  datastoreResolver: DatastorePathResolver;
  dataRepo: NonNullable<RetentionScanSources["dataRepo"]>;
  watermarks?: RetentionWatermarkRepository;
}): RetentionScanSources {
  const config = input.datastoreConfig;
  return {
    repoDir: input.repoDir,
    datastoreResolver: input.datastoreResolver,
    dataRepo: input.dataRepo,
    ...(input.watermarks ? { watermarks: input.watermarks } : {}),
    ...(!isCustomDatastoreConfig(config) &&
        resolverEngine(input.datastoreResolver) === "v3"
      ? {
        v3History: (now: Date) =>
          v3RetentionHistory(input.repoDir, config, now),
      }
      : {}),
  };
}

/** True when the summary shows anything past its retention. */
export function retentionCheckFailed(summary: RetentionCheckSummary): boolean {
  return summary.kinds.some((kind) => kind.overdue > 0) ||
    summary.v3History?.overdue === true;
}

class OverdueList {
  count = 0;
  kept = 0;
  readonly items: RetentionOverdueItem[] = [];

  add(id: string, atMs: number): void {
    this.count++;
    if (this.items.length < RETENTION_CHECK_ITEM_LIMIT) {
      this.items.push({ id, at: new Date(atMs).toISOString() });
    }
  }
}

interface RunRecord {
  workflowId: string;
  runId: string;
  status: string | null;
  /** completedAt ?? startedAt, in epoch ms; undefined when neither parses. */
  timestampMs: number | undefined;
  mtimeMs: number | undefined;
  parentRunId: string | null;
  childRunIds: string[];
}

function parseTime(value: unknown): number | undefined {
  if (typeof value !== "string" && !(value instanceof Date)) return undefined;
  const ms = new Date(value).getTime();
  return Number.isNaN(ms) ? undefined : ms;
}

async function readDirNames(
  dir: string,
  want: "file" | "dir",
): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (want === "dir" ? entry.isDirectory : entry.isFile) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return names.sort();
}

/** Every run record file, read straight from storage (no index). */
async function readRunRecords(runsDir: string): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const workflowId of await readDirNames(runsDir, "dir")) {
    const dir = join(runsDir, workflowId);
    for (const name of await readDirNames(dir, "file")) {
      if (!name.startsWith("workflow-run-") || !name.endsWith(".yaml")) {
        continue;
      }
      const path = join(dir, name);
      let mtimeMs: number | undefined;
      let data: Record<string, unknown> | null;
      try {
        mtimeMs = (await Deno.stat(path)).mtime?.getTime();
        data = parseYaml(await Deno.readTextFile(path)) as
          | Record<string, unknown>
          | null;
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        // An unparseable record is judged like an empty one: by its mtime.
        data = null;
      }
      const fileRunId = name.slice("workflow-run-".length, -".yaml".length);
      if (!data || typeof data !== "object") {
        records.push({
          workflowId,
          runId: fileRunId,
          status: null,
          timestampMs: undefined,
          mtimeMs,
          parentRunId: null,
          childRunIds: [],
        });
        continue;
      }
      const parent = ParentRunRefSchema.safeParse(data.parentRun);
      const childRunIds: string[] = [];
      const jobs = Array.isArray(data.jobs) ? data.jobs : [];
      for (const job of jobs) {
        const steps = Array.isArray(job?.steps) ? job.steps : [];
        for (const step of steps) {
          const link = NestedRunRefSchema.safeParse(step?.nestedRun);
          if (link.success) childRunIds.push(link.data.runId.toLowerCase());
        }
      }
      records.push({
        workflowId,
        runId: typeof data.id === "string" ? data.id : fileRunId,
        status: typeof data.status === "string" ? data.status : null,
        timestampMs: parseTime(data.completedAt) ?? parseTime(data.startedAt),
        mtimeMs,
        parentRunId: parent.success ? parent.data.runId.toLowerCase() : null,
        childRunIds,
      });
    }
  }
  return records;
}

function checkRuns(
  records: readonly RunRecord[],
  cutoffMs: number,
): OverdueList {
  const list = new OverdueList();
  const byId = new Map(records.map((r) => [r.runId.toLowerCase(), r]));
  const unfinished = (record: RunRecord | undefined): boolean =>
    record !== undefined && record.status !== null &&
    !TERMINAL_STATUSES.has(record.status);

  for (const record of records) {
    const id = `${record.workflowId}/${record.runId}`;
    if (record.status === null) {
      // An empty record is removed by its mtime alone.
      if (record.mtimeMs !== undefined && record.mtimeMs < cutoffMs) {
        list.add(id, record.mtimeMs);
      }
      continue;
    }
    if (record.timestampMs === undefined || record.timestampMs >= cutoffMs) {
      continue;
    }
    if (!TERMINAL_STATUSES.has(record.status)) {
      list.kept++;
      continue;
    }
    // A finished nested run is kept while its parent has not finished, and
    // a finished parent while a child it started still runs.
    const parent = record.parentRunId === null
      ? undefined
      : byId.get(record.parentRunId);
    const self = record.runId.toLowerCase();
    const waitingChild = record.childRunIds.some((childId) => {
      const child = byId.get(childId);
      return unfinished(child) &&
        (child!.parentRunId === null || child!.parentRunId === self);
    });
    if (unfinished(parent) || waitingChild) {
      list.kept++;
      continue;
    }
    list.add(id, record.timestampMs);
  }
  return list;
}

async function checkSnapshots(
  snapshotsDir: string,
  repoDir: string,
  records: readonly RunRecord[],
  snapshotCutoffMs: number,
  runCutoffMs: number | undefined,
  nowMs: number,
): Promise<OverdueList> {
  const list = new OverdueList();
  const statuses = new Map(
    records.map((r) => [r.runId.toLowerCase(), r.status]),
  );
  const finishedAt = new Map(
    records.map((r) => [r.runId.toLowerCase(), r.timestampMs]),
  );
  // Orphans are judged against the run retention; with none, against the
  // snapshot retention, never younger than the orphan age guard.
  const orphanCutoffMs = Math.min(
    runCutoffMs ?? snapshotCutoffMs,
    nowMs - MIN_ORPHAN_SNAPSHOT_AGE_MS,
  );
  const snapshots = await new YamlEvaluatedWorkflowRepository(
    repoDir,
    snapshotsDir,
  ).listRunSnapshots();
  for (const snapshot of snapshots) {
    const modifiedMs = snapshot.modifiedAt.getTime();
    const key = snapshot.runId.toLowerCase();
    if (!statuses.has(key)) {
      if (modifiedMs < orphanCutoffMs) list.add(snapshot.runId, modifiedMs);
      continue;
    }
    // As retention ages it: from the later of the snapshot and its run's
    // finish, so a long-suspended run's snapshot is not overdue early.
    const agedFromMs = Math.max(modifiedMs, finishedAt.get(key) ?? modifiedMs);
    if (agedFromMs >= snapshotCutoffMs) continue;
    const status = statuses.get(key);
    if (
      status !== null && status !== undefined && TERMINAL_STATUSES.has(status)
    ) {
      list.add(snapshot.runId, modifiedMs);
    } else {
      list.kept++;
    }
  }
  return list;
}

async function collectYamlFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        for (const file of await collectYamlFiles(path)) files.push(file);
      } else if (entry.isFile && entry.name.endsWith(".yaml")) {
        files.push(path);
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return files.sort();
}

/**
 * The cutoff an output under `relativePath` is removed at: the retention
 * cutoff, or its method's `outputLifetime` cutoff when that is more recent,
 * as `deleteByMethodLifetime` decides it.
 */
function outputCutoffFor(
  fallbackCutoffMs: number,
  nowMs: number,
): (relativePath: string) => number {
  const types: Array<{
    prefix: string;
    def: NonNullable<ReturnType<typeof modelRegistry.get>>;
  }> = [];
  for (const modelType of modelRegistry.types()) {
    const def = modelRegistry.get(modelType);
    if (def) {
      types.push({
        prefix: modelType.normalized.replaceAll("/", SEPARATOR) + SEPARATOR,
        def,
      });
    }
  }
  types.sort((a, b) => b.prefix.length - a.prefix.length);
  return (relativePath) => {
    for (const { prefix, def } of types) {
      if (!relativePath.startsWith(prefix)) continue;
      const method = def.methods[
        relativePath.slice(prefix.length).split(
          SEPARATOR,
        )[0]
      ];
      const lifetimeMs = method?.outputLifetime
        ? lifetimeToMs(method.outputLifetime)
        : null;
      return lifetimeMs === null
        ? fallbackCutoffMs
        : Math.max(fallbackCutoffMs, nowMs - lifetimeMs);
    }
    return fallbackCutoffMs;
  };
}

async function checkOutputs(
  outputsDir: string,
  cutoffMs: number,
  nowMs: number,
): Promise<OverdueList> {
  const list = new OverdueList();
  const cutoffFor = outputCutoffFor(cutoffMs, nowMs);
  for (const path of await collectYamlFiles(outputsDir)) {
    const relativePath = path.slice(outputsDir.length + 1);
    const outputCutoffMs = cutoffFor(relativePath);
    let data: Record<string, unknown> | null;
    let mtimeMs: number | undefined;
    try {
      mtimeMs = (await Deno.stat(path)).mtime?.getTime();
      data = parseYaml(await Deno.readTextFile(path)) as
        | Record<string, unknown>
        | null;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      data = null;
    }
    if (!data || typeof data !== "object") {
      if (mtimeMs !== undefined && mtimeMs < outputCutoffMs) {
        list.add(relativePath, mtimeMs);
      }
      continue;
    }
    const startedMs = parseTime(data.startedAt);
    if (startedMs === undefined || startedMs >= outputCutoffMs) continue;
    if (
      typeof data.status !== "string" || !TERMINAL_STATUSES.has(data.status)
    ) {
      list.kept++;
      continue;
    }
    list.add(relativePath, startedMs);
  }
  return list;
}

async function checkData(
  dataRepo: NonNullable<RetentionScanSources["dataRepo"]>,
  cutoffMs: number,
): Promise<OverdueList> {
  const list = new OverdueList();
  for (const { data, modelType, modelId } of await dataRepo.findAllGlobal()) {
    const versions = await dataRepo.listVersions(modelType, modelId, data.name);
    const label = `${modelType.normalized}/${modelId}/${data.name}`;
    const aged: Array<{ version: number; createdMs: number }> = [];
    for (const version of versions) {
      const stored = await dataRepo.findByName(
        modelType,
        modelId,
        data.name,
        version,
      );
      if (!stored) continue;
      const createdMs = stored.createdAt.getTime();
      if (createdMs < cutoffMs) aged.push({ version, createdMs });
    }
    if (aged.length === 0) continue;
    if (
      isRetentionExempt(modelType.normalized) ||
      await dataRepo.hasPendingVersions?.(modelType, modelId, data.name)
    ) {
      list.kept += aged.length;
      continue;
    }
    for (const { version, createdMs } of aged) {
      list.add(`${label}@${version}`, createdMs);
    }
  }
  return list;
}

async function checkAudit(
  auditDir: string,
  cutoff: Date,
): Promise<OverdueList> {
  const list = new OverdueList();
  // Retention removes whole days: a file goes once its day is before the
  // cutoff's day.
  const cutoffDay = cutoff.toISOString().split("T")[0];
  for (const name of await readDirNames(auditDir, "file")) {
    const day = name.match(AUDIT_FILENAME_PATTERN)?.[1];
    if (day !== undefined && day < cutoffDay) {
      list.add(name, Date.parse(`${day}T00:00:00.000Z`));
    }
  }
  return list;
}

async function readWatermarks(
  repo: RetentionWatermarkRepository | undefined,
): Promise<RetentionWatermark[]> {
  if (!repo) return [];
  try {
    return await repo.getAll();
  } catch {
    // A watermark the store cannot give is only context for the scan.
    return [];
  }
}

/**
 * How far past its cutoff an item may be before the check calls it overdue
 * when retention is automatic: one hourly pass plus slack.
 */
export const RETENTION_PASS_GRACE_MS = 2 * 60 * 60 * 1000;

/**
 * Scans storage — the record files themselves, never only an index — for
 * items each kind's retention should already have removed
 * (swamp-club#3473). Read-only.
 */
export async function scanRetention(
  sources: RetentionScanSources,
  policy: RetentionPolicy,
  now: Date,
): Promise<RetentionCheckSummary> {
  const nowMs = now.getTime();
  const dirFor = (subdir: string): string =>
    sources.datastoreResolver?.resolvePath(subdir) ??
      swampPath(sources.repoDir, subdir);
  const watermarks = await readWatermarks(sources.watermarks);
  // With automatic retention, an item that crossed its cutoff since the
  // last hourly pass is not yet overdue: it is judged against the cutoff
  // less one pass interval and slack (serve's first pass, a CLI's budget).
  const graceMs = policy.automatic ? RETENTION_PASS_GRACE_MS : 0;
  const cutoffOf = (kind: RetentionKind): Date | undefined => {
    const cutoff = policy.cutoff(kind, now);
    return cutoff ? new Date(cutoff.getTime() - graceMs) : undefined;
  };

  const runCutoff = cutoffOf("workflowRuns");
  const snapshotCutoff = cutoffOf("evaluatedSnapshots");
  const runRecords = runCutoff || snapshotCutoff
    ? await readRunRecords(dirFor(SWAMP_SUBDIRS.workflowRuns))
    : [];

  const scan = async (
    kind: RetentionKind,
    cutoff: Date,
  ): Promise<OverdueList | null> => {
    switch (kind) {
      case "workflowRuns":
        return checkRuns(runRecords, cutoff.getTime());
      case "evaluatedSnapshots":
        return await checkSnapshots(
          dirFor(SWAMP_SUBDIRS.workflowsEvaluated),
          sources.repoDir,
          runRecords,
          // Without its own key a snapshot goes with its run: only orphans
          // can be overdue, never a kept run's snapshot.
          policy.isExplicit("evaluatedSnapshots")
            ? cutoff.getTime()
            : Number.NEGATIVE_INFINITY,
          runCutoff?.getTime(),
          nowMs,
        );
      case "outputs":
        return await checkOutputs(
          dirFor(SWAMP_SUBDIRS.outputs),
          cutoff.getTime(),
          nowMs,
        );
      case "data":
        return sources.dataRepo
          ? await checkData(sources.dataRepo, cutoff.getTime())
          : null;
      case "audit":
        return await checkAudit(
          sources.auditDir ?? swampPath(sources.repoDir, SWAMP_SUBDIRS.audit),
          cutoff,
        );
      case "bookkeeping":
        // Serve bookkeeping lives in serve's control plane and is reaped by
        // its worker GC; only its watermark is shown.
        return null;
    }
  };

  const kinds: RetentionKindCheck[] = [];
  for (const kind of RETENTION_KINDS) {
    const cutoff = cutoffOf(kind);
    const result = cutoff ? await scan(kind, cutoff) : null;
    const watermark = watermarks.find((w) => w.kind === kind);
    kinds.push({
      kind,
      retention: policy.durationFor(kind) ?? null,
      cutoff: cutoff?.toISOString() ?? null,
      scanned: result !== null,
      overdue: result?.count ?? 0,
      items: result?.items ?? [],
      kept: result?.kept ?? 0,
      watermark: watermark
        ? {
          lastPassAt: watermark.lastPassAt,
          cutoff: watermark.cutoff,
          complete: watermark.complete,
        }
        : null,
    });
  }

  const summary: RetentionCheckSummary = {
    configured: policy.hasAnyRetention,
    automatic: policy.automatic,
    checkedAt: now.toISOString(),
    kinds,
  };

  if (sources.v3History) {
    const history = await sources.v3History(now);
    const failBefore = new Date(
      history.compactionBound.getTime() - V3_HISTORY_GRACE_MS,
    );
    const oldestMs = history.oldestCommitAt === null
      ? undefined
      : parseTime(history.oldestCommitAt);
    summary.v3History = {
      oldestCommitAt: history.oldestCommitAt,
      compactionBound: history.compactionBound.toISOString(),
      failBefore: failBefore.toISOString(),
      overdue: policy.hasAnyRetention && oldestMs !== undefined &&
        oldestMs < failBefore.getTime(),
    };
  }

  return summary;
}
