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
 * In-memory remote datastore fake with content.
 *
 * One {@link InMemoryRemote} stands for a shared bucket. Each
 * {@link InMemoryRemote.connect} call returns a sync service bound to one
 * local cache directory, so several connections simulate several machines
 * sharing that bucket. The connected services follow the `markDirty`
 * contract in swamp's canonical `DatastoreSyncService` (rules 1-8).
 *
 * Deliberate limits: no namespace scoping, no lazy hydration (`hydrateFile`
 * is absent), no control-plane store, no `previewPush`, and injected
 * failures are atomic (nothing is half-uploaded).
 *
 * @module
 */

import { ensureDir } from "@std/fs/ensure-dir";
import { dirname, join } from "@std/path";
import {
  bytesEqual,
  isAtOrUnder,
  isCacheRelative,
  isInternalCacheFile,
  listCacheFiles,
  pathKind,
  readIfFile,
  trimTrailingSlash,
} from "./_in_memory_remote_paths.ts";
import type {
  DatastoreSyncOptions,
  DatastoreSyncService,
  SyncCapabilities,
} from "./datastore_types.ts";

/** A remote-facing operation of a connected sync service. */
export type InMemoryRemoteOp = "push" | "pull" | "prepare" | "commit";

/** One successful remote-facing operation, in the order it completed. */
export interface InMemoryRemoteOperation {
  /** The `instance` name of the connection that ran the operation. */
  instance: string;
  op: InMemoryRemoteOp;
  /**
   * Paths written: uploaded to the remote for `push` and `commit`, staged
   * for `prepare`, downloaded into the cache for `pull`.
   */
  paths: string[];
  /**
   * Paths removed: from the remote for `push` and `commit`, staged for
   * removal for `prepare`, from the cache for `pull`.
   */
  deleted: string[];
}

/** Capabilities the in-memory remote can advertise. */
export interface InMemoryRemoteCapabilities extends SyncCapabilities {
  /** Core splits pushes into `preparePush` + `commitPush` when `true`. */
  twoPhaseSync?: boolean;
  /** The service honours the `subdirs` option on `pullChanged`. */
  configRefresh?: boolean;
}

/** Options for {@link createInMemoryRemote}. */
export interface InMemoryRemoteOptions {
  /**
   * Whether `pullChanged` deletes a local file that a peer removed from the
   * remote since this connection last synced it (default: `false`).
   *
   * `false` is what `@swamp/s3-datastore` and `@swamp/gcs-datastore` do
   * today: their pull drops the entry from the local index but leaves the
   * file on disk (s3_cache_sync.ts and gcs_cache_sync.ts in
   * swamp-extensions, the `pull404Rels` pruning in `pullChanged`). `true`
   * models a pull that propagates deletes; it never deletes a file that is
   * dirty locally.
   */
  pullDeletes?: boolean;
  /**
   * Capabilities every connection advertises
   * (default: `{ twoPhaseSync: true, configRefresh: true }`).
   */
  capabilities?: InMemoryRemoteCapabilities;
}

/** Options for {@link InMemoryRemote.connect}. */
export interface InMemoryRemoteConnectOptions {
  /** Name recorded in {@link InMemoryRemote.ops} (default: `instance-<n>`). */
  instance?: string;
  /**
   * Treat the first push after connecting as a full walk of the cache
   * (default: `false`).
   *
   * Contract rule 4 says an implementation that keeps its dirty set in
   * memory must fall back to a full walk on the first push after process
   * start. The default departs from that on purpose: a full walk would
   * upload files whose `markDirty` call core dropped, hiding exactly the
   * missing marks tests built on this fake are meant to catch.
   */
  fullWalkOnFirstPush?: boolean;
}

/** Options accepted by {@link InMemoryRemoteSyncService.pullChanged}. */
export interface InMemoryPullOptions extends DatastoreSyncOptions {
  /** Restrict the pull to these cache subdirectories (e.g. `["config"]`). */
  subdirs?: readonly string[];
}

/**
 * Opaque handle returned by `preparePush` and consumed by `commitPush`.
 * A manifest can be committed once, by the connection that prepared it.
 */
export interface InMemoryPushManifest {
  readonly id: string;
  readonly instance: string;
}

