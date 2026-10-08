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
 * An in-memory remote datastore for testing sync behaviour across several
 * simulated machines.
 *
 * Its default behaviour reproduces what `@swamp/s3-datastore` and
 * `@swamp/gcs-datastore` 2026.10.06.1 through 2026.10.07.1 do, quirks
 * included, so a test that passes against this fake cannot lose data that
 * production would keep. Each pinned behaviour was checked against
 * swamp-extensions @ 7c0b1eacf; `S3SYNC` below is
 * `datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts`, and the GCS
 * equivalent behaves the same.
 *
 * - A path mark records a cache-relative path. A bare mark, an empty path or
 *   a path that climbs out of the cache with `..` sets the bulk flag. An
 *   absolute path is nested under the cache, as `join(cachePath, relPath)`
 *   does, so its real file is never pushed; once bulk is set, later
 *   path marks are not recorded (S3SYNC:1757-1817). Past `dirtyPathsCap`
 *   paths the set overflows into bulk (S3SYNC:1799-1806). The extensions
 *   also mark a clean sidecar dirty again for a path it still lists
 *   (S3SYNC:1765-1772, 1794-1798). Only a pull under
 *   {@link LEGACY_EXTENSION_SEMANTICS} leaves a sidecar clean with paths
 *   listed, and those releases keep it clean, so that is not modelled.
 * - Dirty state lives in a per-cache "sidecar" that survives reconnects, like
 *   `.datastore-sync-state.json`. A push with a clean sidecar returns 0
 *   without walking, so a write that was never marked is never pushed
 *   (S3SYNC:1945-1954). A cache with no sidecar yet pushes with a full walk
 *   that deletes nothing.
 * - A scoped push uploads each marked file that differs, walks each marked
 *   directory deleting remote entries under it that are gone locally, and
 *   deletes the remote key (and `key/`) of a marked path that is absent
 *   (S3SYNC:3134-3205). A mark of `.` becomes the cache root: its walk
 *   uploads everything but deletes nothing, because the delete prefix is
 *   `/` (S3SYNC:3168-3171). A bulk push uploads everything and deletes nothing
 *   unless the set overflowed (S3SYNC:3206-3276).
 * - Uploads go through `pushFile`, which sets the bulk flag
 *   (S3SYNC:2911). A push that fails after its uploads therefore leaves bulk
 *   set, and the next push loses the recorded deletes.
 * - Dirty state is cleared only when a push succeeds (S3SYNC:3398-3427). A
 *   pull keeps it, so a write whose push failed is sent by the next push
 *   (S3SYNC:1843-1877, 2792-2796, 2826-2851).
 * - A pull downloads committed entries that are new or differ and
 *   overwrites local files even if they are dirty (S3SYNC:2616-2690). An
 *   unchanged remote takes the fast path and touches nothing
 *   (S3SYNC:1884-1896).
 * - A pull, push or `preparePush` that read the remote removes the local
 *   copy of each file a peer deleted since this cache last synced, before
 *   it downloads or walks (S3SYNC:2537-2543, 3103-3109, 3635-3641). A copy
 *   that is marked or changed since that sync is kept, and so is every copy
 *   when no committed key is in scope; directories the removal empties go
 *   too, up to the top-level one (S3SYNC:4197-4324). What the cache last
 *   synced is the whole remote after a pull (a subdir-scoped one included)
 *   or after a full push or commit, and a scoped push only adds its own
 *   changes to it (S3SYNC:2289-2344). A scoped push reconciles only the
 *   index shards its marks read (S3SYNC:1548-1610, 4174-4182,
 *   4436-4468). The fast paths and `commitPush` remove nothing. A pull
 *   leaves removals out of its count (S3SYNC:2875), though the
 *   `pullChanged` contract asks for them.
 * - `preparePush` uploads and deletes content at once but publishes nothing
 *   other machines can pull, and keeps dirty state; `commitPush` publishes
 *   the index and clears dirty state, including marks made in between
 *   (S3SYNC:3517-4089). After an unscoped prepare, commit checks
 *   completeness against the index it read at prepare plus its own changes,
 *   so a peer's commit in between is skipped by the next pull
 *   (S3SYNC:4015-4026, 4333-4361).
 * - Internal cache files are never pushed or pulled (S3SYNC:116-128). `.log`
 *   files are synced.
 * - A service takes its namespace from the first `pullChanged`, `pushChanged`
 *   or `preparePush` it runs, before it reaches the remote, so one that fails
 *   still binds it. A later one of those with a different namespace rejects
 *   (S3SYNC:668-686). A service is therefore one repository's, for its whole
 *   life. Unlike the extensions, which tell an empty namespace from an unset
 *   one, the fake treats both as no namespace, as the `fetchContent` contract
 *   does.
 *
 * Earlier releases are available through {@link InMemoryRemoteSemantics}:
 * {@link EXTENSION_2026_10_01_SEMANTICS} removes nothing, and
 * {@link LEGACY_EXTENSION_SEMANTICS} (2026.09.24.1 and earlier) also makes
 * an unscoped pull of a moved remote mark the sidecar clean, dropping a
 * pending push, and a later mark of a path it still lists leave it clean.
 * The same type switches behaviours that later phases are expected to
 * change.
 *
 * Experimental: the defaults track the current extension releases and will
 * change with them and during the datastore rework.
 *
 * `fetchContent` returns the committed bytes of one key and touches neither
 * the cache nor the sidecar. It takes the key as given, so a cache-relative
 * path that starts with a namespace reads that key, and it rejects a path
 * that is absolute or has a `..` segment.
 *
 * No method looks at `options.signal`, so a test of cancellation needs a
 * service of its own.
 *
 * The control plane is modelled only when `controlPlane` is set: records
 * live under `_control/<key>`, or `<namespace>/_control/<key>` once the
 * service has bound a namespace, and a service that has not pulled or pushed
 * binds no namespace on its first control-plane call, as the S3 and GCS
 * extensions do (swamp-club#3189). Its writes are recorded as `controlPlane`
 * ops; its reads are not, and are listed by `controlPlaneReads` instead.
 * `datastoreControlPlaneStore` stands in for a provider's datastore-wide
 * store. A control-plane `get` given an already aborted signal rejects with
 * its reason; nothing else in the control plane can be in flight.
 *
 * Not modelled: namespace prefixes (a namespaced path is a plain key and a
 * push is never limited to one), lazy hydration (`hydrateFile`),
 * `previewPush`, model-scoped pulls through `context`, and Windows
 * drive-letter joins. Nor is the window between `preparePush` and
 * `commitPush` in which the extensions have already deleted objects but not
 * yet the index entries, so a peer pulling then drops those entries without
 * downloading them; here a peer still sees the old content until commit.
 * The remote index is always read whole and fresh, so the extensions'
 * TTL-cached and fallback index reads, which remove nothing, and an index
 * entry whose object is missing are not modelled either. The fake
 * compares file bytes, whereas the backends compare size and mtime before
 * hashing (S3SYNC:4373-4415) and can skip a same-size, same-mtime rewrite;
 * deciding whether a copy is unchanged, they compare size and sha256, or
 * the recorded mtime for an entry without a hash.
 *
 * @module
 */

import { dirname, join, normalize } from "@std/path";
import type {
  ControlPlaneStore,
  DatastoreControlPlaneStore,
  DatastoreSyncOptions,
  DatastoreSyncService,
  SyncCapabilities,
} from "./datastore_types.ts";

/**
 * The behaviours that differ between extension releases, or that a later
 * datastore phase is expected to change.
 */
export interface InMemoryRemoteSemantics {
  /**
   * A pull deletes local files the remote dropped since the last pull,
   * unless they are marked, and counts them in its result. No released
   * extension does this. When set, it decides what a pull removes and
   * {@link removesPeerDeletes} applies to pushes only.
   */
  pullDeletes: boolean;
  /** A bulk mark makes the next push a full walk that deletes nothing. */
  bulkDisablesDeletes: boolean;
  /**
   * An unscoped pull of a moved remote marks the cache clean, so a pending
   * push is dropped. Marks stay listed, and marking a listed path again
   * does not mark the cache dirty.
   */
  pullClearsPendingPush: boolean;
  /**
   * A pull, push or `preparePush` that read the remote first removes the
   * local copy of each file a peer deleted since this cache last synced,
   * when that copy is unchanged and unmarked. A pull does not count the
   * removals in its result. When {@link pullDeletes} is also set, it
   * decides what a pull removes instead.
   */
  removesPeerDeletes: boolean;
}

/**
 * What `@swamp/s3-datastore` and `@swamp/gcs-datastore` do from
 * 2026.10.06.1, checked through 2026.10.07.1 (swamp-extensions
 * @ 7c0b1eacf). The default.
 */
export const EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> = Object
  .freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: false,
    removesPeerDeletes: true,
  });

