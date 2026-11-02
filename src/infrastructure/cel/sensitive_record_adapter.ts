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
 * other-namespace records pass through with tags unread, so foreign tags cannot
 * choose which secrets are read; a tagged own record is validated whole first
 * and refused with secret_reference_invalid
 */

import {
  isForeignToReader,
  type NamespaceReader,
} from "../../domain/data/namespace.ts";
import { SECRET_REFERENCE_INVALID } from "../../domain/expressions/errors.ts";
import {
  parseStoredVaultReference,
  readSensitiveFieldJsonPlaces,
  readSensitiveFieldPlaces,
  type SensitiveFieldsTag,
  SensitiveFieldsTagInvalidError,
  UNSAFE_PATH_SEGMENTS,
} from "../../domain/models/data_writer.ts";
import type { SecretReference } from "../../domain/vaults/secret_bag_registry.ts";
import { analyzeExpression } from "../../domain/expressions/expression_references.ts";
import {
  type StepOutputGroup,
  type StepOutputSources,
  stepOutputSourcesOf,
} from "../../domain/expressions/step_output_sources.ts";
import { isPlainMap } from "./secret_boundary.ts";
import {
  recordSecretRead,
  recordSensitiveReference,
  refuse,
} from "./secret_fault_context.ts";
import { dataReferenceSecret, type Secret } from "./secret_value.ts";

/**
 * The accessor a record was read through, named in refusals and locations.
 * A step output names its step as the expression reads it
 * (`steps.seed.outputs`); a child output is read through its parent step.
 */
export type DataAccessor =
  | "data.latest"
  | "data.version"
  | "data.findBySpec"
  | "data.findByTag"
  | "data.query"
  | "model.<name>.resource"
  | "model.method"
  | `steps.${string}.outputs`;

interface RecordLike {
  readonly tags: Record<string, string>;
  readonly attributes: Record<string, unknown>;
  readonly namespace: string;
  readonly modelName: string;
  readonly id: string;
  readonly version: number;
}

