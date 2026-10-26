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
import {
  type Definition,
  isFilenameSafeDefinitionName,
} from "../../domain/definitions/definition.ts";
import type { ModelType } from "../../domain/models/model_type.ts";
import { withSpan } from "../tracing/mod.ts";
import { RUN_INDEX_RACY_WINDOW_MS } from "./run_index_cache.ts";
import { isIoError } from "./io_errors.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

type FoundDefinition = { definition: Definition; type: ModelType };

/**
 * Reads one definition file as a scan of a definitions directory reads it: a
 * {@link YamlDefinitionRepository}'s `readDefinitionFile`. Null for an empty
 * or broken file, which it warns about; an I/O error is raised.
 */
export type NameIndexFileReader = (
  path: string,
  typeSegments: string[],
  isSymlink: boolean,
) => Promise<FoundDefinition | null>;

export interface AutoDefinitionNameIndexOptions {
  racyWindowMs?: number;
  now?: () => number;
  /**
   * Stats a directory or file, following symlinks: null when it is gone,
   * undefined when the platform gives no mtime. Defaults to `statRecord`.
   */
  stat?: (path: string) => Promise<RecordFingerprint | undefined | null>;
}

/**
 * A file that a lookup by its declared name could not find at its
 * name-derived path: one whose name is not its filename (a legacy
 * `{uuid}.yaml`, a name that is not filename-safe, a mismatched file), one
 * that did not parse, or a symlink, whose target can change without its
 * directory's stat moving.
 */
interface IrregularFile {
  /** The name it declared when last read; undefined when it did not parse. */
  name: string | undefined;
  /**
   * Its stat when read, kept only when old enough to rule out a change
   * within the same clock tick; undefined otherwise, so it is read again.
   */
  fingerprint: RecordFingerprint | undefined;
  readonly isSymlink: boolean;
}

interface ValidationCounts {
  relisted: boolean;
  filesParsed: number;
}

/**
 * Which file of one auto-definitions type directory declares which
 * definition name, kept by a {@link YamlDefinitionRepository} between
 * lookups, so a lookup of a name that has no definition yet does not read
 * and parse every file in the directory (swamp-club#3984). Serve looks up a
 * worker's definition by name on each enrollment, and a fleet of ephemeral
 * workers brings a new name each time.
 *
 * Only names and locations are kept, never definitions: {@link find} reads
 * the file it answers with, so the definition is current, and a file that
 * no longer declares the name is read again on the next check.
 *
 * Most files are `<name>.yaml` declaring that name, which a lookup reads
 * directly at its name-derived path; such a file is kept as its filename
 * alone. The rest, which only a scan could find, are kept with the name they
 * declared and are stat'ed on every check, and read again when their stat
 * moved, so a `{uuid}.yaml` whose definition was renamed in place is seen.
 *
 * Each check stats the directory, as {@link DefinitionIdIndex} does. When the
 * stat moved, or was too recent when it was listed to rule out a change
 * within the same clock tick, the directory is listed again, and only the
 * files new to the listing are read. A listing replaces the entries only
 * once it has read the whole directory, so one that fails leaves the index
 * as it was. Overlapping lookups share a check that starts after each of
 * them asked.
 *
 * A lookup whose read of the name-derived file missed, though the index
 * holds that file as declaring the name, reads it again here as a scan
 * would: an I/O error is then raised instead of reported as no definition,
 * so an auto-creating run cannot write a new definition over it.
 *
 * One change is not seen until that file is listed anew, or a lookup of the
 * name it declared before reads it: a `<name>.yaml` declaring its own name,
 * rewritten by something other than `save()` to declare another name (a
 * hand edit, a checkout). `save()` never does this; it moves a renamed
 * definition to its new name's path. Until then a lookup of the new name
 * misses the file, and an auto-creating run creates a second definition of
 * that name.
 */
