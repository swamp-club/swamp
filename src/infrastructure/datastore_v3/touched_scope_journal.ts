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

import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  SEPARATOR,
} from "@std/path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { dataNameOfKey } from "../../domain/datastore_v3/recovery_scope.ts";
import { TOUCHED_TRACKING_SQL } from "../persistence/catalog_store.ts";
import {
  isCheckoutLocalKey,
  MATERIALISED_SUBDIRS,
} from "./record_path_guard.ts";

/** a scope standing for every materialised path: recovery walks them all */
export const WHOLE_CHECKOUT_SCOPE = "*";

/**
 * marks a scope walked through every file, as a removal of a whole data name
 * can be cut short in any of its versions
 */
export const DEEP_SCOPE_SUFFIX = "/**";

/** the record key a scope covers, without its deep marker */
export function scopeKey(scope: string): string {
  return scope.endsWith(DEEP_SCOPE_SUFFIX)
    ? scope.slice(0, -DEEP_SCOPE_SUFFIX.length)
    : scope;
}

/**
 * the record key a write signal's path names under the checkout's cache root;
 * undefined for a path outside it, outside the materialised directories, or
 * the checkout's own
 */
export function touchedScopeOf(
  cacheRoot: string,
  path: string,
  canonicalRoot: () => string = () => canonicalPath(cacheRoot),
): string | undefined {
  return scopeUnder(cacheRoot, path) ??
    scopeUnder(canonicalRoot(), canonicalPath(path));
}

/**
 * the real spelling of a path that may not exist yet, through its nearest
 * existing ancestor: a repository and the cache root can name one directory
 * through different links
 */
export function canonicalPath(path: string): string {
  const rest: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(Deno.realPathSync(current), ...rest.reverse());
    } catch (error) {
      if (
        !(error instanceof Deno.errors.NotFound) &&
        !(error instanceof Deno.errors.NotADirectory)
      ) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
}

function scopeUnder(cacheRoot: string, path: string): string | undefined {
  const rel = relative(cacheRoot, path);
  if (rel === "" || isAbsolute(rel)) return undefined;
  const segments = rel.split(SEPARATOR);
  if (segments[0] === "..") return undefined;
  if (!MATERIALISED_SUBDIRS.has(segments[0])) return undefined;
  if (isCheckoutLocalKey(segments)) return undefined;
  return segments.join("/");
}

export function scopeCovers(scope: string, key: string): boolean {
  const covered = scopeKey(scope);
  return scope === WHOLE_CHECKOUT_SCOPE || key === covered ||
    key.startsWith(`${covered}/`);
}

/**
 * the write-ahead side of the catalog's touched scopes: its own connection
 * syncs each record fully, so no file a signal names is on disk without it
 */
export class TouchedScopeJournal {
  readonly #path: string;
  #db: DatabaseSync | undefined;
  #insert: StatementSync | undefined;
  readonly #recorded = new Map<string, Set<string>>();

  constructor(catalogPath: string) {
    this.#path = catalogPath;
  }

  /**
   * synchronous so it lands before the write the signal precedes; false when
   * there is no catalog yet, whose tracking then starts after this writer
   */
  record(unitId: string, namespace: string, scope: string): boolean {
    let scopes = this.#recorded.get(unitId);
    if (scopes === undefined) {
      scopes = new Set();
      this.#recorded.set(unitId, scopes);
    }
    const key = `${namespace}\0${scope}`;
    if (scopes.has(key)) return true;
    const db = this.#open();
    if (db === undefined) return false;
    const name = scope === WHOLE_CHECKOUT_SCOPE
      ? undefined
      : dataNameOfKey(scope);
    this.#insert ??= db.prepare(
      "INSERT OR IGNORE INTO catalog_touched (unit_id, namespace, scope, type_normalized, model_id, data_name) VALUES (?, ?, ?, ?, ?, ?)",
    );
    this.#insert.run(
      unitId,
      namespace,
      scope,
      name?.type ?? "",
      name?.modelId ?? "",
      name?.name ?? "",
    );
    scopes.add(key);
    return true;
  }

  /** the scopes this process recorded for the unit, as record keys */
  recordedFor(unitId: string, namespace: string): string[] {
    const prefix = `${namespace}\0`;
    return [...this.#recorded.get(unitId) ?? []]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  /** the unit's records were released or recovered, so it starts afresh */
  forget(unitId: string): void {
    this.#recorded.delete(unitId);
  }

  close(): void {
    this.#insert = undefined;
    this.#db?.close();
    this.#db = undefined;
    this.#recorded.clear();
  }

  #open(): DatabaseSync | undefined {
    if (this.#db !== undefined) return this.#db;
    try {
      Deno.statSync(this.#path);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return undefined;
      throw error;
    }
    const db = new DatabaseSync(this.#path);
    try {
      db.exec("PRAGMA busy_timeout=5000");
      db.exec("PRAGMA synchronous=FULL");
      db.exec(TOUCHED_TRACKING_SQL);
    } catch (error) {
      db.close();
      throw error;
    }
    this.#db = db;
    return db;
  }
}
