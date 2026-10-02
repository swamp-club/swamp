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

// Every file a hooked repository creates, changes or deletes in the datastore
// cache must be covered by a markDirty call: the file's own cache-relative
// path, or an ancestor directory of it (swamp-club#2855). A dropped mark
// leaves the change on one machine, because the sync service only pushes and
// deletes what it was told about.
//
// Each row builds a fresh repository with the real markDirty hook wired to a
// recording sync service, snapshots the cache (size and sha256 of every file),
// runs one write or delete method, and diffs the cache. A mark covers a
// changed file only when the absolute path the repository passed to the hook
// lies inside the cache root. The hook also forwards paths under <repo>/.swamp
// relative to that directory, whose layout mirrors the cache's, so judging by
// the forwarded relPath alone would let a repo-local mark hide a cache gap.
// Changed paths no mark covers are collected as "<Repository>.<method>: <normalised path>" and
// checked against KNOWN_UNMARKED, so a new gap fails and a fixed gap fails
// until it is removed from the list.
//
// Only the cache is walked. The catalog database, the run index and the run
// logs are repo-local and never synced.
//
// Not in the table:
// - YamlVaultConfigRepository and LockfileRepository take no hook; their
//   callers mark the file by path (src/serve/handlers/vault_handlers.ts:884-893
//   and :1086-1092, src/serve/handlers/admin_handlers.ts:1330-1342,
//   src/cli/managed_config_sync.ts:159-195). The use-case characterisation
//   tests cover them.
// - Audit repositories: always repo-local.
// - The namespace manifest.
//
// pruneExcessVersions (UnifiedData), deleteExpired and sweepOrphanLogs
// (Output) are private; they are reached through save with autoGc, and
// through Output deleteOlderThan / deleteByMethodLifetime.

import "../src/domain/models/models.ts";
import { assert, assertEquals } from "@std/assert";
import { ensureDir, walk } from "@std/fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import { createRecordingSyncService } from "@swamp-club/swamp-testing";
import { buildMarkDirtyHook } from "../src/cli/repo_context.ts";
import type { StagedChange } from "../src/domain/datastore/unit_of_work.ts";
import type { MarkDirtyHook } from "../src/domain/datastore/datastore_sync_service.ts";
import { Data } from "../src/domain/data/data.ts";
import {
  createDefinitionId,
  Definition,
} from "../src/domain/definitions/definition.ts";
import {
  type ExecutionProvenance,
  ModelOutput,
} from "../src/domain/models/model_output.ts";
import { ModelType } from "../src/domain/models/model_type.ts";
import { Job } from "../src/domain/workflows/job.ts";
import { Step } from "../src/domain/workflows/step.ts";
import { StepTask } from "../src/domain/workflows/step_task.ts";
import { Workflow } from "../src/domain/workflows/workflow.ts";
import { WorkflowRun } from "../src/domain/workflows/workflow_run.ts";
import { initializeLogging } from "../src/infrastructure/logging/logger.ts";
import { DefaultDatastorePathResolver } from "../src/infrastructure/persistence/default_datastore_path_resolver.ts";
import { createLegacyUnitOfWork } from "../src/infrastructure/persistence/legacy_unit_of_work.ts";
import {
  createRepositoryContext,
  type RepositoryContext,
} from "../src/infrastructure/persistence/repository_factory.ts";
import { runInUnitOfWork } from "../src/infrastructure/persistence/unit_of_work_scope.ts";
import { YamlEvaluatedWorkflowRepository } from "../src/infrastructure/persistence/yaml_evaluated_workflow_repository.ts";
import { assertPinnedSet } from "./arch_fitness_helpers.ts";

await initializeLogging({});

/**
 * Changed cache paths no mark covers today. Each entry names the source line
 * that writes or removes the file without a mark (line numbers at the commit
 * that added this test). Fix a gap and its entry must go; open a new one and
 * the test fails until it is pinned here on purpose.
 */
const KNOWN_UNMARKED: readonly string[] = [
  // delete(version) marks only the version directory (:913). Removing the
  // latest version rewrites `latest` (:940, via updateLatestMarker), and
  // removing the last one removes the data-name directory with its `latest`
  // (:954). src/infrastructure/persistence/unified_data_repository_test.ts:851-856
  // pins exactly one mark call for this case.
  "UnifiedData.delete(version,latest-of-two): data/command/shell/<id>/item/latest",
  "UnifiedData.delete(version,last): data/command/shell/<id>/item/latest",
  // advanceLatestMarkers writes `latest` with no mark (:1352); it relies on
  // the saveDeferred mark of the same cycle.
  "UnifiedData.advanceLatestMarkers: data/command/shell/<id>/item/latest",
  // rollbackVersions removes the version directory with no mark (:1385).
  "UnifiedData.rollbackVersions: data/command/shell/<id>/item/<v>/metadata.yaml",
  "UnifiedData.rollbackVersions: data/command/shell/<id>/item/<v>/raw",
  // finalizeVersion marks only the version directory but rewrites `latest`
  // (:1264). In production allocateVersion marks the data-name directory in
  // the same cycle, which hides it; kept because Phase 1 may split them.
  "UnifiedData.finalizeVersion(standalone): data/command/shell/<id>/item/latest",
  // YamlDefinitionRepository.cleanupOldPaths removes the previous-name file
  // (:1096) and the legacy <id>.yaml file (:1114) with no mark; save marks
  // only the new target path.
  "Definition.save(rename): config/models/command/shell/probe.yaml",
  "Definition.save(legacy): config/models/command/shell/<id>.yaml",
  // YamlWorkflowRepository.save removes the previous-name file (:284) and the
  // legacy file (:303) with no mark; delete marks one resolved path and
  // removes the other pathsToTry entries unmarked (:372).
  "Workflow.save(rename): config/workflows/workflow-probe.yaml",
  "Workflow.save(legacy): config/workflows/workflow-<id>.yaml",
  "Workflow.delete(dual-file): config/workflows/workflow-probe.yaml",
  // YamlEvaluatedDefinitionRepository: save removes the previous-name file
  // (:395) and the legacy file (:407) unmarked; delete removes the other
  // pathsToTry entries unmarked (:441).
  "EvaluatedDefinition.save(rename): definitions-evaluated/command/shell/probe.yaml",
  "EvaluatedDefinition.save(legacy): definitions-evaluated/command/shell/<id>.yaml",
  "EvaluatedDefinition.delete(dual-file): definitions-evaluated/command/shell/probe.yaml",
  // YamlEvaluatedWorkflowRepository: save removes the previous-name file
  // (:298) and the legacy file (:310) unmarked; delete removes the other
  // pathsToTry entries unmarked (:337).
  "EvaluatedWorkflow.save(rename): workflows-evaluated/workflow-probe.yaml",
  "EvaluatedWorkflow.save(legacy): workflows-evaluated/workflow-<id>.yaml",
  "EvaluatedWorkflow.delete(dual-file): workflows-evaluated/workflow-probe.yaml",
  // YamlWorkflowRunRepository.deleteOlderThan marks the run YAML but removes
  // its .log unmarked: terminal runs (:766), unparseable run files (:720).
  // It also removes a legacy cache-side .runs-index.json unmarked (:799).
  "WorkflowRun.deleteOlderThan(terminal): workflow-runs/<id>/workflow-run-<id>.log",
  "WorkflowRun.deleteOlderThan(unparseable): workflow-runs/<id>/workflow-run-<id>.log",
  "WorkflowRun.deleteOlderThan(legacy-index): workflow-runs/<id>/.runs-index.json",
];

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
/** The start-time stamp in an output file name. */
const OUTPUT_STAMP = /\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z/g;
/** An atomicWrite temp file: `.<uuid>.tmp`. */
const ATOMIC_TEMP = /^\.[0-9a-f-]{36}\.tmp$/;

