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
 * The data names the policy loader reads. Only their versions decide
 * access, so other data a grant or group model keeps (method-summary
 * reports) is not watched.
 */
const ACCESS_DATA_NAMES: readonly string[] = ["grant-main", "group-main"];

/**
 * One record directory (`<subdir>/<modelId>`): every entry of its access
 * data by relative path, and the version directories (`<dataName>/<N>`)
 * among them.
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
 * Each `detect()` compares a fingerprint of the records' access data (entry
 * names, sizes, mtimes, inodes) with the previous one and returns how many
 * records another process changed: a peer serve, a CLI, or a remote worker.
 * A record this process changed is not counted, so a manual-mode instance
 * keeps its own writes staged, as on S3/GCS, where serve never pulls its
 * own writes. Its own writes are the exact data versions its grant and
 * group method runs name in their `ModelUpdated` events.
 *
 * Attribution fails safe: a changed record counts as a peer change unless
 * every version added to it is one this process's events named and nothing
 * but older versions went away. A cycle that sees an own version before its
 * run publishes the event therefore reloads, which can apply a staged own
 * write one interval early, but a peer's change is never swallowed: a peer's
 * version is never named by this process's events.
 *
 * A record, or a part of one, that cannot be read (a peer wrote it with a
 * restrictive umask or as another uid) does not stop the cycle
 * (swamp-club#3386). Each directory or entry that cannot be read is
 * fingerprinted as its error, so it counts as changed when it turns
 * unreadable and again when it reads, while everything readable beside it
 * and every other record is still compared. While it stays unreadable it
 * is not counted again; a snapshot missing records it could not read is
 * retried by the poller on its own.
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

  /**
   * Records this process's own grant and group writes from its event bus.
   * Listening from construction; call again after `dispose()` to resume.
   */
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

  /** Whether `detect()` has a baseline to compare against. */
  get hasBaseline(): boolean {
    return this.#baseline !== null;
  }

  /** Takes the baseline the first `detect()` compares against. */
  async prime(): Promise<void> {
    this.#baseline = await this.#fingerprint();
    this.#ownVersions = new Map();
  }

  /**
   * The number of records another process changed since the last call.
   * Without a baseline (`prime()` failed) it reports one change, so the
   * caller reloads rather than trusting a snapshot it cannot vouch for.
   */
  async detect(): Promise<number> {
    // Counted into the poller's change_detection phase, when one records.
    const tally = currentDiagnosticTally();
    const current = await this.#fingerprint();
    if (tally.recording) {
      // A directory that could not be listed is keyed by itself, not a record.
      const dirs = new Set(this.#dirs);
      for (const [key, record] of current) {
        if (!dirs.has(key)) tally.add("records");
        tally.add("entries", record.entries.size);
        tally.add("unreadable_entries", unreadableEntries(record.entries).size);
      }
    }
    // Own versions are only ever matched against the versions added since
    // the last call. One named by an event that arrived after its version
    // was already counted can match nothing later, so it is dropped.
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
 * True when the change to one record is accounted for by versions this
 * process wrote: the record still exists, it gained at least one version,
 * every version it gained is one of `ownVersions`, and any version it lost
 * is older than every version it gained (pruned by garbage collection on an
 * own write).
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
 * The fingerprint of a record or directory that could not be read: one
 * entry naming the error, and no versions. It differs from any readable
 * fingerprint, so turning unreadable or readable again counts as a change,
 * and it never counts as an own change. While the same error persists it
 * stays equal, so the record is not counted every cycle.
 */
function unreadableFingerprint(error: unknown): RecordFingerprint {
  return {
    entries: new Map([["!unreadable", unreadableEntry(error)]]),
    versions: new Set(),
  };
}

/** The entries of a fingerprint that record something it could not read. */
function unreadableEntries(
  entries: ReadonlyMap<string, string> | undefined,
): Map<string, string> {
  return new Map(
    [...entries ?? []].filter(([, entry]) => entry.startsWith("!unreadable")),
  );
}

/** The fingerprint entry of something that could not be read: its error. */
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
 * Records every entry under `dir` by its `/`-joined path relative to the
 * record directory. Symlinks are recorded, never followed, and dot-named
 * entries (atomic-write temp files) are skipped. An entry removed mid-walk
 * is left out. A directory or entry that cannot be read is recorded as its
 * error and its siblings are still walked, so an unreadable old version
 * never hides a new version or a changed `latest` beside it.
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
    // Beside the directory's own entry, which stays: a version directory
    // that cannot be read is still that version.
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
