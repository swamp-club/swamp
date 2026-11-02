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

/**
 * a name is adopted only while no commit of its partition has changed its
 * definition, so a re-run adopts nothing and a deleted or already committed
 * name is never brought back or overwritten
 */

import { ensureDir } from "@std/fs";
import { dirname, extname, join, relative, SEPARATOR } from "@std/path";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import { copyPulledExtensions } from "../../domain/datastore/managed_config_migration.ts";
import {
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
import {
  type CommitChange,
  CommitsCompactedError,
  type CommitStore,
} from "../../domain/datastore_v3/commit_store.ts";
import { changesDefinition } from "../../domain/datastore_v3/intent.ts";
import { PutOp, TombstoneOp } from "../../domain/datastore_v3/op.ts";
import {
  type LiveRecord,
  type ReadModel,
  ReadModelIncompleteError,
} from "../../domain/datastore_v3/read_model.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import {
  ConfigChanges,
  LockfileChanges,
} from "../../domain/datastore_v3/repository_changes.ts";
import { UserError } from "../../domain/errors.ts";
import {
  definitionSaveBatches,
  keyUnder,
  readPriorFile,
  unlessUnpartitionable,
} from "../persistence/config_staging.ts";
import { assertContainedPath } from "../persistence/safe_path.ts";
import type { RepositoryContext } from "../persistence/repository_factory.ts";
import { runInRootUnitOfWork } from "../persistence/repo_unit_of_work.ts";
import { stageTyped } from "../persistence/unit_of_work_scope.ts";
import { type V3DatastoreConfig, v3DatastoreFor } from "./v3_repo_context.ts";

const ADOPTED_TREES: readonly {
  readonly kind: DefinitionKind;
  readonly dir: string;
}[] = [
  { kind: "model", dir: "models" },
  { kind: "workflow", dir: "workflows" },
  { kind: "vault", dir: "vaults" },
];

export interface ConfigAdoption {
  readonly kind: DefinitionKind;
  readonly name: string;
  readonly id: string | undefined;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly content: Uint8Array;
}

export type ConfigAdoptionSkipReason =
  | "unnamed"
  | "unreadable"
  /**
   * the commit log already holds a definition of the name and this checkout's
   * config tier has no copy at the file's path
   */
  | "name-committed"
  /**
   * The name's history in the commit log was compacted, and what is left
   * shows no definition of it: it may have been deleted, or never
   * committed, and the two cannot be told apart, so it is left out.
   */
  | "history-compacted"
  | "invalid-path"
  | "duplicate-name";

export interface SkippedConfigFile {
  readonly kind: DefinitionKind | "lockfile";
  readonly path: string;
  readonly name: string | undefined;
  readonly reason: ConfigAdoptionSkipReason;
}

export interface LockfileAdoption {
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly content: Uint8Array;
  /**
   * never committed, having no v3 intent: copied in this checkout only, as v2's
   * migration copies them
   */
  readonly pulledExtensions?: {
    readonly source: string;
    readonly target: string;
  };
}

export interface ConfigAdoptionPlan {
  readonly adoptions: readonly ConfigAdoption[];
  readonly lockfile?: LockfileAdoption;
  readonly alreadyCommitted: number;
  readonly skipped: readonly SkippedConfigFile[];
}

export interface PlanConfigAdoptionOptions {
  readonly repoDir: string;
  readonly configBase: string;
  /**
   * Whether the commit log holds any commit of `partition`. Asked of the
   * lockfile partition, which holds nothing but the lockfile.
   */
  readonly partitionHasCommits: (partition: PartitionKey) => Promise<boolean>;
  /**
   * the evaluated workflow a run stages into the same partition is not the
   * definition, so it must not count
   */
  readonly definitionCommitState: (
    partition: PartitionKey,
  ) => Promise<DefinitionCommitState>;
  /**
   * turning managedConfig on moves the lockfile into the config tier, so it is
   * adopted with the config
   */
  readonly lockfileSource?: string;
  /**
   * a copy the commit log never held (left by an earlier setup or placed by
   * hand) must not stop its name being committed, so migrate confirms copies
   * against the log
   */
  readonly verifyTierCopies?: boolean;
}