const TYPE = ModelType.create("command/shell");
const PROVENANCE: ExecutionProvenance = {
  definitionHash: "abc123",
  modelVersion: "2026.02.09.1",
  triggeredBy: "manual",
};
const DAY_MS = 24 * 60 * 60 * 1000;

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const tempDir = await Deno.makeTempDir();
  try {
    await fn(tempDir);
  } finally {
    if (Deno.build.os === "windows") {
      // Best-effort: EBUSY can fire when V8 hasn't GC'd native
      // sqlite handles yet. Temp dir is ephemeral, OS reclaims.
      await Deno.remove(tempDir, { recursive: true }).catch(() => {});
    } else {
      await Deno.remove(tempDir, { recursive: true });
    }
  }
}

/** The repositories one context exposes, plus the hand-built one. */
interface Repos {
  ctx: RepositoryContext;
  evaluatedWorkflowRepo: YamlEvaluatedWorkflowRepository;
}

interface Harness extends Repos {
  repoDir: string;
  cacheRoot: string;
  definitionsDir: string;
  workflowsDir: string;
  /** The recording hook every repository in this harness was built with. */
  markDirty: MarkDirtyHook;
  /** A cold second context on the same repo and cache, same hook. */
  fresh(): Repos;
}

interface Row {
  repo: string;
  method: string;
  /** Builds prior state and returns the act. Marks are cleared after it. */
  prepare: (h: Harness) => Promise<() => Promise<unknown>>;
  /** False for rows that must leave the cache untouched (dry runs). */
  changesCache?: boolean;
  autoGc?: boolean;
  /**
   * The act marks from parallel tasks, so its mark order varies from run to
   * run (collectGarbage removes versions in Promise.allSettled batches,
   * src/infrastructure/persistence/unified_data_repository.ts:1821).
   */
  parallelMarks?: boolean;
}

/** What the hook saw (absolute paths) and what it forwarded (relPaths). */
interface Marks {
  /** Absolute paths the repositories passed to the hook; undefined is bare. */
  abs: Array<string | undefined>;
  /** relPaths the hook forwarded to the sync service. */
  forwarded: Array<string | undefined>;
}

async function withHarness(
  autoGc: boolean,
  fn: (h: Harness, marks: Marks) => Promise<void>,
): Promise<void> {
  await withTempDir(async (dir) => {
    const repoDir = join(dir, "repo");
    const cacheRoot = join(dir, "cache");
    await ensureDir(repoDir);
    await ensureDir(cacheRoot);

    const { service, marks: forwarded } = createRecordingSyncService();
    const hook = buildMarkDirtyHook(service, cacheRoot, repoDir);
    const abs: Array<string | undefined> = [];
    // Record the absolute path, then delegate to the real hook.
    const markDirty: MarkDirtyHook = (absPath?: string) => {
      abs.push(absPath);
      return hook(absPath);
    };
    const resolver = new DefaultDatastorePathResolver(repoDir, {
      type: "@test/remote",
      config: {},
      datastorePath: join(dir, "remote"),
      cachePath: cacheRoot,
    });
    // Definitions and workflows under the cache config/ tier, as managedConfig
    // wires them (src/cli/repo_context.ts:1220-1231). Repo-local, the hook
    // drops their marks and the rows would prove nothing.
    const configBase = resolver.resolvePath("config");
    const definitionsDir = join(configBase, "models");
    const workflowsDir = join(configBase, "workflows");

    const opened: RepositoryContext[] = [];
    const build = (): Repos => {
      const ctx = createRepositoryContext({
        repoDir,
        enableIndexing: false,
        datastoreResolver: resolver,
        markDirty,
        definitionsDir,
        yamlWorkflowsDir: workflowsDir,
        autoGc,
      });
      opened.push(ctx);
      // The factory does not build this one.
      const evaluatedWorkflowRepo = new YamlEvaluatedWorkflowRepository(
        repoDir,
        resolver.resolvePath("workflows-evaluated"),
        markDirty,
      );
      return { ctx, evaluatedWorkflowRepo };
    };
    try {
      const first = build();
      await fn({
        ...first,
        repoDir,
        cacheRoot,
        definitionsDir,
        workflowsDir,
        markDirty,
        fresh: build,
      }, { abs, forwarded });
    } finally {
      for (const ctx of opened) ctx.catalogStore.close();
    }
  });
}