export class AutoDefinitionNameIndex {
  readonly #dir: string;
  readonly #typeSegments: readonly string[];
  readonly #read: NameIndexFileReader;
  readonly #racyWindowMs: number;
  readonly #now: () => number;
  readonly #stat: (
    path: string,
  ) => Promise<RecordFingerprint | undefined | null>;
  /** The directory's stat when listed, when settled as it was taken. */
  #stamp: RecordFingerprint | undefined;
  #listed = false;
  /** Regular files that declared the name their filename gives. */
  #regular = new Set<string>();
  /** Every other file, in listing order. */
  #irregular = new Map<string, IrregularFile>();
  /** A check queued behind the running one, which has not started yet. */
  #waiting: Promise<void> | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(
    dir: string,
    type: ModelType,
    read: NameIndexFileReader,
    options: AutoDefinitionNameIndexOptions = {},
  ) {
    this.#dir = dir;
    this.#typeSegments = type.normalized.split("/");
    this.#read = read;
    this.#racyWindowMs = options.racyWindowMs ?? RUN_INDEX_RACY_WINDOW_MS;
    this.#now = options.now ?? Date.now;
    this.#stat = options.stat ?? statRecord;
  }

  /**
   * The definition declaring `name` in a file other than its name-derived
   * one, as the first file in name order that declares it, or null. The
   * caller has already looked at the name-derived file.
   */
  async find(
    name: string,
  ): Promise<{ definition: Definition; path: string } | null> {
    await this.#validate();
    const named = `${name}.yaml`;
    if (isFilenameSafeDefinitionName(name) && this.#regular.has(named)) {
      // The caller's read of the file its name gives missed, though the file
      // declared that name when listed. Read it as a scan would, so an I/O
      // error is raised rather than taken for a definition that is not there.
      const path = join(this.#dir, named);
      const isSymlink = await liveSymlink(path);
      if (isSymlink !== null) {
        const found = await this.#read(
          path,
          [...this.#typeSegments],
          isSymlink,
        );
        if (found?.definition.name === name) {
          return { definition: found.definition, path };
        }
        // Rewritten to declare another name: keep what it declares now.
        if (found && this.#regular.delete(named)) {
          this.#irregular.set(named, {
            name: found.definition.name,
            fingerprint: undefined,
            isSymlink,
          });
        }
      }
    }
    for (const [filename, file] of [...this.#irregular]) {
      if (file.name !== name) continue;
      const path = join(this.#dir, filename);
      // Whether it is a symlink now, not when listed: a file swapped for a
      // symlink since must still have its target contained in the repo.
      const isSymlink = await liveSymlink(path);
      if (isSymlink === null) continue;
      const found = await this.#read(path, [...this.#typeSegments], isSymlink);
      if (found?.definition.name === name) {
        return { definition: found.definition, path };
      }
      // Rewritten since it was read: keep what it declares now, and read it
      // again on the next check.
      if (this.#irregular.get(filename) === file) {
        file.name = found?.definition.name;
        file.fingerprint = undefined;
      }
    }
    return null;
  }

  #validate(): Promise<void> {
    if (this.#waiting) return this.#waiting;
    const run: Promise<void> = this.#tail.then(() => {
      if (this.#waiting === run) this.#waiting = undefined;
      return this.#check();
    });
    this.#waiting = run;
    this.#tail = run.catch(() => {});
    return run;
  }

  async #check(): Promise<void> {
    await withSpan(
      "swamp.definition.name_index.validate",
      { "name_index.type": this.#typeSegments.join("/") },
      async (span) => {
        const counts: ValidationCounts = { relisted: false, filesParsed: 0 };
        const statAt = this.#now();
        const current = await this.#stat(this.#dir);
        if (current === null) {
          this.#stamp = undefined;
          this.#listed = false;
          this.#regular = new Set();
          this.#irregular = new Map();
        } else {
          const read = new Set<string>();
          if (!this.#listed || !this.#trusted(this.#stamp, current)) {
            await this.#relist(this.#settled(current, statAt), counts, read);
          }
          await this.#recheckIrregular(read, counts);
        }
        span.setAttributes({
          "name_index.entries": this.#regular.size + this.#irregular.size,
          "name_index.relisted": counts.relisted,
          "name_index.files_parsed": counts.filesParsed,
        });
      },
    );
  }

  /**
   * Lists the directory, reading only files the last listing did not have,
   * and replaces the entries once every file is accounted for.
   */
  async #relist(
    stamp: RecordFingerprint | undefined,
    counts: ValidationCounts,
    read: Set<string>,
  ): Promise<void> {
    counts.relisted = true;
    let entries: Deno.DirEntry[];
    try {
      entries = await readDirSorted(this.#dir);
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
      entries = [];
    }
    const regular = new Set<string>();
    const irregular = new Map<string, IrregularFile>();
    for (const entry of entries) {
      if (!(entry.isFile || entry.isSymlink) || !entry.name.endsWith(".yaml")) {
        continue;
      }
      if (entry.isFile && this.#regular.has(entry.name)) {
        regular.add(entry.name);
        continue;
      }
      const known = this.#irregular.get(entry.name);
      if (known && known.isSymlink === entry.isSymlink) {
        irregular.set(entry.name, known);
        continue;
      }
      const file = await this.#readFile(entry.name, entry.isSymlink, counts);
      read.add(entry.name);
      if (file === "regular") regular.add(entry.name);
      else if (file) irregular.set(entry.name, file);
    }
    this.#regular = regular;
    this.#irregular = irregular;
    this.#stamp = stamp;
    this.#listed = true;
  }

  /**
   * Stats each irregular file not read by this check, and reads again each
   * one whose stat moved or could not be trusted.
   */
  async #recheckIrregular(
    read: ReadonlySet<string>,
    counts: ValidationCounts,
  ): Promise<void> {
    for (const [filename, file] of [...this.#irregular]) {
      if (read.has(filename)) continue;
      const path = join(this.#dir, filename);
      let current;
      try {
        current = await this.#stat(path);
      } catch (error) {
        if (isIoError(error)) throw error;
        // A symlink loop or the like: it declares nothing, as a scan skips
        // it with a warning.
        file.name = undefined;
        file.fingerprint = undefined;
        continue;
      }
      if (current === null) {
        // Gone, or a symlink whose target is gone: it declares nothing, and
        // a symlink stays listed until its directory says otherwise.
        file.name = undefined;
        file.fingerprint = undefined;
        continue;
      }
      if (this.#trusted(file.fingerprint, current)) continue;
      const next = await this.#readFile(filename, file.isSymlink, counts);
      if (this.#irregular.get(filename) !== file) continue;
      if (next === "regular") {
        this.#irregular.delete(filename);
        this.#regular.add(filename);
      } else if (next) {
        file.name = next.name;
        file.fingerprint = next.fingerprint;
      } else {
        this.#irregular.delete(filename);
      }
    }
  }

  /**
   * Reads one file: "regular" when it is a regular file declaring the name
   * its filename gives, else how to keep it; null for a regular file gone
   * since it was listed.
   */
  async #readFile(
    filename: string,
    isSymlink: boolean,
    counts: ValidationCounts,
  ): Promise<"regular" | IrregularFile | null> {
    const path = join(this.#dir, filename);
    const statAt = this.#now();
    let stat;
    try {
      stat = await this.#stat(path);
    } catch (error) {
      if (isIoError(error)) throw error;
      stat = undefined;
    }
    if (stat === null) {
      // A symlink whose target is missing stays listed, so its target is
      // stat'ed on each check and read once it appears.
      return isSymlink
        ? { name: undefined, fingerprint: undefined, isSymlink }
        : null;
    }
    const found = await this.#read(path, [...this.#typeSegments], isSymlink);
    counts.filesParsed++;
    const name = found?.definition.name;
    if (
      !isSymlink && name !== undefined &&
      isFilenameSafeDefinitionName(name) && filename === `${name}.yaml`
    ) {
      return "regular";
    }
    return {
      name,
      fingerprint: this.#settled(stat, statAt),
      isSymlink,
    };
  }

  /**
   * `stat` when it was old enough, as it was taken at `statAt`, to rule out
   * a change within the same clock tick, else undefined. A time in the
   * future is never settled; the ctime counts as well as the mtime.
   */
  #settled(
    stat: RecordFingerprint | undefined,
    statAt: number,
  ): RecordFingerprint | undefined {
    if (!stat) return undefined;
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
