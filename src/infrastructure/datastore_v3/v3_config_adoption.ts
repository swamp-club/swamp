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
 * Adopting a repo's existing config into a v3 datastore's config tier
 * (swamp-club#3300).
 *
 * On v2, `swamp datastore config migrate` copies the repo's model
 * definitions, workflows and vault configs into the config tier. A v3 config
 * tier is what its commits say, so each of those files has to be committed.
 * Adoption reads the repo-local `models/`, `workflows/` and `vaults/` trees
 * and commits each file into its managed-config partition (the config
 * partition of its kind and name) as a `definition.create` expecting its
 * key absent, writing the same bytes into the checkout's config tier.
 *
 * The commit log is the migration record: a name is adopted only while its
 * partition has never had a commit. So a re-run adopts nothing, a name
 * deleted from the tier after it was adopted is never brought back, and a
 * name another checkout already committed is never overwritten. A checkout
 * that commits the same name between this one's catch-up and its commit
 * makes this one's create fail its `absent` precondition.
 *
 * Only regular files are read: a symlink in the repo's trees is skipped, so
 * a repo-controlled link can never pull bytes from outside the repo into the
 * datastore. Secrets are never read: vault configs name their vault, the
 * secrets stay where the vault keeps them.
 *
 * @module
 */

import { ensureDir } from "@std/fs";
import { dirname, extname, join, relative, SEPARATOR } from "@std/path";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import type { FilesystemDatastoreConfig } from "../../domain/datastore/datastore_config.ts";
import { copyPulledExtensions } from "../../domain/datastore/managed_config_migration.ts";
import {
  type DefinitionKind,
  type PartitionKey,
  partitionOf,
} from "../../domain/datastore_v3/partition_key.ts";
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
import { v3DatastoreFor } from "./v3_repo_context.ts";

/** Where each kind of config lives, in the repo and in the config tier. */
const ADOPTED_TREES: readonly {
  readonly kind: DefinitionKind;
  readonly dir: string;
}[] = [
  { kind: "model", dir: "models" },
  { kind: "workflow", dir: "workflows" },
  { kind: "vault", dir: "vaults" },
];

/** A repo-local file adoption will commit. */
export interface ConfigAdoption {
  readonly kind: DefinitionKind;
  readonly name: string;
  readonly id: string | undefined;
  /** The repo-local file. */
  readonly sourcePath: string;
  /** Where it lands in the config tier. */
  readonly targetPath: string;
  readonly content: Uint8Array;
}

/** Why a repo-local file is not adopted, when that is worth reporting. */
export type ConfigAdoptionSkipReason =
  /** The file declares no name, or one no partition can be formed from. */
  | "unnamed"
  /** The file, or a directory holding it, could not be read. */
  | "unreadable"
  /**
   * The commit log already holds the name, and this checkout's config tier
   * has no copy at the file's path: another checkout's definition of it, or
   * one renamed or deleted since it was adopted.
   */
  | "name-committed"
  /** No record key can name the file's path in the config tier. */
  | "invalid-path"
  /** An earlier file of the same kind declares the same name. */
  | "duplicate-name";

/** A repo-local file adoption skipped, and why. */
export interface SkippedConfigFile {
  readonly kind: DefinitionKind | "lockfile";
  readonly path: string;
  readonly name: string | undefined;
  readonly reason: ConfigAdoptionSkipReason;
}

/** The repo-local extension lockfile, adopted with the config. */
export interface LockfileAdoption {
  readonly sourcePath: string;
  /** `upstream_extensions.json` in the config tier. */
  readonly targetPath: string;
  readonly content: Uint8Array;
  /**
   * The repo's pulled extension sources and the managed root a managed repo
   * reads them from, when the repo has any. They are never committed (they
   * have no v3 intent), so they are copied in this checkout only, as v2's
   * migration copies them.
   */
  readonly pulledExtensions?: {
    readonly source: string;
    readonly target: string;
  };
}

/** What adoption found in the repo. */
export interface ConfigAdoptionPlan {
  readonly adoptions: readonly ConfigAdoption[];
  /** The extension lockfile, when the commit log has never held one. */
  readonly lockfile?: LockfileAdoption;
  /**
   * Files with nothing to do: the commit log already holds their name, or
   * the config tier already holds their bytes at their path.
   */
  readonly alreadyCommitted: number;
  readonly skipped: readonly SkippedConfigFile[];
}

/** Options for {@link planConfigAdoption}. */
export interface PlanConfigAdoptionOptions {
  readonly repoDir: string;
  /** The checkout's managed config base, `.swamp[/<namespace>]/config`. */
  readonly configBase: string;
  /** Whether the commit log holds any commit of `partition`. */
  readonly partitionHasCommits: (partition: PartitionKey) => Promise<boolean>;
  /**
   * The repo-local extension lockfile (`upstream_extensions.json` in the
   * repo's extension models directory). Turning managedConfig on moves the
   * lockfile into the config tier, so it is adopted with the config, and
   * the repo's pulled extension sources move with it.
   */
  readonly lockfileSource?: string;
  /**
   * Confirm a config-tier copy against the commit log rather than trust it.
   * `datastore config migrate` sets it: it is not on every command's path,
   * and a copy the commit log never held (one left by an earlier setup, or
   * placed by hand) must not stop its name being committed.
   */
  readonly verifyTierCopies?: boolean;
}

/**
 * Finds the repo-local config the commit log has never held. Reads files
 * and the commit log only; it writes nothing.
 */
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
      // Adoption writes a tier copy only after its commit lands, and every
      // later write there commits too, so a file at the target path means a
      // committed name (a copy placed there by hand aside), whatever bytes
      // an edit has since given it. Skip it before parsing it or reading the
      // commit log: a repo adopted long ago pays one lstat per file.
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
      if (await options.partitionHasCommits(changes.partition)) {
        if (hasTierCopy) {
          alreadyCommitted++;
        } else {
          skipped.push({
            kind,
            path: sourcePath,
            name,
            reason: "name-committed",
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
 * The lockfile adoption, when the repo has a lockfile of its own and the
 * commit log has never held one. Its partition has no precondition (a
 * lockfile put carries none), so the commit log's head is what keeps a
 * second checkout from replacing a lockfile another one committed.
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

/**
 * Stages each adoption's commit. Call it inside a root unit of work open over
 * the v3 context whose hook is `markDirty`; the root's commit lands the
 * adoptions. It writes no file: {@link commitConfigAdoption} writes the
 * config tier once the commit has landed.
 */
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

/**
 * {@link planConfigAdoption} over the v3 datastore `config` names, whose
 * commit store answers which partitions have commits. The context opening
 * caught the read model up, so the plan sees every commit made before it.
 */
export async function planV3ConfigAdoption(
  repoDir: string,
  config: FilesystemDatastoreConfig,
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
    ...options,
  });
}

/**
 * Thrown when another checkout committed a name this adoption was about to
 * create: its `absent` precondition failed, and nothing it staged in that
 * name's partition landed. Running adoption again adopts nothing for the
 * names that now have commits.
 */
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

/** Options for {@link adoptV3Config}. */
export interface AdoptV3ConfigOptions {
  /** The v3 context to commit through. */
  readonly repoContext: Pick<RepositoryContext, "markDirty" | "commitLog">;
  readonly repoDir: string;
  readonly config: FilesystemDatastoreConfig;
  /** The checkout's managed config base, `.swamp[/<namespace>]/config`. */
  readonly configBase: string;
  /** See {@link PlanConfigAdoptionOptions.lockfileSource}. */
  readonly lockfileSource?: string;
  /** See {@link PlanConfigAdoptionOptions.verifyTierCopies}. */
  readonly verifyTierCopies?: boolean;
}

/**
 * Commits the repo-local config the v3 commit log has never held
 * ({@link commitConfigAdoption}) and returns what it found.
 *
 * @throws ConfigAdoptionRefusedError when another checkout committed one of
 *   the names first
 */
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
 * Commits `plan`'s adoptions in a root unit of work of its own over the v3
 * context, then writes them into the checkout's config tier. The root has no
 * flush, so it never releases the locks of the command it runs in. Call it
 * with no root open over the context: a child unit would end before the
 * outer root commits, and the files would be written ahead of the commit. A
 * plan with nothing to adopt opens no root.
 *
 * @throws ConfigAdoptionRefusedError when another checkout committed one of
 *   the keys first
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
  // The files are written only once the commit has landed, so a config-tier
  // copy always means a committed one. When the commit fails, nothing is
  // written, and the partitions that did commit reach this checkout at its
  // next catch-up, as another checkout's commits do.
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

/** Whether `path` is a regular file, without following a symlink. */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.lstat(path)).isFile;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
}

/**
 * The `.yaml` and `.yml` regular files under `root`, sorted, so the first
 * of two files declaring one name is always the same one. Symlinks, to
 * files or directories and `root` itself, are skipped and never followed. A
 * missing root has none.
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
