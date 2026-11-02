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
  stageTyped,
  typedStagingActive,
  withChangeSignalled,
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
 * a listing for a file modified this recently is not kept: an edit within one
 * tick of a coarse file clock could leave its stat unchanged
 */
const LISTING_RACY_WINDOW_MS = 2_000;

interface CachedListing {
  fingerprint: RecordFingerprint;
  listing: WorkflowListing;
}

export function isPrimaryWorkflowFileName(name: string): boolean {
  return name.startsWith("workflow-") && name.endsWith(".yaml");
}

/**
 * the message carries the file name only and the full path rides on the error,
 * because swamp serve withholds messages holding an absolute path from its
 * clients
 */
function namingWorkflowFile(error: unknown, path: string): unknown {
  return error instanceof WorkflowSchemaError
    ? markErrorPaths(error.inFile(basename(path)), [path])
    : error;
}

export class YamlWorkflowRepository implements WorkflowRepository {
  private readonly baseDir: string;
  private readonly idToActualPath = new Map<WorkflowId, string>();
  /**
   * a path only, never a parsed workflow or negative result: the file is
   * re-read and its name re-checked on every hit, so stale hints self-correct
   * and save/delete need no invalidation
   */
  private readonly nameToActualPath = new Map<string, string>();
  /**
   * reused only while a fresh stat matches, so outside edits are seen; never
   * holds a parsed Workflow, since the aggregate is mutable and findAll builds
   * a new one each time
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

    // the hint check is outside the isFilenameSafeName guard: slow-path
    // workflows are those the guard rejects or whose name file is missing, so a
    // nested check would never fire
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
    const foundPath = this.idToActualPath.get(found.id as WorkflowId);
    if (foundPath) this.nameToActualPath.set(name, foundPath);
    return found;
  }

  /**
   * null on any failure so the caller falls back to its scan; a broken file
   * must not throw, as findAll skips it; a hint that is not a regular file is
   * rejected, since the scan ignores symlinks
   */
  private readWorkflowIfNamed(
    path: string,
    name: string,
  ): Promise<Workflow | null> {
    return this.readWorkflowIf(path, (workflow) => workflow.name === name);
  }

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

  async findAllListings(): Promise<WorkflowListing[]> {
    return (await this.scanListings()).map((l) => l.listing);
  }

  /**
   * lists files as readAll does: same files, order and skipped broken ones; a
   * file whose stat matches its kept listing is not read again
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
   * a file is passed over only when its text holds neither the ID nor a
   * backslash: without an escape sequence, a YAML scalar equal to the ID has
   * the ID in the text
   */
  async findAllById(id: WorkflowId): Promise<Workflow[]> {
    const found = await this.readAll((content) =>
      content.includes(id) || content.includes("\\")
    );
    return found.filter((workflow) => workflow.id === id);
  }

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
    return await withChangeSignalled(
      this.markDirtyHook,
      { kind: "write", path: targetPath },
      { typed: true },
      async () => {
        const previousPath = this.idToActualPath.get(workflow.id);

        const legacyPath = this.getLegacyPath(workflow.id);
        // on v3, what each file held before this save: its digest for an edit's
        // precondition, and the name it declared, which tells a rename apart
        const priors = typedStagingActive(this.markDirtyHook)
          ? await readPriors([targetPath, previousPath, legacyPath])
          : new Map<string, PriorFile>();
        const isNew = !(await this.exists(targetPath)) &&
          !(previousPath && await this.exists(previousPath)) &&
          !(await this.exists(legacyPath));

        const data = workflow.toData();
        const cleanData = JSON.parse(JSON.stringify(data));
        const content = stringifyYaml(cleanData as Record<string, unknown>);
        await atomicWriteTextFile(targetPath, content);
        const removed: string[] = [];

        if (previousPath && previousPath !== targetPath) {
          try {
            await Deno.remove(previousPath);
            removed.push(previousPath);
            logger.debug`Migrated workflow file from ${
              basename(previousPath)
            } to ${basename(targetPath)}`;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
              logger.warn`Failed to remove old workflow file ${previousPath}: ${
                error instanceof Error ? error.message : String(error)
              }`;
            }
          }
        }

        if (
          targetPath !== legacyPath && previousPath !== legacyPath &&
          await this.exists(legacyPath)
        ) {
          try {
            await Deno.remove(legacyPath);
            removed.push(legacyPath);
            logger.debug`Migrated workflow file from ${
              basename(legacyPath)
            } to ${basename(targetPath)}`;
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) {
              logger
                .warn`Failed to remove legacy workflow file ${legacyPath}: ${
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

        if (this.eventBus) {
          const event = isNew
            ? createWorkflowCreated(workflow.id, workflow.name)
            : createWorkflowUpdated(workflow.id, workflow.name);
          await this.eventBus.publish(event);
        }
      },
    );
  }

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
   * ids are not unique (a copied file keeps its id), so with name only a file
   * declaring both is removed, never another workflow sharing the id
   */
  async delete(id: WorkflowId, name?: string): Promise<void> {
    const workflow = await this.findById(id);
    const workflowName = name ?? workflow?.name;

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
    return await withChangeSignalled(
      this.markDirtyHook,
      {
        kind: kept ? "write" : "remove",
        path: resolvedPath,
      },
      { typed: true },
      async () => {
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
      },
    );
  }

  /** undefined for a git-tracked workflow, which stages nothing */
  private stagingTierOf(path: string) {
    const tier = stagingTierOf(this.repoDir, [], path);
    return tier?.tier === "config" ? tier : undefined;
  }

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

  getWritePath(workflow: Workflow): string {
    return this.resolveWritePath(workflow);
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

  getWorkflowsDir(): string {
    return this.baseDir;
  }

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
    const filename = basename(path);
    return filename.replace(/\.yaml$/, "");
  }
}
