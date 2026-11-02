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
 * bypasses the sync index and cache pipeline, for coordination state that must
 * survive instance death; keys map under _control/ in the remote backend,
 * scoped by namespace when configured
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

export interface ControlPlaneReadOptions {
  /**
   * an extension that honours it stops the request and retry backoff on abort
   * and rejects; a sync service store may ignore it, as core stops waiting at
   * its deadline. A DatastoreControlPlaneStore must honour it
   */
  readonly signal?: AbortSignal;
}

/**
 * binds no namespace and shares no state with any sync service, so it can be
 * used before the command's namespaced sync service is built
 */
export interface DatastoreControlPlaneStore {
  /**
   * null only when no such record exists; every other failure, access denied
   * included, rejects, so the caller can tell an unreadable record from a
   * missing one
   */
  get(
    key: string,
    options?: ControlPlaneReadOptions,
  ): Promise<Uint8Array | null>;
}

/**
 * one writer per datastore, not per namespace, so the v3 writer lease lives
 * here; records a namespaced sync service writes under <namespace>/_control/
 * are never read, listed or changed through it
 */
export interface WritableDatastoreControlPlaneStore
  extends DatastoreControlPlaneStore {
  put(key: string, data: Uint8Array): Promise<void>;
  /**
   * of concurrent creates of one key, from any process, exactly one returns
   * true; a false return leaves the existing record unchanged
   */
  putIfAbsent(key: string, data: Uint8Array): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

export function isWritableDatastoreControlPlaneStore(
  store: DatastoreControlPlaneStore,
): store is WritableDatastoreControlPlaneStore {
  const candidate = store as Partial<WritableDatastoreControlPlaneStore>;
  return typeof candidate.put === "function" &&
    typeof candidate.putIfAbsent === "function" &&
    typeof candidate.delete === "function" &&
    typeof candidate.list === "function";
}
