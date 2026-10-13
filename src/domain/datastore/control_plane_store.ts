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
 * Direct read/write access to small control-plane records in the remote
 * datastore. Bypasses the sync index and cache pipeline entirely — used
 * for coordination state (instance heartbeats, pending run entries) that
 * must survive instance death.
 *
 * Keys are slash-delimited paths (e.g. `heartbeats/{id}`,
 * `pending-runs/{id}`). The extension maps them under `_control/` in the
 * remote backend, scoped by namespace when configured.
 */
export interface ControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  putIfAbsent?(key: string, data: Uint8Array): Promise<boolean>;
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

/** Options for a control-plane read. */
export interface ControlPlaneReadOptions {
  /**
   * Cancels the read. An extension that honours it stops the request in
   * flight and any retry backoff when it aborts, and rejects; until then it
   * may retry as usual. A sync service's {@link ControlPlaneStore} that
   * ignores it still works, because core stops waiting at its own deadline
   * either way. A {@link DatastoreControlPlaneStore} must honour it.
   */
  readonly signal?: AbortSignal;
}

/**
 * Reads control-plane records at the datastore-wide `_control/` root,
 * whatever namespace a repository uses. The datastore format marker is
 * read through it, before a command locks, pulls or pushes.
 *
 * Unlike a sync service's {@link ControlPlaneStore}, it binds no namespace
 * and shares no state with any sync service, so it can be used before the
 * command's own namespaced sync service is built.
 */
export interface DatastoreControlPlaneStore {
  /**
   * The record at `_control/<key>`, or null only when no such record
   * exists. Every other failure, access denied included, rejects, so the
   * caller can tell an unreadable record from a missing one. Rejects when
   * `options.signal` aborts, as `assertDatastoreControlPlaneStoreConformance`
   * checks.
   */
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
}

/**
 * A {@link DatastoreControlPlaneStore} that can also write, at the same
 * datastore-wide `_control/` root. The v3 writer lease keeps its records
 * (`writer/`) here, because there is one writer per datastore, not per
 * namespace.
 *
 * Every key is relative to `_control/` at the datastore root: writing binds
 * no namespace, and records a namespaced sync service writes under
 * `<namespace>/_control/` are never read, listed or changed through it.
 */
export interface WritableDatastoreControlPlaneStore
  extends DatastoreControlPlaneStore {
  /** Writes the record at `_control/<key>`, replacing any record there. */
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * Creates the record at `_control/<key>` only if no record is there.
   * Returns false, leaving the existing record unchanged, when one is. Of
   * concurrent creates of one key, from any process, exactly one returns
   * true.
   */
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  /** Removes the record at `_control/<key>`; a missing record is no error. */
  delete(key: string): Promise<void>;
  /** The keys under `_control/<prefix>`, relative to `_control/`. */
  list(prefix: string): Promise<string[]>;
}

/** True when `store` also has the writes a datastore-wide writer needs. */
export function isWritableDatastoreControlPlaneStore(
  store: DatastoreControlPlaneStore,
): store is WritableDatastoreControlPlaneStore {
  const candidate = store as Partial<WritableDatastoreControlPlaneStore>;
  return typeof candidate.put === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.delete === "function" &&
    typeof candidate.list === "function";
}