/**
 * What the extensions do in 2026.10.01.1: a pull keeps a pending push
 * (swamp-club#2888) but never removes local files.
 */
export const EXTENSION_2026_10_01_SEMANTICS: Readonly<
  InMemoryRemoteSemantics
> = Object.freeze({
  pullDeletes: false,
  bulkDisablesDeletes: true,
  pullClearsPendingPush: false,
  removesPeerDeletes: false,
});

/**
 * What the extensions do in 2026.09.24.1 and earlier (swamp-extensions
 * @ 5368cb002): a pull of a moved remote drops a pending push, and never
 * removes local files.
 */
export const LEGACY_EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> =
  Object.freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: true,
    removesPeerDeletes: false,
  });

/** Options for {@link createInMemoryRemote}. */
export interface InMemoryRemoteOptions {
  /** Overrides for {@link EXTENSION_SEMANTICS}. */
  semantics?: Partial<InMemoryRemoteSemantics>;
  /** Marked paths kept before the set overflows into bulk. Default 2000. */
  dirtyPathsCap?: number;
  /** What every connected service advertises. Default `{ twoPhaseSync: true }`. */
  capabilities?: SyncCapabilities;
  /**
   * Gives every connected service a `controlPlaneStore()` and adds
   * `controlPlane: true` to its capabilities. Default false.
   */
  controlPlane?: boolean;
}