export async function planConfigAdoption(
  options: PlanConfigAdoptionOptions,
): Promise<ConfigAdoptionPlan> {
  const adoptions: ConfigAdoption[] = [];
  const skipped: SkippedConfigFile[] = [];
  let alreadyCommitted = 0;
  for (const { kind, dir } of ADOPTED_TREES) {
    const sourceRoot = join(options.repoDir, dir);
    const targetRoot = join(options.configBase, dir);
    const seen = new Set<string>();
    const { files, unreadable } = await regularYamlFiles(sourceRoot);
    for (const path of unreadable) {
      skipped.push({ kind, path, name: undefined, reason: "unreadable" });
    }
    for (const sourcePath of files) {
      const rel = relative(sourceRoot, sourcePath);
      assertContainedPath(rel, targetRoot);
      const targetPath = join(targetRoot, rel);
      // adoption writes a tier copy only after its commit lands, so a file at
      // the target path means a committed name; skip it before parsing or
      // reading the commit log
      const hasTierCopy = await isFile(targetPath);
      if (hasTierCopy && options.verifyTierCopies !== true) {
        alreadyCommitted++;
        continue;
      }
      let prior: Awaited<ReturnType<typeof readPriorFile>>;
      try {
        prior = await readPriorFile(sourcePath);
      } catch {
        // An unreadable leftover must not fail every command.
        skipped.push({
          kind,
          path: sourcePath,
          name: undefined,
          reason: "unreadable",
        });
        continue;
      }
      if (prior === undefined) continue;
      const name = prior.name;
      const changes = name === undefined
        ? undefined
        : unlessUnpartitionable(() => new ConfigChanges(kind, name));
      if (name === undefined || changes === undefined) {
        skipped.push({ kind, path: sourcePath, name, reason: "unnamed" });
        continue;
      }
      // A path no record key can name (a backslash in a file name, say)
      // would throw when staged and fail every writing command.
      if (
        unlessUnpartitionable(() =>
          keyUnder("config", options.configBase, targetPath)
        ) === undefined
      ) {
        skipped.push({ kind, path: sourcePath, name, reason: "invalid-path" });
        continue;
      }
      if (seen.has(name)) {
        skipped.push({
          kind,
          path: sourcePath,
          name,
          reason: "duplicate-name",
        });
        continue;
      }
      seen.add(name);
      const state = await options.definitionCommitState(changes.partition);
      if (state !== "none") {
        if (hasTierCopy) {
          alreadyCommitted++;
        } else {
          skipped.push({
            kind,
            path: sourcePath,
            name,
            reason: state === "committed"
              ? "name-committed"
              : "history-compacted",
          });
        }
        continue;
      }
      adoptions.push({
        kind,
        name,
        id: prior.id,
        sourcePath,
        targetPath,
        content: prior.bytes,
      });
    }
  }
  const lockfile = options.lockfileSource === undefined
    ? undefined
    : await planLockfileAdoption(options, options.lockfileSource, skipped);
  return {
    adoptions,
    ...(lockfile !== undefined ? { lockfile } : {}),
    alreadyCommitted,
    skipped,
  };
}

/**
 * a lockfile put carries no precondition, so the commit log's head is what
 * keeps a second checkout from replacing a lockfile another one committed
 */
