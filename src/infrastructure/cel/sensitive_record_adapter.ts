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
 * The accessor adapter of typed secrets (design/enablers/typed-secrets.md
 * Section 6.1, typed-secrets 3.3). The tagged sensitive fields of a trusted
 * own-namespace data record reach CEL as data-origin `Secret` values, never
 * as the stored reference text and never as plaintext. This module is the
 * only producer of data-origin Secrets.
 *
 * - A record from another namespace is returned as stored, its tag unread:
 *   that namespace's tags must not choose which of this repository's secrets
 *   are read (swamp-club#3306), and its references name vaults this
 *   repository does not have. A record with no tag is returned as it is.
 * - A tagged record is validated whole before CEL sees it. The tag is read
 *   strictly. The star value tags every own top-level field of the
 *   attributes; a list tags each dot-path, walked through own properties
 *   only, as the writer's own lookup walks. A tagged value that is absent or
 *   null stays so, a stored reference becomes a Secret, and a tagged path
 *   that is a strict prefix of another tagged path may hold a container
 *   instead, which is the writer's parent-and-child artifact. Anything else
 *   refuses with `secret_reference_invalid`, recording the fault first so an
 *   absorbing operator cannot hide it. The refusal names the accessor, the
 *   model, the record id, the version and the field path: never the data
 *   name, which a vary suffix can fill from a resolved secret
 *   (swamp-club#3585), and never a value.
 * - Every reference the record holds is recorded in the evaluation's fault
 *   scope, selected or not, and the evaluator authorizes each after release.
 * - The adapter builds new objects. Each tagged leaf is a getter that returns
 *   one cached Secret and counts a read for the container rule (Section 4.3
 *   item 5); untagged values are carried as they are; the record, the
 *   context and the model map are never mutated. For a JSON resource
 *   `content` and `attributes` are one object, and stay one view. When the
 *   run's registry is non-empty the boundary conversion views the bindings
 *   too, so a leaf read through the model map counts twice; the container
 *   rule is a boolean, so that is harmless.
 * - The model map view is lazy: the original `resource` and `file` loaders
 *   fire only when CEL reads them, each original object has one view per
 *   evaluation, so `model.<name>` and `model["<id>"]` share it, and each
 *   record is adapted at first read.
 */

import { SECRET_REFERENCE_INVALID } from "../../domain/expressions/errors.ts";
import {
  parseStoredVaultReference,
  readSensitiveFieldsTag,
  type SensitiveFieldsTag,
  SensitiveFieldsTagInvalidError,
} from "../../domain/models/data_writer.ts";
import {
  recordSecretRead,
  recordSensitiveReference,
  refuse,
} from "./secret_fault_context.ts";
import { dataReferenceSecret, type Secret } from "./secret_value.ts";

/** The accessor a record was read through, named in refusals and locations. */
export type DataAccessor =
  | "data.latest"
  | "data.version"
  | "data.findBySpec"
  | "data.findByTag"
  | "model.<name>.resource";

/** The fields of a record the adapter reads. Anything else passes through. */
interface RecordLike {
  readonly tags: Record<string, string>;
  readonly attributes: Record<string, unknown>;
  readonly namespace: string;
  readonly modelName: string;
  readonly id: string;
  readonly version: number;
}

/** A path segment that would reach a prototype rather than a field. */
const UNSAFE_FIELD_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/** Whether cel-js reads `value` as a map: a plain object, any prototype. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || prototype === Object.prototype;
}

function isRecordLike(
  value: unknown,
): value is RecordLike & Record<string, unknown> {
  return isPlainObject(value) && isPlainObject(value.tags) &&
    isPlainObject(value.attributes) && typeof value.namespace === "string";
}

function defineValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * A getter that reads once, on first access, and answers the same value
 * afterwards. Nothing it reads is read before CEL asks for the key.
 */
function defineLazy(target: object, key: string, read: () => unknown): void {
  let done = false;
  let value: unknown;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: false,
    get: () => {
      if (!done) {
        value = read();
        done = true;
      }
      return value;
    },
  });
}

