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

import { join } from "@std/path";
import { getLogger } from "@logtape/logtape";
import { parse as parseYaml } from "@std/yaml";
import { isIoError } from "./io_errors.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import type { WorkflowRepository } from "../../domain/workflows/repositories.ts";
import {
  createWorkflowId,
  type WorkflowId,
} from "../../domain/workflows/workflow_id.ts";
import {
  Workflow,
  type WorkflowData,
} from "../../domain/workflows/workflow.ts";
import { isWorkflowDocument } from "../../domain/workflows/workflow_document.ts";
import { MANIFEST_FILENAMES } from "../../domain/extensions/manifest_cross_kind_discovery.ts";
import { errorPaths, markErrorPaths, UserError } from "../../domain/errors.ts";
import {
  type WorkflowListing,
  workflowListingOf,
} from "../../domain/workflows/workflow_listing.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

const logger = getLogger(["extension-workflow-repo"]);

const WORKFLOW_FILE_PATTERN = /\.ya?ml$/;

// an edit within one tick of a coarse file clock could leave its stat unchanged
const LISTING_RACY_WINDOW_MS = 2_000;

/**
 * visits each level in name order for the same sequence on every filesystem;
 * yields as found so an early stop or caught error keeps earlier files; errors,
 * including NotFound for dir, propagate
 */
export async function* extensionWorkflowFiles(
  dir: string,
): AsyncIterable<string> {
  for (const entry of await readDirSorted(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) {
      yield* extensionWorkflowFiles(path);
    } else if (
      WORKFLOW_FILE_PATTERN.test(entry.name) &&
      !MANIFEST_FILENAMES.has(entry.name)
    ) {
      yield path;
    }
  }
}

/**
 * read-only; a YAML file counts as a workflow only with a top-level jobs key,
 * so manifests and data files an extension ships are skipped
 */
export class ExtensionWorkflowRepository implements WorkflowRepository {
  private readonly baseDir: string;
  private workflowsDirs: string[];
  // keyed by path and error, so a broken file warns once however often read
  private readonly warnedBroken = new Set<string>();
  // reused only while a fresh stat matches; never a parsed Workflow, since the
  // aggregate is mutable, so lookups re-read the one matching file
  private readonly listingsByPath = new Map<
    string,
    { fingerprint: RecordFingerprint; listing: WorkflowListing | "skip" }
  >();

  constructor(
    workflowsDir: string,
    additionalDirs?: string[],
  ) {
    this.baseDir = workflowsDir;
    this.workflowsDirs = [workflowsDir, ...(additionalDirs ?? [])];
  }

  updateAdditionalDirs(additionalDirs: string[]): void {
    this.workflowsDirs = [this.baseDir, ...additionalDirs];
  }

  getWorkflowDirs(): readonly string[] {
    return this.workflowsDirs;
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    return await lookUp(
      await this.scanListings(),
      (listing) => listing.id === id,
      (workflow) => workflow.id === id,
      (path, wanted) => this.readWorkflowIf(path, wanted),
      () => this.findAll(),
    );
  }

  async findByName(name: string): Promise<Workflow | null> {
    return await lookUp(
      await this.scanListings(),
      (listing) => listing.name === name,
      (workflow) => workflow.name === name,
      (path, wanted) => this.readWorkflowIf(path, wanted),
      () => this.findAll(),
    );
  }

  async findAllListings(): Promise<WorkflowListing[]> {
    return unshadowedListings(await this.scanListings());
  }

  /**
   * A read-only view that scans the extension workflows on its first lookup
   * and answers every later lookup from that scan, a failed scan included.
   * Creating the view reads nothing.
   */
  memoizedView(): WorkflowRepository {
    return new MemoizedExtensionWorkflows(this, {
      scan: () => this.scanListings(),
      readIf: (path, wanted) => this.readWorkflowIf(path, wanted),
    });
  }

  /** every read of an extension workflow file goes through here */
  protected readWorkflowFile(path: string): Promise<string> {
    return Deno.readTextFile(path);
  }

  /**
   * null on any failure so the caller falls back to findAll; a path that is no
   * longer a regular file is not followed
   */
  private async readWorkflowIf(
    path: string,
    wanted: (workflow: Workflow) => boolean,
  ): Promise<Workflow | null> {
    try {
      if (!(await Deno.lstat(path)).isFile) return null;
      const data = parseYaml(await this.readWorkflowFile(path)) as
        | WorkflowData
        | null;
      if (!isWorkflowDocument(data)) return null;
      const workflow = Workflow.fromData(data);
      return wanted(workflow) ? workflow : null;
    } catch {
      return null;
    }
  }

