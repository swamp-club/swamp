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

import { basename, dirname, join } from "@std/path";
import type { UnreadableContentLookup } from "../../domain/datastore/datastore_sync_service.ts";
import type { Definition } from "../../domain/definitions/definition.ts";
import type {
  DefinitionOwnerIndex,
  DefinitionOwnerView,
} from "../../domain/definitions/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { withSpan } from "../tracing/mod.ts";
import { RUN_INDEX_RACY_WINDOW_MS } from "./run_index_cache.ts";
import { SharedIndexRead } from "./shared_index_read.ts";
import { comparePathsBySegment, readDirSorted } from "./sorted_dir_entries.ts";
import { warnUnreadableLeftOut } from "./unreadable_records.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

/** How many files of one directory are stat'ed or read at once. */
const FILE_CONCURRENCY = 64;

type FoundDefinition = { definition: Definition; type: ModelType };

/**
 * The definition files an index reads: a {@link YamlDefinitionRepository}.
 * Reading goes through it so a file is parsed, typed and contained exactly
 * as a scan of every definition does it.
 */
export interface DefinitionFileSource {
  definitionRoots(): string[];
  readDefinitionFile(
    path: string,
    typeSegments: string[],
    isSymlink: boolean,
  ): Promise<FoundDefinition | null>;
  readonly unreadableContent?: UnreadableContentLookup;
}

export interface DefinitionIdIndexOptions {
  racyWindowMs?: number;
  now?: () => number;
}

/** A definition file as last listed. */
interface IndexedFile {
  /** The id it declared when last read; undefined when it did not parse. */
  id: string | undefined;
  /** Undefined when the platform gives no mtime, or it must be read again. */
  fingerprint: RecordFingerprint | undefined;
  readonly isSymlink: boolean;
}

/** A directory under a root as last listed. */
interface IndexedDir {
  readonly root: number;
  /** Its path below its root: the type of a file in it that declares none. */
  readonly segments: readonly string[];
  /** Its stat when listed; undefined when there was no mtime to compare. */
  readonly stamp: RecordFingerprint | undefined;
  /** The listing's ticket: a listing never replaces a later one. */
  readonly ticket: number;
  readonly files: Map<string, IndexedFile>;
  readonly dirs: readonly string[];
}

interface ValidationCounts {
  dirsChecked: number;
  dirsRelisted: number;
  filesParsed: number;
}

/**
 * Which file declares which definition id, kept between requests by `swamp
 * serve` so authorizing what a request reads does not parse every
 * definition each time (swamp-club#3968).
 *
 * Only locations are kept, never definitions: a lookup reads each file that
 * declared the id now, so its name and tags are current, and moves a file
 * that no longer declares it. {@link begin} checks every directory's stat,
 * as {@link RunIndexCache} does a run index: a directory whose stat moved,
 * or is too recent to rule out a change within the same clock tick, is
 * listed again, and of its files only those whose own stat moved are read.
 * Creating, removing or renaming a file moves its directory's stat, so any
 * writer — this process, a CLI, a datastore pull — is seen by the next
 * request. A file that failed to parse, a file a lookup found rewritten,
 * and a symlink (whose target may sit in another directory) are stat'ed on
 * every check, so a change to them made in place is seen as well.
 *
 * One change is not seen until its directory next changes, or a lookup of
 * the id it declared reads it: a regular file that declares an id,
 * overwritten in place to declare another. Until then the file does not
 * count as an owner of its new id, which fails open: a deny that this copy
 * would bring, by its name or its tags, does not apply. Writing it needs
 * write access to the definitions, which can change any owner's file
 * itself, so it grants nothing that access does not already give.
 *
 * Listing a directory is shared by the requests that may share it, and
 * stops once every one of them has been cancelled. A listing replaces the
 * directory's entries only once it has read the whole directory, so one
 * that fails or is cancelled leaves the index as it was.
 */