/** A remote operation a failure can be injected into. */
export type InMemoryRemoteFailure =
  | "push"
  | "pull"
  | "prepare"
  | "commit"
  | "fetch"
  | "controlPlane";

/** Options for {@link InMemoryRemote.failNext}. */
export interface FailNextOptions {
  /**
   * Fail a push after its uploads land, as a mid-push network error would.
   * Other operations fail before doing anything either way.
   */
  afterUploads?: boolean;
  /** Only fail an operation from this instance. */
  instance?: string;
}

/** One recorded sync operation. */
export interface InMemoryRemoteOpRecord {
  /** The instance name given to `connect`. */
  instance: string;
  op:
    | "markDirty"
    | "push"
    | "pull"
    | "prepare"
    | "commit"
    | "fetch"
    | "controlPlane";
  /** Paths marked, uploaded, downloaded or fetched, sorted. */
  paths: string[];
  /** Paths deleted remotely (push) or locally (pull), sorted. */
  deleted: string[];
  /**
   * Local copies a push or prepare removed because a peer deleted them,
   * sorted. Present only when there were some.
   */
  removed?: string[];
  /** Set on a bare `markDirty`. */
  bulk?: boolean;
}

/** One control-plane read, listed by {@link InMemoryRemote.controlPlaneReads}. */
export interface InMemoryControlPlaneRead {
  /** The instance name given to `connect`. */
  instance: string;
  /** The full remote key read, `_control/<key>` or `<namespace>/_control/<key>`. */
  key: string;
}

/** The manifest `preparePush` hands to `commitPush`. */
export interface InMemoryPushManifest {
  readonly uploads: ReadonlyMap<string, Uint8Array>;
  readonly deletes: readonly string[];
}