  /**
   * walks the same files in the same order as findAll; a file whose stat
   * matches its kept entry is not read again
   */
  protected async scanListings(): Promise<ScannedListing[]> {
    const listed: ScannedListing[] = [];
    // only workflows claim a name, as in findAll's dedupe
    const seenNames = new Set<string>();
    const seenPaths = new Set<string>();
    for (const dir of this.workflowsDirs) {
      try {
        for await (const path of extensionWorkflowFiles(dir)) {
          seenPaths.add(path);
          const listing = await this.listingAt(path);
          if (listing === "skip") continue;
          const unshadowed = !seenNames.has(listing.name);
          seenNames.add(listing.name);
          listed.push({ path, listing, unshadowed });
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) continue;
        throw error;
      }
    }
    for (const path of [...this.listingsByPath.keys()]) {
      if (!seenPaths.has(path)) this.listingsByPath.delete(path);
    }
    return listed;
  }

  private async listingAt(path: string): Promise<WorkflowListing | "skip"> {
    // Stat before reading: a change after the stat makes the next stat
    // differ, so the entry read here is never kept past it.
    let fingerprint: RecordFingerprint | undefined | null;
    try {
      fingerprint = await statRecord(path);
    } catch (error) {
      if (isIoError(error)) throw extensionReadError(path, error);
      this.warnBrokenOnce(path, error);
      return "skip";
    }
    if (fingerprint === null) return "skip";
    const cached = this.listingsByPath.get(path);
    if (
      cached && fingerprint &&
      fingerprintMatches(cached.fingerprint, fingerprint)
    ) {
      return cached.listing;
    }
    this.listingsByPath.delete(path);
    const listing = await this.readListing(path);
    if (
      fingerprint &&
      fingerprint.mtimeMs <= Date.now() - LISTING_RACY_WINDOW_MS
    ) {
      this.listingsByPath.set(path, { fingerprint, listing });
    }
    return listing;
  }

  private async readListing(path: string): Promise<WorkflowListing | "skip"> {
    try {
      const data = parseYaml(await this.readWorkflowFile(path)) as
        | WorkflowData
        | null;
      if (!data) return "skip";
      if (!isWorkflowDocument(data)) {
        logger.debug`Skipping ${path}: not a workflow (no top-level jobs key)`;
        return "skip";
      }
      return workflowListingOf(Workflow.fromData(data));
    } catch (error) {
      if (isIoError(error)) throw extensionReadError(path, error);
      this.warnBrokenOnce(path, error);
      return "skip";
    }
  }

  private warnBrokenOnce(path: string, error: unknown): void {
    const errorMsg = error instanceof Error ? error.message : String(error);
    const warnKey = `${path}\0${errorMsg}`;
    if (this.warnedBroken.has(warnKey)) return;
    this.warnedBroken.add(warnKey);
    logger.warn`Skipping broken extension workflow ${path}: ${errorMsg}`;
  }

  async findAll(): Promise<Workflow[]> {
    const workflows: Workflow[] = [];
    const seenNames = new Set<string>();

    for (const dir of this.workflowsDirs) {
      try {
        for await (const path of extensionWorkflowFiles(dir)) {
          try {
            const content = await this.readWorkflowFile(path);
            const data = parseYaml(content) as WorkflowData | null;
            if (!data) continue;
            if (!isWorkflowDocument(data)) {
              logger
                .debug`Skipping ${path}: not a workflow (no top-level jobs key)`;
              continue;
            }
            const workflow = Workflow.fromData(data);
            // Deduplicate: first directory wins (user dir before pulled dir)
            if (!seenNames.has(workflow.name)) {
              seenNames.add(workflow.name);
              workflows.push(workflow);
            }
          } catch (error) {
            if (isIoError(error)) throw extensionReadError(path, error);
            this.warnBrokenOnce(path, error);
          }
        }
      } catch (error) {
        if (error instanceof Deno.errors.NotFound) {
          continue;
        }
        throw error;
      }
    }

    return workflows;
  }

  save(_workflow: Workflow): Promise<void> {
    return Promise.reject(
      new UserError(
        "Extension workflows are read-only. To modify, edit the source file directly.",
      ),
    );
  }

