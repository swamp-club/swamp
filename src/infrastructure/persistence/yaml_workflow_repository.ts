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
import { basename, join } from "@std/path";
import {
  signalChange,
  stageTyped,
  typedStagingActive,
} from "./unit_of_work_scope.ts";
import {
  definitionDeleteBatches,
  definitionSaveBatches,
  type PriorFile,
  readPriors,
  stagingTierOf,
} from "./config_staging.ts";
import { resolveEffectiveWorkflowsDir } from "./paths.ts";
import { getLogger } from "@logtape/logtape";
import { atomicWriteTextFile } from "./atomic_write.ts";
import { isIoError } from "./io_errors.ts";
import { parse as parseYaml, stringify as stringifyYaml } from "@std/yaml";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import { assertSafePath } from "./safe_path.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  isFilenameSafeName,
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { WorkflowSchemaError } from "../../domain/workflows/workflow_schema_error.ts";
import {
  type WorkflowListing,
  workflowListingOf,
} from "../../domain/workflows/workflow_listing.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import type { EventBus } from "../../domain/events/event_bus.ts";
import type { MarkDirtyHook } from "../../domain/datastore/datastore_sync_service.ts";
import {
  createWorkflowCreated,
  createWorkflowDeleted,
  createWorkflowUpdated,
} from "../../domain/events/types.ts";

const logger = getLogger(["workflow-repo"]);

/**
 * How recent a workflow file's mtime may be before its listing is not kept:
 * an edit landing within one tick of a coarse file clock could otherwise
 * leave its stat unchanged.
 */
const LISTING_RACY_WINDOW_MS = 2_000;

/** A workflow file's listing, and the stat of the file it was read from. */
interface CachedListing {
  fingerprint: RecordFingerprint;
  listing: WorkflowListing;
}

/**
 * Reports whether a file in the workflows directory is one the repository
 * reads: `workflow-{name}.yaml` or the legacy `workflow-{uuid}.yaml`. Any
 * other file there is never loaded.
 */
export function isPrimaryWorkflowFileName(name: string): boolean {
  return name.startsWith("workflow-") && name.endsWith(".yaml");
}

/**
 * Names the file in a schema failure met while reading `path`; any other
 * error is returned as it came. The message carries the file name only and
 * the full path rides on the error, because `swamp serve` withholds messages
 * that hold an absolute path from its clients (swamp-club#3062).
 */
function namingWorkflowFile(error: unknown, path: string): unknown {
  return error instanceof WorkflowSchemaError
    ? markErrorPaths(error.inFile(basename(path)), [path])
    : error;
}

/**
 * YAML-based implementation of WorkflowRepository.
 *
 * Stores workflows as YAML files in the directory structure:
 * {repoDir}/workflows/workflow-{name}.yaml   (new default for filename-safe names)
 * {repoDir}/workflows/workflow-{uuid}.yaml   (legacy, still discoverable)
 */
export class YamlWorkflowRepository implements WorkflowRepository {
  private readonly baseDir: string;
  // Tracks the actual on-disk path for each workflow ID, so getPath()
  // returns the real location rather than guessing.
  private readonly idToActualPath = new Map<WorkflowId, string>();
  /**
   * Name → file path hints, so a repeated lookup for a workflow whose file is
   * not at its name-derived path (a legacy `{uuid}.yaml`, or a name that is not
   * filename-safe) skips re-reading and re-parsing every workflow each time.
   *
   * Stores a PATH ONLY — never a parsed workflow, never a negative result. The
   * file is re-read and its declared name re-checked on every hit, so a stale
   * hint is self-correcting and external edits, renames, additions and
   * deletions stay visible. That is why `save()` and `delete()` need no
   * invalidation bookkeeping.
   *
   * If a cache-reset hook is ever added to this class, it must clear this
   * alongside `idToActualPath` and `listingsByPath`.
   */
  private readonly nameToActualPath = new Map<string, string>();
  /**
   * Each workflow file's listing, by path, kept with the stat of the file it
   * was read from (swamp-club#3443). A listing is reused only while a fresh
   * stat still matches, so an edit, rename, addition or deletion by anyone
   * is seen on the next listing. Never holds a parsed Workflow: the
   * aggregate is mutable, and `findAll` builds a new one each time.
   */
  private readonly listingsByPath = new Map<string, CachedListing>();