/**
 * Cache-relative forward-slash path to `size:sha256`, files only.
 *
 * Empty directories are ignored on purpose: the sync service pushes and
 * deletes files, so a leftover or newly created empty directory never reaches
 * the remote and needs no mark. A rewrite with identical bytes keeps the same
 * hash and is not a change: the remote already holds those bytes, so a
 * dropped mark loses nothing. Both would otherwise flag gaps that cannot
 * diverge two machines.
 */
async function snapshot(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const entry of walk(root, { includeDirs: false })) {
    if (ATOMIC_TEMP.test(basename(entry.path))) continue;
    const bytes = await Deno.readFile(entry.path);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", bytes),
    );
    const hex = Array.from(digest).map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    const rel = relative(root, entry.path).split(SEPARATOR).join("/");
    files.set(rel, `${bytes.length}:${hex}`);
  }
  return files;
}

function changedPaths(
  before: Map<string, string>,
  after: Map<string, string>,
): string[] {
  const changed = new Set<string>();
  for (const [path, sig] of before) {
    if (after.get(path) !== sig) changed.add(path);
  }
  for (const path of after.keys()) {
    if (!before.has(path)) changed.add(path);
  }
  return [...changed].sort();
}

function normalise(relPath: string): string {
  return relPath
    .replace(UUID, "<id>")
    .replace(OUTPUT_STAMP, "<time>")
    .split("/")
    .map((segment) => /^\d+$/.test(segment) ? "<v>" : segment)
    .join("/");
}

/**
 * Cache-relative forward-slash form of an absolute mark path, or undefined
 * when the path lies outside the cache root (repo-local marks included).
 */
function cacheRelative(cacheRoot: string, absPath: string): string | undefined {
  const rel = relative(cacheRoot, absPath);
  if (rel === ".." || rel.startsWith(".." + SEPARATOR) || isAbsolute(rel)) {
    return undefined;
  }
  return rel.split(SEPARATOR).join("/");
}