/** A sync service connected to an {@link InMemoryRemote}. */
export interface InMemoryRemoteSyncService extends DatastoreSyncService {
  /** The name this connection records in the op log. */
  readonly instance: string;
  /** The local cache directory this connection syncs. */
  readonly cacheDir: string;
  /**
   * Download remote files changed since this connection last synced them,
   * skipping files dirty locally. Resolves to the number of files written
   * to or removed from the cache.
   */
  pullChanged(options?: InMemoryPullOptions): Promise<number>;
  /**
   * Upload marked files, delete marked files that are absent locally, and
   * clear the marks the push started with. Resolves to the number of
   * remote files written or removed.
   */
  pushChanged(options?: DatastoreSyncOptions): Promise<number>;
  /** Record a dirty path, or set the bulk flag when `relPath` is absent. */
  markDirty(options?: DatastoreSyncOptions): Promise<void>;
  capabilities(): InMemoryRemoteCapabilities;
  /** Stage a push without touching the remote or the dirty state. */
  preparePush(options?: DatastoreSyncOptions): Promise<InMemoryPushManifest>;
  /** Apply a staged push and clear the marks it was built from. */
  commitPush(
    manifest: InMemoryPushManifest,
    options?: DatastoreSyncOptions,
  ): Promise<number>;
  /** Every `markDirty` relPath in call order; `undefined` is a bare call. */
  marks(): ReadonlyArray<string | undefined>;
  /**
   * relPaths `markDirty` received that are not cache-relative
   * forward-slash paths (contract rule 5). They are never pushed.
   */
  violations(): readonly string[];
  /** Paths currently marked dirty, sorted. */
  dirtyPaths(): readonly string[];
  /** Whether a bare `markDirty` call is waiting for the next push. */
  isBulkDirty(): boolean;
  /** Make the next call of `op` reject with `error`, before any change. */
  failNext(op: InMemoryRemoteOp, error?: Error): void;
  /** While offline, every remote-facing call rejects; marks still record. */
  offline(value: boolean): void;
}

/** A shared in-memory remote datastore. */
export interface InMemoryRemote {
  /** Connect a sync service to this remote for one local cache directory. */
  connect(
    cacheDir: string,
    options?: InMemoryRemoteConnectOptions,
  ): InMemoryRemoteSyncService;
  /** A copy of every remote file, keyed by cache-relative path. */
  files(): Map<string, Uint8Array>;
  /** A copy of one remote file, or `undefined` when absent. */
  read(relPath: string): Uint8Array | undefined;
  /** Write a remote file directly, as an out-of-band peer would. */
  write(relPath: string, content: Uint8Array | string): void;
  /** Delete a remote file directly. Returns whether it existed. */
  delete(relPath: string): boolean;
  /** Every successful remote-facing operation across all connections. */
  ops(): InMemoryRemoteOperation[];
}

/**
 * Creates an in-memory remote datastore that several sync services can
 * share, one per simulated machine.
 *
 * ```typescript
 * import { createInMemoryRemote } from "@swamp-club/swamp-testing";
 *
 * const remote = createInMemoryRemote();
 * const a = remote.connect(cacheA, { instance: "a" });
 * const b = remote.connect(cacheB, { instance: "b" });
 *
 * await Deno.writeTextFile(join(cacheA, "data", "x"), "hello");
 * await a.markDirty({ relPath: "data/x" });
 * await a.pushChanged();
 * await b.pullChanged(); // cacheB/data/x now holds "hello"
 * ```
 */
export function createInMemoryRemote(
  options?: InMemoryRemoteOptions,
): InMemoryRemote {
  const store = new Map<string, Uint8Array>();
  const opLog: InMemoryRemoteOperation[] = [];
  const pullDeletes = options?.pullDeletes ?? false;
  const capabilities: InMemoryRemoteCapabilities = options?.capabilities ??
    { twoPhaseSync: true, configRefresh: true };
  let connectionCount = 0;

  function record(
    instance: string,
    op: InMemoryRemoteOp,
    paths: Iterable<string>,
    deleted: Iterable<string>,
  ): void {
    opLog.push({
      instance,
      op,
      paths: [...paths].sort(),
      deleted: [...deleted].sort(),
    });
  }

  return {
    connect(cacheDir, connectOptions) {
      connectionCount++;
      return connectService({
        cacheDir,
        instance: connectOptions?.instance ?? `instance-${connectionCount}`,
        fullWalkOnFirstPush: connectOptions?.fullWalkOnFirstPush ?? false,
        pullDeletes,
        capabilities,
        store,
        record,
      });
    },
    files() {
      return new Map([...store].map(([rel, bytes]) => [rel, bytes.slice()]));
    },
    read(relPath) {
      return store.get(relPath)?.slice();
    },
    write(relPath, content) {
      if (!isCacheRelative(relPath)) {
        throw new Error(`Not a cache-relative path: ${relPath}`);
      }
      store.set(
        relPath,
        typeof content === "string"
          ? new TextEncoder().encode(content)
          : content.slice(),
      );
    },
    delete(relPath) {
      return store.delete(relPath);
    },
    ops() {
      return opLog.map((entry) => ({
        ...entry,
        paths: [...entry.paths],
        deleted: [...entry.deleted],
      }));
    },
  };
}