function isRecordLike(
  value: unknown,
): value is RecordLike & Record<string, unknown> {
  return isPlainMap(value) && isPlainMap(value.tags) &&
    isPlainMap(value.attributes) && typeof value.namespace === "string";
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function defineValue(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

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

/** the query view keeps one by identity when a projection returns it */
const views = new WeakSet<object>();

export function isAdaptedView(value: unknown): boolean {
  return typeof value === "object" && value !== null && views.has(value);
}

function describeRecord(record: RecordLike, accessor: DataAccessor): string {
  return `model '${record.modelName}' record ${record.id} version ${record.version} (${accessor})`;
}

function valueAt(
  attributes: Record<string, unknown>,
  path: readonly string[],
): unknown {
  let current: unknown = attributes;
  for (const segment of path) {
    if (!isContainer(current) || !Object.hasOwn(current, segment)) {
      return undefined;
    }
    current = current[segment];
  }
  return current;
}

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

// JSON, so a record key holding any character, NUL included, keeps paths
// apart.
const pathKey = (path: readonly string[]): string => JSON.stringify(path);

class Validation {
  private readonly root: PathNode = { children: new Map() };
  private readonly location: string;
  private readonly jsonPlaces: ReadonlySet<string>;

  constructor(
    private readonly record: RecordLike,
    private readonly accessor: DataAccessor,
  ) {
    this.location = `${accessor} of ${describeRecord(record, accessor)}`;
    this.jsonPlaces = new Set(
      readSensitiveFieldJsonPlaces(record.tags).map(pathKey),
    );
  }

  private refuse(reason: string): never {
    return refuse(
      `an invalid sensitive-field reference in ${
        describeRecord(this.record, this.accessor)
      }: ${reason}`,
      SECRET_REFERENCE_INVALID,
    );
  }

  private leaf(path: readonly string[], reference: SecretReference): void {
    recordSensitiveReference(reference);
    nodeAt(this.root, path).secret = dataReferenceSecret(
      reference,
      `${this.location}, field '${path.join(".")}'`,
      this.jsonPlaces.has(pathKey(path)),
    );
  }

  private notReference(path: readonly string[]): never {
    return this.refuse(
      `field '${path.join(".")}' is not a stored vault reference`,
    );
  }

  private assertSafeName(name: string): void {
    if (UNSAFE_PATH_SEGMENTS.has(name)) {
      this.refuse(`the unsafe field name '${name}'`);
    }
  }

  /**
   * Under the star tag every leaf, at any depth, is absent, null or a
   * stored reference; containers only ever hold a child's reference.
   */
  private walkAll(value: unknown, path: string[]): void {
    if (value === undefined || value === null) return;
    const reference = typeof value === "string"
      ? parseStoredVaultReference(value)
      : undefined;
    if (reference !== undefined) {
      this.leaf(path, reference);
      return;
    }
    if (!isContainer(value)) this.notReference(path);
    for (const key of Object.keys(value)) {
      this.assertSafeName(key);
      this.walkAll(value[key], [...path, key]);
    }
  }

  /**
   * A container the writer left at a tagged parent path holds nothing but
   * its tagged descendants: every leaf in it is at a tagged path, where the
   * tagged path's own entry decides, or holds nothing.
   */
  private assertTaggedLeaves(
    value: Record<string, unknown>,
    path: readonly string[],
    tagged: ReadonlySet<string>,
  ): void {
    for (const key of Object.keys(value)) {
      const childPath = [...path, key];
      if (tagged.has(pathKey(childPath))) continue;
      const child = value[key];
      if (child === undefined || child === null) continue;
      if (isContainer(child)) {
        this.assertTaggedLeaves(child, childPath, tagged);
        continue;
      }
      this.refuse(
        `field '${
          childPath.join(".")
        }' is not a tagged field of a sensitive container`,
      );
    }
  }

  run(tag: SensitiveFieldsTag): PathNode {
    if (tag.kind === "all") {
      for (const key of Object.keys(this.record.attributes)) {
        this.assertSafeName(key);
        this.walkAll(this.record.attributes[key], [key]);
      }
      return this.root;
    }
    if (tag.kind !== "paths") return this.root;
    const tagged = new Set(tag.paths.map(pathKey));
    // A path that is a strict prefix of another tagged path may hold a
    // container: the writer stores the child's reference inside it.
    const prefixes = new Set<string>();
    for (const path of tag.paths) {
      for (let length = 1; length < path.length; length++) {
        prefixes.add(pathKey(path.slice(0, length)));
      }
    }
    for (const path of tag.paths) {
      const value = valueAt(this.record.attributes, path);
      if (value === undefined || value === null) continue;
      const reference = typeof value === "string"
        ? parseStoredVaultReference(value)
        : undefined;
      if (reference !== undefined) {
        this.leaf(path, reference);
        continue;
      }
      if (isContainer(value) && prefixes.has(pathKey(path))) {
        this.assertTaggedLeaves(value, path, tagged);
        continue;
      }
      this.notReference(path);
    }
    return this.root;
  }
}

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
        isContainer(value)
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
    views.add(view);
    return view;
  }
  const view: object = Object.create(Object.getPrototypeOf(original));
  const source = original as Record<string, unknown>;
  for (const key of Object.keys(source)) define(view, key, source[key]);
  views.add(view);
  return view;
}

/**
 * reader is undefined when every record is the reader's own by construction, as
 * the model map's are
 */