/** The exact file, or an ancestor directory on a segment boundary. */
function isCovered(path: string, marks: readonly string[]): boolean {
  return marks.some((mark) =>
    mark === "" || path === mark || path.startsWith(mark + "/")
  );
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeData(
  overrides: {
    name?: string;
    garbageCollection?: number | string;
    streaming?: boolean;
  } = {},
): Data {
  return Data.create({
    name: overrides.name ?? "item",
    contentType: "text/plain",
    lifetime: "infinite",
    garbageCollection: overrides.garbageCollection ?? 10,
    streaming: overrides.streaming,
    tags: { type: "resource" },
    ownerDefinition: { ownerType: "manual", ownerRef: "test-user" },
  });
}

const bytes = (text: string) => new TextEncoder().encode(text);

function makeDefinition(
  id: string,
  name: string,
  tags: Record<string, string> = {},
): Definition {
  return Definition.create({ id, name, globalArguments: {}, tags });
}

function makeWorkflow(id: string, name: string): Workflow {
  return Workflow.create({
    id,
    name,
    jobs: [
      Job.create({
        name: "job1",
        steps: [
          Step.create({
            name: "step1",
            task: StepTask.model("probe-model", "run"),
          }),
        ],
      }),
    ],
  });
}

function makeOutput(status: "succeeded" | "running" = "succeeded") {
  const startedAt = new Date(Date.now() - 2 * DAY_MS);
  return ModelOutput.create({
    definitionId: createDefinitionId(crypto.randomUUID()),
    methodName: "execute",
    status,
    startedAt,
    completedAt: status === "succeeded"
      ? new Date(startedAt.getTime() + 1000)
      : undefined,
    provenance: PROVENANCE,
  });
}

/** Rewrites a saved version's metadata createdAt into the past. */
async function backdateVersion(
  h: Harness,
  modelId: string,
  name: string,
  version: number,
  ageMs: number,
): Promise<void> {
  const path = h.ctx.unifiedDataRepo.getMetadataPath(
    TYPE,
    modelId,
    name,
    version,
  );
  const metadata = parseYaml(await Deno.readTextFile(path)) as Record<
    string,
    unknown
  >;
  metadata.createdAt = new Date(Date.now() - ageMs).toISOString();
  await Deno.writeTextFile(path, stringifyYaml(metadata));
}

/** A cutoff after everything the row wrote. */
const futureCutoff = () => new Date(Date.now() + 60_000);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const unifiedDataRows: Row[] = [
  {
    repo: "UnifiedData",
    method: "save",
    prepare: (h) => {
      const modelId = crypto.randomUUID();
      return Promise.resolve(() =>
        h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"))
      );
    },
  },
  {
    repo: "UnifiedData",
    method: "save(second-version)",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return () =>
        h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v2"));
    },
  },
  {
    repo: "UnifiedData",
    method: "save(autoGc-prune)",
    autoGc: true,
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const data = makeData({ garbageCollection: 2 });
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, data, bytes("v1"));
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, data, bytes("v2"));
      return async () => {
        await h.ctx.unifiedDataRepo.save(TYPE, modelId, data, bytes("v3"));
        // pruneExcessVersions ran: v1 is gone.
        assertEquals(
          await h.ctx.unifiedDataRepo.listVersions(TYPE, modelId, "item"),
          [2, 3],
        );
      };
    },
  },
  {
    repo: "UnifiedData",
    method: "saveDeferred",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return () =>
        h.ctx.unifiedDataRepo.saveDeferred(
          TYPE,
          modelId,
          makeData(),
          bytes("v2"),
        );
    },
  },
  {
    repo: "UnifiedData",
    method: "append",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(
        TYPE,
        modelId,
        makeData({ streaming: true }),
        bytes("line1\n"),
      );
      return () =>
        h.ctx.unifiedDataRepo.append(TYPE, modelId, "item", bytes("line2\n"));
    },
  },
  {
    repo: "UnifiedData",
    method: "rename",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return () =>
        h.ctx.unifiedDataRepo.rename(TYPE, modelId, "item", "renamed");
    },
  },
  {
    repo: "UnifiedData",
    method: "removeLatestMarker",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return () =>
        h.ctx.unifiedDataRepo.removeLatestMarker(TYPE, modelId, "item");
    },
  },
  {
    repo: "UnifiedData",
    method: "allocateVersion+finalizeVersion",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return async () => {
        const repo = h.ctx.unifiedDataRepo;
        const data = makeData();
        const { version, contentPath, priorVersions } = await repo
          .allocateVersion(TYPE, modelId, data);
        await Deno.writeFile(contentPath, bytes("v2"));
        await repo.finalizeVersion(TYPE, modelId, data, version, priorVersions);
      };
    },
  },
  {
    repo: "UnifiedData",
    method: "allocateVersion+finalizeVersionDeferred",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      await h.ctx.unifiedDataRepo.save(TYPE, modelId, makeData(), bytes("v1"));
      return async () => {
        const repo = h.ctx.unifiedDataRepo;
        const data = makeData();
        const { version, contentPath, priorVersions } = await repo
          .allocateVersion(TYPE, modelId, data);
        await Deno.writeFile(contentPath, bytes("v2"));
        await repo.finalizeVersionDeferred(
          TYPE,
          modelId,
          data,
          version,
          priorVersions,
        );
      };
    },
  },
  {
    // finalizeVersion on its own, with allocateVersion and the content write
    // done in setup, so only finalizeVersion's own marks count.
    repo: "UnifiedData",
    method: "finalizeVersion(standalone)",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      await repo.save(TYPE, modelId, makeData(), bytes("v1"));
      const data = makeData();
      const { version, contentPath, priorVersions } = await repo
        .allocateVersion(TYPE, modelId, data);
      await Deno.writeFile(contentPath, bytes("v2"));
      return () =>
        repo.finalizeVersion(TYPE, modelId, data, version, priorVersions);
    },
  },
  {
    repo: "UnifiedData",
    method: "delete(version,latest-of-two)",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      await repo.save(TYPE, modelId, makeData(), bytes("v1"));
      await repo.save(TYPE, modelId, makeData(), bytes("v2"));
      return () => repo.delete(TYPE, modelId, "item", 2);
    },
  },
  {
    repo: "UnifiedData",
    method: "delete(version,last)",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      await repo.save(TYPE, modelId, makeData(), bytes("v1"));
      return () => repo.delete(TYPE, modelId, "item", 1);
    },
  },
  {
    repo: "UnifiedData",
    method: "delete(all)",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      await repo.save(TYPE, modelId, makeData(), bytes("v1"));
      await repo.save(TYPE, modelId, makeData(), bytes("v2"));
      return () => repo.delete(TYPE, modelId, "item");
    },
  },
  {
    repo: "UnifiedData",
    method: "advanceLatestMarkers",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      const receipt = await repo.saveDeferred(
        TYPE,
        modelId,
        makeData(),
        bytes("v1"),
      );
      return () => repo.advanceLatestMarkers([receipt]);
    },
  },
  {
    repo: "UnifiedData",
    method: "rollbackVersions",
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      const receipt = await repo.saveDeferred(
        TYPE,
        modelId,
        makeData(),
        bytes("v1"),
      );
      return () => repo.rollbackVersions([receipt]);
    },
  },
  {
    repo: "UnifiedData",
    method: "collectGarbage(numeric)",
    parallelMarks: true,
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      const data = makeData({ garbageCollection: 1 });
      for (const v of ["v1", "v2", "v3"]) {
        await repo.save(TYPE, modelId, data, bytes(v));
      }
      return async () => {
        const result = await repo.collectGarbage(TYPE, modelId);
        assertEquals(result.versionsRemoved, 2);
      };
    },
  },
  {
    repo: "UnifiedData",
    method: "collectGarbage(duration)",
    parallelMarks: true,
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      const data = makeData({ garbageCollection: "1d" });
      for (const v of ["v1", "v2", "v3"]) {
        await repo.save(TYPE, modelId, data, bytes(v));
      }
      await backdateVersion(h, modelId, "item", 1, 3 * DAY_MS);
      await backdateVersion(h, modelId, "item", 2, 3 * DAY_MS);
      return async () => {
        const result = await repo.collectGarbage(TYPE, modelId);
        assertEquals(result.versionsRemoved, 2);
      };
    },
  },
  {
    repo: "UnifiedData",
    method: "collectGarbage(dry-run)",
    changesCache: false,
    prepare: async (h) => {
      const modelId = crypto.randomUUID();
      const repo = h.ctx.unifiedDataRepo;
      const data = makeData({ garbageCollection: 1 });
      for (const v of ["v1", "v2", "v3"]) {
        await repo.save(TYPE, modelId, data, bytes(v));
      }
      return async () => {
        const result = await repo.collectGarbage(TYPE, modelId, {
          dryRun: true,
        });
        assertEquals(result.versionsRemoved, 2);
      };
    },
  },
];

