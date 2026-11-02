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
import { currentDiagnosticTally } from "../../domain/diagnostics/diagnostic_phase.ts";
import { RUN_INDEX_RACY_WINDOW_MS } from "./run_index_cache.ts";
import { isIoError } from "./io_errors.ts";
import { readDirSorted } from "./sorted_dir_entries.ts";
import {
  fingerprintMatches,
  type RecordFingerprint,
  statRecord,
} from "./workflow_run_index.ts";

type FoundDefinition = { definition: Definition; type: ModelType };

export type NameIndexFileReader = (
  path: string,
  typeSegments: string[],
  isSymlink: boolean,
) => Promise<FoundDefinition | null>;

export interface AutoDefinitionNameIndexOptions {
  racyWindowMs?: number;
  now?: () => number;
  stat?: (path: string) => Promise<RecordFingerprint | undefined | null>;
}

interface IrregularFile {
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
 * keeps names and locations only, so a lookup of a missing name avoids reading
 * every file; a failed listing leaves the index intact; a missed read of an
 * indexed file is retried so I/O errors surface
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
  #stamp: RecordFingerprint | undefined;
  #listed = false;
  #regular = new Set<string>();
  #irregular = new Map<string, IrregularFile>();
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

  // A lookup that joins a queued check counts `index_checks_joined` in its
  // diagnostic phase; the check runs, and is counted, in the phase of the
  // lookup that queued it.
  #validate(): Promise<void> {
    if (this.#waiting) {
      currentDiagnosticTally().add("index_checks_joined");
      return this.#waiting;
    }
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
        const entries = this.#regular.size + this.#irregular.size;
        span.setAttributes({
          "name_index.entries": entries,
          "name_index.relisted": counts.relisted,
          "name_index.files_parsed": counts.filesParsed,
        });
        const tally = currentDiagnosticTally();
        tally.add("index_checks_run");
        tally.add("index_entries", entries);
        if (counts.relisted) tally.add("index_relists");
      },
    );
  }

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
   * settled only if old enough to rule out a change within the same clock tick;
   * a future time is never settled; ctime counts as well as mtime
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