/** A sync service bound to one cache directory, with two-phase push. */
export interface InMemorySyncService extends DatastoreSyncService {
  preparePush(options?: DatastoreSyncOptions): Promise<InMemoryPushManifest>;
  commitPush(
    manifest: InMemoryPushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
}

/** Options for {@link InMemoryRemote.connect}. */
export interface ConnectOptions {
  /** Name recorded in the op log. Default `instance-<n>`. */
  instance?: string;
  /**
   * Whether the service has `fetchContent`. Default true; false leaves the
   * method out, as an extension that does not implement it would.
   */
  fetchContent?: boolean;
}

/** A remote datastore shared by any number of simulated machines. */
export interface InMemoryRemote {
  /** Binds a sync service to a cache directory, one per simulated machine. */
  connect(cacheDir: string, options?: ConnectOptions): InMemorySyncService;
  /** The committed content other machines can pull. */
  files(): ReadonlyMap<string, Uint8Array>;
  /** Fails the next matching operation with `error`. */
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
  /** Every control-plane record, keyed by its full remote key. */
  controlPlaneRecords(): ReadonlyMap<string, Uint8Array>;
  /** Every recorded operation, in order. */
  ops(): readonly InMemoryRemoteOpRecord[];
  /**
   * A provider's datastore-wide store: `get` reads `_control/<key>`
   * whatever namespace any service has bound, binds nothing, and is listed
   * as instance `"datastore"` by `controlPlaneReads`. Needs `controlPlane`.
   */
  datastoreControlPlaneStore(): DatastoreControlPlaneStore;
  /** How many sync services `connect` has built. */
  connections(): number;
  /**
   * Every control-plane `get`, in order, including one that failed. Reads
   * change nothing, so they are not ops.
   */
  controlPlaneReads(): readonly InMemoryControlPlaneRead[];
  /** Drops a cache's persisted dirty state, like a lost sidecar file. */
  resetSidecar(cacheDir: string): void;
  /**
   * What the next push from `cacheDir` would send, read without side
   * effects: nothing is uploaded, no op is recorded, no injected failure is
   * consumed, and it works while offline.
   *
   * `uploads` are the files that differ from the committed content and
   * `deletes` the committed keys the push would remove, both sorted and
   * computed exactly as `pushChanged` would plan them now. A cache whose
   * sidecar is clean reports nothing, like the push fast path. `marked`
   * holds the recorded path marks and `bulk` whether the next push is a
   * full walk; while `bulk` is set the marks are ignored.
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

interface InternalManifest extends InMemoryPushManifest {
  [PLAN_SCOPED]?: boolean;
  [PLAN_PRIOR_SEQ]?: number;
  [PLAN_INDEX]?: ReadonlyMap<string, Uint8Array>;
  [PLAN_OVERFLOWED]?: boolean;
}

interface Sidecar {
  localDirty: boolean;
  dirtyPaths: Set<string>;
  bulk: boolean;
  overflowed: boolean;
  /** The remote commit sequence this cache last saw in full. */
  commitSeq?: number;
  /** Committed keys this cache saw at its last pull. */
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
 * Converts a mark to a forward-slash cache-relative path, or undefined when
 * it climbs out of the cache. Like the extensions' `join(cachePath, relPath)`,
 * an absolute path is nested under the cache rather than treated as escaping,
 * so the real file is never pushed.
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
 * Whether `relPath` is absolute or has a `..` segment (fetchContent rule 5).
 * A drive letter counts only before a separator, so `a:b/raw` is a name.
 */
function couldLeaveDatastore(relPath: string): boolean {
  return /^([\\/]|[A-Za-z]:[\\/])/.test(relPath) ||
    relPath.split(/[\\/]/).some((segment) => segment === "..");
}

/**
 * The index shard a cache-relative path belongs to, or undefined for a path
 * no shard holds (S3SYNC:4436-4468).
 */
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

/**
 * The shards a push of marked paths reads, as `assembleDirtyShardsOnly`
 * picks them (S3SYNC:1548-1610): each existing shard that is a mark's own,
 * an ancestor of a mark, or lies under a marked directory.
 */
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

/** Lists every non-internal file under `rel` in the cache, sorted. */
async function walkLocal(cacheDir: string, rel: string): Promise<string[]> {
  const found: string[] = [];
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
      } else if (entry.isFile && !isInternalCacheFile(child)) {
        found.push(child);
      }
    }
  };
  await visit(rel);
  return found.sort();
}

/**
 * Creates an in-memory remote datastore. Connect one sync service per
 * simulated machine; they share the remote's content.
 *
 * ```typescript
 * import { createInMemoryRemote } from "@swamp-club/swamp-testing";
 *
 * const remote = createInMemoryRemote();
 * const alice = remote.connect(aliceCache, { instance: "alice" });
 * const bob = remote.connect(bobCache, { instance: "bob" });
 * await Deno.writeTextFile(`${aliceCache}/note`, "hi");
 * await alice.markDirty({ relPath: "note" });
 * await alice.pushChanged();
 * await bob.pullChanged(); // bobCache/note now holds "hi"
 * ```
 */