export function adaptDataRecord(
  record: unknown,
  reader: NamespaceReader | undefined,
  accessor: DataAccessor,
): unknown {
  if (!isRecordLike(record)) return record;
  if (reader !== undefined && isForeignToReader(record.namespace, reader)) {
    return record;
  }
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldPlaces(record.tags);
  } catch (error) {
    if (error instanceof SensitiveFieldsTagInvalidError) {
      refuse(
        `an invalid sensitive-field reference in ${
          describeRecord(record, accessor)
        }: ${error.message}`,
        SECRET_REFERENCE_INVALID,
      );
    }
    throw error;
  }
  if (tag.kind === "none") return record;
  if (tag.kind === "paths" && tag.paths.length === 0) return record;
  const attributes = viewOf(
    record.attributes,
    new Validation(record, accessor).run(tag),
  );
  const view: Record<string, unknown> = Object.create(
    Object.getPrototypeOf(record),
  );
  for (const key of Object.keys(record)) {
    const aliased = key === "attributes" ||
      (key === "content" && record.content === record.attributes);
    defineValue(view, key, aliased ? attributes : record[key]);
  }
  views.add(view);
  return view;
}

/**
 * adapted so each tagged field is a Secret, as data.latest returns them, so a
 * stored reference never comes back as a comparable string; the record is the
 * run's own, so no namespace check applies
 */
export function adaptModelMethodResult(result: unknown): unknown {
  if (!isRecordLike(result)) return result;
  const adapted = adaptDataRecord(result, undefined, "model.method");
  return (adapted as RecordLike).attributes;
}

/**
 * a rejected adaptation is a refusal cel-js observes on await; the Promise is
 * also marked handled so an abandoned evaluation leaves no unobserved rejection
 */
export function adaptDataResult(
  result: unknown,
  reader: NamespaceReader,
  accessor: DataAccessor,
): unknown {
  if (result instanceof Promise) {
    const adapted = result.then((value) =>
      adaptDataResult(value, reader, accessor)
    );
    adapted.catch(() => {});
    return adapted;
  }
  if (Array.isArray(result)) {
    return result.map((item) => adaptDataRecord(item, reader, accessor));
  }
  return adaptDataRecord(result, reader, accessor);
}

/**
 * with reader undefined every record is adapted, since the map holds only this
 * repository's records; a known namespace is checked as well, as defense in
 * depth
 */
export function modelMapView(
  model: unknown,
  reader: NamespaceReader | undefined,
): unknown {
  if (!isPlainMap(model)) return model;
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
      (key) => adaptDataRecord(instances[key], reader, "model.<name>.resource"),
    );
  const specsView = (specs: Record<string, unknown>): object =>
    lazyMap(specs, (key) => {
      const instances = specs[key];
      return isPlainMap(instances) ? instancesView(instances) : instances;
    });
  const modelDataView = (modelData: Record<string, unknown>): object =>
    lazyMap(modelData, (key) => {
      const value = modelData[key];
      return key === "resource" && isPlainMap(value) ? specsView(value) : value;
    });
  return lazyMap(model, (key) => {
    const value = model[key];
    return isPlainMap(value) ? modelDataView(value) : value;
  });
}

/**
 * all of a step's records are adapted on first read, selected or not, so every
 * reference is recorded and a denied one fails before its result is used; a
 * step named __proto__ reaches nothing shared
 */
export function stepsView(
  steps: unknown,
  reader: NamespaceReader | undefined,
): unknown {
  if (!isPlainMap(steps)) return steps;
  const view: object = Object.create(Object.getPrototypeOf(steps));
  for (const name of Object.keys(steps)) {
    defineLazy(
      view,
      name,
      () => stepContextView(name, steps[name], reader),
    );
  }
  return view;
}

function stepContextView(
  stepName: string,
  context: unknown,
  reader: NamespaceReader | undefined,
): unknown {
  const sources = stepOutputSourcesOf(context);
  if (sources === undefined || !isPlainMap(context)) return context;
  const view: object = Object.create(Object.getPrototypeOf(context));
  for (const key of Object.keys(context)) {
    if (key !== "outputs") defineValue(view, key, context[key]);
  }
  defineLazy(
    view,
    "outputs",
    () => mergedOutputsView(stepName, sources, reader),
  );
  return view;
}