  delete(_id: WorkflowId): Promise<void> {
    return Promise.reject(
      new UserError(
        "Extension workflows are read-only and cannot be deleted via the CLI.",
      ),
    );
  }

  nextId(): WorkflowId {
    return createWorkflowId(crypto.randomUUID());
  }

  getPath(id: WorkflowId): string {
    // synchronous fallback for display purposes only
    return `${this.workflowsDirs[0]}/workflow-${id}.yaml`;
  }

  async findPath(id: WorkflowId): Promise<string | null> {
    for (const dir of this.workflowsDirs) {
      try {
        for await (const path of extensionWorkflowFiles(dir)) {
          try {
            const content = await this.readWorkflowFile(path);
            const data = parseYaml(content) as WorkflowData | null;
            if (!isWorkflowDocument(data)) continue;
            if (data.id === id) {
              return path;
            }
          } catch (error) {
            if (isIoError(error)) throw extensionReadError(path, error);
          }
        }
      } catch (error) {
        if (error instanceof UserError) throw error;
      }
    }
    return null;
  }
}

interface ScannedListing {
  path: string;
  listing: WorkflowListing;
  /** false when an earlier file holds the name, so findAll drops this one */
  unshadowed: boolean;
}

type ReadWorkflowIf = (
  path: string,
  wanted: (workflow: Workflow) => boolean,
) => Promise<Workflow | null>;

function unshadowedListings(scanned: ScannedListing[]): WorkflowListing[] {
  return scanned.filter((l) => l.unshadowed).map((l) => l.listing);
}

/**
 * re-reads only the matched file and keeps it only if it still matches;
 * anything else is answered by findAll, so a parsed Workflow is never cached
 */
async function lookUp(
  scanned: ScannedListing[],
  listed: (listing: WorkflowListing) => boolean,
  wanted: (workflow: Workflow) => boolean,
  readIf: ReadWorkflowIf,
  all: () => Promise<Workflow[]>,
): Promise<Workflow | null> {
  const match = scanned.find((l) => l.unshadowed && listed(l.listing));
  if (!match) return null;
  return await readIf(match.path, wanted) ??
    (await all()).find(wanted) ?? null;
}

function extensionReadError(path: string, error: unknown): Error {
  return markErrorPaths(
    new UserError(
      `Failed to read extension workflow ${path}: ${
        error instanceof Error ? error.message : error
      }. If the open-file limit was reached, raise it with 'ulimit -n'.`,
    ),
    [path, ...errorPaths(error)],
  );
}

/**
 * scans the source at most once and re-reads only each matched file; findAll
 * is also read at most once and returns the same Workflow instances, so
 * callers must not mutate them
 */
class MemoizedExtensionWorkflows implements WorkflowRepository {
  #scanned: Promise<ScannedListing[]> | undefined;
  #all: Promise<Workflow[]> | undefined;

  constructor(
    private readonly source: ExtensionWorkflowRepository,
    private readonly reads: {
      scan: () => Promise<ScannedListing[]>;
      readIf: ReadWorkflowIf;
    },
  ) {}

  // Assigned before any await, so lookups started together share one scan.
  #scan(): Promise<ScannedListing[]> {
    this.#scanned ??= this.reads.scan();
    return this.#scanned;
  }

  #readAll(): Promise<Workflow[]> {
    this.#all ??= this.source.findAll();
    return this.#all;
  }

  async findById(id: WorkflowId): Promise<Workflow | null> {
    return await lookUp(
      await this.#scan(),
      (listing) => listing.id === id,
      (workflow) => workflow.id === id,
      this.reads.readIf,
      () => this.#readAll(),
    );
  }

  async findByName(name: string): Promise<Workflow | null> {
    return await lookUp(
      await this.#scan(),
      (listing) => listing.name === name,
      (workflow) => workflow.name === name,
      this.reads.readIf,
      () => this.#readAll(),
    );
  }

  async findAll(): Promise<Workflow[]> {
    return [...await this.#readAll()];
  }

  async findAllListings(): Promise<WorkflowListing[]> {
    return unshadowedListings(await this.#scan());
  }

  save(workflow: Workflow): Promise<void> {
    return this.source.save(workflow);
  }

  delete(id: WorkflowId): Promise<void> {
    return this.source.delete(id);
  }

  nextId(): WorkflowId {
    return this.source.nextId();
  }

  getPath(id: WorkflowId): string {
    return this.source.getPath(id);
  }
}
