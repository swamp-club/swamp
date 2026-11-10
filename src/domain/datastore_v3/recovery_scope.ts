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

import { PartitionKey } from "./partition_key.ts";

/** type normalized, model id lowercase */
export interface CatalogNameKey {
  readonly namespace: string;
  readonly type: string;
  readonly modelId: string;
  readonly name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * the first UUID segment after `data/` is the model id, since a type may hold
 * slashes; the segment after it is the data name
 */
export function dataNameOfKey(
  key: string,
):
  | { readonly type: string; readonly modelId: string; readonly name: string }
  | undefined {
  const segments = key.split("/");
  if (segments[0] !== "data") return undefined;
  for (let i = 2; i < segments.length - 1; i++) {
    if (!UUID.test(segments[i])) continue;
    const name = segments[i + 1];
    if (name.length === 0) return undefined;
    return {
      type: segments.slice(1, i).join("/"),
      modelId: segments[i],
      name,
    };
  }
  return undefined;
}

/** the `data/<type>/<id>/<name>` prefix every record key of a data name has */
export function dataNamePrefix(name: CatalogNameKey): string {
  return `data/${name.type}/${name.modelId}/${name.name}`;
}

export interface ScopedPartition {
  readonly namespace: string;
  readonly partition: PartitionKey;
  readonly names: readonly string[];
}

/**
 * what a targeted recovery repairs: data names grouped by partition, the record
 * keys whose files are checked against the read model's state, and the files no
 * commit owns that are removed
 */
export class RecoveryScope {
  readonly #partitions = new Map<
    string,
    { namespace: string; partition: PartitionKey; names: Set<string> }
  >();
  readonly #check = new Map<string, Set<string>>();
  readonly #remove = new Map<
    string,
    { namespace: string; key: string; path: string }
  >();
  #unscopable: string | undefined;

  /** false, and the scope unusable, for a name of no valid model partition */
  addName(name: CatalogNameKey): boolean {
    let partition: PartitionKey;
    try {
      partition = PartitionKey.forModel(name.type, name.modelId);
    } catch (error) {
      this.#unscopable ??= error instanceof Error
        ? error.message
        : String(error);
      return false;
    }
    if (
      partition.identity.kind !== "model" ||
      partition.identity.id !== name.modelId
    ) {
      this.#unscopable ??= `model id is not canonical: ${name.modelId}`;
      return false;
    }
    const id = `${name.namespace}\0${partition.toString()}`;
    let entry = this.#partitions.get(id);
    if (entry === undefined) {
      entry = { namespace: name.namespace, partition, names: new Set() };
      this.#partitions.set(id, entry);
    }
    entry.names.add(name.name);
    return true;
  }

  /** a file of `namespace` to check; its data name, if any, is touched */
  addKeyToCheck(namespace: string, key: string): void {
    let keys = this.#check.get(namespace);
    if (keys === undefined) this.#check.set(namespace, keys = new Set());
    keys.add(key);
    this.#touchNameOf(namespace, key);
  }

  /** a file no commit owns; its data name, if any, is touched */
  addRemoval(namespace: string, key: string, path: string): void {
    this.#remove.set(JSON.stringify([namespace, key]), {
      namespace,
      key,
      path,
    });
    this.#touchNameOf(namespace, key);
  }

  #touchNameOf(namespace: string, listed: string): void {
    // as listed and NFC-composed, since HFS+ lists names decomposed
    for (const key of new Set([listed, listed.normalize("NFC")])) {
      this.#touchNameOfKey(namespace, key);
    }
  }

  #touchNameOfKey(namespace: string, key: string): void {
    const name = dataNameOfKey(key);
    if (name === undefined) return;
    // a key whose segments name no valid model is checked as a file only
    try {
      PartitionKey.forModel(name.type, name.modelId);
    } catch {
      return;
    }
    this.addName({ namespace, ...name });
  }

  /** why a name could not be scoped, once one could not */
  get unscopable(): string | undefined {
    return this.#unscopable;
  }

  partitions(): ScopedPartition[] {
    return [...this.#partitions.values()]
      .map((entry) => ({
        namespace: entry.namespace,
        partition: entry.partition,
        names: [...entry.names].sort(),
      }))
      .sort((a, b) =>
        a.namespace === b.namespace
          ? compare(a.partition.toString(), b.partition.toString())
          : compare(a.namespace, b.namespace)
      );
  }

  names(): CatalogNameKey[] {
    return this.partitions().flatMap(({ namespace, partition, names }) => {
      const identity = partition.identity;
      if (identity.kind !== "model") return [];
      return names.map((name) => ({
        namespace,
        type: identity.type,
        modelId: identity.id,
        name,
      }));
    });
  }

  get nameCount(): number {
    let count = 0;
    for (const entry of this.#partitions.values()) count += entry.names.size;
    return count;
  }

  get partitionCount(): number {
    return this.#partitions.size;
  }

  keysToCheck(): { readonly namespace: string; readonly keys: string[] }[] {
    return [...this.#check]
      .map(([namespace, keys]) => ({ namespace, keys: [...keys].sort() }))
      .sort((a, b) => compare(a.namespace, b.namespace));
  }

  get keysToCheckCount(): number {
    let count = 0;
    for (const keys of this.#check.values()) count += keys.size;
    return count;
  }

  removals(): {
    readonly namespace: string;
    readonly key: string;
    readonly path: string;
  }[] {
    return [...this.#remove.values()];
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