async function planLockfileAdoption(
  options: PlanConfigAdoptionOptions,
  sourcePath: string,
  skipped: SkippedConfigFile[],
): Promise<LockfileAdoption | undefined> {
  const targetPath = join(options.configBase, "upstream_extensions.json");
  if (options.verifyTierCopies !== true && await isFile(targetPath)) {
    return undefined;
  }
  let content: Uint8Array;
  try {
    if (!await isFile(sourcePath)) return undefined;
    content = await Deno.readFile(sourcePath);
  } catch {
    skipped.push({
      kind: "lockfile",
      path: sourcePath,
      name: undefined,
      reason: "unreadable",
    });
    return undefined;
  }
  if (await options.partitionHasCommits(partitionOf({ kind: "lockfile" }))) {
    return undefined;
  }
  const pulledSource = join(options.repoDir, ".swamp", "pulled-extensions");
  const pulledTarget = join(
    options.repoDir,
    ".swamp",
    "config",
    "pulled-extensions",
  );
  let hasPulled = false;
  try {
    hasPulled = (await Deno.lstat(pulledSource)).isDirectory;
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  return {
    sourcePath,
    targetPath,
    content,
    ...(hasPulled
      ? { pulledExtensions: { source: pulledSource, target: pulledTarget } }
      : {}),
  };
}

export async function stageConfigAdoption(
  markDirty: MarkDirtyHook,
  configBase: string,
  plan: ConfigAdoptionPlan,
): Promise<void> {
  const tierOf = (path: string) => ({
    tier: "config" as const,
    key: keyUnder("config", configBase, path),
  });
  for (const adoption of plan.adoptions) {
    for (
      const batch of definitionSaveBatches({
        kind: adoption.kind,
        id: adoption.id ?? "",
        name: adoption.name,
        targetPath: adoption.targetPath,
        content: adoption.content,
        removed: [],
        priors: new Map(),
        tierOf,
      })
    ) {
      await stageTyped(markDirty, () => batch);
    }
  }
  if (plan.lockfile !== undefined) {
    const key = keyUnder("config", configBase, plan.lockfile.targetPath);
    const content = plan.lockfile.content;
    await stageTyped(
      markDirty,
      () => [new LockfileChanges().write(key, content)],
    );
  }
}

export async function planV3ConfigAdoption(
  repoDir: string,
  config: V3DatastoreConfig,
  configBase: string,
  options: Pick<
    PlanConfigAdoptionOptions,
    "lockfileSource" | "verifyTierCopies"
  > = {},
): Promise<ConfigAdoptionPlan> {
  const handle = v3DatastoreFor(repoDir, config);
  return await planConfigAdoption({
    repoDir,
    configBase,
    partitionHasCommits: async (partition) =>
      (await handle.commitStore.head(handle.namespace, partition)).seq > 0,
    definitionCommitState: (partition) =>
      definitionCommitState(
        handle.commitStore,
        handle.readModel,
        handle.namespace,
        partition,
      ),
    ...options,
  });
}

export const DEFINITION_SCAN_PAGE = 256;

/**
 * compaction keeps only live records, so a deleted definition's tombstone may
 * be gone: a compacted name cannot be told from one never committed
 */
export type DefinitionCommitState = "none" | "committed" | "compacted";

export async function definitionCommitState(
  store: Pick<CommitStore, "head" | "readPartition">,
  readModel: Pick<ReadModel, "catchUp" | "liveRecords">,
  namespace: string,
  partition: PartitionKey,
): Promise<DefinitionCommitState> {
  const head = (await store.head(namespace, partition)).seq;
  if (head === 0) return "none";
  const scan = await scanForDefinition(store, namespace, partition, 1);
  if (scan !== "compacted") return scan ? "committed" : "none";
  const tail = await firstStoredSeq(store, namespace, partition, head);
  if (
    tail !== undefined &&
    await scanForDefinition(store, namespace, partition, tail) === true
  ) {
    return "committed";
  }
  let records: readonly LiveRecord[];
  try {
    // Reading the index needs a whole catch-up once the history was
    // compacted (a partition's alone leaves it incomplete); only a compacted
    // partition pays it.
    await readModel.catchUp(new AbortController().signal);
    records = await readModel.liveRecords(namespace, partition);
  } catch (error) {
    if (error instanceof ReadModelIncompleteError) return "compacted";
    throw error;
  }
  return records.some((r) => r.key.toString().startsWith("config/"))
    ? "committed"
    : "compacted";
}

async function scanForDefinition(
  store: Pick<CommitStore, "readPartition">,
  namespace: string,
  partition: PartitionKey,
  from: number,
): Promise<boolean | "compacted"> {
  for (;;) {
    let page: readonly CommitChange[];
    try {
      page = await store.readPartition(
        namespace,
        partition,
        from,
        DEFINITION_SCAN_PAGE,
      );
    } catch (error) {
      if (error instanceof CommitsCompactedError) return "compacted";
      throw error;
    }
    for (const { commit } of page) {
      if (
        commit.ops.some((op) =>
          (op instanceof PutOp || op instanceof TombstoneOp) &&
          changesDefinition(op.intent)
        )
      ) {
        return true;
      }
    }
    if (page.length < DEFINITION_SCAN_PAGE) return false;
    from = page[page.length - 1].commit.seq + 1;
  }
}

/**
 * the store keeps a partition's compacted seq to itself, so find the lowest
 * stored seq by bisecting readPartition's refusals
 */
async function firstStoredSeq(
  store: Pick<CommitStore, "readPartition">,
  namespace: string,
  partition: PartitionKey,
  head: number,
): Promise<number | undefined> {
  let low = 1;
  let high = head + 1;
  while (high - low > 1) {
    const mid = Math.floor((low + high) / 2);
    try {
      await store.readPartition(namespace, partition, mid, 1);
      high = mid;
    } catch (error) {
      if (!(error instanceof CommitsCompactedError)) throw error;
      low = mid;
    }
  }
  return high <= head ? high : undefined;
}

export class ConfigAdoptionRefusedError extends UserError {
  constructor(cause: CommitRejectedError) {
    super(
      "Another checkout committed config to this datastore while it was " +
        "being adopted, so some of this repo's existing definitions, " +
        "workflows or vault configs were not committed. Run the command " +
        `again. (${cause.message})`,
    );
    this.name = "ConfigAdoptionRefusedError";
  }
}

export interface AdoptV3ConfigOptions {
  readonly repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">;
  readonly repoDir: string;
  readonly config: V3DatastoreConfig;
  readonly configBase: string;
  readonly lockfileSource?: string;
  readonly verifyTierCopies?: boolean;
}

export async function adoptV3Config(
  options: AdoptV3ConfigOptions,
): Promise<ConfigAdoptionPlan> {
  const plan = await planV3ConfigAdoption(
    options.repoDir,
    options.config,
    options.configBase,
    {
      ...(options.lockfileSource !== undefined
        ? { lockfileSource: options.lockfileSource }
        : {}),
      ...(options.verifyTierCopies !== undefined
        ? { verifyTierCopies: options.verifyTierCopies }
        : {}),
    },
  );
  await commitConfigAdoption(options.repoContext, options.configBase, plan);
  return plan;
}

/**
 * the root has no flush, so it never releases the command's locks; call with no
 * root open, or the files would be written ahead of the outer commit
 */
export async function commitConfigAdoption(
  repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">,
  configBase: string,
  plan: ConfigAdoptionPlan,
): Promise<void> {
  if (plan.adoptions.length === 0 && plan.lockfile === undefined) return;
  const markDirty = repoContext.markDirty;
  if (markDirty === undefined) {
    throw new Error("adopting config needs a v3 context's hook");
  }
  try {
    await runInRootUnitOfWork(
      repoContext,
      { flush: undefined },
      () => stageConfigAdoption(markDirty, configBase, plan),
    );
  } catch (error) {
    if (error instanceof CommitRejectedError) {
      throw new ConfigAdoptionRefusedError(error);
    }
    throw error;
  }
  // write files only once the commit has landed, so a config-tier copy always
  // means a committed one
  for (const adoption of plan.adoptions) {
    await ensureDir(dirname(adoption.targetPath));
    await Deno.writeFile(adoption.targetPath, adoption.content);
  }
  if (plan.lockfile !== undefined) {
    await ensureDir(dirname(plan.lockfile.targetPath));
    await Deno.writeFile(plan.lockfile.targetPath, plan.lockfile.content);
    const pulled = plan.lockfile.pulledExtensions;
    if (pulled !== undefined) {
      await copyPulledExtensions(pulled.source, pulled.target);
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * sorted so the first of two files declaring one name is always the same;
 * symlinks are skipped, never followed
 */
async function regularYamlFiles(
  root: string,
): Promise<{ files: string[]; unreadable: string[] }> {
  const files: string[] = [];
  const unreadable: string[] = [];
  try {
    if ((await Deno.lstat(root)).isSymlink) return { files, unreadable };
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return { files, unreadable };
    unreadable.push(root);
    return { files, unreadable };
  }
  const walk = async (dir: string): Promise<void> => {
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dir));
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound ||
        error instanceof Deno.errors.NotADirectory
      ) {
        return;
      }
      // An unreadable directory is reported, not a failure of the command.
      unreadable.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry.isSymlink) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory) {
        await walk(path);
      } else if (
        entry.isFile && [".yaml", ".yml"].includes(extname(entry.name))
      ) {
        files.push(path);
      }
    }
  };
  await walk(root);
  // Code-unit order, not the host locale's, so every machine picks the same
  // first file of a repeated name.
  const key = (path: string) => path.split(SEPARATOR).join("/");
  files.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return { files, unreadable };
}
