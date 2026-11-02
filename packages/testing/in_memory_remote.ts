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

/**
 * fake remote datastore for testing sync across simulated machines; defaults
 * reproduce the released S3 and GCS extensions, quirks included, and will
 * change with them. No method honors options.signal.
 */

import { dirname, join, normalize } from "@std/path";
import type {
  ControlPlaneStore,
  DatastoreStorage,
  DatastoreSyncOptions,
  DatastoreSyncService,
  RepairUnpushedFilesOptions,
  ReplicaPathStore,
  StoredChunk,
  SyncCapabilities,
  UnpushedFilesSummary,
  V3ReplicaTarget,
  WritableDatastoreControlPlaneStore,
} from "./datastore_types.ts";
import { replicaPathFenceProblem } from "./replica_path_fence.ts";

export interface InMemoryRemoteSemantics {
  /**
   * a pull deletes local files the remote dropped since the last pull, unless
   * marked, and counts them; no released extension does this. When set it
   * decides what a pull removes, and removesPeerDeletes applies to pushes only.
   */
  pullDeletes: boolean;
  bulkDisablesDeletes: boolean;
  /**
   * An unscoped pull of a moved remote marks the cache clean, so a pending
   * push is dropped. Marks stay listed, and marking a listed path again
   * does not mark the cache dirty.
   */
  pullClearsPendingPush: boolean;
  /**
   * a pull, push or preparePush that read the remote first removes the
   * unchanged, unmarked local copy of each file a peer deleted; a pull does not
   * count them. pullDeletes, when also set, decides what a pull removes instead.
   */
  removesPeerDeletes: boolean;
  /**
   * a successful push clears every mark, even ones made after it began, as
   * released extensions do; unset, clearing removes only snapshot marks whose
   * generation is unchanged
   */
  commitClearsLaterMarks: boolean;
  /**
   * an entry that cannot be stat'ed (a dangling symlink) in a marked directory
   * makes the push treat the directory as absent and delete every committed key
   * under it, as released extensions do. Unset, the entry is skipped.
   */
  vanishedEntryDeletesDir: boolean;
}

/**
 * the default: what current S3 and GCS extension releases do; a push clears
 * only the marks it handled and skips an entry that vanished mid-walk.
 */
export const EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> = Object
  .freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: false,
    removesPeerDeletes: true,
    commitClearsLaterMarks: false,
    vanishedEntryDeletesDir: false,
  });

/**
 * released S3 and GCS extension behavior before the clearing and vanished-entry
 * fixes: a push or commit clears marks made after it began, and a vanished
 * entry deletes its whole marked directory remotely.
 */
export const EXTENSION_2026_10_20_SEMANTICS: Readonly<
  InMemoryRemoteSemantics
> = Object.freeze({
  pullDeletes: false,
  bulkDisablesDeletes: true,
  pullClearsPendingPush: false,
  removesPeerDeletes: true,
  commitClearsLaterMarks: true,
  vanishedEntryDeletesDir: true,
});

/** a pull keeps a pending push but never removes local files. */
export const EXTENSION_2026_10_01_SEMANTICS: Readonly<
  InMemoryRemoteSemantics
> = Object.freeze({
  pullDeletes: false,
  bulkDisablesDeletes: true,
  pullClearsPendingPush: false,
  removesPeerDeletes: false,
  commitClearsLaterMarks: true,
  vanishedEntryDeletesDir: true,
});

/** a pull of a moved remote drops a pending push and never removes local files. */
export const LEGACY_EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> =
  Object.freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: true,
    removesPeerDeletes: false,
    commitClearsLaterMarks: true,
    vanishedEntryDeletesDir: true,
  });

export interface InMemoryRemoteOptions {
  semantics?: Partial<InMemoryRemoteSemantics>;
  dirtyPathsCap?: number;
  capabilities?: SyncCapabilities;
  controlPlane?: boolean;
  storage?: boolean;
  /**
   * Gives the remote a `replicaTarget()` returning this target as given,
   * unchecked, so a test can hand swamp a bad one. The remote has no key
   * prefix, so a target that matches where it writes has prefix `""`.
   */
  replicaTarget?: V3ReplicaTarget;
  replicaPaths?: boolean;
  monolithIndex?: boolean;
  conditionalCreate?: boolean;
}

export type InMemoryRemoteFailure =
  | "push"
  | "pull"
  | "prepare"
  | "commit"
  | "fetch"
  | "repair"
  | "controlPlane"
  | "replicaPaths";

export interface FailNextOptions {
  /**
   * Fail a push after its uploads land, as a mid-push network error would.
   * Other operations fail before doing anything either way.
   */
  afterUploads?: boolean;
  instance?: string;
}

export interface InMemoryRemoteOpRecord {
  instance: string;
  op:
    | "markDirty"
    | "clearDirty"
    | "push"
    | "pull"
    | "prepare"
    | "commit"
    | "fetch"
    | "repair"
    | "controlPlane";
  paths: string[];
  deleted: string[];
  removed?: string[];
  bulk?: boolean;
}

export interface InMemoryControlPlaneRead {
  instance: string;
  key: string;
}

export interface InMemoryPushManifest {
  readonly uploads: ReadonlyMap<string, Uint8Array>;
  readonly deletes: readonly string[];
}