interface ConnectionConfig {
  cacheDir: string;
  instance: string;
  fullWalkOnFirstPush: boolean;
  pullDeletes: boolean;
  capabilities: InMemoryRemoteCapabilities;
  store: Map<string, Uint8Array>;
  record: (
    instance: string,
    op: InMemoryRemoteOp,
    paths: Iterable<string>,
    deleted: Iterable<string>,
  ) => void;
}

/** The marks a push or prepare started from, so only those are cleared. */
interface DirtySnapshot {
  paths: Map<string, number>;
  bulkSeq: number;
  fullWalk: boolean;
}

/** What a push will do to the remote. */
interface PushSet {
  uploads: Map<string, Uint8Array>;
  deletes: Set<string>;
}

interface StagedPush {
  set: PushSet;
  snapshot: DirtySnapshot;
}

function connectService(config: ConnectionConfig): InMemoryRemoteSyncService {
  const { cacheDir, instance, store } = config;

  // Each mark gets a sequence number so a push clears only the marks it
  // started with: a path re-marked while the push runs stays dirty.
  let seq = 0;
  const dirty = new Map<string, number>();
  let bulkSeq = 0;
  let pushedOnce = false;

  // What this connection last pushed or pulled for each path. Pull uses it
  // to tell a remote change from a local edit; push deletes only paths in
  // it, so a peer's file this connection never saw is never deleted.
  const baseline = new Map<string, Uint8Array>();

  const markLog: Array<string | undefined> = [];
  const violationLog: string[] = [];
  const pendingFailures = new Map<InMemoryRemoteOp, Error>();
  let isOffline = false;
  const staged = new Map<string, StagedPush>();
  let manifestCount = 0;

  function checkAvailable(op: InMemoryRemoteOp): void {
    if (isOffline) {
      throw new Error(`In-memory remote is offline (${instance} ${op})`);
    }
    const failure = pendingFailures.get(op);
    if (failure) {
      pendingFailures.delete(op);
      throw failure;
    }
  }

  function takeSnapshot(): DirtySnapshot {
    return {
      paths: new Map(dirty),
      bulkSeq,
      fullWalk: config.fullWalkOnFirstPush && !pushedOnce,
    };
  }

  function clearSnapshot(snapshot: DirtySnapshot): void {
    for (const [path, markSeq] of snapshot.paths) {
      if (dirty.get(path) === markSeq) dirty.delete(path);
    }
    if (snapshot.bulkSeq !== 0 && bulkSeq === snapshot.bulkSeq) bulkSeq = 0;
    pushedOnce = true;
  }

  function isDirtyLocally(rel: string): boolean {
    for (const path of dirty.keys()) {
      if (isAtOrUnder(rel, path)) return true;
    }
    return false;
  }

  async function computePushSet(snapshot: DirtySnapshot): Promise<PushSet> {
    const set: PushSet = { uploads: new Map(), deletes: new Set() };
    const addUpload = async (rel: string): Promise<void> => {
      set.uploads.set(rel, await Deno.readFile(join(cacheDir, rel)));
    };
    const deleteBaselineUnder = async (prefix: string): Promise<void> => {
      for (const rel of baseline.keys()) {
        if (!isAtOrUnder(rel, prefix) || set.uploads.has(rel)) continue;
        if (await pathKind(join(cacheDir, rel)) !== "file") {
          set.deletes.add(rel);
        }
      }
    };

    if (snapshot.bulkSeq !== 0 || snapshot.fullWalk) {
      // Rule 3 and rule 8: a bare mark makes this push a full walk, which
      // overrides the per-path marks from the same operation.
      for (const rel of await listCacheFiles(cacheDir, cacheDir)) {
        await addUpload(rel);
      }
      await deleteBaselineUnder("");
      return set;
    }

    for (const path of snapshot.paths.keys()) {
      const kind = await pathKind(join(cacheDir, path));
      if (kind === "file") {
        if (!isInternalCacheFile(path)) await addUpload(path);
      } else if (kind === "dir") {
        // Core marks directories (a data name, a version) as well as files.
        for (
          const rel of await listCacheFiles(cacheDir, join(cacheDir, path))
        ) {
          await addUpload(rel);
        }
      }
      // Rule 2: a marked path absent on disk is a delete. Limited to the
      // baseline, as S3 and GCS diff against their own index.
      await deleteBaselineUnder(path);
    }
    return set;
  }

  function applyPushSet(
    set: PushSet,
  ): { written: string[]; removed: string[] } {
    const written: string[] = [];
    const removed: string[] = [];
    for (const [rel, bytes] of set.uploads) {
      const current = store.get(rel);
      if (!current || !bytesEqual(current, bytes)) {
        store.set(rel, bytes.slice());
        written.push(rel);
      }
      baseline.set(rel, bytes.slice());
    }
    for (const rel of set.deletes) {
      if (store.delete(rel)) removed.push(rel);
      baseline.delete(rel);
    }
    return { written, removed };
  }

  const service: InMemoryRemoteSyncService = {
    instance,
    cacheDir,

    markDirty(options) {
      const relPath = options?.relPath;
      markLog.push(relPath);
      if (relPath === undefined) {
        bulkSeq = ++seq;
      } else if (isCacheRelative(relPath)) {
        dirty.set(trimTrailingSlash(relPath), ++seq);
      } else {
        violationLog.push(relPath);
      }
      return Promise.resolve();
    },

    async pushChanged() {
      checkAvailable("push");
      const snapshot = takeSnapshot();
      const set = await computePushSet(snapshot);
      const { written, removed } = applyPushSet(set);
      clearSnapshot(snapshot);
      config.record(instance, "push", written, removed);
      return written.length + removed.length;
    },

    async preparePush() {
      checkAvailable("prepare");
      const snapshot = takeSnapshot();
      const set = await computePushSet(snapshot);
      const manifest: InMemoryPushManifest = {
        id: `${instance}#${++manifestCount}`,
        instance,
      };
      staged.set(manifest.id, { set, snapshot });
      config.record(instance, "prepare", set.uploads.keys(), set.deletes);
      return manifest;
    },

    commitPush(manifest) {
      const entry = staged.get(manifest.id);
      if (!entry) {
        return Promise.reject(
          new Error(`Unknown or already committed manifest: ${manifest.id}`),
        );
      }
      try {
        checkAvailable("commit");
      } catch (error) {
        return Promise.reject(error);
      }
      staged.delete(manifest.id);
      const { written, removed } = applyPushSet(entry.set);
      clearSnapshot(entry.snapshot);
      config.record(instance, "commit", written, removed);
      return Promise.resolve(written.length + removed.length);
    },

    async pullChanged(options) {
      checkAvailable("pull");
      const subdirs = options?.subdirs?.map(trimTrailingSlash);
      const inScope = (rel: string): boolean =>
        !isInternalCacheFile(rel) &&
        (subdirs === undefined || subdirs.some((dir) => isAtOrUnder(rel, dir)));

      const written: string[] = [];
      const removed: string[] = [];
      for (const [rel, bytes] of [...store]) {
        if (!inScope(rel)) continue;
        const synced = baseline.get(rel);
        if (synced && bytesEqual(synced, bytes)) continue;
        if (isDirtyLocally(rel)) continue;
        const absPath = join(cacheDir, rel);
        const local = await readIfFile(absPath);
        if (!local || !bytesEqual(local, bytes)) {
          await ensureDir(dirname(absPath));
          await Deno.writeFile(absPath, bytes);
          written.push(rel);
        }
        baseline.set(rel, bytes.slice());
      }
      for (const rel of [...baseline.keys()]) {
        if (!inScope(rel) || store.has(rel) || isDirtyLocally(rel)) continue;
        baseline.delete(rel);
        if (!config.pullDeletes) continue;
        const absPath = join(cacheDir, rel);
        if (await pathKind(absPath) === "file") {
          await Deno.remove(absPath);
          removed.push(rel);
        }
      }
      config.record(instance, "pull", written, removed);
      return written.length + removed.length;
    },

    capabilities() {
      return { ...config.capabilities };
    },

    marks() {
      return [...markLog];
    },

    violations() {
      return [...violationLog];
    },

    dirtyPaths() {
      return [...dirty.keys()].sort();
    },

    isBulkDirty() {
      return bulkSeq !== 0;
    },

    failNext(op, error) {
      pendingFailures.set(
        op,
        error ?? new Error(`Injected ${op} failure (${instance})`),
      );
    },

    offline(value) {
      isOffline = value;
    },
  };
  return service;
}