  constructor(
    private readonly repoDir: string,
    private readonly eventBus?: EventBus,
    baseDir?: string,
    private readonly markDirtyHook?: MarkDirtyHook,
  ) {
    this.baseDir = baseDir ?? resolveEffectiveWorkflowsDir(repoDir);
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    // Fast path: try UUID-based filename (legacy). The file must declare this
    // id: a workflow *named* with this UUID lives at the same path.
    const legacyPath = this.getLegacyPath(id);
    try {
      const content = await Deno.readTextFile(legacyPath);
      const data = parseYaml(content) as WorkflowData | null;
      if (data) {
        const workflow = Workflow.fromData(data);
        if (workflow.id === id) {
          this.idToActualPath.set(id, legacyPath);
          return workflow;
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) {
        throw namingWorkflowFile(error, legacyPath);
      }
    }

    // Try name-based filename from cache
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath && cachedPath !== legacyPath) {
      try {
        const content = await Deno.readTextFile(cachedPath);
        const data = parseYaml(content) as WorkflowData | null;
        if (data) {
          const workflow = Workflow.fromData(data);
          if (workflow.id === id) return workflow;
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw namingWorkflowFile(error, cachedPath);
        }
      }
    }

    // Slow path: the listings say which file declares the id, so only that
    // file is read. A file that changed since it was listed falls back to
    // reading them all.
    const listed = (await this.scanListings()).find((l) => l.listing.id === id);
    if (!listed) return null;
    const read = await this.readWorkflowIf(listed.path, (w) => w.id === id);
    if (read) return read;
    const workflows = await this.findAll();
    return workflows.find((w) => w.id === id) ?? null;
  }

  async findByName(name: string): Promise<Workflow | null> {
    // Fast path: try name-based filename directly
    if (isFilenameSafeName(name)) {
      const namePath = this.getNamePath(name);
      try {
        const content = await Deno.readTextFile(namePath);
        const data = parseYaml(content) as WorkflowData | null;
        if (data) {
          const workflow = Workflow.fromData(data);
          if (workflow.name !== name) {
            // File content doesn't match filename — fall through to slow path
          } else {
            this.idToActualPath.set(workflow.id as WorkflowId, namePath);
            return workflow;
          }
        }
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw namingWorkflowFile(error, namePath);
        }
      }
    }

    // Hinted path: deliberately OUTSIDE the isFilenameSafeName guard above.
    // The workflows that reach the slow path are exactly the ones that guard
    // rejects, or whose name-derived file does not exist, so a hint check
    // nested inside it would never fire for the cases that need it.
    const hintedPath = this.nameToActualPath.get(name);
    if (hintedPath) {
      const hinted = await this.readWorkflowIfNamed(hintedPath, name);
      if (hinted) return hinted;
      this.nameToActualPath.delete(name);
    }

