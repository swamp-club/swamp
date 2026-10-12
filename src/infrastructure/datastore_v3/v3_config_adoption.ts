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
import type {
  DefinitionKind,
  PartitionKey,
} from "../../domain/datastore_v3/partition_key.ts";
import { CommitRejectedError } from "../../domain/datastore_v3/partition.ts";
import { ConfigChanges } from "../../domain/datastore_v3/repository_changes.ts";
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
  /** An earlier file of the same kind declares the same name. */
  | "duplicate-name";

/** A repo-local file adoption skipped, and why. */
export interface SkippedConfigFile {
  readonly kind: DefinitionKind;
  readonly path: string;
  readonly name: string | undefined;
  readonly reason: ConfigAdoptionSkipReason;
}

/** What adoption found in the repo. */
export interface ConfigAdoptionPlan {
  readonly adoptions: readonly ConfigAdoption[];
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
    for (const sourcePath of await regularYamlFiles(sourceRoot)) {
      const rel = relative(sourceRoot, sourcePath);
      assertContainedPath(rel, targetRoot);
      const targetPath = join(targetRoot, rel);
      // Once adopted, the config tier holds the same bytes at the same
      // path: skip it before parsing it or reading the commit log, so a
      // repo whose config was adopted long ago pays one read per file.
      // Adoption writes a tier copy only after its commit lands, so a copy
      // means a committed name (a copy placed there by hand aside).
      if (await sameBytes(sourcePath, targetPath)) {
        alreadyCommitted++;
        continue;
      }
      const prior = await readPriorFile(sourcePath);
      if (prior === undefined) continue;
      const name = prior.name;
      const changes = name === undefined
        ? undefined
        : unlessUnpartitionable(() => new ConfigChanges(kind, name));
      if (name === undefined || changes === undefined) {
        skipped.push({ kind, path: sourcePath, name, reason: "unnamed" });
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
        alreadyCommitted++;
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
  return { adoptions, alreadyCommitted, skipped };
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
): Promise<ConfigAdoptionPlan> {
  const handle = v3DatastoreFor(repoDir, config);
  return await planConfigAdoption({
    repoDir,
    configBase,
    partitionHasCommits: async (partition) =>
      (await handle.commitStore.head(handle.namespace, partition)).seq > 0,
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
  if (plan.adoptions.length === 0) return;
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
}

/** Whether `target` is a file holding exactly the bytes `source` holds. */
async function sameBytes(source: string, target: string): Promise<boolean> {
  let targetBytes: Uint8Array;
  try {
    const info = await Deno.lstat(target);
    if (!info.isFile) return false;
    targetBytes = await Deno.readFile(target);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return false;
    throw error;
  }
  const sourceBytes = await Deno.readFile(source);
  return sourceBytes.length === targetBytes.length &&
    sourceBytes.every((byte, index) => byte === targetBytes[index]);
}

/**
 * The `.yaml` and `.yml` regular files under `root`, sorted, so the first
 * of two files declaring one name is always the same one. Symlinks, to
 * files or directories and `root` itself, are skipped and never followed. A
 * missing root has none.
 */
async function regularYamlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  try {
    if ((await Deno.lstat(root)).isSymlink) return [];
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
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
      throw error;
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
  return files.sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
}
