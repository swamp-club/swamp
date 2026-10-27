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
import type { Definition } from "../../domain/definitions/definition.ts";
import type {
  DefinitionOwnerIndex,
  DefinitionOwnerView,
} from "../../domain/definitions/repositories.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { observeDiagnosticPhase } from "../../domain/diagnostics/diagnostic_phase.ts";
import { activeSpanLink, type Link, withSpan } from "../tracing/mod.ts";
import { RUN_INDEX_RACY_WINDOW_MS } from "./run_index_cache.ts";
import { SharedIndexRead } from "./shared_index_read.ts";
import { Semaphore } from "../stream/semaphore.ts";
import { isIoError } from "./io_errors.ts";
import { comparePathsBySegment, readDirSorted } from "./sorted_dir_entries.ts";
import { warnUnreadableLeftOut } from "./unreadable_records.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

const logger = getLogger(["definition-repo"]);

/**
 * How many files an index's listings stat or read at once, together: right
 * after a write, overlapping requests may each list the same directory, and
 * must not open a descriptor per file each.
 */
const MAX_OPEN_FILES = 32;

/** A file whose stat failed for a reason other than being gone or I/O. */
const BROKEN = Symbol("broken");

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
  /**
   * Stats a directory or file, following symlinks: null when it is gone,
   * undefined when the platform gives no mtime. Defaults to `statRecord`.
   */
  stat?: (path: string) => Promise<RecordFingerprint | undefined | null>;
}

/** A definition file as last listed. */
interface IndexedFile {
  /** The id it declared when last read; undefined when it did not parse. */
  id: string | undefined;
  /**
   * Its stat when read, kept only when old enough to rule out a change
   * within the same clock tick. Undefined when there was none to keep, or a
   * lookup found it rewritten: such a file is stat'ed on every check.
   */
  fingerprint: RecordFingerprint | undefined;
  readonly isSymlink: boolean;
}

/** A directory under a root as last listed. */
interface IndexedDir {
  readonly root: number;
  /** Its path below its root: the type of a file in it that declares none. */
  readonly segments: readonly string[];
  /**
   * Its stat when listed, kept only when old enough to rule out a change
   * within the same clock tick; undefined otherwise, so it is listed again.
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
  /** Of those relisted, listings another request had started. */
  dirsJoined: number;
  filesParsed: number;
  /** Of those parsed, files the joined listings read. */
  filesJoined: number;
  /** The spans that started the joined listings, one per span. */
  readonly joinedFrom: Map<string, Link>;
}

/** At most this many links from one check to the listings it joined. */
const MAX_JOIN_LINKS = 8;

/**
 * Which file declares which definition id, kept between requests by `swamp
 * serve` so authorizing what a request reads does not parse every
 * definition each time (swamp-club#3968).
 *
 * Only locations are kept, never definitions: a lookup reads each file that
 * declared the id now, so its name and tags are current, and moves a file
 * that no longer declares it. {@link begin} checks every directory's stat,
 * as {@link RunIndexCache} does a run index: a directory whose stat moved,
 * or was too recent when it was listed to rule out a change within the same
 * clock tick, is listed again, and of its files only those whose own stat
 * moved, or was too recent when read, are read again.
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
  readonly #stat: (
    path: string,
  ) => Promise<RecordFingerprint | undefined | null>;
  readonly #dirs = new Map<string, IndexedDir>();
  readonly #pathsById = new Map<string, Set<string>>();
  #definitions = 0;
  readonly #openFiles = new Semaphore(MAX_OPEN_FILES);
  readonly #listing = new Map<
    string,
    {
      ticket: number;
      /** The stat it lists from, when it was settled as it was taken. */
      stamp: RecordFingerprint | undefined;
      read: SharedIndexRead<number>;
      /** The span of the check that started it, for checks that join it. */
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
  }

  /**
   * Checks the index against the definitions stored now, traced as a
   * `swamp.serve.definition_index.validate` span, and returns a view that
   * reads each id's files when it is looked up.
   */
  async begin(signal?: AbortSignal): Promise<DefinitionOwnerView> {
    signal?.throwIfAborted();
    // Inside a diagnostic area that lists it, the check is its owner_index
    // phase, so definition files it reads are counted apart from the
    // request's other work (design/enablers/serve-phase-telemetry.md).
    await observeDiagnosticPhase("owner_index", {}, async (phase) => {
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
                // A scan of every definition names the auto-definitions the
                // datastore could not materialise (swamp-club#3617); so does
                // a listing of them.
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
              // A joined listing ran under the request that started it;
              // the link names that request without reparenting its work.
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

  /** Lists one file of a directory into `files`; 1 when it was read. */
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
      fingerprint,
      isSymlink: entry.isSymlink,
    });
    return 1;
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
      // Whether it is a symlink now, not when listed: a file swapped for a
      // symlink since must still have its target contained in the repo.
      const isSymlink = dir && file ? await liveSymlink(path) : null;
      // Gone since it was listed (the view lasts the whole request): it owns
      // nothing, and is no broken definition to warn about.
      if (!dir || !file || isSymlink === null) {
        this.#unindex(id, path);
        continue;
      }
      const read = await this.#source.readDefinitionFile(
        path,
        [...dir.segments],
        isSymlink,
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
   * Stats a definition file as a scan reads one: an I/O error (EACCES,
   * EMFILE, …) is raised, and any other failure — a symlink loop, a path
   * through a regular file — makes it {@link BROKEN}: it owns nothing and
   * is stat'ed again on each check, as a scan skips it with a warning.
   * `warn` logs that warning, once per listing rather than per check.
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
   * `stat` when it was old enough, as it was taken at `statAt`, to rule out
   * a change within the same clock tick, else undefined; null (gone) as is.
   * Deciding when a stat is taken, not when it is compared, is what keeps a
   * change made in the tick after a listing from hiding behind a stat that
   * only later looks old (the racy-git problem). A time in the future is
   * never settled. The ctime counts as well as the mtime: a rewrite that sets
   * the mtime back moves only the ctime.
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

  /**
   * Whether a stored stat, settled when it was taken, still describes what
   * `current` describes, and is old enough to rule out a change within the
   * same clock tick.
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

/**
 * Runs `each` over `items`, {@link MAX_OPEN_FILES} at a time, so a listing
 * that fails stops starting reads at the next batch.
 */
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

/**
 * Whether `path` is a symlink now; null when it is gone, or a directory on
 * its path is no longer one.
 */
async function liveSymlink(path: string): Promise<boolean | null> {
  try {
    return (await Deno.lstat(path)).isSymlink;
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