    // Slow path: the listings say which file declares the name, so only
    // that file is read, and a name no file declares reads none. A file that
    // changed since it was listed falls back to reading them all.
    const listed = (await this.scanListings()).find((l) =>
      l.listing.name === name
    );
    if (!listed) return null;
    const read = await this.readWorkflowIfNamed(listed.path, name);
    if (read) {
      this.nameToActualPath.set(name, listed.path);
      return read;
    }
    const workflows = await this.findAll();
    const found = workflows.find((w) => w.name === name);
    if (!found) return null;
    // findAll records every file it parsed, so the path is already known.
    const foundPath = this.idToActualPath.get(found.id as WorkflowId);
    if (foundPath) this.nameToActualPath.set(name, foundPath);
    return found;
  }

  /**
   * Reads a hinted file and returns its workflow only if the file still
   * declares the expected name.
   *
   * Returns null on any failure — missing, unreadable, unparseable or renamed —
   * so the caller falls back to its normal scan and the outcome is exactly what
   * it would have been without a hint. In particular a broken workflow file
   * must not throw from here, because `findAll` warns and skips it.
   *
   * A hinted path is rejected unless it is still a regular file. `findAll`
   * discovers regular files only, so a hint can never legitimately point at a
   * symlink; without this check, a file replaced by a symlink after discovery
   * would be read through the hint when the scan would have ignored it.
   */
  private readWorkflowIfNamed(
    path: string,
    name: string,
  ): Promise<Workflow | null> {
    return this.readWorkflowIf(path, (workflow) => workflow.name === name);
  }

  /**
   * {@link readWorkflowIfNamed} for any test of the workflow the file holds.
   * Records the file as the workflow's path when it passes.
   */
  private async readWorkflowIf(
    path: string,
    wanted: (workflow: Workflow) => boolean,
  ): Promise<Workflow | null> {
    try {
      if (!(await Deno.lstat(path)).isFile) return null;
      const content = await Deno.readTextFile(path);
      const data = parseYaml(content) as WorkflowData | null;
      if (!data) return null;
      const workflow = Workflow.fromData(data);
      if (!wanted(workflow)) return null;
      this.idToActualPath.set(workflow.id as WorkflowId, path);
      return workflow;
    } catch {
      return null;
    }
  }

  findAll(): Promise<Workflow[]> {
    return this.readAll();
  }

  /**
   * The listing of every workflow {@link findAll} returns, in the same
   * order, read only from files that changed since they were last listed.
   */
  async findAllListings(): Promise<WorkflowListing[]> {
    return (await this.scanListings()).map((l) => l.listing);
  }

  /**
   * Lists every workflow file as `readAll` reads them: the same files, in
   * the same order, skipping the same broken ones with the same warning. A
   * file whose stat matches the one its kept listing was read at is not
   * read again.
   */
  private async scanListings(): Promise<
    Array<{ path: string; listing: WorkflowListing }>
  > {
    const dir = this.getWorkflowsDir();
    const listed: Array<{ path: string; listing: WorkflowListing }> = [];
    let entries: Deno.DirEntry[];
    try {
      entries = await readDirSorted(dir);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        this.listingsByPath.clear();
        return [];
      }
      throw error;
    }

    const seen = new Set<string>();
    for (const entry of entries) {
      if (!entry.isFile || !isPrimaryWorkflowFileName(entry.name)) continue;
      const path = join(dir, entry.name);
      seen.add(path);
      // Stat before reading: a change after the stat makes the next stat
      // differ, so the listing read here is never kept past it.
      let fingerprint: RecordFingerprint | undefined | null;
      try {
        fingerprint = await statRecord(path);
      } catch (error) {
        this.skipUnreadable(path, error);
        continue;
      }
      if (fingerprint === null) continue;
      const cached = this.listingsByPath.get(path);
      if (
        cached && fingerprint &&
        fingerprintMatches(cached.fingerprint, fingerprint)
      ) {
        this.idToActualPath.set(cached.listing.id as WorkflowId, path);
        listed.push({ path, listing: cached.listing });
        continue;
      }
      this.listingsByPath.delete(path);

      let workflow: Workflow | null;
      try {
        const content = await Deno.readTextFile(path);
        const data = parseYaml(content) as WorkflowData | null;
        workflow = data ? Workflow.fromData(data) : null;
      } catch (error) {
        this.skipUnreadable(path, error);
        continue;
      }
      if (!workflow) continue;
      this.idToActualPath.set(workflow.id as WorkflowId, path);
      const listing = workflowListingOf(workflow);
      listed.push({ path, listing });
      if (
        fingerprint &&
        fingerprint.mtimeMs <= Date.now() - LISTING_RACY_WINDOW_MS
      ) {
        this.listingsByPath.set(path, { fingerprint, listing });
      }
    }
    for (const path of [...this.listingsByPath.keys()]) {
      if (!seen.has(path)) this.listingsByPath.delete(path);
    }
    return listed;
  }

  /**
   * Reads every file, as `findAll` does, and parses only those that can
   * declare `id`, so the cost of the rest is one read each. A file is passed
   * over only when its text holds neither the ID nor a backslash: without an
   * escape sequence, a YAML scalar equal to the ID has the ID in the text.
   */
  async findAllById(id: WorkflowId): Promise<Workflow[]> {
    const found = await this.readAll((content) =>
      content.includes(id) || content.includes("\\")
    );
    return found.filter((workflow) => workflow.id === id);
  }

  /**
   * Every workflow in the directory, or only those in files `mayMatch`
   * accepts the text of. A file it refuses is not parsed, so nothing is
   * said of whether it is broken.
   */
  private async readAll(
    mayMatch?: (content: string) => boolean,
  ): Promise<Workflow[]> {
    const dir = this.getWorkflowsDir();
    const workflows: Workflow[] = [];

    try {
      for (const entry of await readDirSorted(dir)) {
        if (entry.isFile && isPrimaryWorkflowFileName(entry.name)) {
          const path = join(dir, entry.name);
          try {
            const content = await Deno.readTextFile(path);
            if (mayMatch && !mayMatch(content)) continue;
            const data = parseYaml(content) as WorkflowData | null;
            if (!data) continue;
            const workflow = Workflow.fromData(data);
            this.idToActualPath.set(workflow.id as WorkflowId, path);
            workflows.push(workflow);
          } catch (error) {
            this.skipUnreadable(path, error);
          }
        }
      }
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return [];
      }
      throw error;
    }

    return workflows;
  }

  /**
   * What a read of the workflow file at `path` that threw does: an I/O
   * failure fails the read, anything else skips the file with a warning.
   */
  private skipUnreadable(path: string, error: unknown): void {
    if (isIoError(error)) {
      throw markErrorPaths(
        new UserError(
          `Failed to read workflow file ${path}: ${
            error instanceof Error ? error.message : error
          }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
        ),
        [path, ...errorPaths(error)],
      );
    }
    const errorMsg = error instanceof Error ? error.message : String(error);
    const workflowName = this.tryExtractName(path);

    if (errorMsg.includes('type "shell" is no longer supported')) {
      logger
        .warn`Skipping workflow ${workflowName}: uses deprecated 'shell' task. Delete or update to 'type: model_method' with 'command/shell'. File: ${path}`;
    } else {
      logger
        .warn`Skipping broken workflow ${workflowName}: ${errorMsg}. Run 'swamp doctor workflows --json' to see all errors. File: ${path}`;
    }
  }

  async save(workflow: Workflow): Promise<void> {
    const dir = this.getWorkflowsDir();
    await assertSafePath(dir, this.baseDir);
    await ensureDir(dir);

    const targetPath = this.resolveWritePath(workflow);
    await signalChange(
      this.markDirtyHook,
      { kind: "write", path: targetPath },
      { typed: true },
    );
    const previousPath = this.idToActualPath.get(workflow.id);

    // Check if this is a new workflow or an update
    const legacyPath = this.getLegacyPath(workflow.id);
    // On v3 (swamp-club#3256), what each file held before this save replaces
    // or removes it: its digest for an edit's precondition, and the name it
    // declared, which tells a rename apart.
    const priors = typedStagingActive(this.markDirtyHook)
      ? await readPriors([targetPath, previousPath, legacyPath])
      : new Map<string, PriorFile>();
    const isNew = !(await this.exists(targetPath)) &&
      !(previousPath && await this.exists(previousPath)) &&
      !(await this.exists(legacyPath));

    const data = workflow.toData();
    // Remove undefined values since YAML can't stringify them
    const cleanData = JSON.parse(JSON.stringify(data));
    const content = stringifyYaml(cleanData as Record<string, unknown>);
    await atomicWriteTextFile(targetPath, content);
    // The paths the cleanup below actually removed, for their v3 tombstones.
    const removed: string[] = [];

    // Clean up old file if we wrote to a different path
    if (previousPath && previousPath !== targetPath) {
      try {
        await Deno.remove(previousPath);
        removed.push(previousPath);
        logger.debug`Migrated workflow file from ${basename(previousPath)} to ${
          basename(targetPath)
        }`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove old workflow file ${previousPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    // Also check the legacy UUID path if it wasn't the previousPath
    if (
      targetPath !== legacyPath && previousPath !== legacyPath &&
      await this.exists(legacyPath)
    ) {
      try {
        await Deno.remove(legacyPath);
        removed.push(legacyPath);
        logger.debug`Migrated workflow file from ${basename(legacyPath)} to ${
          basename(targetPath)
        }`;
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          logger.warn`Failed to remove legacy workflow file ${legacyPath}: ${
            error instanceof Error ? error.message : String(error)
          }`;
        }
      }
    }

    this.idToActualPath.set(workflow.id, targetPath);
    // Staged outside the cleanup's catch blocks, so a v3 refusal surfaces.
    for (
      const batch of typedStagingActive(this.markDirtyHook)
        ? definitionSaveBatches({
          kind: "workflow",
          id: workflow.id,
          name: workflow.name,
          targetPath,
          content: new TextEncoder().encode(content),
          removed,
          priors,
          tierOf: (path) => this.stagingTierOf(path),
        })
        : [[]]
    ) {
      await stageTyped(this.markDirtyHook, () => batch);
    }

    // Emit event
    if (this.eventBus) {
      const event = isNew
        ? createWorkflowCreated(workflow.id, workflow.name)
        : createWorkflowUpdated(workflow.id, workflow.name);
      await this.eventBus.publish(event);
    }
  }

  /**
   * Checks if a file exists.
   */
  private async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        return false;
      }
      throw error;
    }
  }

  /**
   * Deletes the workflow with this id. Ids are not guaranteed unique — a
   * copied file keeps its id — so with `name` only a file declaring both is
   * removed, never another workflow that shares the id.
   */
  async delete(id: WorkflowId, name?: string): Promise<void> {
    // Get the workflow before deleting for the event and to find the right file
    const workflow = await this.findById(id);
    const workflowName = name ?? workflow?.name;

    // Try removing both possible file paths
    const pathsToTry = new Set([
      this.getLegacyPath(id),
      ...(workflowName && isFilenameSafeName(workflowName)
        ? [this.getNamePath(workflowName)]
        : []),
    ]);
    const cachedPath = this.idToActualPath.get(id);
    if (cachedPath) pathsToTry.add(cachedPath);

    const resolvedPath = cachedPath ?? this.getLegacyPath(id);
    // A file here that declares another workflow is kept, so the change is
    // a write of this path rather than its removal.
    const kept = await this.declaresOther(resolvedPath, id, name);
    await signalChange(this.markDirtyHook, {
      kind: kept ? "write" : "remove",
      path: resolvedPath,
    }, { typed: true });
    const priors = typedStagingActive(this.markDirtyHook)
      ? await readPriors([...pathsToTry])
      : new Map<string, PriorFile>();

    let deleted = false;
    const removed: string[] = [];
    for (const path of pathsToTry) {
      // The id-named path is also where a workflow named with this UUID
      // lives, and a copied file can share the id; never remove another
      // workflow's file.
      if (await this.declaresOther(path, id, name)) continue;
      try {
        await Deno.remove(path);
        deleted = true;
        removed.push(path);
      } catch (error) {
        if (!(error instanceof Deno.errors.NotFound)) {
          throw error;
        }
      }
    }

    if (deleted) {
      this.idToActualPath.delete(id);

      if (this.eventBus && workflowName) {
        const event = createWorkflowDeleted(id, workflowName);
        await this.eventBus.publish(event);
      }
    }
    for (
      const batch of typedStagingActive(this.markDirtyHook)
        ? definitionDeleteBatches({
          kind: "workflow",
          id,
          name: workflowName,
          removed,
          priors,
          tierOf: (path) => this.stagingTierOf(path),
        })
        : [[]]
    ) {
      await stageTyped(this.markDirtyHook, () => batch);
    }
  }

  /**
   * A managed-config workflow file's record key (swamp-club#3256); undefined
   * for a git-tracked workflow, which stages nothing.
   */
  private stagingTierOf(path: string) {
    const tier = stagingTierOf(this.repoDir, [], path);
    return tier?.tier === "config" ? tier : undefined;
  }

  /**
   * Whether `path` holds a readable workflow that declares an id not `id`,
   * or — when `name` is given — a name not `name`.
   */
  private async declaresOther(
    path: string,
    id: WorkflowId,
    name?: string,
  ): Promise<boolean> {
    try {
      const data = parseYaml(await Deno.readTextFile(path)) as
        | { id?: unknown; name?: unknown }
        | null;
      if (typeof data?.id === "string" && data.id !== id) return true;
      return name !== undefined && typeof data?.name === "string" &&
        data.name !== name;
    } catch {
      return false;
    }
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    return this.idToActualPath.get(id) ?? this.getLegacyPath(id);
  }

  private resolveWritePath(workflow: Workflow): string {
    if (isFilenameSafeName(workflow.name)) {
      return this.getNamePath(workflow.name);
    }
    return this.getLegacyPath(workflow.id);
  }

  private getNamePath(name: string): string {
    return join(this.getWorkflowsDir(), `workflow-${name}.yaml`);
  }

  private getLegacyPath(id: WorkflowId): string {
    return join(this.getWorkflowsDir(), `workflow-${id}.yaml`);
  }

  /** The directory this repository reads workflow files from. */
  getWorkflowsDir(): string {
    return this.baseDir;
  }

  /**
   * Attempts to extract workflow name from a YAML file path.
   * Falls back to the filename if parsing fails.
   */
  private tryExtractName(path: string): string {
    try {
      const content = Deno.readTextFileSync(path);
      const data = parseYaml(content) as { name?: string };
      if (data?.name) {
        return data.name;
      }
    } catch {
      // Ignore - fall through to filename
    }
    // Extract filename without extension as fallback
    const filename = basename(path);
    return filename.replace(/\.yaml$/, "");
  }
}
