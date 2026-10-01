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
 * `@swamp/gcs-datastore` do today, quirks included, so a test that passes
 * against this fake cannot lose data that production would keep. Each
 * pinned behaviour was checked against swamp-extensions @ 5368cb002;
 * `S3SYNC` below is
 * `datastore/s3/extensions/datastores/_lib/s3_cache_sync.ts`, and the GCS
 * equivalent behaves the same.
 *
 * - A path mark records a cache-relative path. A bare mark, an empty path or
 *   a path that climbs out of the cache with `..` sets the bulk flag. An
 *   absolute path is nested under the cache, as `join(cachePath, relPath)`
 *   does, so its real file is never pushed; once bulk is set, later
 *   path marks are dropped (S3SYNC:1748-1793). Past `dirtyPathsCap` paths the
 *   set overflows into bulk (S3SYNC:1775-1782).
 * - Dirty state lives in a per-cache "sidecar" that survives reconnects, like
 *   `.datastore-sync-state.json`. A push with a clean sidecar returns 0
 *   without walking, so a write that was never marked is never pushed
 *   (S3SYNC:1913-1922). A cache with no sidecar yet pushes with a full walk
 *   that deletes nothing.
 * - A scoped push uploads each marked file that differs, walks each marked
 *   directory deleting remote entries under it that are gone locally, and
 *   deletes the remote key (and `key/`) of a marked path that is absent
 *   (S3SYNC:3023-3094). A mark of `.` becomes the cache root: its walk
 *   uploads everything but deletes nothing, because the delete prefix is
 *   `/` (S3SYNC:3057-3060). A bulk push uploads everything and deletes nothing
 *   unless the set overflowed (S3SYNC:3095-3165).
 * - Uploads go through `pushFile`, which sets the bulk flag
 *   (S3SYNC:2822). A push that fails after its uploads therefore leaves bulk
 *   set, and the next push loses the recorded deletes.
 * - Dirty state is cleared only when a push succeeds (S3SYNC:3287-3316).
 * - A pull downloads committed entries that are new or differ, overwrites
 *   local files even if they are dirty, and never deletes local files
 *   (S3SYNC:2535-2609). When the remote has moved since this cache last
 *   pulled, an unscoped pull marks the sidecar clean, so a pending push is
 *   dropped (S3SYNC:2742, 2759). An unchanged remote takes the fast path and
 *   touches nothing (S3SYNC:1852-1864).
 * - `preparePush` uploads and deletes content at once but publishes nothing
 *   other machines can pull, and keeps dirty state; `commitPush` publishes
 *   the index and clears dirty state, including marks made in between
 *   (S3SYNC:3406-3956).
 * - Internal cache files are never pushed or pulled (S3SYNC:116-128). `.log`
 *   files are synced.
 *
 * Three behaviours that later phases are expected to change can be switched
 * through {@link InMemoryRemoteSemantics}.
 *
 * Experimental: the defaults track today's extension behaviour and will
 * change during the datastore rework.
 *
 * Not modelled: namespaces, lazy hydration (`hydrateFile`), the control
 * plane, `previewPush`, model-scoped pulls through `context`, and Windows
 * drive-letter joins. Nor is the window between `preparePush` and
 * `commitPush` in which the extensions have already deleted objects but not
 * yet the index entries, so a peer pulling then drops those entries without
 * downloading them; here a peer still sees the old content until commit. The fake
 * compares file bytes, whereas the backends compare size and mtime before
 * hashing (S3SYNC:4052-4094) and can skip a same-size, same-mtime rewrite.
 *
 * @module
 */

import { dirname, join, normalize } from "@std/path";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  SyncCapabilities,
} from "./datastore_types.ts";

/** The behaviours a later datastore phase is expected to change. */
export interface InMemoryRemoteSemantics {
  /** A pull deletes local files the remote dropped since the last pull. */
  pullDeletes: boolean;
  /** A bulk mark makes the next push a full walk that deletes nothing. */
  bulkDisablesDeletes: boolean;
  /** An unscoped pull of a moved remote marks the cache clean. */
  pullClearsPendingPush: boolean;
}

/** What `@swamp/s3-datastore` and `@swamp/gcs-datastore` do today. */
export const LEGACY_EXTENSION_SEMANTICS: Readonly<InMemoryRemoteSemantics> =
  Object.freeze({
    pullDeletes: false,
    bulkDisablesDeletes: true,
    pullClearsPendingPush: true,
  });

/** Options for {@link createInMemoryRemote}. */
export interface InMemoryRemoteOptions {
  /** Overrides for {@link LEGACY_EXTENSION_SEMANTICS}. */
  semantics?: Partial<InMemoryRemoteSemantics>;
  /** Marked paths kept before the set overflows into bulk. Default 2000. */
  dirtyPathsCap?: number;
  /** What every connected service advertises. Default `{ twoPhaseSync: true }`. */
  capabilities?: SyncCapabilities;
}

/** A remote operation a failure can be injected into. */
export type InMemoryRemoteFailure = "push" | "pull" | "prepare" | "commit";

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
  op: "markDirty" | "push" | "pull" | "prepare" | "commit";
  /** Paths marked, uploaded or downloaded, sorted. */
  paths: string[];
  /** Paths deleted remotely (push) or locally (pull), sorted. */
  deleted: string[];
  /** Set on a bare `markDirty`. */
  bulk?: boolean;
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
  /** While offline, every push, pull, prepare and commit throws. */
  offline(isOffline: boolean): void;
  /** Every recorded operation, in order. */
  ops(): readonly InMemoryRemoteOpRecord[];
  /** Drops a cache's persisted dirty state, like a lost sidecar file. */
  resetSidecar(cacheDir: string): void;
}

