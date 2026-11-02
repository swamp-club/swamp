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
import { currentDiagnosticTally } from "../domain/diagnostics/diagnostic_phase.ts";
import { minOf } from "../domain/array_extrema.ts";
import type { EventBus } from "../domain/events/event_bus.ts";
import type { ModelUpdated } from "../domain/events/types.ts";
import { GRANT_MODEL_TYPE } from "../domain/models/access/grant_model.ts";
import { GROUP_MODEL_TYPE } from "../domain/models/access/group_model.ts";

/**
 * only their versions decide access, so other data a grant or group model keeps
 * is not watched
 */
const ACCESS_DATA_NAMES: readonly string[] = ["grant-main", "group-main"];

interface RecordFingerprint {
  readonly entries: ReadonlyMap<string, string>;
  readonly versions: ReadonlySet<string>;
}

type Fingerprint = Map<string, RecordFingerprint>;

export interface FilesystemAccessDataChangeSourceOptions {
  dirs: readonly string[];
  eventBus: EventBus;
}

/**
 * a changed record counts as a peer change unless every added version is one
 * this process's events named and only older versions went away; an early own
 * version just reloads, a peer's change is never swallowed
 */
export class FilesystemAccessDataChangeSource {
  readonly #dirs: readonly string[];
  readonly #eventBus: EventBus;
  readonly #unsubscribers: (() => void)[] = [];
  #baseline: Fingerprint | null = null;
  #ownVersions = new Map<string, Set<string>>();

  constructor(options: FilesystemAccessDataChangeSourceOptions) {
    this.#dirs = options.dirs;
    this.#eventBus = options.eventBus;
    this.listen();
  }

  listen(): void {
    if (this.#unsubscribers.length > 0) return;
    this.#unsubscribers.push(
      this.#eventBus.subscribe<ModelUpdated>("ModelUpdated", (event) => {
        if (
          event.modelType !== GRANT_MODEL_TYPE.normalized &&
          event.modelType !== GROUP_MODEL_TYPE.normalized
        ) {
          return;
        }
        const own = this.#ownVersions.get(event.modelInputId) ?? new Set();
        for (const { name, version } of event.dataVersions ?? []) {
          own.add(`${name}/${version}`);
        }
        this.#ownVersions.set(event.modelInputId, own);
      }),
    );
  }

  get hasBaseline(): boolean {
    return this.#baseline !== null;
  }

  async prime(): Promise<void> {
    this.#baseline = await this.#fingerprint();
    this.#ownVersions = new Map();
  }

  async detect(): Promise<number> {
    const tally = currentDiagnosticTally();
    const current = await this.#fingerprint();
    if (tally.recording) {
      const dirs = new Set(this.#dirs);
      for (const [key, record] of current) {
        if (!dirs.has(key)) tally.add("records");
        tally.add("entries", record.entries.size);
        tally.add("unreadable_entries", unreadableEntries(record.entries).size);
      }
    }
    // own versions match only versions added since the last call; one named by
    // an event arriving after its version was counted can match nothing later,
    // so it is dropped
    const ownVersions = this.#ownVersions;
    this.#ownVersions = new Map();
    const baseline = this.#baseline;
    this.#baseline = current;
    if (!baseline) return 1;

    let changed = 0;
    for (const key of new Set([...baseline.keys(), ...current.keys()])) {
      const before = baseline.get(key);
      const after = current.get(key);
      if (sameEntries(before?.entries, after?.entries)) continue;
      if (!isOwnChange(before, after, ownVersions.get(modelIdOf(key)))) {
        changed++;
      } else {
        tally.add("own_changes_excluded");
      }
    }
    tally.add("changed", changed);
    return changed;
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers.length = 0;
  }

  async #fingerprint(): Promise<Fingerprint> {
    const fingerprint: Fingerprint = new Map();
    for (const dir of this.#dirs) {
      let modelIds: string[];
      try {
        modelIds = await listDirectories(dir);
      } catch (error) {
        fingerprint.set(dir, unreadableFingerprint(error));
        continue;
      }
      for (const modelId of modelIds) {
        const entries = new Map<string, string>();
        for (const dataName of ACCESS_DATA_NAMES) {
          await walk(join(dir, modelId, dataName), dataName, entries);
        }
        const versions = new Set<string>();
        for (const [path, entry] of entries) {
          const parts = path.split("/");
          if (
            parts.length === 2 && /^\d+$/.test(parts[1]) && entry === "d"
          ) {
            versions.add(path);
          }
        }
        fingerprint.set(join(dir, modelId), { entries, versions });
      }
    }
    return fingerprint;
  }
}