const definitionRows: Row[] = [
  {
    repo: "Definition",
    method: "save(new)",
    prepare: (h) =>
      Promise.resolve(() =>
        h.ctx.definitionRepo.save(
          TYPE,
          makeDefinition(crypto.randomUUID(), "probe"),
        )
      ),
  },
  {
    // An unchanged save returns before writing, so the update changes data.
    repo: "Definition",
    method: "save(update)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.definitionRepo.save(TYPE, makeDefinition(id, "probe"));
      return () =>
        h.ctx.definitionRepo.save(
          TYPE,
          makeDefinition(id, "probe", { env: "prod" }),
        );
    },
  },
  {
    // Same id, new name, on the warm instance that knows the old path.
    repo: "Definition",
    method: "save(rename)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.definitionRepo.save(TYPE, makeDefinition(id, "probe"));
      return () =>
        h.ctx.definitionRepo.save(TYPE, makeDefinition(id, "renamed"));
    },
  },
  {
    // A legacy <id>.yaml file, saved through a cold instance.
    repo: "Definition",
    method: "save(legacy)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.definitionRepo.save(TYPE, makeDefinition(id, "probe"));
      const typeDir = join(h.definitionsDir, TYPE.toDirectoryPath());
      await Deno.rename(
        join(typeDir, "probe.yaml"),
        join(typeDir, `${id}.yaml`),
      );
      const cold = h.fresh();
      return () =>
        cold.ctx.definitionRepo.save(TYPE, makeDefinition(id, "probe"));
    },
  },
  {
    // A definition that lives only in the auto-definitions directory is
    // saved back there.
    repo: "Definition",
    method: "save(auto-definitions)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.definitionRepo.save(TYPE, makeDefinition(id, "probe"));
      const autoTypeDir = join(
        h.ctx.autoDefinitionsDir,
        TYPE.toDirectoryPath(),
      );
      await ensureDir(autoTypeDir);
      const autoPath = join(autoTypeDir, "probe.yaml");
      await Deno.rename(
        join(h.definitionsDir, TYPE.toDirectoryPath(), "probe.yaml"),
        autoPath,
      );
      const cold = h.fresh();
      return async () => {
        await cold.ctx.definitionRepo.save(
          TYPE,
          makeDefinition(id, "probe", { env: "prod" }),
        );
        assert(
          (await Deno.readTextFile(autoPath)).includes("prod"),
          "expected the save to stay in the auto-definitions directory",
        );
      };
    },
  },
  {
    repo: "Definition",
    method: "delete",
    prepare: async (h) => {
      const definition = makeDefinition(crypto.randomUUID(), "probe");
      await h.ctx.definitionRepo.save(TYPE, definition);
      return () => h.ctx.definitionRepo.delete(TYPE, definition.id);
    },
  },
  {
    // Name file and an identical copy at the <id>.yaml path. Both declare
    // this definition, so declaresOther skips neither; a cold delete marks
    // the resolved path and then each other path it removes.
    repo: "Definition",
    method: "delete(dual-file)",
    prepare: async (h) => {
      const definition = makeDefinition(crypto.randomUUID(), "probe");
      await h.ctx.definitionRepo.save(TYPE, definition);
      const typeDir = join(h.definitionsDir, TYPE.toDirectoryPath());
      const idPath = join(typeDir, `${definition.id}.yaml`);
      await Deno.copyFile(join(typeDir, "probe.yaml"), idPath);
      const cold = h.fresh();
      return async () => {
        await cold.ctx.definitionRepo.delete(TYPE, definition.id);
        for (const path of [join(typeDir, "probe.yaml"), idPath]) {
          let exists = true;
          try {
            await Deno.stat(path);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
            exists = false;
          }
          assert(!exists, `expected the delete to remove ${basename(path)}`);
        }
      };
    },
  },
];

const workflowRows: Row[] = [
  {
    repo: "Workflow",
    method: "save(new)",
    prepare: (h) =>
      Promise.resolve(() =>
        h.ctx.workflowRepo.save(makeWorkflow(crypto.randomUUID(), "probe"))
      ),
  },
  {
    repo: "Workflow",
    method: "save(rename)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.workflowRepo.save(makeWorkflow(id, "probe"));
      return () => h.ctx.workflowRepo.save(makeWorkflow(id, "renamed"));
    },
  },
  {
    repo: "Workflow",
    method: "save(legacy)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.workflowRepo.save(makeWorkflow(id, "probe"));
      await Deno.rename(
        join(h.workflowsDir, "workflow-probe.yaml"),
        join(h.workflowsDir, `workflow-${id}.yaml`),
      );
      const cold = h.fresh();
      return () => cold.ctx.workflowRepo.save(makeWorkflow(id, "probe"));
    },
  },
  {
    repo: "Workflow",
    method: "delete",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      await h.ctx.workflowRepo.save(workflow);
      return () => h.ctx.workflowRepo.delete(workflow.id);
    },
  },
  {
    // Name file and legacy file for one id; a cold delete resolves the
    // legacy one first.
    repo: "Workflow",
    method: "delete(dual-file)",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      await h.ctx.workflowRepo.save(workflow);
      await Deno.copyFile(
        join(h.workflowsDir, "workflow-probe.yaml"),
        join(h.workflowsDir, `workflow-${workflow.id}.yaml`),
      );
      const cold = h.fresh();
      return () => cold.ctx.workflowRepo.delete(workflow.id);
    },
  },
];

function makeTerminalRun(workflow: Workflow): WorkflowRun {
  const run = WorkflowRun.create(workflow);
  run.start();
  run.endAsCancelled("test");
  return run;
}

