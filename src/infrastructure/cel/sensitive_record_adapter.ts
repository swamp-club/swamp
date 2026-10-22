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
 * - A tagged record is validated whole before CEL sees it, against what the
 *   writer can store. The tag is read strictly. Under the star value every
 *   field is sensitive at any depth: the writer stores each top-level field
 *   as a reference, and a container appears only where a schema marks a
 *   parent and a child inside it sensitive, holding the child's reference.
 *   Under a path list each path is walked through own properties only, as
 *   the writer's own lookup walks; a tagged value that is absent or null
 *   stays so, a stored reference becomes a Secret, and a tagged path that is
 *   a strict prefix of another tagged path may hold a container whose leaves
 *   are all tagged, which is the writer's parent-and-child artifact. Anything
 *   else refuses with `secret_reference_invalid`, recording the fault first so
 *   an absorbing operator cannot hide it. The refusal names the accessor, the
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
 * - The steps view (typed-secrets 4.2) reads `steps.<name>.outputs` as the
 *   merge of the adapted records the outputs came from, which the step
 *   context carries as its output sources (`step_output_sources.ts`), so a
 *   tagged output field is a Secret too. See {@link stepsView}.
 */

import { SECRET_REFERENCE_INVALID } from "../../domain/expressions/errors.ts";
import {
  parseStoredVaultReference,
  readSensitiveFieldsTag,
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

/** The fields of a record the adapter reads. Anything else passes through. */
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

/**
 * Every view this module built: the attribute views and the record views of
 * {@link adaptDataRecord}. The query view keeps one by identity when a
 * projection returns it (design/enablers/typed-secrets.md Section 6.2).
 */
const views = new WeakSet<object>();

/** Whether `value` is a view this module built. */
export function isAdaptedView(value: unknown): boolean {
  return typeof value === "object" && value !== null && views.has(value);
}

/** Identifies a record without its data name or any value. */
function describeRecord(record: RecordLike, accessor: DataAccessor): string {
  return `model '${record.modelName}' record ${record.id} version ${record.version} (${accessor})`;
}

/** The value at `path` walked through own properties only, or undefined. */
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

const pathKey = (path: readonly string[]): string => path.join("\u0000");

/**
 * Validates every sensitive field of `record` against what the writer can
 * store, records each reference it holds, and returns the trie of Secrets
 * the view hands out.
 */
class Validation {
  private readonly root: PathNode = { children: new Map() };
  private readonly location: string;

  constructor(
    private readonly record: RecordLike,
    private readonly accessor: DataAccessor,
  ) {
    this.location = `${accessor} of ${describeRecord(record, accessor)}`;
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
 * `record` as CEL reads it: unchanged when it is not a record, belongs to a
 * namespace other than `ownNamespace` or carries no tag; otherwise a new
 * record whose tagged fields are data-origin Secrets, validated whole first.
 * `ownNamespace` is undefined when every record is the reader's own by
 * construction, as the model map's are: the resolver builds it from the
 * local repository alone.
 */
export function adaptDataRecord(
  record: unknown,
  ownNamespace: string | undefined,
  accessor: DataAccessor,
): unknown {
  if (!isRecordLike(record)) return record;
  if (ownNamespace !== undefined && record.namespace !== ownNamespace) {
    return record;
  }
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldsTag(record.tags);
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
 * What `model.method` returns to CEL (design/enablers/typed-secrets.md
 * Section 4.5 item 4): the attributes of the stored record its delegate
 * returned in a typed run, adapted so each tagged field is a `Secret`, as
 * `data.latest` returns them, so a stored reference never comes back as a
 * comparable string. A value that is not a record, the delegate's raw
 * result, is returned as it is. The record is the run's own by
 * construction, so no namespace check applies.
 */
export function adaptModelMethodResult(result: unknown): unknown {
  if (!isRecordLike(result)) return result;
  const adapted = adaptDataRecord(result, undefined, "model.method");
  return (adapted as RecordLike).attributes;
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
 * value that is not a plain map is returned as it is. The map holds only
 * this repository's records, so with `ownNamespace` undefined every record
 * is adapted; a known namespace is checked as well, as defense in depth.
 */
export function modelMapView(
  model: unknown,
  ownNamespace: string | undefined,
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
      (key) =>
        adaptDataRecord(instances[key], ownNamespace, "model.<name>.resource"),
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
 * A lazy view of the `steps` map for one evaluation (typed-secrets 4.2). A
 * step context that carries its output sources (`step_output_sources.ts`)
 * reads its `outputs` as the merge of the adapted records of every group,
 * built on first read: each record is adapted as `data.latest` adapts one,
 * under the accessor `steps.<name>.outputs`, and its attributes are laid
 * over the group's path in write order, so a later record's field wins, as
 * the flat merge decided, a later group at the same path replaces the
 * earlier one, as a repeated child step name does in the flat outputs, and
 * a tagged field stays a recording getter. The maps the view builds have no
 * prototype and the path walk steps into own properties only, so a step
 * named `__proto__` reaches nothing shared. All of a step's records are
 * adapted on that first read, selected or not, so
 * every reference is recorded and a denied one fails the evaluation before
 * its result is used (the set-read rule). A context with no sources, such
 * as the payload of a signal wait, passes through unchanged, as does
 * anything that is not a plain map. The original map and contexts are
 * never mutated.
 *
 * The sources of a reconstructed or child output carry the tag the run
 * record kept, as today's reader takes it. A tag tampered with there can
 * only refuse (a tagged path holding no stored reference) or leave a field
 * as inert reference text: it names only content the datastore holds, and
 * every reference is authorized under the run's access before its result
 * is used, so it cannot load what that access would not allow.
 */
export function stepsView(
  steps: unknown,
  ownNamespace: string | undefined,
): unknown {
  if (!isPlainMap(steps)) return steps;
  const view: object = Object.create(Object.getPrototypeOf(steps));
  for (const name of Object.keys(steps)) {
    defineLazy(
      view,
      name,
      () => stepContextView(name, steps[name], ownNamespace),
    );
  }
  return view;
}

/** One step context with its outputs viewed, or the context as it is. */
function stepContextView(
  stepName: string,
  context: unknown,
  ownNamespace: string | undefined,
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
    () => mergedOutputsView(stepName, sources, ownNamespace),
  );
  return view;
}

/**
 * The outputs a step's sources merge to: each group's adapted records laid
 * over the group's path, a later record's field winning. Records are walked
 * last to first, keeping the first definition of each key, so the winning
 * getter is defined once and keeps the adapter's descriptor. Of two groups
 * at one path only the last counts: a child step name repeated across jobs
 * replaces the earlier step's outputs, as `resolveChildOutputs` records it.
 */
function mergedOutputsView(
  stepName: string,
  sources: StepOutputSources,
  ownNamespace: string | undefined,
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
        ownNamespace,
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
 * The stored references a record's sensitive-fields tag names, read as
 * {@link adaptDataRecord} would read them and without recording or
 * refusing anything: the leaves under a star tag, and the values at each
 * tagged path, including the leaves of a container the writer left at a
 * tagged prefix. A tag or a field the adapter would refuse yields nothing
 * here and is refused when the record is adapted.
 */
function storedReferencesOf(record: RecordLike): SecretReference[] {
  let tag: SensitiveFieldsTag;
  try {
    tag = readSensitiveFieldsTag(record.tags);
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
 * The sensitive-field references a synchronous evaluation of `celExpression`
 * can read through the model map and the steps map: those of every
 * `model.<name>.resource` record of the models the expression names, as the
 * same analysis the data namespace's `prepare` runs lists them
 * (`syncDataReads`), and those of the output sources of every step the
 * expression names (`stepTargets`, typed-secrets 4.2), restricted to the
 * records {@link modelMapView} and {@link stepsView} adapt (own-namespace,
 * or every record when `ownNamespace` is undefined). Reading a model's
 * `resource` map fires the context's own lazy loader, which the caller has
 * made local first. The authorization step of the synchronous passes
 * authorizes each (design/enablers/typed-secrets.md Section 3.4,
 * typed-secrets 4.1); an expression that reads either map by a computed key
 * names nothing, a step context without sources holds nothing, and an
 * absent map contributes nothing, so such a read still fails closed at
 * evaluation.
 */
export function synchronousSensitiveReferences(
  celExpression: string,
  model: unknown,
  ownNamespace: string | undefined,
  steps?: unknown,
): SecretReference[] {
  const references: SecretReference[] = [];
  const own = (record: RecordLike): boolean =>
    ownNamespace === undefined || record.namespace === ownNamespace;
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
