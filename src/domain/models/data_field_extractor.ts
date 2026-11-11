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

import type { z } from "zod";
import { indexPath, keyPath } from "../expressions/provenance_map.ts";
import {
  type FieldMetadata,
  findFieldMetadata,
  findFieldsWhere,
  findValuesWithMetadata,
} from "./zod_field_metadata.ts";
import type { ModelDefinition } from "./model.ts";

interface DataMetadata {
  data?: boolean;
}

function isData(meta: FieldMetadata): boolean {
  return (meta as DataMetadata).data === true;
}

export type KeyPath = readonly (string | number)[];

/**
 * where args holds a value at or under a field marked `.meta({ data: true })`,
 * the root included; pipeline inputs that may reach a marked output count, so
 * a gap marks more as data, never less
 */
export function dataArgumentKeys(
  schema: z.ZodTypeAny,
  args: Record<string, unknown>,
): KeyPath[] {
  const found = findValuesWithMetadata(schema, args, isData, {
    rawInputs: true,
    reportRoot: true,
  });
  const seen = new Map<string, KeyPath>();
  for (const { keys } of found) seen.set(JSON.stringify(keys), keys);
  return [...seen.values()];
}

export function dataArgumentPaths(
  schema: z.ZodTypeAny,
  args: Record<string, unknown>,
): string[] {
  return dataArgumentKeys(schema, args).map((keys) => keysToPath(keys));
}

export function keysToPath(keys: KeyPath, base = ""): string {
  return keys.reduce<string>(
    (path, key) =>
      typeof key === "number" ? indexPath(path, key) : keyPath(path, key),
    base,
  );
}

/** the dotted form `--input a.b=` writes, split as setNestedValue splits it */
export function dottedKeyPath(key: string): KeyPath {
  return key.split(".");
}

/**
 * the path as it sits in value, a segment under an array read as its index, so
 * a dotted key and the walker name one place; undefined when nothing is there
 */
export function canonicalKeyPath(
  value: unknown,
  keys: KeyPath,
): KeyPath | undefined {
  const canonical: (string | number)[] = [];
  let current = value;
  for (const key of keys) {
    if (Array.isArray(current)) {
      const index = typeof key === "number"
        ? key
        : /^(0|[1-9][0-9]*)$/.test(key)
        ? Number(key)
        : -1;
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      canonical.push(index);
      current = current[index];
    } else if (
      current !== null && typeof current === "object" &&
      typeof key === "string" && Object.hasOwn(current, key)
    ) {
      canonical.push(key);
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return canonical;
}

export function valueAt(value: unknown, keys: KeyPath): unknown {
  let current = value;
  for (const key of keys) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}

/** a copy of value with what sits at each path removed; the root empties it */
export function omitKeyPaths(
  value: Record<string, unknown>,
  paths: readonly KeyPath[],
): Record<string, unknown> {
  if (paths.some((keys) => keys.length === 0)) return {};
  const copy = structuredClone(value);
  for (const keys of paths) {
    const parent = valueAt(copy, keys.slice(0, -1));
    if (parent === null || typeof parent !== "object") continue;
    const last = keys[keys.length - 1];
    if (Array.isArray(parent) && typeof last === "number") {
      parent[last] = null;
    } else {
      delete (parent as Record<string | number, unknown>)[last];
    }
  }
  return copy;
}

/**
 * global arguments are saved into the definition and evaluated on every later
 * run, so a data marker there would promise what the run cannot keep
 */
export function assertNoDataGlobalArguments(
  model: Pick<ModelDefinition, "type" | "globalArguments">,
): void {
  const schema = model.globalArguments;
  if (!schema) return;
  const marked = findFieldMetadata(schema, isData) !== undefined
    ? [""]
    : findFieldsWhere(schema, (chain) => chain.some(isData));
  if (marked.length === 0) return;
  const field = marked[0] === "" ? "the schema" : `field '${marked[0]}'`;
  throw new Error(
    `Behavior type '${model.type.normalized}' global arguments: ${field} is ` +
      `marked data: true. Global arguments are saved into the definition and ` +
      `evaluated on later runs, so only method arguments can be marked data; ` +
      `move the field to a method argument.`,
  );
}