const workflowRunRows: Row[] = [
  {
    repo: "WorkflowRun",
    method: "save",
    prepare: (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      const run = WorkflowRun.create(workflow);
      run.start();
      return Promise.resolve(() =>
        h.ctx.workflowRunRepo.save(workflow.id, run)
      );
    },
  },
  {
    repo: "WorkflowRun",
    method: "deleteAllByWorkflowId",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      await h.ctx.workflowRunRepo.save(workflow.id, makeTerminalRun(workflow));
      await h.ctx.workflowRunRepo.save(workflow.id, makeTerminalRun(workflow));
      return () => h.ctx.workflowRunRepo.deleteAllByWorkflowId(workflow.id);
    },
  },
  {
    repo: "WorkflowRun",
    method: "deleteOlderThan(terminal)",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      const run = makeTerminalRun(workflow);
      await h.ctx.workflowRunRepo.save(workflow.id, run);
      const yamlPath = h.ctx.workflowRunRepo.getPath(workflow.id, run.id);
      await Deno.writeTextFile(yamlPath.replace(/\.yaml$/, ".log"), "log\n");
      return async () => {
        const result = await h.ctx.workflowRunRepo.deleteOlderThan(
          futureCutoff(),
        );
        assertEquals(result.deletedRunIds, [run.id]);
      };
    },
  },
  {
    repo: "WorkflowRun",
    method: "deleteOlderThan(unparseable)",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      const runsDir = dirname(
        h.ctx.workflowRunRepo.getPath(
          workflow.id,
          h.ctx.workflowRunRepo.nextId(),
        ),
      );
      await ensureDir(runsDir);
      const runId = crypto.randomUUID();
      await Deno.writeTextFile(join(runsDir, `workflow-run-${runId}.yaml`), "");
      await Deno.writeTextFile(
        join(runsDir, `workflow-run-${runId}.log`),
        "log\n",
      );
      return async () => {
        const result = await h.ctx.workflowRunRepo.deleteOlderThan(
          futureCutoff(),
        );
        assertEquals(result.deletedRunIds, [runId]);
      };
    },
  },
  {
    // A cache-side .runs-index.json from before the index moved repo-local.
    // A second, live run keeps the directory from being cleaned up.
    repo: "WorkflowRun",
    method: "deleteOlderThan(legacy-index)",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      const run = makeTerminalRun(workflow);
      await h.ctx.workflowRunRepo.save(workflow.id, run);
      const live = WorkflowRun.create(workflow);
      live.start();
      await h.ctx.workflowRunRepo.save(workflow.id, live);
      const runsDir = dirname(
        h.ctx.workflowRunRepo.getPath(workflow.id, run.id),
      );
      await Deno.writeTextFile(join(runsDir, ".runs-index.json"), "{}");
      return async () => {
        const result = await h.ctx.workflowRunRepo.deleteOlderThan(
          futureCutoff(),
        );
        assertEquals(result.deletedRunIds, [run.id]);
      };
    },
  },
  {
    repo: "WorkflowRun",
    method: "deleteOlderThan(dry-run)",
    changesCache: false,
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      const run = makeTerminalRun(workflow);
      await h.ctx.workflowRunRepo.save(workflow.id, run);
      return async () => {
        const result = await h.ctx.workflowRunRepo.deleteOlderThan(
          futureCutoff(),
          { dryRun: true },
        );
        assertEquals(result.deletedRunIds, [run.id]);
      };
    },
  },
];

const evaluatedDefinitionRows: Row[] = [
  {
    repo: "EvaluatedDefinition",
    method: "save",
    prepare: (h) =>
      Promise.resolve(() =>
        h.ctx.evaluatedDefinitionRepo.save(
          TYPE,
          makeDefinition(crypto.randomUUID(), "probe"),
        )
      ),
  },
  {
    repo: "EvaluatedDefinition",
    method: "save(rename)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.evaluatedDefinitionRepo.save(
        TYPE,
        makeDefinition(id, "probe"),
      );
      return () =>
        h.ctx.evaluatedDefinitionRepo.save(TYPE, makeDefinition(id, "renamed"));
    },
  },
  {
    repo: "EvaluatedDefinition",
    method: "save(legacy)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.ctx.evaluatedDefinitionRepo.save(
        TYPE,
        makeDefinition(id, "probe"),
      );
      const typeDir = join(
        h.cacheRoot,
        "definitions-evaluated",
        TYPE.toDirectoryPath(),
      );
      await Deno.rename(
        join(typeDir, "probe.yaml"),
        join(typeDir, `${id}.yaml`),
      );
      const cold = h.fresh();
      return () =>
        cold.ctx.evaluatedDefinitionRepo.save(
          TYPE,
          makeDefinition(id, "probe"),
        );
    },
  },
  {
    repo: "EvaluatedDefinition",
    method: "delete",
    prepare: async (h) => {
      const definition = makeDefinition(crypto.randomUUID(), "probe");
      await h.ctx.evaluatedDefinitionRepo.save(TYPE, definition);
      return () => h.ctx.evaluatedDefinitionRepo.delete(TYPE, definition.id);
    },
  },
  {
    repo: "EvaluatedDefinition",
    method: "delete(dual-file)",
    prepare: async (h) => {
      const definition = makeDefinition(crypto.randomUUID(), "probe");
      await h.ctx.evaluatedDefinitionRepo.save(TYPE, definition);
      const typeDir = join(
        h.cacheRoot,
        "definitions-evaluated",
        TYPE.toDirectoryPath(),
      );
      await Deno.copyFile(
        join(typeDir, "probe.yaml"),
        join(typeDir, `${definition.id}.yaml`),
      );
      const cold = h.fresh();
      return () => cold.ctx.evaluatedDefinitionRepo.delete(TYPE, definition.id);
    },
  },
  {
    repo: "EvaluatedDefinition",
    method: "clearAll",
    prepare: async (h) => {
      await h.ctx.evaluatedDefinitionRepo.save(
        TYPE,
        makeDefinition(crypto.randomUUID(), "probe"),
      );
      return () => h.ctx.evaluatedDefinitionRepo.clearAll();
    },
  },
];