export class DefinitionIdIndex implements DefinitionOwnerIndex {
  readonly #source: DefinitionFileSource;
  readonly #racyWindowMs: number;
  readonly #now: () => number;
  readonly #dirs = new Map<string, IndexedDir>();
  readonly #pathsById = new Map<string, Set<string>>();
  #definitions = 0;
  readonly #listing = new Map<
    string,
    {
      ticket: number;
      stamp: RecordFingerprint | undefined;
      read: SharedIndexRead<number>;
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
  }

  /**
   * Checks the index against the definitions stored now, traced as a
   * `swamp.serve.definition_index.validate` span, and returns a view that
   * reads each id's files when it is looked up.
   */
  async begin(signal?: AbortSignal): Promise<DefinitionOwnerView> {
    signal?.throwIfAborted();
    await withSpan(
      "swamp.serve.definition_index.validate",
      {},
      async (span) => {
        const counts: ValidationCounts = {
          dirsChecked: 0,
          dirsRelisted: 0,
          filesParsed: 0,
        };
        const roots = this.#source.definitionRoots();
        for (const [root, path] of roots.entries()) {
          const relisted = counts.dirsRelisted;
          await this.#validateDir(path, root, [], counts, signal);
          // A scan of every definition names the auto-definitions the
          // datastore could not materialise (swamp-club#3617); so does a
          // listing of them.
          if (root > 0 && counts.dirsRelisted > relisted) {
            await warnUnreadableLeftOut(this.#source.unreadableContent, path);
          }
        }
        span.setAttributes({
          "definition_index.definitions": this.#definitions,
          "definition_index.dirs_checked": counts.dirsChecked,
          "definition_index.dirs_relisted": counts.dirsRelisted,
          "definition_index.files_parsed": counts.filesParsed,
        });
      },
    );
    return { findAllById: (id) => this.#findAllById(id, signal) };
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
    const stamp = await statRecord(path);
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
   * Lists the directory again, or waits for a listing in flight that is as
   * recent: one started after this check began, or from the same stat when
   * that stat is not too recent to trust.
   */
  async #relist(
    path: string,
    root: number,
    segments: readonly string[],
    stamp: RecordFingerprint | undefined,
    checkedAt: number,
    signal: AbortSignal | undefined,
  ): Promise<number> {
    const running = this.#listing.get(path);
    if (
      running && !running.read.signal.aborted &&
      (running.ticket > checkedAt || this.#trusted(running.stamp, stamp))
    ) {
      return await running.read.get(signal);
    }
    const ticket = ++this.#ticket;
    const read = new SharedIndexRead(
      (sharedSignal) =>
        this.#list(path, root, segments, stamp, ticket, sharedSignal),
      () => {
        if (this.#listing.get(path)?.read === read) this.#listing.delete(path);
      },
    );
    this.#listing.set(path, { ticket, stamp, read });
    return await read.get(signal);
  }

  /** Reads the directory's entries and replaces them once all are read. */
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
      const filePath = join(path, entry.name);
      const fingerprint = await statRecord(filePath);
      if (fingerprint === null) {
        // A symlink whose target is missing stays listed, so its target is
        // stat'ed on each check and read once it appears: the link's own
        // directory need not change when it does.
        if (entry.isSymlink) {
          files.set(entry.name, {
            id: undefined,
            fingerprint: undefined,
            isSymlink: true,
          });
        }
        return;
      }
      const known = previous?.files.get(entry.name);
      if (
        known?.id !== undefined && fingerprint &&
        this.#trusted(known.fingerprint, fingerprint)
      ) {
        files.set(entry.name, known);
        return;
      }
      const found = await this.#source.readDefinitionFile(
        filePath,
        [...segments],
        entry.isSymlink,
      );
      parsed++;
      files.set(entry.name, {
        id: found?.definition.id,
        fingerprint,
        isSymlink: entry.isSymlink,
      });
    });
    signal.throwIfAborted();
    this.#commit(path, { root, segments, stamp, ticket, files, dirs });
    return parsed;
  }