const PLAN_SCOPED = Symbol("scoped");
const PLAN_PRIOR_SEQ = Symbol("priorSeq");
const PLAN_OVERFLOWED = Symbol("overflowed");

interface InternalManifest extends InMemoryPushManifest {
  [PLAN_SCOPED]?: boolean;
  [PLAN_PRIOR_SEQ]?: number;
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
    ...LEGACY_EXTENSION_SEMANTICS,
    ...options?.semantics,
  };
  const dirtyPathsCap = options?.dirtyPathsCap ?? 2000;
  const capabilities: SyncCapabilities = options?.capabilities ??
    { twoPhaseSync: true };

  // Stored objects, written at once by prepare and push.
  const objects = new Map<string, Uint8Array>();
  // The published index: what other machines see when they pull.
  const committed = new Map<string, Uint8Array>();
  let commitSeq = 0;
  const sidecars = new Map<string, Sidecar>();
  const log: InMemoryRemoteOpRecord[] = [];
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

  function connect(
    cacheDir: string,
    connectOptions?: ConnectOptions,
  ): InMemorySyncService {
    instanceCount++;
    const instance = connectOptions?.instance ?? `instance-${instanceCount}`;
    const key = sidecarKey(cacheDir);

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

    async function planPush(sidecar: Sidecar | undefined): Promise<PushPlan> {
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

    async function hasAllCommitted(): Promise<boolean> {
      for (const remoteKey of committed.keys()) {
        if (!(await statLocal(cacheDir, remoteKey))) return false;
      }
      return true;
    }

    /**
     * Marks the cache clean after a successful push, and arms the pull fast
     * path only when nothing else landed since `baseSeq` and this cache is
     * known to hold everything (S3SYNC:3287-3316, 3916-3929).
     */
    async function settle(arm: {
      priorSeq: number | undefined;
      baseSeq: number;
      upToDate: boolean;
      scoped: boolean;
      overflowed: boolean;
    }): Promise<void> {
      const sidecar = ensureSidecar();
      sidecar.dirtyPaths.clear();
      sidecar.bulk = false;
      sidecar.overflowed = false;
      sidecar.localDirty = false;
      const reconciled = (arm.scoped || arm.overflowed) &&
        arm.priorSeq === arm.baseSeq;
      const armed = arm.upToDate &&
        (reconciled || (!arm.scoped && await hasAllCommitted()));
      sidecar.commitSeq = armed ? commitSeq : undefined;
    }

    async function pushChanged(
      _options?: DatastoreSyncOptions,
    ): Promise<number> {
      const sidecar = loadSidecar();
      // The fast path reads only the local sidecar, so it succeeds offline
      // and never reaches an injected failure (S3SYNC:1913-1922).
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "push", paths: [], deleted: [] });
        return 0;
      }
      const failure = checkReachable("push", instance);
      const priorSeq = sidecar?.commitSeq;
      const baseSeq = commitSeq;
      const overflowed = sidecar?.overflowed ?? false;
      const plan = await planPush(sidecar);
      if (failure) {
        // Uploads landed as objects but the index was never committed, and
        // each upload's bare mark leaves the bulk flag set (S3SYNC:2822).
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
      record({
        instance,
        op: "push",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes.filter((rel) => !committed.has(rel)),
      });
      return plan.uploads.size + deleted;
    }

    async function preparePush(
      _options?: DatastoreSyncOptions,
    ): Promise<InMemoryPushManifest> {
      const sidecar = loadSidecar();
      if (sidecar && !sidecar.localDirty) {
        record({ instance, op: "prepare", paths: [], deleted: [] });
        return { uploads: new Map(), deletes: [] };
      }
      checkReachable("prepare", instance);
      const plan = await planPush(sidecar);
      for (const [rel, bytes] of plan.uploads) objects.set(rel, bytes);
      for (const rel of plan.deletes) objects.delete(rel);
      record({
        instance,
        op: "prepare",
        paths: [...plan.uploads.keys()],
        deleted: plan.deletes,
      });
      return {
        uploads: plan.uploads,
        deletes: plan.deletes,
        [PLAN_SCOPED]: plan.scoped,
        [PLAN_PRIOR_SEQ]: sidecar?.commitSeq,
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
      const deleted = publish(manifest.uploads, manifest.deletes);
      await settle({
        priorSeq: internal[PLAN_PRIOR_SEQ],
        baseSeq,
        upToDate: true,
        scoped: internal[PLAN_SCOPED] ?? false,
        overflowed: internal[PLAN_OVERFLOWED] ?? false,
      });
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
      checkReachable("pull", instance);
      const subdirs = options?.subdirs ?? [];
      const scoped = subdirs.length > 0;
      const sidecar = loadSidecar();
      if (sidecar?.commitSeq !== undefined && sidecar.commitSeq === commitSeq) {
        record({ instance, op: "pull", paths: [], deleted: [] });
        return 0;
      }

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
      const state = ensureSidecar();
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
      if (!scoped) {
        if (semantics.pullClearsPendingPush) state.localDirty = false;
        state.commitSeq = commitSeq;
      }

      record({ instance, op: "pull", paths: downloaded, deleted: removed });
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

    return {
      pullChanged,
      pushChanged,
      markDirty,
      preparePush,
      commitPush,
      capabilities: () => ({ ...capabilities }),
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
    ops: () =>
      log.map((entry) => ({
        ...entry,
        paths: [...entry.paths],
        deleted: [...entry.deleted],
      })),
    resetSidecar(cacheDir) {
      sidecars.delete(sidecarKey(cacheDir));
    },
  };
}
