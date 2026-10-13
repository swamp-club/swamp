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
import { minOf } from "../domain/array_extrema.ts";
import type { EventBus } from "../domain/events/event_bus.ts";
import type { ModelCreated, ModelUpdated } from "../domain/events/types.ts";
import { GRANT_MODEL_TYPE } from "../domain/models/access/grant_model.ts";
import { GROUP_MODEL_TYPE } from "../domain/models/access/group_model.ts";

/**
 * One record directory (`<subdir>/<modelId>`): every entry beneath it by
 * relative path, and the version directories (`<dataName>/<N>`) among them.
 */
interface RecordFingerprint {
  readonly entries: ReadonlyMap<string, string>;
  readonly versions: ReadonlySet<string>;
}

type Fingerprint = Map<string, RecordFingerprint>;

export interface FilesystemAccessDataChangeSourceOptions {
  /** Absolute grant and group data directories to watch. */
  dirs: readonly string[];
  /** This process's event bus, where its own grant and group runs publish. */
  eventBus: EventBus;
}

/**
 * Detects grant and group changes on a v2 filesystem datastore, where peers
 * share the files and there is nothing to pull (swamp-club#3371).
 *
 * Each `detect()` compares a fingerprint of the record directories (entry
 * names, sizes, mtimes, inodes) with the previous one and returns how many
 * records another process changed: a peer serve, a CLI, or a remote worker.
 * A record this process changed is not counted, so a manual-mode instance
 * keeps its own writes staged, as on S3/GCS, where serve never pulls its
 * own writes. Its own writes are recognised by the `ModelCreated` and
 * `ModelUpdated` events its grant and group method runs publish.
 *
 * Attribution fails safe: a changed record counts as a peer change unless
 * every version added to it is matched by one of this process's events and
 * nothing but older versions went away. A tick that sees an own version
 * before its run publishes the event therefore reloads, which can apply a
 * staged own write one interval early, but a peer's change is never
 * swallowed.
 */
export class FilesystemAccessDataChangeSource {
  readonly #dirs: readonly string[];
  readonly #eventBus: EventBus;
  readonly #unsubscribers: (() => void)[] = [];
  #baseline: Fingerprint | null = null;
  #ownWrites = new Map<string, number>();

  constructor(options: FilesystemAccessDataChangeSourceOptions) {
    this.#dirs = options.dirs;
    this.#eventBus = options.eventBus;
    this.listen();
  }

  /**
   * Records this process's own grant and group writes from its event bus.
   * Listening from construction; call again after `dispose()` to resume.
   */
  listen(): void {
    if (this.#unsubscribers.length > 0) return;
    const noteOwnWrite = (event: ModelCreated | ModelUpdated) => {
      if (
        event.modelType === GRANT_MODEL_TYPE.normalized ||
        event.modelType === GROUP_MODEL_TYPE.normalized
      ) {
        this.#ownWrites.set(
          event.modelInputId,
          (this.#ownWrites.get(event.modelInputId) ?? 0) + 1,
        );
      }
    };
    this.#unsubscribers.push(
      this.#eventBus.subscribe<ModelCreated>("ModelCreated", noteOwnWrite),
      this.#eventBus.subscribe<ModelUpdated>("ModelUpdated", noteOwnWrite),
    );
  }

  /** Takes the baseline the first `detect()` compares against. */
  async prime(): Promise<void> {
    this.#baseline = await this.#fingerprint();
    this.#ownWrites = new Map();
  }

  /**
   * The number of records another process changed since the last call.
   * Without a baseline (`prime()` failed) it reports one change, so the
   * caller reloads rather than trusting a snapshot it cannot vouch for.
   */
  async detect(): Promise<number> {
    const current = await this.#fingerprint();
    const ownWrites = this.#ownWrites;
    this.#ownWrites = new Map();
    const baseline = this.#baseline;
    this.#baseline = current;
    if (!baseline) return 1;

    let changed = 0;
    for (const key of new Set([...baseline.keys(), ...current.keys()])) {
      const before = baseline.get(key);
      const after = current.get(key);
      if (before && after && sameEntries(before.entries, after.entries)) {
        continue;
      }
      if (!isOwnChange(before, after, ownWrites.get(modelIdOf(key)) ?? 0)) {
        changed++;
      }
    }
    return changed;
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribers) unsubscribe();
    this.#unsubscribers.length = 0;
  }

  async #fingerprint(): Promise<Fingerprint> {
    const fingerprint: Fingerprint = new Map();
    for (const dir of this.#dirs) {
      for (const modelId of await listDirectories(dir)) {
        const entries = new Map<string, string>();
        await walk(join(dir, modelId), "", entries);
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
 * True when the change to one record is accounted for by `ownWrites` of this
 * process: the record still exists, it gained no more versions than this
 * process wrote, and any version it lost is older than every version it
 * gained (pruned by garbage collection on an own write).
 */
function isOwnChange(
  before: RecordFingerprint | undefined,
  after: RecordFingerprint | undefined,
  ownWrites: number,
): boolean {
  if (!after || ownWrites === 0) return false;
  const beforeVersions = before?.versions ?? new Set<string>();
  const added = [...after.versions].filter((v) => !beforeVersions.has(v));
  const removed = [...beforeVersions].filter((v) => !after.versions.has(v));
  if (added.length > ownWrites) return false;
  if (removed.length === 0) return true;
  if (added.length === 0) return false;
  const oldestAdded = minOf(added.map(versionNumber))!;
  return removed.every((v) => versionNumber(v) < oldestAdded);
}

function versionNumber(versionPath: string): number {
  return Number(versionPath.split("/")[1]);
}

function modelIdOf(recordKey: string): string {
  const parts = recordKey.split(/[\\/]/);
  return parts[parts.length - 1];
}

function sameEntries(
  a: ReadonlyMap<string, string>,
  b: ReadonlyMap<string, string>,
): boolean {
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
 * Records every entry under `dir` by its `/`-joined path relative to the
 * record directory. Symlinks are recorded, never followed, and dot-named
 * entries (atomic-write temp files) are skipped. An entry removed mid-walk
 * is left out.
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
    throw error;
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
      throw error;
    }
    // A directory is recorded by name only: its own mtime moves whenever
    // a temp file comes and goes, and its children carry every real change.
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