/**
 * records are walked last to first keeping the first definition of each key; of
 * two groups at one path only the last counts, as resolveChildOutputs records
 * it
 */
function mergedOutputsView(
  stepName: string,
  sources: StepOutputSources,
  reader: NamespaceReader | undefined,
): Record<string, unknown> {
  const accessor: DataAccessor = `steps.${stepName}.outputs`;
  const root: Record<string, unknown> = Object.create(null);
  const lastAtPath = new Map<string, StepOutputGroup>();
  for (const group of sources) lastAtPath.set(pathKey(group.path), group);
  for (const group of lastAtPath.values()) {
    let target = root;
    for (const segment of group.path) {
      const existing = Object.hasOwn(target, segment)
        ? target[segment]
        : undefined;
      if (isPlainMap(existing)) {
        target = existing;
        continue;
      }
      const next: Record<string, unknown> = Object.create(null);
      defineValue(target, segment, next);
      target = next;
    }
    for (let index = group.records.length - 1; index >= 0; index--) {
      const adapted = adaptDataRecord(
        group.records[index],
        reader,
        accessor,
      );
      if (!isRecordLike(adapted)) continue;
      const attributes = adapted.attributes;
      for (const key of Object.keys(attributes)) {
        if (Object.hasOwn(target, key)) continue;
        Object.defineProperty(
          target,
          key,
          Object.getOwnPropertyDescriptor(attributes, key)!,
        );
      }
    }
  }
  return root;
}

/**
 * read as adaptDataRecord would but without recording or refusing; a tag or
 * field the adapter would refuse yields nothing here and is refused when the
 * record is adapted
 */
function storedReferencesOf(record: RecordLike): SecretReference[] {
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldPlaces(record.tags);
  } catch (error) {
    if (error instanceof SensitiveFieldsTagInvalidError) return [];
    throw error;
  }
  const references: SecretReference[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === "string") {
      const reference = parseStoredVaultReference(value);
      if (reference !== undefined) references.push(reference);
      return;
    }
    if (!isContainer(value)) return;
    for (const key of Object.keys(value)) collect(value[key]);
  };
  if (tag.kind === "all") {
    collect(record.attributes);
  } else if (tag.kind === "paths") {
    for (const path of tag.paths) collect(valueAt(record.attributes, path));
  }
  return references;
}

/**
 * an expression that reads either map by a computed key names nothing, and a
 * step context without sources holds nothing, so such a read still fails closed
 * at evaluation
 */
export function synchronousSensitiveReferences(
  celExpression: string,
  model: unknown,
  reader: NamespaceReader | undefined,
  steps?: unknown,
): SecretReference[] {
  const references: SecretReference[] = [];
  const own = (record: RecordLike): boolean =>
    reader === undefined || !isForeignToReader(record.namespace, reader);
  const analysis = analyzeExpression(celExpression);
  if (isPlainMap(model)) {
    for (const [ref, read] of analysis.syncDataReads) {
      if (!read.resource) continue;
      const modelData = model[ref];
      if (!isPlainMap(modelData)) continue;
      const specs = modelData["resource"];
      if (!isPlainMap(specs)) continue;
      for (const spec of Object.keys(specs)) {
        const instances = specs[spec];
        if (!isPlainMap(instances)) continue;
        for (const instance of Object.keys(instances)) {
          const record = instances[instance];
          if (!isRecordLike(record) || !own(record)) continue;
          for (const reference of storedReferencesOf(record)) {
            references.push(reference);
          }
        }
      }
    }
  }
  if (isPlainMap(steps)) {
    for (const name of analysis.stepTargets) {
      for (const group of stepOutputSourcesOf(steps[name]) ?? []) {
        for (const record of group.records) {
          if (!isRecordLike(record) || !own(record)) continue;
          for (const reference of storedReferencesOf(record)) {
            references.push(reference);
          }
        }
      }
    }
  }
  return references;
}