export interface InMemorySyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<InMemoryPushManifest>;
  commitPush(
    manifest: InMemoryPushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

export interface ConnectOptions {
  instance?: string;
  fetchContent?: boolean;
  clearDirty?: boolean;
  repairUnpushedFiles?: boolean;
}

export interface InMemoryRemote {
  connect(cacheDir: string, options?: ConnectOptions): InMemorySyncService;
  files(): ReadonlyMap<string, Uint8Array>;
  /**
   * Stores an object at `key` without indexing it, as an upload whose
   * index commit never ran leaves one. Other machines cannot pull it.
   */
  storeObject(key: string, bytes: Uint8Array): void;
  failNext(
    op: InMemoryRemoteFailure,
    error?: Error,
    options?: FailNextOptions,
  ): void;
  /**
   * While offline, every push, pull, prepare, commit, fetch and
   * control-plane call throws.
   */
  offline(isOffline: boolean): void;
  /**
   * Writes a control-plane record straight into the remote, as another
   * machine or a later swamp would, without recording an op. The record is
   * datastore-wide unless `namespace` is given. Needs `controlPlane`.
   */
  seedControlPlane(
    key: string,
    data: Uint8Array,
    options?: { namespace?: string },
  ): void;
  controlPlaneRecords(): ReadonlyMap<string, Uint8Array>;
  ops(): readonly InMemoryRemoteOpRecord[];
  /**
   * writable datastore-wide store: keys are `_control/<key>` whatever namespace
   * a service has bound. Its reads list as instance "datastore", its writes are
   * recorded as controlPlane ops, and failNext with that instance reaches it.
   */
  datastoreControlPlaneStore?(): WritableDatastoreControlPlaneStore;
  storage?(): DatastoreStorage;
  replicaTarget?(): V3ReplicaTarget;
  replicaPaths?(): ReplicaPathStore;
  /**
   * Writes an object at `key`, which must start with `_litestream/`, as
   * Litestream would. Present only with `replicaPaths`.
   */
  putReplicaObject?(key: string, bytes: Uint8Array): void;
  deleteReplicaObject?(key: string): void;
  /**
   * whether the remote holds an object at `key`, keyed as a bucket would: a
   * committed file, control-plane record, chunk, or replica object under
   * `_litestream/`.
   */
  objectExists(key: string): Promise<boolean>;
  setChunkLastModified?(
    namespace: string,
    sha256: string,
    date: Date,
  ): Promise<void>;
  connections(): number;
  /**
   * Every control-plane `get`, in order, including one that failed. Reads
   * change nothing, so they are not ops.
   */
  controlPlaneReads(): readonly InMemoryControlPlaneRead[];
  resetSidecar(cacheDir: string): void;
  /**
   * reads what the next push from cacheDir would send with no side effects,
   * even offline; a clean sidecar reports nothing, and while bulk is set the
   * marks are ignored.
   */
  pendingPush(cacheDir: string): Promise<{
    uploads: string[];
    deletes: string[];
    marked: string[];
    bulk: boolean;
  }>;
}

const PLAN_SCOPED = Symbol("scoped");
const PLAN_PRIOR_SEQ = Symbol("priorSeq");
const PLAN_INDEX = Symbol("index");
const PLAN_OVERFLOWED = Symbol("overflowed");
const PLAN_MARKS = Symbol("marks");

interface InternalManifest extends InMemoryPushManifest {
  [PLAN_SCOPED]?: boolean;
  [PLAN_PRIOR_SEQ]?: number;
  [PLAN_INDEX]?: ReadonlyMap<string, Uint8Array>;
  [PLAN_OVERFLOWED]?: boolean;
  [PLAN_MARKS]?: MarkSnapshot;
}

/**
 * The marks a push or `preparePush` walks, taken when it starts. Clearing
 * removes only what this snapshot holds and has not been marked since.
 */
interface MarkSnapshot {
  paths: ReadonlyMap<string, number>;
  bulkGen: number;
  bulk: boolean;
  overflowed: boolean;
}

interface Sidecar {
  localDirty: boolean;
  dirtyPaths: Set<string>;
  bulk: boolean;
  overflowed: boolean;
  pathGens: Map<string, number>;
  bulkGen: number;
  markSeq: number;
  commitSeq?: number;
  pulledKeys: Set<string>;
}

interface PendingFailure {
  op: InMemoryRemoteFailure;
  error: Error;
  afterUploads: boolean;
  instance?: string;
}

interface PushPlan {
  uploads: Map<string, Uint8Array>;
  deletes: string[];
  scoped: boolean;
}

const INTERNAL_FILES = new Set([
  ".datastore-index.json",
  ".push-queue.json",
  ".datastore.lock",
  ".datastore-sync-state.json",
]);

function isInternalCacheFile(rel: string): boolean {
  if (INTERNAL_FILES.has(rel)) return true;
  const first = rel.split("/")[0];
  if (first === "_index" || first === "_control") return true;
  const base = rel.split("/").at(-1) ?? rel;
  return base === ".lock" || base === ".namespace.json" ||
    base === "_catalog.db" || base.startsWith("_catalog.db-");
}

function sameBytes(a: Uint8Array, b: Uint8Array | undefined): boolean {
  if (!b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Matches the extensions' `dir + "/"` prefix test, so `""` matches nothing. */
function isUnder(key: string, dir: string): boolean {
  return key.startsWith(dir + "/");
}

function isInSubdirs(key: string, subdirs: readonly string[]): boolean {
  return subdirs.some((dir) => key === dir || isUnder(key, dir));
}

/**
 * converts a mark to a forward-slash cache-relative path, or undefined when it
 * climbs out of the cache; an absolute path is nested under the cache, so the
 * real file is never pushed.
 */
function toCacheRelative(relPath: string): string | undefined {
  const parts: string[] = [];
  for (const part of relPath.replaceAll("\\", "/").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.join("/");
}

/**
 * whether relPath is absolute or has a `..` segment; a drive letter counts only
 * before a separator, so `a:b/raw` is a name.
 */
function couldLeaveDatastore(relPath: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(relPath) ||
    relPath.split(/[\\/]/).some((segment) => segment === "..");
}

function partitionKeyFromPath(rel: string): string | undefined {
  const segments = rel.split("/");
  if (segments.length < 2) {
    return segments.length === 1 && segments[0] !== "" ? "_root" : undefined;
  }
  const subdir = segments[0];
  switch (subdir) {
    case "data":
    case "outputs":
    case "definitions-evaluated": {
      if (segments.length < 4) return undefined;
      const prefixEnd = segments.length >= 6
        ? segments.length - 3
        : segments.length - 1;
      return segments.slice(0, prefixEnd).join("--");
    }
    case "workflow-runs":
      if (segments.length < 3) return undefined;
      return `${subdir}--${segments[1]}`;
    default:
      return subdir;
  }
}

function shardsReadFor(
  marks: Iterable<string>,
  keys: Iterable<string>,
): Set<string> {
  const existing = new Set<string>();
  for (const rel of keys) {
    const key = partitionKeyFromPath(rel);
    if (key) existing.add(key);
  }
  const needed = new Set<string>();
  const ancestorKeys = new Set<string>();
  const dirtyKeys = new Set<string>();
  for (const mark of marks) {
    const key = partitionKeyFromPath(mark);
    if (key) needed.add(key);
    let joined = "";
    for (const segment of mark.split("/")) {
      if (segment === "") continue;
      joined = joined ? `${joined}--${segment}` : segment;
      ancestorKeys.add(joined);
    }
    if (joined) dirtyKeys.add(joined);
  }
  for (const partition of existing) {
    if (ancestorKeys.has(partition)) {
      needed.add(partition);
      continue;
    }
    for (
      let i = partition.indexOf("--");
      i !== -1;
      i = partition.indexOf("--", i + 2)
    ) {
      if (dirtyKeys.has(partition.substring(0, i))) {
        needed.add(partition);
        break;
      }
    }
  }
  return new Set([...needed].filter((key) => existing.has(key)));
}

async function readLocal(
  cacheDir: string,
  rel: string,
): Promise<Uint8Array | undefined> {
  try {
    return await Deno.readFile(join(cacheDir, ...rel.split("/")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function isRegularFile(cacheDir: string, rel: string): Promise<boolean> {
  try {
    return (await Deno.lstat(join(cacheDir, ...rel.split("/")))).isFile;
  } catch (error) {
    if (
      error instanceof Deno.errors.NotFound ||
      error instanceof Deno.errors.NotADirectory
    ) return false;
    throw error;
  }
}

async function statLocal(
  cacheDir: string,
  rel: string,
): Promise<Deno.FileInfo | undefined> {
  try {
    return await Deno.stat(join(cacheDir, ...rel.split("/")));
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

interface WalkedEntry {
  rel: string;
  dangling: boolean;
}

async function walkLocalEntries(
  cacheDir: string,
  rel: string,
): Promise<WalkedEntry[]> {
  const found: WalkedEntry[] = [];
  const visit = async (dirRel: string): Promise<void> => {
    const dirPath = dirRel === ""
      ? cacheDir
      : join(cacheDir, ...dirRel.split("/"));
    let entries: Deno.DirEntry[];
    try {
      entries = await Array.fromAsync(Deno.readDir(dirPath));
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return;
      throw error;
    }
    for (const entry of entries) {
      const child = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(child);
      } else if (isInternalCacheFile(child)) {
        continue;
      } else if (entry.isFile) {
        found.push({ rel: child, dangling: false });
      } else if (entry.isSymlink && !(await statLocal(cacheDir, child))) {
        found.push({ rel: child, dangling: true });
      }
    }
  };
  await visit(rel);
  return found.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}

function filesOf(entries: readonly WalkedEntry[]): string[] {
  return entries.filter((entry) => !entry.dangling).map((entry) => entry.rel);
}

/**
 * creates an in-memory remote; connect one sync service per simulated machine,
 * all sharing the remote's content.
 */
export function createInMemoryRemote(
  options?: InMemoryRemoteOptions,
): InMemoryRemote {
  const semantics: InMemoryRemoteSemantics = {
    ...EXTENSION_SEMANTICS,
    ...options?.semantics,
  };
  const dirtyPathsCap = options?.dirtyPathsCap ?? 2000;
  const monolithIndex = options?.monolithIndex ?? false;
  const conditionalCreate = options?.conditionalCreate ?? true;
  const controlPlane = options?.controlPlane ?? false;
  const capabilities: SyncCapabilities = {
    ...(options?.capabilities ?? { twoPhaseSync: true }),
    ...(controlPlane ? { controlPlane: true } : {}),
  };
  const controlRecords = new Map<string, Uint8Array>();
  const controlKey = (namespace: string | undefined, key: string) =>
    namespace ? `${namespace}/_control/${key}` : `_control/${key}`;
  const chunkStorage = options?.storage ? createChunkStorage() : undefined;
  const replicaTarget = options?.replicaTarget;
  const replicaObjects = options?.replicaPaths
    ? new Map<string, Uint8Array>()
    : undefined;

  const objects = new Map<string, Uint8Array>();
  const committed = new Map<string, Uint8Array>();
  let commitSeq = 0;
  const sidecars = new Map<string, Sidecar>();
  // The committed bytes of each key as a cache last synced them. Stands in
  // for the extensions' on-disk `.datastore-index.json`, which is written
  // when they write it and, unlike the sidecar, `resetSidecar` keeps.
  const syncedIndexes = new Map<string, Map<string, Uint8Array>>();
  // Keys a peer deleted after a cache synced them while the cache kept its
  // copy, which `repairUnpushedFiles` must never upload. Like the synced
  // index, `resetSidecar` keeps it.
  const peerDeletedKeys = new Map<string, Set<string>>();
  const log: InMemoryRemoteOpRecord[] = [];
  const reads: InMemoryControlPlaneRead[] = [];
  const failures: PendingFailure[] = [];
  let isOffline = false;
  let instanceCount = 0;

  const sidecarKey = (cacheDir: string) => normalize(cacheDir);

  function takeFailure(
    op: InMemoryRemoteFailure,
    instance: string,
  ): PendingFailure | undefined {
    const index = failures.findIndex((f) =>
      f.op === op && (f.instance === undefined || f.instance === instance)
    );
    if (index === -1) return undefined;
    const [failure] = failures.splice(index, 1);
    return failure;
  }

  function checkReachable(
    op: InMemoryRemoteFailure,
    instance: string,
  ): PendingFailure | undefined {
    if (isOffline) throw new Error(`in-memory remote is offline (${op})`);
    const failure = takeFailure(op, instance);
    // Only a push has uploads to land before it fails.
    if (failure && !(op === "push" && failure.afterUploads)) {
      throw failure.error;
    }
    return failure;
  }

  function record(entry: InMemoryRemoteOpRecord): void {
    log.push({
      ...entry,
      paths: [...entry.paths].sort(),
      deleted: [...entry.deleted].sort(),
    });
  }

  function publish(
    uploads: ReadonlyMap<string, Uint8Array>,
    deletes: readonly string[],
  ): number {
    let deleted = 0;
    for (const [key, bytes] of uploads) committed.set(key, bytes);
    for (const key of deletes) {
      if (committed.delete(key)) deleted++;
    }
    if (uploads.size > 0 || deleted > 0) commitSeq++;
    return deleted;
  }

  function pushScope(sidecar: Sidecar | undefined): (rel: string) => boolean {
    const scoped = sidecar !== undefined && !sidecar.bulk &&
      sidecar.dirtyPaths.size > 0;
    if (!scoped) return () => true;
    const read = shardsReadFor(sidecar.dirtyPaths, committed.keys());
    return (rel) => {
      const key = partitionKeyFromPath(rel);
      return key !== undefined && read.has(key);
    };
  }

  async function removableCopies(
    cacheDir: string,
    prior: ReadonlyMap<string, Uint8Array> | undefined,
    inScope: (rel: string) => boolean,
    marked: ReadonlySet<string>,
  ): Promise<string[]> {
    if (!prior) return [];
    const candidates = [...prior.keys()].filter((rel) =>
      !isInternalCacheFile(rel) && inScope(rel) && !committed.has(rel)
    ).sort();
    if (candidates.length === 0) return [];
    if (![...committed.keys()].some(inScope)) return [];
    const removable: string[] = [];
    for (const rel of candidates) {
      if (marked.has(rel)) continue;
      const info = await statLocal(cacheDir, rel);
      if (!info?.isFile) continue;
      if (sameBytes(prior.get(rel)!, await readLocal(cacheDir, rel))) {
        removable.push(rel);
      }
    }
    return removable;
  }

  async function planPushFor(
    cacheDir: string,
    sidecar: Sidecar | undefined,
  ): Promise<PushPlan> {
    const uploads = new Map<string, Uint8Array>();
    const deletes = new Set<string>();
    const uploadIfChanged = async (rel: string) => {
      const bytes = await readLocal(cacheDir, rel);
      if (bytes && !sameBytes(bytes, committed.get(rel))) {
        uploads.set(rel, bytes);
      }
    };

    const scoped = sidecar !== undefined && !sidecar.bulk &&
      sidecar.dirtyPaths.size > 0;
    if (scoped) {
      for (const rel of [...sidecar.dirtyPaths].sort()) {
        if (isInternalCacheFile(rel)) continue;
        const info = await statLocal(cacheDir, rel);
        if (info?.isFile) {
          await uploadIfChanged(rel);
        } else if (info?.isDirectory) {
          const entries = await walkLocalEntries(cacheDir, rel);
          const cut = semantics.vanishedEntryDeletesDir
            ? entries.findIndex((entry) => entry.dangling)
            : -1;
          if (cut !== -1) {
            // the failed stat escapes the walk, so the directory is taken as
            // absent.
            for (const entry of entries.slice(0, cut)) {
              await uploadIfChanged(entry.rel);
            }
            for (const remoteKey of committed.keys()) {
              if (remoteKey === rel || isUnder(remoteKey, rel)) {
                deletes.add(remoteKey);
              }
            }
            continue;
          }
          const local = filesOf(entries);
          for (const file of local) await uploadIfChanged(file);
          const present = new Set(local);
          for (const remoteKey of committed.keys()) {
            if (isUnder(remoteKey, rel) && !present.has(remoteKey)) {
              deletes.add(remoteKey);
            }
          }
        } else if (!info) {
          for (const remoteKey of committed.keys()) {
            if (remoteKey === rel || isUnder(remoteKey, rel)) {
              deletes.add(remoteKey);
            }
          }
        }
      }
      return { uploads, deletes: [...deletes].sort(), scoped };
    }

    // full walk: a bulk mark, an empty set, or no sidecar yet; a failed stat
    // ends it early, unnoticed.
    const entries = await walkLocalEntries(cacheDir, "");
    const cut = semantics.vanishedEntryDeletesDir
      ? entries.findIndex((entry) => entry.dangling)
      : -1;
    const local = filesOf(cut === -1 ? entries : entries.slice(0, cut));
    for (const file of local) await uploadIfChanged(file);
    const deletesMissing = sidecar !== undefined &&
      (sidecar.overflowed ||
        (sidecar.bulk && !semantics.bulkDisablesDeletes));
    if (deletesMissing) {
      const present = new Set(local);
      for (const remoteKey of committed.keys()) {
        if (!present.has(remoteKey)) deletes.add(remoteKey);
      }
    }
    return { uploads, deletes: [...deletes].sort(), scoped };
  }

  function connect(
    cacheDir: string,
    connectOptions?: ConnectOptions,
  ): InMemorySyncService {
    instanceCount++;
    const instance = connectOptions?.instance ?? `instance-${instanceCount}`;
    const key = sidecarKey(cacheDir);

    let namespace: string | undefined;
    let namespaceBound = false;
    /**
     * Binds the namespace on first use and refuses a different one after.
     * An empty namespace is no namespace.
     */
    const bindNamespace = (given: string | undefined): void => {
      const ns = given || undefined;
      if (!namespaceBound) {
        namespace = ns;
        namespaceBound = true;
        return;
      }
      if (namespace !== ns) {
        throw new Error(
          `Namespace mismatch: bound to ${JSON.stringify(namespace)} ` +
            `but called with ${JSON.stringify(ns)}`,
        );
      }
    };

    const loadSidecar = () => sidecars.get(key);
    const ensureSidecar = (): Sidecar => {
      let sidecar = sidecars.get(key);
      if (!sidecar) {
        sidecar = {
          localDirty: false,
          dirtyPaths: new Set(),
          bulk: false,
          overflowed: false,
          pathGens: new Map(),
          bulkGen: 0,
          markSeq: 0,
          pulledKeys: new Set(),
        };
        sidecars.set(key, sidecar);
      }
      return sidecar;
    };

    const planPush = (sidecar: Sidecar | undefined): Promise<PushPlan> =>
      planPushFor(cacheDir, sidecar);

    const snapshotMarks = (sidecar: Sidecar | undefined): MarkSnapshot => ({
      paths: new Map(sidecar?.pathGens ?? []),
      bulkGen: sidecar?.bulkGen ?? 0,
      bulk: sidecar?.bulk ?? false,
      overflowed: sidecar?.overflowed ?? false,
    });

    const walkedSidecar = (
      sidecar: Sidecar | undefined,
      marks: MarkSnapshot,
    ): Sidecar | undefined =>
      semantics.commitClearsLaterMarks || !sidecar ? sidecar : {
        ...sidecar,
        dirtyPaths: new Set(marks.paths.keys()),
        bulk: marks.bulk,
        overflowed: marks.overflowed,
      };

    const markBulkOn = (sidecar: Sidecar, overflow: boolean): void => {
      sidecar.bulk = true;
      sidecar.bulkGen = ++sidecar.markSeq;
      sidecar.localDirty = true;
      if (overflow) sidecar.overflowed = true;
    };

    async function hasAll(index: Iterable<string>): Promise<boolean> {
      for (const remoteKey of index) {
        if (!(await statLocal(cacheDir, remoteKey))) return false;
      }
      return true;
    }

    /**
     * marks the cache clean after a successful push and arms the pull fast path
     * only when nothing else landed since baseSeq and the cache holds
     * everything.
     */
    async function settle(arm: {
      priorSeq: number | undefined;
      baseSeq: number;
      upToDate: boolean;
      scoped: boolean;
      overflowed: boolean;
      index?: Iterable<string>;
      marks?: MarkSnapshot;
    }): Promise<void> {
      const sidecar = ensureSidecar();
      if (semantics.commitClearsLaterMarks) {
        sidecar.dirtyPaths.clear();
        sidecar.pathGens.clear();
        sidecar.bulk = false;
        sidecar.overflowed = false;
        sidecar.localDirty = false;
      } else if (arm.marks) {
        for (const [rel, gen] of arm.marks.paths) {
          if (sidecar.pathGens.get(rel) !== gen) continue;
          sidecar.dirtyPaths.delete(rel);
          sidecar.pathGens.delete(rel);
        }
        if (sidecar.bulkGen === arm.marks.bulkGen) {
          sidecar.bulk = false;
          sidecar.overflowed = false;
        }
        sidecar.localDirty = sidecar.bulk || sidecar.dirtyPaths.size > 0;
      }
      const reconciled = (arm.scoped || arm.overflowed) &&
        arm.priorSeq === arm.baseSeq;
      const armed = arm.upToDate &&
        (reconciled ||
          (!arm.scoped && await hasAll(arm.index ?? committed.keys())));
      sidecar.commitSeq = armed ? commitSeq : undefined;
    }

    async function removePeerDeleted(
      prior: ReadonlyMap<string, Uint8Array> | undefined,
      inScope: (rel: string) => boolean,
      marked: ReadonlySet<string>,
    ): Promise<string[]> {
      const keepDepth = namespace ? 2 : 1;
      const removed: string[] = [];
      for (
        const rel of await removableCopies(cacheDir, prior, inScope, marked)
      ) {
        try {
          await Deno.remove(join(cacheDir, ...rel.split("/")));
        } catch (error) {
          if (error instanceof Deno.errors.NotFound) continue;
          throw error;
        }
        const segments = rel.split("/");
        for (let depth = segments.length - 1; depth > keepDepth; depth--) {
          try {
            await Deno.remove(join(cacheDir, ...segments.slice(0, depth)));
          } catch {
            break;
          }
        }
        removed.push(rel);
      }
      return removed;
    }

    function removeBeforePush(sidecar: Sidecar | undefined): Promise<string[]> {
      if (!semantics.removesPeerDeletes) return Promise.resolve([]);
      return removePeerDeleted(
        syncedIndexes.get(key),
        pushScope(sidecar),
        sidecar?.dirtyPaths ?? new Set(),
      );
    }

    async function recordPushed(
      scoped: boolean,
      index: ReadonlyMap<string, Uint8Array>,
      uploads: ReadonlyMap<string, Uint8Array>,
      deletes: readonly string[],
    ): Promise<void> {
      if (!scoped) {
        const next = new Map(index);
        for (const [rel, bytes] of uploads) next.set(rel, bytes);
        for (const rel of deletes) next.delete(rel);
        await recordPeerDeleted(next);
        syncedIndexes.set(key, next);
        return;
      }
      const synced = syncedIndexes.get(key);
      if (!synced) return;
      const recorded = peerDeletedKeys.get(key) ?? new Set<string>();
      for (const [rel, bytes] of uploads) {
        synced.set(rel, bytes);
        recorded.delete(rel);
      }
      for (const rel of deletes) {
        // A directory taken as absent deletes files still on disk.
        if (
          synced.delete(rel) && !isInternalCacheFile(rel) &&
          await isRegularFile(cacheDir, rel)
        ) {
          recorded.add(rel);
        }
      }
      for (const rel of [...recorded]) {
        if (!(await isRegularFile(cacheDir, rel))) recorded.delete(rel);
      }
      peerDeletedKeys.set(key, recorded);
    }

    /**
     * records each key next drops from the last-synced index while a regular
     * file stays at its path; a delete this cache pushed is recorded only when
     * a file was still on disk.
     */
    async function recordPeerDeleted(
      next: ReadonlyMap<string, Uint8Array>,
    ): Promise<void> {
      const recorded = peerDeletedKeys.get(key) ?? new Set<string>();
      for (const rel of syncedIndexes.get(key)?.keys() ?? []) {
        if (!next.has(rel) && !isInternalCacheFile(rel)) recorded.add(rel);
      }
      for (const rel of [...recorded]) {
        if (next.has(rel) || !(await isRegularFile(cacheDir, rel))) {
          recorded.delete(rel);
        }
      }
      peerDeletedKeys.set(key, recorded);
    }

    async function pushChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      bindNamespace(options?.namespace);
      const sidecar = loadSidecar();
      // the fast path reads only the local sidecar, so it succeeds offline and
      // never reaches an injected failure.
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "push", paths: [], deleted: [] });
        return 0;
      }
      const failure = checkReachable("push", instance);
      const priorSeq = sidecar?.commitSeq;
      const baseSeq = commitSeq;
      const overflowed = sidecar?.overflowed ?? false;
      const snapshot = new Map(committed);
      const marks = snapshotMarks(sidecar);
      const walked = walkedSidecar(sidecar, marks);
      const removed = await removeBeforePush(walked);
      const plan = await planPush(walked);
      if (failure) {
        // Uploads landed but the index was never committed: each upload's bare
        // mark leaves the bulk flag set, while a scoped push keeps only its
        // path marks.
        for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
        const keepsPathMarks = !semantics.commitClearsLaterMarks &&
          plan.scoped;
        if (plan.uploads.size > 0 && !keepsPathMarks) {
          markBulkOn(ensureSidecar(), false);
        }
        throw failure.error;
      }
      for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
      for (const rel of plan.deletes) objects.delete(rel);
      // Another machine may have committed while this push read its files.
      const upToDate = commitSeq === baseSeq;
      const deleted = publish(plan.uploads, plan.deletes);
      await settle({
        priorSeq,
        baseSeq,
        upToDate,
        scoped: plan.scoped,
        overflowed,
        marks,
      });
      await recordPushed(plan.scoped, snapshot, plan.uploads, plan.deletes);
      record({
        instance,
        op: "push",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes.filter((rel) => !committed.has(rel)),
        ...(removed.length > 0 ? { removed } : {}),
      });
      return plan.uploads.size + deleted;
    }

    async function preparePush(
      options?: DatastoreSyncOptions,
    ): Promise<InMemoryPushManifest> {
      bindNamespace(options?.namespace);
      const sidecar = loadSidecar();
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "prepare", paths: [], deleted: [] });
        return { uploads: new Map(), deletes: [] };
      }
      checkReachable("prepare", instance);
      const snapshot = new Map(committed);
      const marks = snapshotMarks(sidecar);
      const walked = walkedSidecar(sidecar, marks);
      const removed = await removeBeforePush(walked);
      const plan = await planPush(walked);
      for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
      for (const rel of plan.deletes) objects.delete(rel);
      record({
        instance,
        op: "prepare",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes,
        ...(removed.length > 0 ? { removed } : {}),
      });
      return {
        uploads: plan.uploads,
        deletes: plan.deletes,
        [PLAN_SCOPED]: plan.scoped,
        [PLAN_PRIOR_SEQ]: sidecar?.commitSeq,
        [PLAN_INDEX]: snapshot,
        [PLAN_OVERFLOWED]: sidecar?.overflowed ?? false,
        [PLAN_MARKS]: marks,
      } as InMemoryPushManifest;
    }

    async function commitPush(
      manifest: InMemoryPushManifest,
      _options?: DatastoreSyncOptions,
    ): Promise<number> {
      checkReachable("commit", instance);
      const internal = manifest as InternalManifest;
      // commit compares the cache's last-seen sequence with the remote's at
      // commit time, so a peer's commit after prepare blocks the arm.
      const baseSeq = commitSeq;
      // the cache's own index is what prepare read plus this push's changes; a
      // peer's commit since prepare is not in it.
      const index = new Map(internal[PLAN_INDEX] ?? committed);
      for (const [rel, bytes] of manifest.uploads) index.set(rel, bytes);
      for (const rel of manifest.deletes) index.delete(rel);
      const scoped = internal[PLAN_SCOPED] ?? false;
      const deleted = publish(manifest.uploads, manifest.deletes);
      await settle({
        priorSeq: internal[PLAN_PRIOR_SEQ],
        baseSeq,
        upToDate: true,
        scoped,
        overflowed: internal[PLAN_OVERFLOWED] ?? false,
        index: index.keys(),
        marks: internal[PLAN_MARKS],
      });
      await recordPushed(scoped, index, manifest.uploads, manifest.deletes);
      record({
        instance,
        op: "commit",
        paths: [...manifest.uploads.keys()],
        deleted: manifest.deletes.filter((rel) => !committed.has(rel)),
      });
      return manifest.uploads.size + deleted;
    }

    async function pullChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      bindNamespace(options?.namespace);
      checkReachable("pull", instance);
      const subdirs = options?.subdirs ?? [];
      const scoped = subdirs.length > 0;
      const sidecar = loadSidecar();
      if (sidecar?.commitSeq !== undefined && sidecar.commitSeq === commitSeq) {
        record({ instance, op: "pull", paths: [], deleted: [] });
        return 0;
      }

      const state = ensureSidecar();
      // removal runs before downloading, and a subdir-scoped pull still
      // reconciles every key.
      const peerRemoved = semantics.removesPeerDeletes && !semantics.pullDeletes
        ? await removePeerDeleted(
          syncedIndexes.get(key),
          () => true,
          state.dirtyPaths,
        )
        : [];

      const downloaded: string[] = [];
      for (const [rel, bytes] of committed) {
        if (scoped && !isInSubdirs(rel, subdirs)) continue;
        const local = await readLocal(cacheDir, rel);
        if (sameBytes(bytes, local)) continue;
        const path = join(cacheDir, ...rel.split("/"));
        await Deno.mkdir(dirname(path), { recursive: true });
        await Deno.writeFile(path, bytes);
        downloaded.push(rel);
      }

      const removed: string[] = [];
      if (semantics.pullDeletes) {
        for (const rel of state.pulledKeys) {
          if (committed.has(rel)) continue;
          if (scoped && !isInSubdirs(rel, subdirs)) continue;
          if (state.dirtyPaths.has(rel)) continue;
          try {
            await Deno.remove(join(cacheDir, ...rel.split("/")));
            removed.push(rel);
          } catch (error) {
            if (!(error instanceof Deno.errors.NotFound)) throw error;
          }
        }
      }

      for (const rel of [...state.pulledKeys]) {
        if (!scoped || isInSubdirs(rel, subdirs)) state.pulledKeys.delete(rel);
      }
      for (const rel of committed.keys()) {
        if (!scoped || isInSubdirs(rel, subdirs)) state.pulledKeys.add(rel);
      }
      // a subdir-scoped pull saves the whole index too; one snapshot feeds
      // both, so a peer's delete during the record's awaits is not lost.
      const next = new Map(committed);
      await recordPeerDeleted(next);
      syncedIndexes.set(key, next);
      if (!scoped) {
        if (semantics.pullClearsPendingPush) state.localDirty = false;
        state.commitSeq = commitSeq;
      }

      record({
        instance,
        op: "pull",
        paths: downloaded,
        deleted: [...removed, ...peerRemoved],
      });
      // like the extensions, a pull leaves peer removals out of its count.
      return downloaded.length + removed.length;
    }

    function markDirty(options?: DatastoreSyncOptions): Promise<void> {
      const relPath = options?.relPath;
      const sidecar = ensureSidecar();
      const markBulk = (overflow: boolean) => markBulkOn(sidecar, overflow);
      const tracksGenerations = !semantics.commitClearsLaterMarks;

      if (relPath) {
        record({ instance, op: "markDirty", paths: [relPath], deleted: [] });
        if (sidecar.bulk) {
          // The path is not recorded, so the bulk flag carries the mark: a
          // push that snapshotted the flag before this keeps it set.
          if (tracksGenerations) sidecar.bulkGen = ++sidecar.markSeq;
          return Promise.resolve();
        }
        const rel = toCacheRelative(relPath);
        if (rel === undefined) {
          markBulk(false);
          return Promise.resolve();
        }
        if (sidecar.dirtyPaths.has(rel)) {
          if (tracksGenerations) sidecar.pathGens.set(rel, ++sidecar.markSeq);
          return Promise.resolve();
        }
        if (sidecar.dirtyPaths.size >= dirtyPathsCap) {
          markBulk(true);
          return Promise.resolve();
        }
        sidecar.dirtyPaths.add(rel);
        sidecar.pathGens.set(rel, ++sidecar.markSeq);
        sidecar.localDirty = true;
        return Promise.resolve();
      }

      record({
        instance,
        op: "markDirty",
        paths: [],
        deleted: [],
        bulk: true,
      });
      markBulk(false);
      return Promise.resolve();
    }

    // models the clearDirty contract; synchronous, so every mark it sees was
    // made before the call.
    function clearDirty(relPaths: readonly string[]): Promise<void> {
      record({
        instance,
        op: "clearDirty",
        paths: [...relPaths].sort(),
        deleted: [],
      });
      const sidecar = loadSidecar();
      if (sidecar === undefined) return Promise.resolve();
      for (const relPath of relPaths) {
        const rel = toCacheRelative(relPath);
        if (rel === undefined) continue;
        sidecar.dirtyPaths.delete(rel);
        sidecar.pathGens.delete(rel);
      }
      sidecar.localDirty = sidecar.bulk || sidecar.dirtyPaths.size > 0;
      return Promise.resolve();
    }

    function fetchContent(
      relPath: string,
      _options?: DatastoreSyncOptions,
    ): Promise<Uint8Array | null> {
      try {
        const rel = toCacheRelative(relPath);
        if (rel === undefined || couldLeaveDatastore(relPath)) {
          throw new Error(`Path traversal rejected: ${relPath}`);
        }
        checkReachable("fetch", instance);
        record({ instance, op: "fetch", paths: [rel], deleted: [] });
        const bytes = committed.get(rel);
        // A copy, so a caller that changes it does not change the remote.
        return Promise.resolve(bytes ? bytes.slice() : null);
      } catch (error) {
        return Promise.reject(error);
      }
    }

    /**
     * models repairUnpushedFiles: the fake compares bytes, so `exact` changes
     * nothing and `unknown` is always 0; its index is never sharded, so created
     * files commit in one batch.
     */
    async function repairUnpushedFiles(
      options?: RepairUnpushedFilesOptions,
    ): Promise<UnpushedFilesSummary> {
      const dryRun = options?.dryRun ?? false;
      bindNamespace(options?.namespace);
      checkReachable("repair", instance);
      if (monolithIndex) {
        throw new Error(
          "The remote index is a v1 monolith. Run `swamp datastore sync " +
            "--pull` and then `swamp datastore migrate-index` first.",
        );
      }
      const synced = syncedIndexes.get(key);
      if (!synced) {
        throw new Error(
          "This cache has no last-synced index, so unpushed files cannot " +
            "be told apart from files a peer deleted. Pull first.",
        );
      }
      if (!dryRun && !conditionalCreate) {
        throw new Error(
          "The remote does not support create-only writes, so unpushed " +
            "files cannot be uploaded without risking a peer's object.",
        );
      }
      const inScope = (rel: string) => !namespace || isUnder(rel, namespace);

      const peerDeletedHere = peerDeletedKeys.get(key) ?? new Set<string>();
      const unpushed: Array<[string, Uint8Array]> = [];
      const alreadyPresent: string[] = [];
      const modified: string[] = [];
      const peerDeleted: string[] = [];
      for (const rel of filesOf(await walkLocalEntries(cacheDir, ""))) {
        if (!inScope(rel)) continue;
        const bytes = await readLocal(cacheDir, rel);
        if (!bytes) continue;
        const syncedBytes = synced.get(rel);
        if (syncedBytes) {
          if (!sameBytes(bytes, syncedBytes)) modified.push(rel);
          continue;
        }
        if (committed.has(rel)) {
          if (!sameBytes(bytes, committed.get(rel))) alreadyPresent.push(rel);
          continue;
        }
        if (peerDeletedHere.has(rel)) {
          peerDeleted.push(rel);
          continue;
        }
        // An unindexed object with these bytes is an upload of ours whose
        // commit never ran; one with other bytes is a peer's.
        const object = objects.get(rel);
        if (object && !sameBytes(bytes, object)) {
          alreadyPresent.push(rel);
        } else {
          unpushed.push([rel, bytes]);
        }
      }
      let remoteMovedOn = 0;
      for (const [rel, bytes] of synced) {
        if (!inScope(rel) || isInternalCacheFile(rel)) continue;
        const remote = committed.get(rel);
        if (remote && !sameBytes(remote, bytes)) remoteMovedOn++;
      }

      const created = new Map<string, Uint8Array>();
      const refused = new Set<string>();
      if (!dryRun) {
        for (const [rel, bytes] of unpushed) {
          // A peer may have committed or stored the key while the walk
          // read files: the create is refused, and other bytes are
          // alreadyPresent.
          const current = committed.get(rel) ?? objects.get(rel);
          if (current && !sameBytes(bytes, current)) {
            alreadyPresent.push(rel);
            refused.add(rel);
            continue;
          }
          if (!objects.has(rel)) objects.set(rel, bytes);
          created.set(rel, bytes);
        }
        // Commits the entries and leaves the sidecar alone: the dirty state
        // and the commit sequence this cache last saw are not touched.
        publish(created, []);
        for (const [rel, bytes] of created) synced.set(rel, bytes);
        record({
          instance,
          op: "repair",
          paths: [...created.keys()],
          deleted: [],
        });
      }
      const remaining = unpushed.map(([rel]) => rel).filter((rel) =>
        !created.has(rel) && !refused.has(rel)
      );
      const sample = (paths: string[]) => paths.sort().slice(0, SAMPLE_LIMIT);
      return {
        unpushed: remaining.length,
        samplePaths: sample(remaining),
        alreadyPresent: alreadyPresent.length,
        sampleAlreadyPresent: sample(alreadyPresent),
        locallyModified: modified.length,
        sampleModified: sample(modified),
        unknown: 0,
        sampleUnknown: [],
        peerDeleted: peerDeleted.length,
        samplePeerDeleted: sample(peerDeleted),
        remoteMovedOn,
        uploaded: created.size,
        pendingChanges: loadSidecar()?.localDirty ?? false,
      };
    }

    /**
     * The extensions' store: a service that has not bound a namespace binds
     * none on its first call, so its keys are datastore-wide from then on.
     */
    function controlPlaneStore(): ControlPlaneStore {
      const reach = (): void => {
        if (!namespaceBound) bindNamespace(undefined);
        checkReachable("controlPlane", instance);
      };
      const written = (fullKey: string): void =>
        record({
          instance,
          op: "controlPlane",
          paths: [fullKey],
          deleted: [],
        });
      return {
        get(key, readOptions) {
          try {
            // An unbound service reads datastore-wide, so the key is the
            // same before and after reach() binds it.
            reads.push({ instance, key: controlKey(namespace, key) });
            readOptions?.signal?.throwIfAborted();
            reach();
            const bytes = controlRecords.get(controlKey(namespace, key));
            return Promise.resolve(bytes ? bytes.slice() : null);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        put(key, data) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            controlRecords.set(fullKey, data.slice());
            written(fullKey);
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        },
        putIfAbsent(key, data) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            if (controlRecords.has(fullKey)) return Promise.resolve(false);
            controlRecords.set(fullKey, data.slice());
            written(fullKey);
            return Promise.resolve(true);
          } catch (error) {
            return Promise.reject(error);
          }
        },
        delete(key) {
          try {
            reach();
            const fullKey = controlKey(namespace, key);
            controlRecords.delete(fullKey);
            record({
              instance,
              op: "controlPlane",
              paths: [],
              deleted: [fullKey],
            });
            return Promise.resolve();
          } catch (error) {
            return Promise.reject(error);
          }
        },
        list(prefix) {
          try {
            reach();
            const base = controlKey(namespace, "");
            return Promise.resolve(
              [...controlRecords.keys()]
                .filter((k) => k.startsWith(base + prefix))
                .map((k) => k.slice(base.length))
                .sort(),
            );
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
    }

    return {
      pullChanged,
      pushChanged,
      markDirty,
      preparePush,
      commitPush,
      capabilities: () => ({ ...capabilities }),
      ...(connectOptions?.fetchContent === false ? {} : { fetchContent }),
      ...(connectOptions?.clearDirty === false ? {} : { clearDirty }),
      ...(connectOptions?.repairUnpushedFiles === false
        ? {}
        : { repairUnpushedFiles }),
      ...(controlPlane ? { controlPlaneStore } : {}),
    };
  }

  function datastoreControlPlaneStore(): WritableDatastoreControlPlaneStore {
    const instance = "datastore";
    const reach = (): void => {
      checkReachable("controlPlane", instance);
    };
    return {
      get(key, readOptions) {
        try {
          const fullKey = controlKey(undefined, key);
          reads.push({ instance, key: fullKey });
          readOptions?.signal?.throwIfAborted();
          reach();
          const bytes = controlRecords.get(fullKey);
          return Promise.resolve(bytes ? bytes.slice() : null);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      put(key, data) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          controlRecords.set(fullKey, data.slice());
          record({
            instance,
            op: "controlPlane",
            paths: [fullKey],
            deleted: [],
          });
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      putIfAbsent(key, data) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          if (controlRecords.has(fullKey)) return Promise.resolve(false);
          controlRecords.set(fullKey, data.slice());
          record({
            instance,
            op: "controlPlane",
            paths: [fullKey],
            deleted: [],
          });
          return Promise.resolve(true);
        } catch (error) {
          return Promise.reject(error);
        }
      },
      delete(key) {
        try {
          reach();
          const fullKey = controlKey(undefined, key);
          controlRecords.delete(fullKey);
          record({
            instance,
            op: "controlPlane",
            paths: [],
            deleted: [fullKey],
          });
          return Promise.resolve();
        } catch (error) {
          return Promise.reject(error);
        }
      },
      list(prefix) {
        try {
          reach();
          const base = controlKey(undefined, "");
          return Promise.resolve(
            [...controlRecords.keys()]
              .filter((k) => k.startsWith(base + prefix))
              .map((k) => k.slice(base.length))
              .sort(),
          );
        } catch (error) {
          return Promise.reject(error);
        }
      },
    };
  }

  function replicaPathStore(
    replicaObjects: Map<string, Uint8Array>,
  ): ReplicaPathStore {
    const settle = <T>(fn: () => T): Promise<T> =>
      new Promise((resolve) => resolve(fn()));
    return {
      list: (signal) =>
        settle(() => {
          checkReachable("replicaPaths", "datastore");
          signal.throwIfAborted();
          const fences = new Set<string>();
          for (const key of replicaObjects.keys()) {
            const rest = key.slice(REPLICA_ROOT.length);
            const slash = rest.indexOf("/");
            if (slash > 0) fences.add(rest.slice(0, slash));
          }
          return [...fences];
        }),
      removePath: (fence, signal) =>
        settle(() => {
          checkReachable("replicaPaths", "datastore");
          const problem = replicaPathFenceProblem(fence);
          if (problem !== undefined) {
            throw new Error(`Refusing to remove a replica path: ${problem}`);
          }
          const dir = `${REPLICA_ROOT}${fence}/`;
          for (;;) {
            signal.throwIfAborted();
            const page = [...replicaObjects.keys()]
              .filter((key) => key.startsWith(dir))
              .slice(0, REPLICA_PAGE_SIZE);
            if (page.length === 0) return;
            for (const key of page) replicaObjects.delete(key);
          }
        }),
    };
  }

  return {
    connect,
    files: () => new Map(committed),
    storeObject(key, bytes) {
      objects.set(key, bytes.slice());
    },
    failNext(op, error, failOptions) {
      failures.push({
        op,
        error: error ?? new Error(`injected ${op} failure`),
        afterUploads: failOptions?.afterUploads ?? false,
        instance: failOptions?.instance,
      });
    },
    offline(value) {
      isOffline = value;
    },
    seedControlPlane(key, data, seedOptions) {
      if (!controlPlane) {
        throw new Error("seedControlPlane needs the controlPlane option");
      }
      controlRecords.set(controlKey(seedOptions?.namespace, key), data.slice());
    },
    controlPlaneRecords: () =>
      new Map([...controlRecords].map(([k, v]) => [k, v.slice()])),
    ...(controlPlane ? { datastoreControlPlaneStore } : {}),
    ...(chunkStorage
      ? {
        storage: chunkStorage.storage,
        setChunkLastModified: chunkStorage.setChunkLastModified,
      }
      : {}),
    ...(replicaTarget !== undefined
      ? { replicaTarget: () => replicaTarget }
      : {}),
    ...(replicaObjects !== undefined
      ? {
        replicaPaths: () => replicaPathStore(replicaObjects),
        putReplicaObject(key: string, bytes: Uint8Array) {
          if (!key.startsWith(REPLICA_ROOT)) {
            throw new Error(
              `a replica object is under ${REPLICA_ROOT}: ${key}`,
            );
          }
          replicaObjects.set(key, bytes.slice());
        },
        deleteReplicaObject(key: string) {
          replicaObjects.delete(key);
        },
      }
      : {}),
    objectExists: (key) =>
      Promise.resolve(
        committed.has(key) || controlRecords.has(key) ||
          (chunkStorage?.hasObject(key) ?? false) ||
          (replicaObjects?.has(key) ?? false),
      ),
    connections: () => instanceCount,
    controlPlaneReads: () => reads.map((read) => ({ ...read })),
    ops: () =>
      log.map((entry) => ({
        ...entry,
        paths: [...entry.paths],
        deleted: [...entry.deleted],
      })),
    resetSidecar(cacheDir) {
      sidecars.delete(sidecarKey(cacheDir));
    },
    async pendingPush(cacheDir) {
      const sidecar = sidecars.get(sidecarKey(cacheDir));
      const marked = [...(sidecar?.dirtyPaths ?? [])].sort();
      const bulk = sidecar?.bulk ?? false;
      if (sidecar && !sidecar.localDirty) {
        return { uploads: [], deletes: [], marked, bulk };
      }
      const plan = await planPushFor(cacheDir, sidecar);
      // The push removes these copies before it walks, so never sends them.
      const removable = new Set(
        semantics.removesPeerDeletes
          ? await removableCopies(
            cacheDir,
            syncedIndexes.get(sidecarKey(cacheDir)),
            pushScope(sidecar),
            sidecar?.dirtyPaths ?? new Set(),
          )
          : [],
      );
      return {
        uploads: [...plan.uploads.keys()].filter((rel) => !removable.has(rel))
          .sort(),
        deletes: plan.deletes,
        marked,
        bulk,
      };
    },
  };
}

const SAMPLE_LIMIT = 20;

const REPLICA_ROOT = "_litestream/";

const REPLICA_PAGE_SIZE = 2;

function createChunkStorage():
  & Required<Pick<InMemoryRemote, "storage" | "setChunkLastModified">>
  & {
    hasObject(objectKey: string): boolean;
  } {
  const chunks = new Map<string, { bytes: Uint8Array; lastModified: Date }>();
  const key = (namespace: string, sha256: string) => `${namespace}/${sha256}`;
  const settle = <T>(fn: () => T): Promise<T> =>
    new Promise((resolve) => resolve(fn()));
  const storage: DatastoreStorage = {
    contract: "storage/1",
    capabilities: () => ({ maxChunkBytes: 16 * 1024 * 1024, touch: true }),
    has: (namespace, hashes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        return new Set(hashes.filter((h) => chunks.has(key(namespace, h))));
      }),
    put: (namespace, sha256, bytes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        chunks.set(key(namespace, sha256), {
          bytes: bytes.slice(),
          lastModified: new Date(),
        });
      }),
    get: (namespace, sha256, signal) =>
      settle(() => {
        signal.throwIfAborted();
        return chunks.get(key(namespace, sha256))?.bytes.slice() ?? null;
      }),
    touch: (namespace, hashes, signal) =>
      settle(() => {
        signal.throwIfAborted();
        const missing = new Set<string>();
        for (const sha256 of hashes) {
          const chunk = chunks.get(key(namespace, sha256));
          if (chunk === undefined) missing.add(sha256);
          else chunk.lastModified = new Date();
        }
        return missing;
      }),
    async *list(namespace, signal): AsyncIterable<StoredChunk> {
      signal.throwIfAborted();
      for (const [k, chunk] of [...chunks]) {
        if (k.startsWith(`${namespace}/`)) {
          yield {
            sha256: k.slice(namespace.length + 1),
            lastModified: new Date(chunk.lastModified),
          };
        }
      }
    },
    delete: (namespace, sha256, signal) =>
      settle(() => {
        signal.throwIfAborted();
        chunks.delete(key(namespace, sha256));
      }),
  };
  return {
    storage: () => storage,
    hasObject(objectKey) {
      const match = /^_blobs\/(.+)\/sha256\/([0-9a-f]{2})\/([0-9a-f]{64})$/
        .exec(objectKey);
      return match !== null && match[3].startsWith(match[2]) &&
        chunks.has(key(match[1], match[3]));
    },
    setChunkLastModified: (namespace, sha256, date) =>
      settle(() => {
        const chunk = chunks.get(key(namespace, sha256));
        if (chunk === undefined) {
          throw new Error(`No chunk ${key(namespace, sha256)}`);
        }
        chunk.lastModified = new Date(date);
      }),
  };
}