  /**
   * Reads again each file whose listing cannot vouch for it, once its stat
   * has moved: one that did not parse, one a lookup found rewritten, and a
   * symlink, whose target can change without its directory's stat moving.
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
      const fingerprint = await statRecord(filePath);
      if (fingerprint === null) continue;
      if (fingerprint && this.#trusted(file.fingerprint, fingerprint)) {
        continue;
      }
      const found = await this.#source.readDefinitionFile(
        filePath,
        [...dir.segments],
        file.isSymlink,
      );
      parsed++;
      if (!this.#isCurrent(filePath, file)) continue;
      file.fingerprint = fingerprint;
      this.#reassign(filePath, file, found?.definition.id);
    }
    return parsed;
  }

  async #findAllById(
    id: string,
    signal: AbortSignal | undefined,
  ): Promise<FoundDefinition[]> {
    const paths = [...this.#pathsById.get(id) ?? []]
      .map((path) => ({ path, dir: this.#dirs.get(dirname(path)) }))
      .sort((a, b) =>
        (a.dir?.root ?? 0) - (b.dir?.root ?? 0) ||
        comparePathsBySegment(a.path, b.path)
      );
    const found: FoundDefinition[] = [];
    for (const { path, dir } of paths) {
      signal?.throwIfAborted();
      const file = dir?.files.get(basename(path));
      if (!dir || !file) {
        this.#unindex(id, path);
        continue;
      }
      const read = await this.#source.readDefinitionFile(
        path,
        [...dir.segments],
        file.isSymlink,
      );
      if (read?.definition.id === id) {
        found.push(read);
        continue;
      }
      // Rewritten since it was listed: index it under what it declares now,
      // and read it again on the next check. A listing that replaced the
      // entry while this read ran already says what the file declares.
      if (!this.#isCurrent(path, file)) continue;
      file.fingerprint = undefined;
      this.#reassign(path, file, read?.definition.id);
    }
    return found;
  }

  /**
   * Whether a stored stat still describes what `current` describes, and is
   * old enough to rule out a change within the same clock tick. A time in
   * the future is never trusted. The ctime counts as well as the mtime: a
   * rewrite that sets the mtime back moves only the ctime.
   */
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
        this.#unindex(file.id, join(path, name));
      }
      for (const name of previous.dirs) {
        if (!dir.dirs.includes(name)) this.#drop(join(path, name));
      }
    }
    for (const [name, file] of dir.files) {
      this.#index(file.id, join(path, name));
    }
    this.#dirs.set(path, dir);
  }

  /** Forgets a directory that is gone, with everything below it. */
  #drop(path: string): void {
    const dir = this.#dirs.get(path);
    if (!dir) return;
    this.#dirs.delete(path);
    for (const [name, file] of dir.files) {
      this.#unindex(file.id, join(path, name));
    }
    for (const name of dir.dirs) this.#drop(join(path, name));
  }

  /** Whether `file` is still the entry the index keeps for `path`. */
  #isCurrent(path: string, file: IndexedFile): boolean {
    return this.#dirs.get(dirname(path))?.files.get(basename(path)) === file;
  }

  #reassign(path: string, file: IndexedFile, id: string | undefined): void {
    this.#unindex(file.id, path);
    file.id = id;
    this.#index(id, path);
  }

  #index(id: string | undefined, path: string): void {
    if (id === undefined) return;
    const paths = this.#pathsById.get(id);
    if (paths?.has(path)) return;
    if (paths) paths.add(path);
    else this.#pathsById.set(id, new Set([path]));
    this.#definitions++;
  }

  #unindex(id: string | undefined, path: string): void {
    if (id === undefined) return;
    const paths = this.#pathsById.get(id);
    if (!paths?.delete(path)) return;
    this.#definitions--;
    if (paths.size === 0) this.#pathsById.delete(id);
  }
}

/** Runs `each` over `items`, {@link FILE_CONCURRENCY} at a time. */
async function inBatches<T>(
  items: readonly T[],
  signal: AbortSignal,
  each: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += FILE_CONCURRENCY) {
    signal.throwIfAborted();
    await Promise.all(items.slice(i, i + FILE_CONCURRENCY).map(each));
  }
}