const evaluatedWorkflowRows: Row[] = [
  {
    repo: "EvaluatedWorkflow",
    method: "save",
    prepare: (h) =>
      Promise.resolve(() =>
        h.evaluatedWorkflowRepo.save(makeWorkflow(crypto.randomUUID(), "probe"))
      ),
  },
  {
    repo: "EvaluatedWorkflow",
    method: "save(rename)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.evaluatedWorkflowRepo.save(makeWorkflow(id, "probe"));
      return () => h.evaluatedWorkflowRepo.save(makeWorkflow(id, "renamed"));
    },
  },
  {
    repo: "EvaluatedWorkflow",
    method: "save(legacy)",
    prepare: async (h) => {
      const id = crypto.randomUUID();
      await h.evaluatedWorkflowRepo.save(makeWorkflow(id, "probe"));
      const dir = join(h.cacheRoot, "workflows-evaluated");
      await Deno.rename(
        join(dir, "workflow-probe.yaml"),
        join(dir, `workflow-${id}.yaml`),
      );
      const cold = h.fresh();
      return () => cold.evaluatedWorkflowRepo.save(makeWorkflow(id, "probe"));
    },
  },
  {
    repo: "EvaluatedWorkflow",
    method: "delete",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      await h.evaluatedWorkflowRepo.save(workflow);
      return () => h.evaluatedWorkflowRepo.delete(workflow.id);
    },
  },
  {
    repo: "EvaluatedWorkflow",
    method: "delete(dual-file)",
    prepare: async (h) => {
      const workflow = makeWorkflow(crypto.randomUUID(), "probe");
      await h.evaluatedWorkflowRepo.save(workflow);
      const dir = join(h.cacheRoot, "workflows-evaluated");
      await Deno.copyFile(
        join(dir, "workflow-probe.yaml"),
        join(dir, `workflow-${workflow.id}.yaml`),
      );
      const cold = h.fresh();
      return () => cold.evaluatedWorkflowRepo.delete(workflow.id);
    },
  },
  {
    repo: "EvaluatedWorkflow",
    method: "clear",
    prepare: async (h) => {
      await h.evaluatedWorkflowRepo.save(
        makeWorkflow(crypto.randomUUID(), "probe"),
      );
      await h.evaluatedWorkflowRepo.saveForRun(
        crypto.randomUUID(),
        makeWorkflow(crypto.randomUUID(), "probe-run"),
      );
      return () => h.evaluatedWorkflowRepo.clear();
    },
  },
  {
    repo: "EvaluatedWorkflow",
    method: "saveForRun",
    prepare: (h) =>
      Promise.resolve(() =>
        h.evaluatedWorkflowRepo.saveForRun(
          crypto.randomUUID(),
          makeWorkflow(crypto.randomUUID(), "probe"),
        )
      ),
  },
  {
    repo: "EvaluatedWorkflow",
    method: "deleteForRun",
    prepare: async (h) => {
      const runId = crypto.randomUUID();
      await h.evaluatedWorkflowRepo.saveForRun(
        runId,
        makeWorkflow(crypto.randomUUID(), "probe"),
      );
      return () => h.evaluatedWorkflowRepo.deleteForRun(runId);
    },
  },
];

/** Saves an output and plants its run log beside it in the cache. */
async function saveOutputWithCacheLog(h: Harness): Promise<ModelOutput> {
  const output = makeOutput();
  await h.ctx.outputRepo.save(TYPE, "execute", output);
  const yamlPath = h.ctx.outputRepo.getPath(TYPE, "execute", output);
  await Deno.writeTextFile(yamlPath.replace(/\.yaml$/, ".log"), "log\n");
  return output;
}

const outputRows: Row[] = [
  {
    repo: "Output",
    method: "save",
    prepare: (h) =>
      Promise.resolve(() =>
        h.ctx.outputRepo.save(TYPE, "execute", makeOutput())
      ),
  },
  {
    repo: "Output",
    method: "delete",
    prepare: async (h) => {
      const output = await saveOutputWithCacheLog(h);
      return () => h.ctx.outputRepo.delete(TYPE, "execute", output.id);
    },
  },
  {
    repo: "Output",
    method: "deleteOlderThan",
    prepare: async (h) => {
      await saveOutputWithCacheLog(h);
      return async () => {
        const result = await h.ctx.outputRepo.deleteOlderThan(futureCutoff());
        assertEquals(result.deleted, 1);
      };
    },
  },
  {
    repo: "Output",
    method: "deleteOlderThan(dry-run)",
    changesCache: false,
    prepare: async (h) => {
      await saveOutputWithCacheLog(h);
      return async () => {
        const result = await h.ctx.outputRepo.deleteOlderThan(futureCutoff(), {
          dryRun: true,
        });
        assertEquals(result.deleted, 1);
      };
    },
  },
  {
    repo: "Output",
    method: "deleteByMethodLifetime",
    prepare: async (h) => {
      await saveOutputWithCacheLog(h);
      return async () => {
        const result = await h.ctx.outputRepo.deleteByMethodLifetime(
          futureCutoff(),
        );
        assertEquals(result.deleted, 1);
      };
    },
  },
  {
    repo: "Output",
    method: "deleteByMethodLifetime(dry-run)",
    changesCache: false,
    prepare: async (h) => {
      await saveOutputWithCacheLog(h);
      return async () => {
        const result = await h.ctx.outputRepo.deleteByMethodLifetime(
          futureCutoff(),
          { dryRun: true },
        );
        assertEquals(result.deleted, 1);
      };
    },
  },
  {
    // sweepOrphanLogs only walks the repo-local outputs root, so an orphan
    // log is removed with no cache change and no mark.
    repo: "Output",
    method: "deleteOlderThan(orphan-log-sweep)",
    changesCache: false,
    prepare: async (h) => {
      const localDir = join(
        h.repoDir,
        ".swamp",
        "outputs",
        TYPE.normalized,
        "execute",
      );
      await ensureDir(localDir);
      const orphan = join(localDir, "orphan.log");
      await Deno.writeTextFile(orphan, "log\n");
      const old = new Date(Date.now() - 8 * DAY_MS);
      await Deno.utime(orphan, old, old);
      return async () => {
        await h.ctx.outputRepo.deleteOlderThan(futureCutoff());
        let exists = true;
        try {
          await Deno.stat(orphan);
        } catch (error) {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
          exists = false;
        }
        assert(!exists, "expected the orphan sweep to remove the old log");
      };
    },
  },
];