/** Identifies a record without its data name or any value. */
function describeRecord(record: RecordLike, accessor: DataAccessor): string {
  return `model '${record.modelName}' record ${record.id} version ${record.version} (${accessor})`;
}

function refuseInvalid(
  record: RecordLike,
  accessor: DataAccessor,
  reason: string,
): never {
  return refuse(
    `an invalid sensitive-field reference in ${
      describeRecord(record, accessor)
    }: ${reason}`,
    SECRET_REFERENCE_INVALID,
  );
}

/** The value at `path` walked through own properties only, or undefined. */
function valueAt(
  attributes: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = attributes;
  for (const segment of path) {
    if (typeof current !== "object" || current === null) return undefined;
    if (!Object.hasOwn(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

/** The tagged paths as a trie, each node holding the Secret read there. */
interface PathNode {
  secret?: Secret;
  readonly children: Map<string, PathNode>;
}

function nodeAt(root: PathNode, path: readonly string[]): PathNode {
  let node = root;
  for (const segment of path) {
    let child = node.children.get(segment);
    if (child === undefined) {
      child = { children: new Map() };
      node.children.set(segment, child);
    }
    node = child;
  }
  return node;
}

/** The paths a tag names on `record`, as segment lists. */
function taggedPaths(
  record: RecordLike,
  tag: SensitiveFieldsTag,
  accessor: DataAccessor,
): readonly (readonly string[])[] {
  if (tag.kind === "paths") return tag.paths;
  return Object.keys(record.attributes).map((key) => {
    if (UNSAFE_FIELD_NAMES.has(key)) {
      refuseInvalid(record, accessor, `the unsafe field name '${key}'`);
    }
    return [key];
  });
}

/**
 * Validates every tagged path of `record`, records each reference it holds,
 * and returns the trie of Secrets the view hands out.
 */
function validate(
  record: RecordLike,
  tag: SensitiveFieldsTag,
  accessor: DataAccessor,
): PathNode {
  const root: PathNode = { children: new Map() };
  const paths = taggedPaths(record, tag, accessor);
  // A path that is a strict prefix of another tagged path may hold a
  // container: the writer stores the child's reference inside it.
  const prefixes = new Set<string>();
  for (const path of paths) {
    for (let length = 1; length < path.length; length++) {
      prefixes.add(path.slice(0, length).join("\u0000"));
    }
  }
  const location = `${accessor} of ${describeRecord(record, accessor)}`;
  for (const path of paths) {
    const value = valueAt(record.attributes, path);
    if (value === undefined || value === null) continue;
    const reference = typeof value === "string"
      ? parseStoredVaultReference(value)
      : undefined;
    if (reference !== undefined) {
      recordSensitiveReference(reference);
      nodeAt(root, path).secret = dataReferenceSecret(
        reference,
        `${location}, field '${path.join(".")}'`,
      );
      continue;
    }
    if (typeof value === "object" && prefixes.has(path.join("\u0000"))) {
      continue;
    }
    refuseInvalid(
      record,
      accessor,
      `field '${path.join(".")}' is not a stored vault reference`,
    );
  }
  return root;
}

/**
 * A view of `original` where each path the trie names a Secret at is a
 * recording getter, each container a path passes through is viewed in turn,
 * and everything else is carried as it is.
 */
function viewOf(original: object, node: PathNode): object {
  const define = (view: object, key: string, value: unknown): void => {
    const child = node.children.get(key);
    if (child?.secret !== undefined) {
      const secret = child.secret;
      Object.defineProperty(view, key, {
        enumerable: true,
        configurable: false,
        get: () => {
          recordSecretRead();
          return secret;
        },
      });
      return;
    }
    const viewed = child !== undefined && child.children.size > 0 &&
        typeof value === "object" && value !== null
      ? viewOf(value, child)
      : value;
    defineValue(view, key, viewed);
  };
  if (Array.isArray(original)) {
    const view: unknown[] = [];
    for (let index = 0; index < original.length; index++) {
      if (index in original) define(view, String(index), original[index]);
    }
    view.length = original.length;
    return view;
  }
  const view: object = Object.create(Object.getPrototypeOf(original));
  const source = original as Record<string, unknown>;
  for (const key of Object.keys(source)) define(view, key, source[key]);
  return view;
}

/**
 * `record` as CEL reads it: unchanged when it is not a record, belongs to
 * another namespace or carries no tag; otherwise a new record whose tagged
 * fields are data-origin Secrets, validated whole first.
 */
export function adaptDataRecord(
  record: unknown,
  ownNamespace: string,
  accessor: DataAccessor,
): unknown {
  if (!isRecordLike(record)) return record;
  if (record.namespace !== ownNamespace) return record;
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldsTag(record.tags);
  } catch (error) {
    if (error instanceof SensitiveFieldsTagInvalidError) {
      refuseInvalid(record, accessor, error.message);
    }
    throw error;
  }
  if (tag.kind === "none") return record;
  if (tag.kind === "paths" && tag.paths.length === 0) return record;
  const attributes = viewOf(record.attributes, validate(record, tag, accessor));
  const view: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(record),
  );
  for (const key of Object.keys(record)) {
    const aliased = key === "attributes" ||
      (key === "content" && record.content === record.attributes);
    defineValue(view, key, aliased ? attributes : record[key]);
  }
  return view;
}

/**
 * {@link adaptDataRecord} over what an accessor answers: a record, a list of
 * records, null, or a Promise of one of those. A rejected adaptation is a
 * refusal cel-js observes when it awaits the result; the Promise is also
 * marked handled, so an evaluation abandoned before that leaves no
 * unobserved rejection.
 */
export function adaptDataResult(
  result: unknown,
  ownNamespace: string,
  accessor: DataAccessor,
): unknown {
  if (result instanceof Promise) {
    const adapted = result.then((value) =>
      adaptDataResult(value, ownNamespace, accessor)
    );
    adapted.catch(() => {});
    return adapted;
  }
  if (Array.isArray(result)) {
    return result.map((item) => adaptDataRecord(item, ownNamespace, accessor));
  }
  return adaptDataRecord(result, ownNamespace, accessor);
}

/**
 * A lazy view of the plain model map for one evaluation: each
 * `model.<name>.resource.<spec>.<instance>` record is adapted when CEL first
 * reads it, every other key is passed through, and the original lazy
 * `resource` and `file` loaders fire only when CEL reads them. One view per
 * original object, so a model indexed by name and by id reads alike. Any
 * value that is not a plain map is returned as it is.
 */
export function modelMapView(model: unknown, ownNamespace: string): unknown {
  if (!isPlainObject(model)) return model;
  const views = new WeakMap<object, object>();
  const shared = (original: object, build: () => object): object => {
    const existing = views.get(original);
    if (existing !== undefined) return existing;
    const built = build();
    views.set(original, built);
    return built;
  };
  const lazyMap = (
    original: Record<string, unknown>,
    read: (key: string) => unknown,
  ): object =>
    shared(original, () => {
      const view: object = Object.create(Object.getPrototypeOf(original));
      for (const key of Object.keys(original)) {
        defineLazy(view, key, () => read(key));
      }
      return view;
    });
  const instancesView = (instances: Record<string, unknown>): object =>
    lazyMap(
      instances,
      (key) =>
        adaptDataRecord(instances[key], ownNamespace, "model.<name>.resource"),
    );
  const specsView = (specs: Record<string, unknown>): object =>
    lazyMap(specs, (key) => {
      const instances = specs[key];
      return isPlainObject(instances) ? instancesView(instances) : instances;
    });
  const modelDataView = (modelData: Record<string, unknown>): object =>
    lazyMap(modelData, (key) => {
      const value = modelData[key];
      return key === "resource" && isPlainObject(value)
        ? specsView(value)
        : value;
    });
  return lazyMap(model, (key) => {
    const value = model[key];
    return isPlainObject(value) ? modelDataView(value) : value;
  });
}