/**
 * own change: the record still exists, gained versions all in ownVersions, and
 * any lost version is older than every gained one (garbage collection on an own
 * write)
 */
function isOwnChange(
  before: RecordFingerprint | undefined,
  after: RecordFingerprint | undefined,
  ownVersions: ReadonlySet<string> | undefined,
): boolean {
  if (!after || !ownVersions) return false;
  // Something turning unreadable, or readable again, is never an own write.
  if (
    !sameEntries(
      unreadableEntries(before?.entries),
      unreadableEntries(after.entries),
    )
  ) {
    return false;
  }
  const beforeVersions = before?.versions ?? new Set<string>();
  const added = [...after.versions].filter((v) => !beforeVersions.has(v));
  const removed = [...beforeVersions].filter((v) => !after.versions.has(v));
  if (added.length === 0) return false;
  if (!added.every((v) => ownVersions.has(v))) return false;
  const oldestAdded = minOf(added.map(versionNumber))!;
  return removed.every((v) => versionNumber(v) < oldestAdded);
}

/**
 * differs from any readable fingerprint so turning unreadable or readable
 * counts as a change, never an own change; stays equal while the same error
 * persists, so it is not counted every cycle
 */
function unreadableFingerprint(error: unknown): RecordFingerprint {
  return {
    entries: new Map([["!unreadable", unreadableEntry(error)]]),
    versions: new Set(),
  };
}

function unreadableEntries(
  entries: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(
    [...entries ?? []].filter(([, entry]) => entry.startsWith("!unreadable")),
  );
}

function unreadableEntry(error: unknown): string {
  return `!unreadable:${error instanceof Error ? error.name : "Error"}`;
}

function versionNumber(versionPath: string): number {
  return Number(versionPath.split("/")[1]);
}

function modelIdOf(recordKey: string): string {
  const parts = recordKey.split(/[\\/]/);
  return parts[parts.length - 1];
}

function sameEntries(
  a: ReadonlyMap<string, string> | undefined,
  b: ReadonlyMap<string, string> | undefined,
): boolean {
  // A record with no access data reads the same as no record.
  if (!a || !b) return (a?.size ?? 0) === 0 && (b?.size ?? 0) === 0;
  if (a.size !== b.size) return false;
  for (const [path, entry] of a) {
    if (b.get(path) !== entry) return false;
  }
  return true;
}

async function listDirectories(dir: string): Promise<string[]> {
  const names: string[] = [];
  try {
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isDirectory && !entry.name.startsWith(".")) {
        names.push(entry.name);
      }
    }
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return [];
    throw error;
  }
  return names;
}

/**
 * symlinks are recorded, never followed; dot-named entries (atomic-write temp
 * files) are skipped; an unreadable entry is recorded as its error and siblings
 * are still walked
 */
async function walk(
  dir: string,
  prefix: string,
  entries: Map<string, string>,
): Promise<void> {
  let children: Deno.DirEntry[];
  try {
    children = await Array.fromAsync(Deno.readDir(dir));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return;
    // beside the directory's own entry, which stays: a version directory that
    // cannot be read is still that version
    entries.set(`${prefix}/!unreadable`, unreadableEntry(error));
    return;
  }
  for (const child of children) {
    if (child.name.startsWith(".")) continue;
    const path = prefix ? `${prefix}/${child.name}` : child.name;
    const fullPath = join(dir, child.name);
    let info: Deno.FileInfo;
    try {
      info = await Deno.lstat(fullPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) continue;
      entries.set(path, unreadableEntry(error));
      continue;
    }
    // a directory is recorded by name only: its mtime moves whenever a temp
    // file comes and goes, and its children carry every real change
    if (info.isDirectory) {
      entries.set(path, "d");
      await walk(fullPath, path, entries);
      continue;
    }
    const kind = info.isSymlink ? "l" : "f";
    entries.set(
      path,
      `${kind}:${info.size}:${info.mtime?.getTime() ?? 0}:${info.ino ?? 0}`,
    );
  }
}