const ROWS: Row[] = [
  ...unifiedDataRows,
  ...definitionRows,
  ...workflowRows,
  ...workflowRunRows,
  ...evaluatedDefinitionRows,
  ...evaluatedWorkflowRows,
  ...outputRows,
];

Deno.test("markDirty: every cache file a hooked repository changes is covered by a mark inside the cache (swamp-club#2855)", async (t) => {
  const uncovered = new Set<string>();

  for (const row of ROWS) {
    const expectation = row.changesCache === false
      ? "leaves the cache unchanged and unmarked"
      : "marks every cache file it changes";
    await t.step(`${row.repo}.${row.method}: ${expectation}`, async () => {
      await withHarness(row.autoGc ?? false, async (h, marks) => {
        const act = await row.prepare(h);
        marks.abs.length = 0;
        marks.forwarded.length = 0;
        const before = await snapshot(h.cacheRoot);
        await act();
        const after = await snapshot(h.cacheRoot);
        const changed = changedPaths(before, after);

        for (const mark of marks.abs) {
          assert(mark !== undefined, "expected no bare markDirty()");
        }
        for (const mark of marks.forwarded) {
          assert(mark !== undefined, "expected no bare markDirty()");
          assert(
            !mark.startsWith("..") && !isAbsolute(mark) && !mark.includes("\\"),
            `expected a cache-relative forward-slash mark, got ${mark}`,
          );
        }
        // Only marks whose absolute path resolves inside the cache count.
        const pathMarks = marks.abs
          .map((m) =>
            m === undefined ? undefined : cacheRelative(h.cacheRoot, m)
          )
          .filter((m): m is string => m !== undefined);

        if (row.changesCache === false) {
          assertEquals(changed, [], "expected no cache change");
          assertEquals(pathMarks, [], "expected no cache mark");
          return;
        }
        assert(
          changed.length > 0,
          "expected the act to change at least one cache file",
        );
        for (const path of changed) {
          if (!isCovered(path, pathMarks)) {
            uncovered.add(`${row.repo}.${row.method}: ${normalise(path)}`);
          }
        }
      });
    });
  }

  assertPinnedSet(
    [...uncovered].sort(),
    KNOWN_UNMARKED,
    "Cache files a repository changes without a covering markDirty",
    "A repository changed a cache file no markDirty call covers. Mark the " +
      "path (or an ancestor directory) before the write or delete. Pin it in " +
      "KNOWN_UNMARKED, with the source line, only if the gap is deliberate.",
  );
});

/** A mark's absolute path made comparable across harnesses; null is bare. */
function comparableMark(h: Harness, mark: string | undefined): string | null {
  if (mark === undefined) return null;
  const rel = relative(dirname(h.cacheRoot), mark).split(SEPARATOR).join("/");
  return normalise(rel);
}

/** The marks one run of `row`'s act sends, and what a scope staged. */
async function marksOf(
  row: Row,
  scoped: boolean,
): Promise<{ marks: (string | null)[]; staged: (string | null)[] }> {
  let marks: (string | null)[] = [];
  let staged: (string | null)[] = [];
  await withHarness(row.autoGc ?? false, async (h, recorded) => {
    const act = await row.prepare(h);
    recorded.abs.length = 0;
    if (scoped) {
      const uow = createLegacyUnitOfWork(h.markDirty, { flush: undefined });
      await runInUnitOfWork(uow, act);
      staged = uow.staged().map((change: StagedChange) =>
        comparableMark(h, change.kind === "bulk" ? undefined : change.path)
      );
    } else {
      await act();
    }
    marks = recorded.abs.map((mark) => comparableMark(h, mark));
  });
  return { marks, staged };
}

Deno.test("unit of work: every repository sends the same marks inside a legacy unit of work scope as without one (swamp-club#2971)", async (t) => {
  for (const row of ROWS) {
    await t.step(`${row.repo}.${row.method}`, async () => {
      const unscoped = await marksOf(row, false);
      const scoped = await marksOf(row, true);
      if (row.parallelMarks) {
        assertEquals(
          [...scoped.marks].sort(),
          [...unscoped.marks].sort(),
          "expected the same marks (in any order: they come from parallel tasks)",
        );
      } else {
        assertEquals(
          scoped.marks,
          unscoped.marks,
          "expected the same marks in the same order",
        );
      }
      // Within one run, the unit records each change just before it marks.
      assertEquals(
        scoped.staged,
        scoped.marks,
        "expected one staged change per mark, in order",
      );
    });
  }
});

/**
 * Repositories that stage typed changes at each call site rather than through
 * a private notifyDirty (datastore rework Phase 1 repository moves). Rows of
 * the others are skipped below: every change they stage is still `write`.
 */
const MOVED_REPOSITORIES: ReadonlySet<string> = new Set([
  // swamp-club#2979, move A.
  "UnifiedData",
  "Output",
]);

/** Whether anything (file, directory or symlink) exists at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

Deno.test("unit of work: each change a moved repository stages matches the disk after the act (swamp-club#2979)", async (t) => {
  for (const row of ROWS) {
    if (!MOVED_REPOSITORIES.has(row.repo)) continue;
    await t.step(`${row.repo}.${row.method}`, async () => {
      await withHarness(row.autoGc ?? false, async (h) => {
        const act = await row.prepare(h);
        const uow = createLegacyUnitOfWork(h.markDirty, { flush: undefined });
        await runInUnitOfWork(uow, act);
        for (const change of uow.staged()) {
          if (change.kind === "bulk") {
            throw new Error(
              `expected no bulk change, got reason ${change.reason}`,
            );
          }
          const shown = comparableMark(h, change.path);
          const exists = await pathExists(change.path);
          if (change.kind === "write") {
            assert(
              exists,
              `expected staged write ${shown} to exist after the act`,
            );
          } else {
            assert(
              !exists,
              `expected staged remove ${shown} to be gone after the act`,
            );
          }
        }
      });
    });
  }
});