export function createInMemoryRemote(
  options?: InMemoryRemoteOptions,
): InMemoryRemote {
  const semantics: InMemoryRemoteSemantics = {
    ...EXTENSION_SEMANTICS,
    ...options?.semantics,
  };
  const dirtyPathsCap = options?.dirtyPathsCap ?? 2000;
  const controlPlane = options?.controlPlane ?? false;
  const capabilities: SyncCapabilities = {
    ...(options?.capabilities ?? { twoPhaseSync: true }),
    ...(controlPlane ? { controlPlane: true } : {}),
  };
  // Control-plane records, keyed `_control/<key>` or
  // `<namespace>/_control/<key>` as the extensions store them.
  const controlRecords = new Map<string, Uint8Array>();
  const controlKey = (namespace: string | undefined, key: string) =>
    namespace ? `${namespace}/_control/${key}` : `_control/${key}`;

  // Stored objects, written at once by prepare and push.
  const objects = new Map<string, Uint8Array>();
  // The published index: what other machines see when they pull.
  const committed = new Map<string, Uint8Array>();
  let commitSeq = 0;
  const sidecars = new Map<string, Sidecar>();
  // The committed bytes of each key as a cache last synced them. Stands in
  // for the extensions' on-disk `.datastore-index.json`, which is written
  // when they write it and, unlike the sidecar, `resetSidecar` keeps.
  const syncedIndexes = new Map<string, Map<string, Uint8Array>>();
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

  /**
   * The keys a push reconciles against what the cache last synced: every
   * key after a full index read, or only those in the shards a push of
   * marked paths reads (S3SYNC:4174-4182).
   */
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

  /**
   * The local copies of files in `prior` that the remote no longer holds
   * and that are in scope, unmarked and unchanged since that sync, read
   * only. None without a prior sync, or when no committed key is in scope
   * (S3SYNC:4197-4301).
   */
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

  /** Plans the push from `cacheDir` as `pushChanged` would, reading only. */
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
          const local = await walkLocal(cacheDir, rel);
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

    // Full walk: a bulk mark, an empty set, or no sidecar yet.
    const local = await walkLocal(cacheDir, "");
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
          pulledKeys: new Set(),
        };
        sidecars.set(key, sidecar);
      }
      return sidecar;
    };

    const planPush = (sidecar: Sidecar | undefined): Promise<PushPlan> =>
      planPushFor(cacheDir, sidecar);

    /** Whether every key in `index` (default: the live remote) is local. */
    async function hasAll(index: Iterable<string>): Promise<boolean> {
      for (const remoteKey of index) {
        if (!(await statLocal(cacheDir, remoteKey))) return false;
      }
      return true;
    }

    /**
     * Marks the cache clean after a successful push, and arms the pull fast
     * path only when nothing else landed since `baseSeq` and this cache is
     * known to hold everything (S3SYNC:3398-3427, 4049-4062).
     */
    async function settle(arm: {
      priorSeq: number | undefined;
      baseSeq: number;
      upToDate: boolean;
      scoped: boolean;
      overflowed: boolean;
      /** The index this cache holds; defaults to the live remote. */
      index?: Iterable<string>;
    }): Promise<void> {
      const sidecar = ensureSidecar();
      sidecar.dirtyPaths.clear();
      sidecar.bulk = false;
      sidecar.overflowed = false;
      sidecar.localDirty = false;
      const reconciled = (arm.scoped || arm.overflowed) &&
        arm.priorSeq === arm.baseSeq;
      const armed = arm.upToDate &&
        (reconciled ||
          (!arm.scoped && await hasAll(arm.index ?? committed.keys())));
      sidecar.commitSeq = armed ? commitSeq : undefined;
    }

    /**
     * Removes the copies {@link removableCopies} finds, then the
     * directories that leaves empty below the top level (S3SYNC:4310-4324).
     */
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

    /**
     * The removal a push or prepare runs after reading the remote, before
     * it walks the cache (S3SYNC:3103-3109, 3635-3641).
     */
    function removeBeforePush(sidecar: Sidecar | undefined): Promise<string[]> {
      if (!semantics.removesPeerDeletes) return Promise.resolve([]);
      return removePeerDeleted(
        syncedIndexes.get(key),
        pushScope(sidecar),
        sidecar?.dirtyPaths ?? new Set(),
      );
    }

    /**
     * Records what a committed push leaves this cache synced to, as
     * `writeLocalIndexAfterPush` writes the local index (S3SYNC:2289-2344):
     * the index it read plus its changes, or, for a push of marked paths,
     * only its changes merged into the last record.
     */
    function recordPushed(
      scoped: boolean,
      index: ReadonlyMap<string, Uint8Array>,
      uploads: ReadonlyMap<string, Uint8Array>,
      deletes: readonly string[],
    ): void {
      if (!scoped) {
        const next = new Map(index);
        for (const [rel, bytes] of uploads) next.set(rel, bytes);
        for (const rel of deletes) next.delete(rel);
        syncedIndexes.set(key, next);
        return;
      }
      const synced = syncedIndexes.get(key);
      if (!synced) return;
      for (const [rel, bytes] of uploads) synced.set(rel, bytes);
      for (const rel of deletes) synced.delete(rel);
    }

    async function pushChanged(
      options?: DatastoreSyncOptions,
    ): Promise<number> {
      bindNamespace(options?.namespace);
      const sidecar = loadSidecar();
      // The fast path reads only the local sidecar, so it succeeds offline
      // and never reaches an injected failure (S3SYNC:1945-1954).
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "push", paths: [], deleted: [] });
        return 0;
      }
      const failure = checkReachable("push", instance);
      const priorSeq = sidecar?.commitSeq;
      const baseSeq = commitSeq;
      const overflowed = sidecar?.overflowed ?? false;
      const snapshot = new Map(committed);
      const removed = await removeBeforePush(sidecar);
      const plan = await planPush(sidecar);
      if (failure) {
        // Uploads landed as objects but the index was never committed, and
        // each upload's bare mark leaves the bulk flag set (S3SYNC:2911).
        for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
        if (plan.uploads.size > 0) {
          const dirty = ensureSidecar();
          dirty.bulk = true;
          dirty.localDirty = true;
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
      });
      recordPushed(plan.scoped, snapshot, plan.uploads, plan.deletes);
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
      const removed = await removeBeforePush(sidecar);
      const plan = await planPush(sidecar);
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
      } as InMemoryPushManifest;
    }

    async function commitPush(
      manifest: InMemoryPushManifest,
      _options?: DatastoreSyncOptions,
    ): Promise<number> {
      checkReachable("commit", instance);
      const internal = manifest as InternalManifest;
      // Commit compares the cache's last-seen sequence with the remote's at
      // commit time, so a peer's commit after prepare blocks the arm.
      const baseSeq = commitSeq;
      // The cache's own index is what prepare read plus this push's changes;
      // a peer's commit since prepare is not in it (S3SYNC:4015-4026).
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
      });
      recordPushed(scoped, index, manifest.uploads, manifest.deletes);
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
      // The extensions remove before downloading, and a subdir-scoped pull
      // still reconciles every key (S3SYNC:2537-2543).
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
      // A subdir-scoped pull saves the whole index too.
      syncedIndexes.set(key, new Map(committed));
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
      // Like the extensions, a pull leaves peer removals out of its count
      // (S3SYNC:2875).
      return downloaded.length + removed.length;
    }

    function markDirty(options?: DatastoreSyncOptions): Promise<void> {
      const relPath = options?.relPath;
      const sidecar = ensureSidecar();
      const markBulk = (overflow: boolean) => {
        sidecar.bulk = true;
        sidecar.localDirty = true;
        if (overflow) sidecar.overflowed = true;
      };

      if (relPath) {
        record({ instance, op: "markDirty", paths: [relPath], deleted: [] });
        if (sidecar.bulk) return Promise.resolve();
        const rel = toCacheRelative(relPath);
        if (rel === undefined) {
          markBulk(false);
          return Promise.resolve();
        }
        if (sidecar.dirtyPaths.has(rel)) return Promise.resolve();
        if (sidecar.dirtyPaths.size >= dirtyPathsCap) {
          markBulk(true);
          return Promise.resolve();
        }
        sidecar.dirtyPaths.add(rel);
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
      ...(controlPlane ? { controlPlaneStore } : {}),
    };
  }

  return {
    connect,
    files: () => new Map(committed),
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
    datastoreControlPlaneStore() {
      if (!controlPlane) {
        throw new Error(
          "datastoreControlPlaneStore needs the controlPlane option",
        );
      }
      return {
        get(key, readOptions) {
          try {
            const fullKey = controlKey(undefined, key);
            reads.push({ instance: "datastore", key: fullKey });
            readOptions?.signal?.throwIfAborted();
            checkReachable("controlPlane", "datastore");
            const bytes = controlRecords.get(fullKey);
            return Promise.resolve(bytes ? bytes.slice() : null);
          } catch (error) {
            return Promise.reject(error);
          }
        },
      };
    },
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
