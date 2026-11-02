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

import { getLogger } from "@logtape/logtape";
import { basename, dirname, join } from "@std/path";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import type {
  Definition,
  DefinitionId,
} from "../../domain/definitions/definition.ts";
import type {
  DefinitionOwner,
  DefinitionOwnerIndex,
  DefinitionOwnerView,
} from "../../domain/definitions/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import type { ObservationAttributes } from "../../domain/remote/observability.ts";
import {
  type DiagnosticPhase,
  observeDiagnosticPhase,
} from "../../domain/diagnostics/diagnostic_phase.ts";
import { activeSpanLink, type Link, withSpan } from "../tracing/mod.ts";
import { RUN_INDEX_RACY_WINDOW_MS } from "./run_index_cache.ts";
import { SharedIndexRead } from "./shared_index_read.ts";
import { Semaphore } from "../stream/semaphore.ts";
import { isIoError } from "./io_errors.ts";
import { comparePathsBySegment, readDirSorted } from "./sorted_dir_entries.ts";
import { warnUnreadableLeftOut } from "./unreadable_records.ts";
import {
  fingerprintMatches,
  fingerprintOf,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

const logger = getLogger(["definition-repo"]);

/**
 * bounds files stat'ed or read at once: overlapping requests right after a
 * write may list the same directory and must not each open a descriptor per
 * file
 */
const MAX_OPEN_FILES = 32;

const BROKEN = Symbol("broken");

type FoundDefinition = { definition: Definition; type: ModelType };

export interface NamedDefinitionMatch {
  definition: Definition;
  type: ModelType;
  path: string;
  segments: string[];
  primary: boolean;
}

export interface DefinitionNameIndex {
  findByName(name: string): Promise<NamedDefinitionMatch | null>;
}

export interface DefinitionFileSource {
  definitionRoots(): string[];
  readDefinitionFile(
    path: string,
    typeSegments: string[],
    isSymlink: boolean,
  ): Promise<FoundDefinition | null>;
  readonly unreadableContent?: UnreadableContentLookup;
}

// as lstat sees it: a symlink is not followed
export interface LiveDefinitionFile {
  isSymlink: boolean;
  // undefined when the platform gives no mtime
  fingerprint: RecordFingerprint | undefined;
}

export interface DefinitionIdIndexOptions {
  racyWindowMs?: number;
  now?: () => number;
  stat?: (path: string) => Promise<RecordFingerprint | undefined | null>;
  // null when the file is gone or a directory on its path no longer is one
  lstat?: (path: string) => Promise<LiveDefinitionFile | null>;
}

interface IndexedFile {
  id: string | undefined;
  name: string | undefined;
  /**
   * answers a lookup of its id while fingerprint holds; never kept for a
   * symlink or a file that did not parse
   */
  owner: DefinitionOwner | undefined;
  /**
   * kept only when old enough to rule out a change within the same clock tick;
   * otherwise undefined and the file is stat'ed on every check
   */
  fingerprint: RecordFingerprint | undefined;
  readonly isSymlink: boolean;
}

interface IndexedDir {
  readonly root: number;
  readonly segments: readonly string[];
  /**
   * kept only when old enough to rule out a change within the same clock tick;
   * undefined otherwise, so the directory is listed again
   */
  readonly stamp: RecordFingerprint | undefined;
  /** The listing's ticket: a listing never replaces a later one. */
  readonly ticket: number;
  readonly files: Map<string, IndexedFile>;
  readonly dirs: readonly string[];
}

interface ValidationCounts {
  dirsChecked: number;
  dirsRelisted: number;
  dirsJoined: number;
  filesParsed: number;
  filesJoined: number;
  readonly joinedFrom: Map<string, Link>;
}

const MAX_JOIN_LINKS = 8;

/**
 * keeps each file's location and owner fields, answering a lookup by id from
 * them while the file's lstat holds; an in-place overwrite that changes a
 * declared id goes unseen until the directory's stat moves, which fails open
 */
export class DefinitionIdIndex implements DefinitionOwnerIndex {
  readonly #source: DefinitionFileSource;
  readonly #racyWindowMs: number;
  readonly #now: () => number;
  readonly #stat: (
    path: string,
  ) => Promise<RecordFingerprint | undefined | null>;
  readonly #lstat: (path: string) => Promise<LiveDefinitionFile | null>;
  readonly #dirs = new Map<string, IndexedDir>();
  readonly #pathsById = new Map<string, Set<string>>();
  readonly #pathsByName = new Map<string, Set<string>>();
  #definitions = 0;
  readonly #openFiles = new Semaphore(MAX_OPEN_FILES);
  readonly #listing = new Map<
    string,
    {
      ticket: number;
      stamp: RecordFingerprint | undefined;
      read: SharedIndexRead<number>;
      owner: Link | undefined;
    }
  >();
  #ticket = 0;

  constructor(
    source: DefinitionFileSource,
    options: DefinitionIdIndexOptions = {},
  ) {
    this.#source = source;
    this.#racyWindowMs = options.racyWindowMs ?? RUN_INDEX_RACY_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    this.#stat = options.stat ?? statRecord;
    this.#lstat = options.lstat ?? lstatDefinitionFile;
  }

  async begin(signal?: AbortSignal): Promise<DefinitionOwnerView> {
    signal?.throwIfAborted();
    // the check is the owner_index phase so definition files it reads are
    // counted apart from the request's other work
    await this.#check("owner_index", {}, signal);
    return { findAllById: (id) => this.#findAllById(id, signal) };
  }

  /**
   * definitions come before auto-definitions so a definition shadows an
   * auto-definition of the same name, as a scan of every definition does
   */
  async findByName(
    name: string,
    signal?: AbortSignal,
  ): Promise<NamedDefinitionMatch | null> {
    signal?.throwIfAborted();
    await this.#check("definition_scan", {
      "swamp.diagnostic.scan_root": "all",
      "swamp.diagnostic.scan_strategy": "global_index",
    }, signal);
    return await this.#firstDeclaring(name, signal);
  }

  async #check(
    phaseName: DiagnosticPhase,
    attributes: ObservationAttributes,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    await observeDiagnosticPhase(phaseName, attributes, async (phase) => {
      const cold = this.#dirs.size === 0;
      const counts: ValidationCounts = {
        dirsChecked: 0,
        dirsRelisted: 0,
        dirsJoined: 0,
        filesParsed: 0,
        filesJoined: 0,
        joinedFrom: new Map(),
      };
      try {
        await withSpan(
          "swamp.serve.definition_index.validate",
          {},
          async (span) => {
            try {
              const roots = this.#source.definitionRoots();
              for (const [root, path] of roots.entries()) {
                const relisted = counts.dirsRelisted;
                await this.#validateDir(path, root, [], counts, signal);
                // a scan names the auto-definitions the datastore could not
                // materialise, so a listing of them does too
                if (root > 0 && counts.dirsRelisted > relisted) {
                  await warnUnreadableLeftOut(
                    this.#source.unreadableContent,
                    path,
                  );
                }
              }
              span.setAttributes({
                "definition_index.definitions": this.#definitions,
                "definition_index.dirs_checked": counts.dirsChecked,
                "definition_index.dirs_relisted": counts.dirsRelisted,
                "definition_index.dirs_joined": counts.dirsJoined,
                "definition_index.files_parsed": counts.filesParsed,
                "definition_index.files_joined": counts.filesJoined,
              });
            } finally {
              // a joined listing ran under the request that started it; the
              // link names that request without reparenting its work
              if (counts.joinedFrom.size > 0) {
                span.addLinks([...counts.joinedFrom.values()]);
              }
            }
          },
        );
      } finally {
        phase.attributes({
          "swamp.diagnostic.cache": cold
            ? "cold"
            : counts.dirsRelisted === 0 && counts.filesParsed === 0
            ? "warm"
            : "refreshed",
          "swamp.diagnostic.definitions": this.#definitions,
          "swamp.diagnostic.dirs_checked": counts.dirsChecked,
          "swamp.diagnostic.dirs_relisted": counts.dirsRelisted,
          "swamp.diagnostic.dirs_joined": counts.dirsJoined,
          "swamp.diagnostic.files_parsed": counts.filesParsed,
          "swamp.diagnostic.files_joined": counts.filesJoined,
        });
      }
    });
  }

  async #validateDir(
    path: string,
    root: number,
    segments: readonly string[],
    counts: ValidationCounts,
    signal: AbortSignal | undefined,
  ): Promise<void> {
    signal?.throwIfAborted();
    counts.dirsChecked++;
    // Any listing started from here on reads what was stored before this
    // check began, so it may be shared whatever its stat.
    const checkedAt = ++this.#ticket;
    const statAt = this.#now();
    const stamp = this.#settled(await this.#stat(path), statAt);
    signal?.throwIfAborted();
    if (stamp === null) {
      this.#drop(path);
      return;
    }
    let dir = this.#dirs.get(path);
    if (!dir || !this.#trusted(dir.stamp, stamp)) {
      counts.filesParsed += await this.#relist(
        path,
        root,
        segments,
        stamp,
        checkedAt,
        counts,
        signal,
      );
      counts.dirsRelisted++;
      dir = this.#dirs.get(path);
      if (!dir) return;
    } else {
      counts.filesParsed += await this.#rereadUnsettled(path, dir, signal);
    }
    for (const name of dir.dirs) {
      await this.#validateDir(
        join(path, name),
        root,
        [...segments, name],
        counts,
        signal,
      );
    }
  }

  /**
   * waits only on a listing started after this check began, or from the same
   * stat when that stat is old enough to trust
   */
  async #relist(
    path: string,
    root: number,
    segments: readonly string[],
    stamp: RecordFingerprint | undefined,
    checkedAt: number,
    counts: ValidationCounts,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const running = this.#listing.get(path);
    if (
      running && !running.read.signal.aborted &&
      (running.ticket > checkedAt || this.#trusted(running.stamp, stamp))
    ) {
      const files = await running.read.get(signal);
      counts.dirsJoined++;
      counts.filesJoined += files;
      // Linked only once joined, so links and dirs_joined agree.
      const owner = running.owner;
      if (owner && counts.joinedFrom.size < MAX_JOIN_LINKS) {
        counts.joinedFrom.set(owner.context.spanId, owner);
      }
      return files;
    }
    const ticket = ++this.#ticket;
    const read = new SharedIndexRead(
      (sharedSignal) =>
        this.#list(path, root, segments, stamp, ticket, sharedSignal),
      () => {
        if (this.#listing.get(path)?.read === read) this.#listing.delete(path);
      },
    );
    this.#listing.set(path, { ticket, stamp, read, owner: activeSpanLink() });
    return await read.get(signal);
  }

  async #list(
    path: string,
    root: number,
    segments: readonly string[],
    stamp: RecordFingerprint | undefined,
    ticket: number,
    signal: AbortSignal,
  ): Promise<number> {
    let entries: Deno.DirEntry[];
    try {
      entries = await readDirSorted(path);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      this.#drop(path);
      return 0;
    }
    signal.throwIfAborted();
    const previous = this.#dirs.get(path);
    const files = new Map<string, IndexedFile>();
    const dirs: string[] = [];
    const yamlFiles: Deno.DirEntry[] = [];
    for (const entry of entries) {
      if ((entry.isFile || entry.isSymlink) && entry.name.endsWith(".yaml")) {
        yamlFiles.push(entry);
      } else if (entry.isDirectory) {
        dirs.push(entry.name);
      }
    }
    let parsed = 0;
    await inBatches(yamlFiles, signal, async (entry) => {
      await this.#openFiles.acquire(signal);
      try {
        // Read before adding: `parsed += await` would add to the value
        // read before the await, losing the other files' counts.
        const read = await this.#listFile(
          path,
          entry,
          segments,
          previous,
          files,
        );
        parsed += read;
      } finally {
        this.#openFiles.release();
      }
    });
    signal.throwIfAborted();
    this.#commit(path, { root, segments, stamp, ticket, files, dirs });
    return parsed;
  }

  async #listFile(
    path: string,
    entry: Deno.DirEntry,
    segments: readonly string[],
    previous: IndexedDir | undefined,
    files: Map<string, IndexedFile>,
  ): Promise<number> {
    const filePath = join(path, entry.name);
    const statAt = this.#now();
    const stat = await this.#statFile(filePath, true);
    if (stat === BROKEN) {
      files.set(entry.name, {
        id: undefined,
        name: undefined,
        owner: undefined,
        fingerprint: undefined,
        isSymlink: entry.isSymlink,
      });
      return 0;
    }
    const fingerprint = this.#settled(stat, statAt);
    if (fingerprint === null) {
      // A symlink whose target is missing stays listed, so its target is
      // stat'ed on each check and read once it appears: the link's own
      // directory need not change when it does.
      if (entry.isSymlink) {
        files.set(entry.name, {
          id: undefined,
          name: undefined,
          owner: undefined,
          fingerprint: undefined,
          isSymlink: true,
        });
      }
      return 0;
    }
    const known = previous?.files.get(entry.name);
    if (
      known?.id !== undefined && this.#trusted(known.fingerprint, fingerprint)
    ) {
      files.set(entry.name, known);
      return 0;
    }
    const found = await this.#source.readDefinitionFile(
      filePath,
      [...segments],
      entry.isSymlink,
    );
    files.set(entry.name, {
      id: found?.definition.id,
      name: found?.definition.name,
      owner: found && !entry.isSymlink ? ownerOf(found) : undefined,
      fingerprint,
      isSymlink: entry.isSymlink,
    });
    return 1;
  }

  /**
   * symlink targets can change without the directory's stat moving, so
   * symlinks, unparsed files and files a lookup found rewritten are stat'ed on
   * each check
   */
  async #rereadUnsettled(
    path: string,
    dir: IndexedDir,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    let parsed = 0;
    for (const [name, file] of dir.files) {
      if (
        file.id !== undefined && file.fingerprint !== undefined &&
        !file.isSymlink
      ) {
        continue;
      }
      signal?.throwIfAborted();
      const filePath = join(path, name);
      const statAt = this.#now();
      const stat = await this.#statFile(filePath, false);
      if (stat === BROKEN) continue;
      const fingerprint = this.#settled(stat, statAt);
      if (fingerprint === null) continue;
      if (this.#trusted(file.fingerprint, fingerprint)) continue;
      const found = await this.#source.readDefinitionFile(
        filePath,
        [...dir.segments],
        file.isSymlink,
      );
      parsed++;
      if (!this.#isCurrent(filePath, file)) continue;
      file.fingerprint = fingerprint;
      this.#reassign(filePath, file, found);
    }
    return parsed;
  }

  // the stat is taken before the read, so a write during the read leaves a
  // stat the next lookup sees has moved
  async #findAllById(
    id: DefinitionId,
    signal: AbortSignal | undefined,
  ): Promise<DefinitionOwner[]> {
    const found: DefinitionOwner[] = [];
    for (const { path, dir } of this.#inScanOrder(this.#pathsById.get(id))) {
      signal?.throwIfAborted();
      const file = dir?.files.get(basename(path));
      const statAt = this.#now();
      const live = dir && file ? await this.#lstat(path) : null;
      // Gone since it was listed (the view lasts the whole request): it owns
      // nothing, and is no broken definition to warn about.
      if (!dir || !file || live === null) {
        this.#unindex(file ?? { id, name: undefined }, path);
        continue;
      }
      const settled = this.#settled(live.fingerprint, statAt) ?? undefined;
      // Whether it is a symlink now, not when listed: a file swapped for a
      // symlink since must still have its target contained in the repo.
      if (
        !live.isSymlink && file.owner?.definition.id === id &&
        revealsRewrites(settled) && this.#trusted(file.fingerprint, settled)
      ) {
        found.push(copyOf(file.owner));
        continue;
      }
      const read = await this.#source.readDefinitionFile(
        path,
        [...dir.segments],
        live.isSymlink,
      );
      if (read?.definition.id === id) {
        found.push(ownerOf(read));
        // the name moves with the kept stat, or a listing trusting that stat
        // would index the file under a name it no longer declares; a symlink's
        // own stat says nothing of its target, so none is kept
        if (!live.isSymlink && this.#isCurrent(path, file)) {
          file.fingerprint = settled;
          this.#reassign(path, file, read);
        }
        continue;
      }
      // Rewritten since it was listed: index it under what it declares now,
      // and read it again on the next check. A listing that replaced the
      // entry while this read ran already says what the file declares.
      if (!this.#isCurrent(path, file)) continue;
      file.fingerprint = undefined;
      this.#reassign(path, file, read, live.isSymlink);
    }
    return found;
  }

  /**
   * the first file indexed under `name` that still declares it, in the order
   * a scan of every definition reads them; always read, since callers run it
   */
  async #firstDeclaring(
    name: string,
    signal: AbortSignal | undefined,
  ): Promise<NamedDefinitionMatch | null> {
    for (
      const { path, dir } of this.#inScanOrder(this.#pathsByName.get(name))
    ) {
      signal?.throwIfAborted();
      const file = dir?.files.get(basename(path));
      // Whether it is a symlink now, not when listed: a file swapped for a
      // symlink since must still have its target contained in the repo.
      const live = dir && file ? await this.#lstat(path) : null;
      // Gone since it was listed (the view lasts the whole request): it owns
      // nothing, and is no broken definition to warn about.
      if (!dir || !file || live === null) {
        this.#unindex(file ?? { id: undefined, name }, path);
        continue;
      }
      const read = await this.#source.readDefinitionFile(
        path,
        [...dir.segments],
        live.isSymlink,
      );
      if (read?.definition.name === name) {
        return {
          definition: read.definition,
          type: read.type,
          path,
          segments: [...dir.segments],
          primary: dir.root === 0,
        };
      }
      // Rewritten since it was listed: index it under what it declares now,
      // and read it again on the next check. A listing that replaced the
      // entry while this read ran already says what the file declares.
      if (!this.#isCurrent(path, file)) continue;
      file.fingerprint = undefined;
      this.#reassign(path, file, read, live.isSymlink);
    }
    return null;
  }

  #inScanOrder(
    paths: ReadonlySet<string> | undefined,
  ): { path: string; dir: IndexedDir | undefined }[] {
    return [...paths ?? []]
      .map((path) => ({ path, dir: this.#dirs.get(dirname(path)) }))
      .sort((a, b) =>
        (a.dir?.root ?? 0) - (b.dir?.root ?? 0) ||
        comparePathsBySegment(a.path, b.path)
      );
  }

  /**
   * I/O errors are raised; any other stat failure (symlink loop, path through a
   * regular file) marks the file BROKEN: it owns nothing and is stat'ed each
   * check, as a scan skips it with a warning
   */
  async #statFile(
    path: string,
    warn: boolean,
  ): Promise<RecordFingerprint | undefined | null | typeof BROKEN> {
    try {
      return await this.#stat(path);
    } catch (error) {
      if (isIoError(error)) throw error;
      if (warn) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn`Skipping broken definition file ${path}: ${msg}`;
      }
      return BROKEN;
    }
  }

  /**
   * settle at take time, not compare time, so a change in the next tick cannot
   * hide behind a stat that later looks old; ctime counts too, as a rewrite
   * that resets mtime moves only it
   */
  #settled(
    stat: RecordFingerprint | undefined | null,
    statAt: number,
  ): RecordFingerprint | undefined | null {
    if (!stat) return stat;
    const threshold = statAt - this.#racyWindowMs;
    return stat.mtimeMs <= threshold &&
        (stat.ctimeMs === undefined || stat.ctimeMs <= threshold)
      ? stat
      : undefined;
  }

  #trusted(
    stored: RecordFingerprint | undefined,
    current: RecordFingerprint | undefined,
  ): boolean {
    if (!stored || !current || !fingerprintMatches(stored, current)) {
      return false;
    }
    const threshold = this.#now() - this.#racyWindowMs;
    return current.mtimeMs <= threshold &&
      (current.ctimeMs === undefined || current.ctimeMs <= threshold);
  }

  #commit(path: string, dir: IndexedDir): void {
    const previous = this.#dirs.get(path);
    if (previous && previous.ticket > dir.ticket) return;
    // A listing that ends after its parent's listing dropped it must not
    // bring back a directory that is gone.
    if (dir.segments.length > 0) {
      const parent = this.#dirs.get(dirname(path));
      if (!parent?.dirs.includes(basename(path))) return;
    }
    if (previous) {
      for (const [name, file] of previous.files) {
        this.#unindex(file, join(path, name));
      }
      for (const name of previous.dirs) {
        if (!dir.dirs.includes(name)) this.#drop(join(path, name));
      }
    }
    for (const [name, file] of dir.files) {
      this.#index(file, join(path, name));
    }
    this.#dirs.set(path, dir);
  }

  #drop(path: string): void {
    const dir = this.#dirs.get(path);
    if (!dir) return;
    this.#dirs.delete(path);
    for (const [name, file] of dir.files) {
      this.#unindex(file, join(path, name));
    }
    for (const name of dir.dirs) this.#drop(join(path, name));
  }

  #isCurrent(path: string, file: IndexedFile): boolean {
    return this.#dirs.get(dirname(path))?.files.get(basename(path)) === file;
  }

  // isSymlink is the path now, which a lookup knows and the listing may not
  #reassign(
    path: string,
    file: IndexedFile,
    found: FoundDefinition | null | undefined,
    isSymlink: boolean = file.isSymlink,
  ): void {
    this.#unindex(file, path);
    file.id = found?.definition.id;
    file.name = found?.definition.name;
    file.owner = found && !isSymlink ? ownerOf(found) : undefined;
    this.#index(file, path);
  }

  #index(
    file: { id: string | undefined; name: string | undefined },
    path: string,
  ): void {
    if (addPath(this.#pathsById, file.id, path)) this.#definitions++;
    addPath(this.#pathsByName, file.name, path);
  }

  #unindex(
    file: { id: string | undefined; name: string | undefined },
    path: string,
  ): void {
    if (removePath(this.#pathsById, file.id, path)) this.#definitions--;
    removePath(this.#pathsByName, file.name, path);
  }
}

function addPath(
  paths: Map<string, Set<string>>,
  key: string | undefined,
  path: string,
): boolean {
  if (key === undefined) return false;
  const keyed = paths.get(key);
  if (keyed?.has(path)) return false;
  if (keyed) keyed.add(path);
  else paths.set(key, new Set([path]));
  return true;
}

function removePath(
  paths: Map<string, Set<string>>,
  key: string | undefined,
  path: string,
): boolean {
  if (key === undefined) return false;
  const keyed = paths.get(key);
  if (!keyed?.delete(path)) return false;
  if (keyed.size === 0) paths.delete(key);
  return true;
}

async function inBatches<T>(
  items: readonly T[],
  signal: AbortSignal,
  each: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += MAX_OPEN_FILES) {
    signal.throwIfAborted();
    await Promise.all(items.slice(i, i + MAX_OPEN_FILES).map(each));
  }
}

function ownerOf({ definition, type }: FoundDefinition): DefinitionOwner {
  const { id, name, tags } = definition;
  return { definition: { id, name, tags: { ...tags } }, type };
}

// a ctime or an inode moves when a same-size rewrite sets the mtime back
function revealsRewrites(stat: RecordFingerprint | undefined): boolean {
  return stat?.ctimeMs !== undefined || stat?.ino !== undefined;
}

// copied so a request that changes its owner cannot reach the next request
function copyOf({ definition, type }: DefinitionOwner): DefinitionOwner {
  const { id, name, tags } = definition;
  return { definition: { id, name, tags: { ...tags } }, type };
}

async function lstatDefinitionFile(
  path: string,
): Promise<LiveDefinitionFile | null> {
  try {
    const info = await Deno.lstat(path);
    return {
      isSymlink: info.isSymlink,
      fingerprint: fingerprintOf(info),
    };
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) {
      return null;
    }
    throw error;
  }
}
