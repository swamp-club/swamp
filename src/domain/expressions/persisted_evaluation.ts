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

import { z } from "zod";
import { Definition, type DefinitionData } from "../definitions/definition.ts";
import {
  findSensitiveValues,
  hasSensitiveFields,
  holdsRuntimeExpression,
  isLiteralSecret,
} from "../models/sensitive_field_extractor.ts";
import {
  isRecordSchema,
  schemaTransformsValues,
} from "../models/zod_type_coercion.ts";
import {
  rehydrateReferences,
  type RunSensitiveValues,
  SENSITIVE_FORMAT_VERSION,
  toPersistedForm,
  vaultReferenceText,
  type WrittenReference,
} from "../secrets/mod.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  type DeferredExpression,
  deferredExpressionReference,
} from "./deferred_expression.ts";
import { expressionReferences, freeRoots } from "./cel_grammar.ts";
import { matchSingleExpression } from "./expression_scanner.ts";
import { UserError } from "../errors.ts";
import { extractExpressions } from "./expression_parser.ts";
import {
  alignProvenance,
  indexPath,
  keyPath,
  ProvenanceMap,
  sentinelReferenceTextOf,
} from "./provenance_map.ts";

/**
 * A masked position in a cached definition, as the keys from the file root:
 * `["globalArguments", "apiKey"]`, `["methods", "run", "arguments", "token"]`.
 * A removed captured scope is `["deferredExpressions", index, "bindings"]`.
 * The cache records these beside `writtenReferences`, so a replay refuses
 * them even under a later schema that no longer marks the field.
 */
export type MaskedPath = readonly (string | number)[];

/** Only argument positions and removed deferred scopes belong in cache metadata. */
export const MaskedPathSchema = z.array(
  z.union([z.string(), z.number().int().nonnegative()]),
).refine((path) =>
  (path[0] === "globalArguments" && (path.length === 1 ||
    (path.length >= 2 && typeof path[1] === "string"))) ||
  (path[0] === "methods" && path.length >= 3 &&
    typeof path[1] === "string" && path[2] === "arguments" &&
    (path.length === 3 || typeof path[3] === "string")) ||
  (path[0] === "deferredExpressions" && path.length === 3 &&
    typeof path[1] === "number" && path[2] === "bindings")
);

/** An evaluated definition as it is written to the evaluated cache. */
export interface PersistedEvaluatedDefinition {
  definition: Definition;
  deferredExpressions: DeferredExpression[];
  writtenReferences: WrittenReference[];
  /** Positions replaced by the mask, an empty argument record, or an empty scope. */
  maskedPaths: MaskedPath[];
  /** The same positions spelled as arguments, `globalArguments.apiKey`. */
  maskedArguments: string[];
  /** Data ranges in the persisted text, for guards before rehydration. */
  persistedProvenance: ProvenanceMap;
}

/**
 * The argument schemas of a model type, as a `ModelDefinition` declares
 * them: the global arguments schema and each method's arguments schema.
 */
export interface ArgumentSchemas {
  globalArguments?: z.ZodTypeAny;
  methods: Record<string, { arguments?: z.ZodTypeAny }>;
}

/** What the evaluated cache holds in place of a literal sensitive argument. */
export const SENSITIVE_ARGUMENT_MASK = "***";

/** Code of the error a repository raises for a plaintext sensitive argument. */
export const PLAINTEXT_SENSITIVE_EVALUATED_ARG_CODE =
  "plaintext_sensitive_evaluated_arg";

/** One place a cached definition holds arguments the schemas describe. */
interface ArgumentSite {
  /** The keys from the file root to the arguments, as references spell paths. */
  prefix: readonly (string | number)[];
  schema: z.ZodTypeAny;
  args: Record<string, unknown>;
  /** Method arguments override global fallback values at the top-level key. */
  methodKeys?: ReadonlySet<string>;
  /** Raw global inputs have no known correspondence to sensitive outputs. */
  opaque?: boolean;
}

function argumentSites(
  schemas: ArgumentSchemas,
  data: DefinitionData,
): ArgumentSite[] {
  const sites: ArgumentSite[] = [];
  if (schemas.globalArguments && data.globalArguments) {
    sites.push({
      prefix: ["globalArguments"],
      schema: schemas.globalArguments,
      args: data.globalArguments,
    });
  }
  for (const [name, method] of Object.entries(schemas.methods)) {
    const schema = method.arguments;
    if (!schema) continue;
    // Own properties only: a method a type names like an Object.prototype
    // member (`toString`) must not read the prototype's function.
    const args = (data.methods && Object.hasOwn(data.methods, name)
      ? data.methods[name]?.arguments
      : undefined) ?? {};
    const usesGlobals = !isRecordSchema(schema);
    if (
      usesGlobals && hasSensitiveFields(schema) &&
      (schemaTransformsValues(schema) ||
        (schemas.globalArguments &&
          schemaTransformsValues(schemas.globalArguments)))
    ) {
      sites.push({
        prefix: ["globalArguments"],
        schema,
        args: data.globalArguments ?? {},
        opaque: true,
      });
    }
    sites.push({
      prefix: ["methods", name, "arguments"],
      schema,
      args: usesGlobals ? { ...data.globalArguments, ...args } : args,
      methodKeys: usesGlobals ? new Set(Object.keys(args)) : undefined,
    });
  }
  return sites;
}

/** Whether a written reference sits at or under the position `keys` names. */
function underWrittenReference(
  prefix: readonly (string | number)[],
  writtenReferences: readonly WrittenReference[],
): (keys: readonly (string | number)[]) => boolean {
  return (keys) => {
    const at = [...prefix, ...keys];
    return writtenReferences.some((reference) =>
      at.every((segment, i) => reference.path[i] === segment)
    );
  };
}

function isContainer(value: unknown): value is Record<string, unknown> {
  return Array.isArray(value) || (
    typeof value === "object" && value !== null &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/** Array indexes reveal no input text; object keys at any depth can. */
function hasObjectKeys(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasObjectKeys);
  return isContainer(value) && Object.keys(value).length > 0;
}

/** Visits every leaf under `value`, with its keys and spelled path. */
function visitLeaves(
  value: unknown,
  keys: readonly (string | number)[],
  path: string,
  visit: (keys: (string | number)[], path: string, value: unknown) => void,
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      visitLeaves(item, [...keys, index], indexPath(path, index), visit)
    );
  } else if (isContainer(value)) {
    for (const [key, item] of Object.entries(value)) {
      visitLeaves(item, [...keys, key], keyPath(path, key), visit);
    }
  } else {
    visit([...keys], path, value);
  }
}

/** What a check for plaintext sensitive arguments may leave out. */
export interface PlaintextCheckOptions {
  /** Data-origin text is a value even when it resembles an expression. */
  provenance?: ProvenanceMap;
  /** Unlike raw replay provenance, these ranges match written reference lengths. */
  persistedProvenance?: ProvenanceMap;
  /**
   * Count the mask as written, for a writer checking that nothing but the
   * mask is about to be written.
   */
  allowMask?: boolean;
  /**
   * The method a replay runs: only the global arguments and this method's
   * arguments are checked, since no other method's run. `replaced` names
   * the arguments the caller sets after replay (a step's inputs, a method
   * run's --input overrides), whose cached value never executes either.
   */
  method?: { name: string; replaced?: Iterable<string> };
  /**
   * The positions the cache recorded as masked when it was written. Those
   * in scope are reported whatever `schemas` mark now, since a later version
   * of the type may have dropped the marker, and the mask must never run.
   */
  recordedMasks?: readonly MaskedPath[];
}

/** A sensitive value in plaintext: its site, its keys there, its spelling. */
interface PlaintextValue {
  site: ArgumentSite;
  keys: (string | number)[];
  path: string;
}

/**
 * Every sensitive leaf of `data` that holds a value in plaintext: a literal
 * by the rule the save-time refusal uses, with no written reference at or
 * under it, and no expression still to be resolved at runtime in it. A
 * sensitive container is walked leaf by leaf. Pending expressions exempt
 * only authored text; a resolved input beside one is still sensitive data.
 * Method schemas also cover globals used as fallback arguments, and the
 * returned position names the global where that value actually lives.
 */
function plaintextValues(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  writtenReferences: readonly WrittenReference[],
  options: PlaintextCheckOptions,
  plaintextDataAt?: (path: MaskedPath) => boolean,
): PlaintextValue[] {
  const found = new Map<string, PlaintextValue>();
  const isPlaintext = (
    value: unknown,
    path: MaskedPath,
    conservative: boolean,
  ): boolean => {
    if (value === undefined || value === null) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    if (options.allowMask === true && value === SENSITIVE_ARGUMENT_MASK) {
      return false;
    }
    if (
      (options.persistedProvenance ?? options.provenance)?.hasDataAtOrBelow(
        provenancePath(path),
      )
    ) return true;
    // At a position that is only potentially sensitive, a literal is the
    // type's own text, already on disk in the source; only data is masked
    // there (swamp-club#3681).
    if (conservative) return false;
    return isLiteralSecret(value) &&
      !(typeof value === "string" && holdsRuntimeExpression(value));
  };
  const referenced = underWrittenReference([], writtenReferences);
  const persistedMap = options.persistedProvenance;
  for (const site of argumentSites(schemas, data)) {
    const ofMethod = site.prefix[0] === "methods";
    if (options.method && ofMethod && site.prefix[1] !== options.method.name) {
      continue;
    }
    const replaced = options.method && ofMethod
      ? new Set<string | number>(options.method.replaced ?? [])
      : undefined;
    const entries = site.opaque
      ? [{ keys: [], path: "", value: site.args, rawInput: true as const }]
      : findSensitiveValues(site.schema, site.args, true);
    for (const entry of entries) {
      // A position that is only potentially sensitive — the raw inputs of a
      // pipeline into a sensitive output, the globals a transforming schema
      // may consume — holds the type's own text as well as data. Only data
      // is masked there: an authored literal is already the definition's
      // text on disk, and a reference names where the secret lives, so
      // masking either would only cost the replay (swamp-club#3681).
      const conservative = site.opaque || entry.rawInput === true;
      const wholeMap = options.provenance ?? persistedMap;
      // A sensitive value inside an object whose keys came from data (a
      // record of objects an input supplied) is reported at that object, as
      // a leaf inside it is below: reported at its own position, the
      // record's key would reach the file, the metadata and the refusal.
      const keyed = dataKeyedContainer(site, entry.keys, wholeMap);
      if (keyed) {
        if (!replaced?.has(entry.keys[0])) {
          found.set(JSON.stringify(position(keyed)), keyed);
        }
        continue;
      }
      const whole = { site, keys: entry.keys, path: entry.path };
      const wholePath = position(whole);
      // Any data under a sensitive object, or an array holding one, masks
      // it whole. Its keys may be data, and provenance does not record every
      // data key on its own (a caller's key beside a described object's
      // properties is recorded only as a data leaf under it), so a leaf mask
      // could leave a data key in the file, the metadata and the refusal
      // message. This fails closed: an authored object holding a
      // data-origin vault reference is masked too and does not replay. A
      // container at a conservative position is masked whole only when its
      // own keys came from data.
      if (
        hasObjectKeys(entry.value) &&
        (conservative
          ? wholeMap?.hasDataKeysAt(provenancePath(wholePath))
          : wholeMap?.hasDataAtOrBelow(provenancePath(wholePath)))
      ) {
        if (!replaced?.has(entry.keys[0])) {
          found.set(JSON.stringify(wholePath), whole);
        }
        continue;
      }
      visitLeaves(entry.value, entry.keys, entry.path, (keys, path, value) => {
        if (replaced?.has(keys[0])) return;
        if (options.allowMask && value === SENSITIVE_ARGUMENT_MASK) return;
        const entry = { site, keys, path };
        // A leaf inside a container whose keys came from data (a record an
        // input or a data read supplied, whole or with an expression the
        // caller typed into it) is reported at that container whatever the
        // leaf holds, a reference included: its keys are data, and a leaf
        // mask, or none, would leave them in the file, the metadata and the
        // refusal message (swamp-club#3681).
        const container = dataKeyedContainer(
          site,
          keys,
          options.provenance ?? persistedMap,
        );
        if (container) {
          found.set(JSON.stringify(position(container)), container);
          return;
        }
        const at = position(entry);
        const mapPath = provenancePath(at);
        const map = persistedMap ?? options.provenance;
        const ranges =
          typeof value === "string" && map?.hasDataAtOrBelow(mapPath)
            ? persistedMap && !map.isWholeDataAt(mapPath)
              ? map.rangesAt(mapPath)
              : [[0, value.length] as const]
            : [];
        const unreferencedData = typeof value === "string" && referenced(at) &&
          ranges.some(([start, end]) => {
            const safe = referenceRanges(
              value,
              writtenReferences.filter((ref) => samePath(ref.path, at)),
            );
            let cursor = start;
            for (const [left, right] of safe) {
              if (
                left > cursor && value.slice(cursor, Math.min(left, end)).trim()
              ) return true;
              if (left < end) cursor = Math.max(cursor, right);
            }
            return cursor < end && value.slice(cursor, end).trim() !== "";
          });
        if (
          plaintextDataAt?.(at) || unreferencedData ||
          (!referenced(at) && isPlaintext(value, at, conservative))
        ) {
          found.set(JSON.stringify(at), entry);
        }
      });
    }
  }
  return [...found.values()].filter((entry) => {
    const at = position(entry);
    return !at.some((_part, index) =>
      found.has(JSON.stringify(at.slice(0, index)))
    );
  });
}

function spelled(value: PlaintextValue): string {
  return spellPosition(position(value));
}

function position({ site, keys }: PlaintextValue): MaskedPath {
  if (keys.length && site.methodKeys && !site.methodKeys.has(String(keys[0]))) {
    return ["globalArguments", ...keys];
  }
  return [...site.prefix, ...keys];
}

/**
 * The shallowest object with keys between the site's root and `keys` whose
 * keys `map` marks data, if any: whole with its values, or on their own
 * beside an authored expression the caller typed into it (swamp-club#3681).
 * Array indexes reveal no input text, so an array is passed through. A fixed
 * object shape supplied whole from data counts too: without the schema the
 * walk cannot tell its keys from a record's, so it fails closed and masks
 * the object's other values with it.
 */
function dataKeyedContainer(
  site: ArgumentSite,
  keys: readonly (string | number)[],
  map: ProvenanceMap | undefined,
): PlaintextValue | undefined {
  if (!map || map.isAuthored) return undefined;
  for (let depth = 1; depth < keys.length; depth++) {
    const prefix = keys.slice(0, depth);
    const value = readAt(site.args, prefix);
    if (
      Array.isArray(value) || !isContainer(value) ||
      Object.keys(value).length === 0
    ) continue;
    const container = { site, keys: prefix, path: "" };
    if (map.hasDataKeysAt(provenancePath(position(container)))) {
      return container;
    }
  }
  return undefined;
}

/** The expression evaluator's spelling, including quoted object keys. */
function provenancePath(path: MaskedPath): string {
  return path.reduce<string>(
    (parent, key) =>
      typeof key === "number" ? indexPath(parent, key) : keyPath(parent, key),
    "",
  );
}

/** Remove child paths that can themselves contain sensitive object keys. */
export function maskProvenance(
  provenance: ProvenanceMap,
  maskedPaths: readonly MaskedPath[],
): ProvenanceMap {
  return provenance.graftAll(maskedPaths.map((path) =>
    [
      provenancePath(path),
      ProvenanceMap.data(),
    ] as const
  ));
}

/** Spells a recorded position the way {@link spelled} spells a found one. */
function spellPosition(path: MaskedPath): string {
  const structural = path[0] === "methods" ? 3 : 1;
  const rest = path.slice(structural).reduce<string>(
    (parent, key) =>
      typeof key === "number" ? indexPath(parent, key) : keyPath(parent, key),
    "",
  );
  return path.slice(0, structural).join(".") + (rest ? `.${rest}` : "");
}

/** Whether a recorded position is one the check covers. */
function recordedInScope(
  path: MaskedPath,
  options: PlaintextCheckOptions,
): boolean {
  if (path[0] === "deferredExpressions") return true;
  if (path[0] === "globalArguments") return true;
  if (path[0] !== "methods" || path[2] !== "arguments") return false;
  if (!options.method) return true;
  if (path[1] !== options.method.name) return false;
  const replaced = new Set<string | number>(options.method.replaced ?? []);
  return path[3] === undefined || !replaced.has(path[3]);
}

/**
 * The sensitive arguments of a cached definition that hold a value in
 * plaintext: every position under `globalArguments` or a method's
 * `arguments` that `schemas` marks sensitive and that holds a literal by the
 * rule the save-time refusal uses, with no written reference at or under
 * it, plus every recorded masked position in scope. Spelled
 * `globalArguments.apiKey` and `methods.execute.arguments.token`. The mask
 * is itself a literal, so a masked cache is reported too, which is what
 * refuses its replay; see {@link PlaintextCheckOptions} for what a caller
 * may leave out or add.
 */
export function findPlaintextSensitiveArguments(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  writtenReferences: readonly WrittenReference[],
  options: PlaintextCheckOptions = {},
): string[] {
  const paths = new Set(
    plaintextValues(schemas, data, writtenReferences, options).map(spelled),
  );
  for (const recorded of options.recordedMasks ?? []) {
    if (recordedInScope(recorded, options)) paths.add(spellPosition(recorded));
  }
  return [...paths];
}

/** `the sensitive argument 'a'`, or `the sensitive arguments 'a', 'b'`. */
function sensitiveArgumentsSubject(paths: readonly string[]): string {
  const list = paths.map((path) => `'${path}'`).join(", ");
  return paths.length > 1
    ? `the sensitive arguments ${list}`
    : `the sensitive argument ${list}`;
}

/**
 * The message for an evaluated definition that holds a sensitive argument in
 * plaintext, naming the paths and never a value.
 */
export function plaintextSensitiveArgumentsMessage(
  name: string,
  paths: readonly string[],
): string {
  return `The evaluated definition for "${name}" holds a plaintext value for ${
    sensitiveArgumentsSubject(paths)
  }, so it was not written: a value a schema marks sensitive reaches the evaluated cache only as a vault reference or the mask. A swamp command that raises this has a bug in its writer; please report it with the command you ran.`;
}

/** Code of the error a replay raises for a cache with such an argument. */
export const EVALUATED_CACHE_HOLDS_SENSITIVE_ARGUMENTS_CODE =
  "evaluated_cache_holds_sensitive_arguments";

/**
 * The message for a cached evaluation that --last-evaluated refuses because
 * a sensitive argument holds a value that did not come from a vault: the
 * mask this swamp writes, or plaintext an older one wrote. A plain re-run
 * writes the mask again, so the message says what does make the run
 * replayable rather than sending the user round that loop. Names the
 * paths, never a value; `command` is what runs without the flag.
 */
export function evaluatedCacheHoldsSensitiveArgumentsMessage(
  name: string,
  paths: readonly string[],
  command: "method" | "workflow",
): string {
  if (
    paths.some((path) =>
      path === "globalArguments" || /^methods\..+\.arguments$/.test(path) ||
      path.startsWith("deferredExpressions.")
    )
  ) {
    return `The evaluated definition cached for "${name}" omits sensitive argument containers or captured bindings, so --last-evaluated cannot replay it. Run the ${command} without --last-evaluated to supply those values again. Removed positions: ${
      paths.map((path) => `'${path}'`).join(", ")
    }.`;
  }
  const replaces = command === "method"
    ? "or replace a cached method argument with --input only if its name is not a declared definition input"
    : "or set it as a step input, which replaces the cached method argument";
  return `The evaluated definition cached for "${name}" holds a value for ${
    sensitiveArgumentsSubject(paths)
  } that did not come from a vault, so --last-evaluated cannot replay it. Run the ${command} without --last-evaluated. To replay it later, store the value in a vault and reference it with \${{ vault.get(...) }}; ${replaces}.`;
}

/** Reads only stored values, never inherited properties. */
function readAt(target: unknown, keys: MaskedPath): unknown {
  let value = target;
  for (const key of keys) {
    if (!isContainer(value) || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** Replaces an existing own value; a missing or already masked parent ends it. */
function setAt(
  target: unknown,
  keys: readonly (string | number)[],
  value: unknown,
): void {
  const parent = readAt(target, keys.slice(0, -1));
  const last = keys.at(-1);
  if (
    isContainer(parent) && last !== undefined && Object.hasOwn(parent, last)
  ) {
    Object.defineProperty(parent, last, {
      value,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
}

function isArgumentRoot(path: MaskedPath): boolean {
  return (path[0] === "globalArguments" && path.length === 1) ||
    (path[0] === "methods" && path[2] === "arguments" && path.length === 3);
}

/** Argument roots must remain records in the serialized Definition. */
function maskAt(target: unknown, path: MaskedPath): void {
  setAt(target, path, isArgumentRoot(path) ? {} : SENSITIVE_ARGUMENT_MASK);
}

/** Returns a masked copy and the sensitive positions it changed. */
function maskSensitiveArguments(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  writtenReferences: readonly WrittenReference[],
  provenance: ProvenanceMap,
  plaintextDataAt: (path: MaskedPath) => boolean,
  inputProvenance: ProvenanceMap,
): { data: DefinitionData; values: PlaintextValue[] } {
  const values: PlaintextValue[] = [];
  let masked = data;
  while (true) {
    const next = plaintextValues(
      schemas,
      masked,
      writtenReferences,
      {
        provenance: inputProvenance,
        persistedProvenance: provenance,
        allowMask: masked !== data,
      },
      plaintextDataAt,
    );
    // A position masked already can be found again: an argument root is
    // written as an empty record, and a method site merges the globals it
    // falls back to back into it, so only new positions continue the loop.
    const fresh = next.filter((value) =>
      !values.some((done) => samePath(position(done), position(value)))
    );
    if (!fresh.length) break;
    if (masked === data) masked = structuredClone(data);
    for (const value of fresh) {
      maskAt(masked, position(value));
      values.push(value);
    }
    // A masked discriminator can select more union branches. Continue until
    // the repository's check of the masked copy has no new positions to mask.
  }
  return { data: masked, values };
}

/** Whether a resolved data segment contains anything beyond vault references. */
function hasUnreferencedData(
  value: unknown,
  values: RunSensitiveValues,
): boolean {
  if (value === undefined || value === null) return false;
  const form = toPersistedForm({ value }, values);
  if (typeof form.data.value !== "string") return true;
  let text = form.data.value;
  // Work from right to left so removing an occurrence leaves earlier offsets
  // intact. Reference-shaped input text without a written entry stays data.
  const ranges = referenceRanges(text, form.writtenReferences);
  for (const [start, end] of ranges.toReversed()) {
    text = text.slice(0, start) + text.slice(end);
  }
  return text.trim() !== "";
}

function samePath(left: MaskedPath, right: MaskedPath): boolean {
  return left.length === right.length &&
    left.every((part, i) => part === right[i]);
}

/**
 * `map` with the range of every written reference in `data` marked as data,
 * so a persisted-coordinate map is exact at each reference whatever rule
 * aligned the rest of its string: a reference the value search wrote has no
 * sentinel to align through, and two in one string would otherwise merge
 * into one span. A path that is whole data stays so.
 */
export function withWrittenReferenceRanges(
  map: ProvenanceMap,
  data: unknown,
  writtenReferences: readonly WrittenReference[],
): ProvenanceMap {
  const byPath = new Map<string, WrittenReference[]>();
  for (const reference of writtenReferences) {
    const spelled = provenancePath(reference.path);
    const refs = byPath.get(spelled);
    if (refs) refs.push(reference);
    else byPath.set(spelled, [reference]);
  }
  let out = map;
  for (const [spelled, refs] of byPath) {
    const text = readAt(data, refs[0].path);
    if (typeof text !== "string" || out.isWholeDataAt(spelled)) continue;
    out = out.withRanges(spelled, [
      ...out.rangesAt(spelled),
      ...referenceRanges(text, refs),
    ]);
  }
  return out;
}

function referenceRanges(
  text: string,
  references: readonly WrittenReference[],
): [number, number][] {
  return references.map((reference): [number, number] => {
    const ref = vaultReferenceText(reference);
    let start = -1;
    for (let i = 0; i <= reference.occurrence; i++) {
      start = text.indexOf(ref, start + 1);
      if (start < 0) break;
    }
    return [start, start + ref.length];
  }).filter(([start]) => start >= 0).sort((a, b) => a[0] - b[0]);
}

/** Keep only the captured roots an expression can read; services are rebuilt. */
function neededBindings(record: DeferredExpression): DeferredExpression {
  const span = matchSingleExpression(record.expression, { exact: true });
  const roots = span ? freeRoots(span.inner) : undefined;
  const bindings = Object.fromEntries(
    Object.entries(record.bindings).filter(([key]) =>
      !roots || key === "workflowRunId" || roots.has(key)
    ),
  );
  const provenance = record.provenance
    ? ProvenanceMap.fromData(record.provenance)
    : undefined;
  return {
    ...record,
    bindings,
    provenance: provenance
      ? ProvenanceMap.authored().graftAll(
        Object.keys(bindings).map((key) =>
          [
            keyPath("", key),
            provenance.subtree(keyPath("", key)),
          ] as const
        ),
      ).toData()
      : undefined,
  };
}

/** Captured data objects can carry sensitive text in keys as well as leaves. */
function hasCapturedPlaintext(
  record: DeferredExpression,
  values: RunSensitiveValues,
): boolean {
  const provenance = record.provenance
    ? ProvenanceMap.fromData(record.provenance)
    : ProvenanceMap.authored();
  const visit = (value: unknown, path: string): boolean => {
    if (!isContainer(value)) return hasUnreferencedData(value, values);
    if (
      !Array.isArray(value) && Object.keys(value).length &&
      provenance.hasDataKeysAt(path)
    ) return true;
    return Object.entries(value).some(([key, child]) =>
      visit(
        child,
        Array.isArray(value)
          ? indexPath(path, Number(key))
          : keyPath(path, key),
      )
    );
  };
  return Object.entries(record.bindings).some(([root, value]) =>
    root !== "workflowRunId" && visit(value, keyPath("", root))
  );
}

/**
 * Builds what to write to the evaluated cache from the copy that executes:
 * issued sentinels become their vault references, tag values carry placeholders,
 * and any literal still under a sensitive argument path of `schemas` (a
 * value from the run's inputs, or one stored in the source) becomes the
 * mask. Nothing sensitive is written in plaintext, whether it came from a
 * vault, a data read or the run's inputs (swamp-club#3681).
 *
 * Authored text joined to a reference or a pending runtime expression stays
 * written. Resolved input/data text beside it masks the whole sensitive leaf,
 * unless every resolved segment was replaced by a recorded vault reference.
 * A masked position no longer fits the provenance ranges recorded for it,
 * which is safe only because
 * replay refuses a cache with a masked argument (see
 * {@link findPlaintextSensitiveArguments}) before it aligns provenance. A
 * masked number or boolean becomes the mask string, so the cached value no
 * longer matches its schema type; only the replay check, which refuses it,
 * and the workflow report, which shows it, read the cache.
 */
export function persistEvaluatedDefinition(
  executed: Definition,
  deferredExpressions: readonly DeferredExpression[],
  source: Definition,
  values: RunSensitiveValues,
  schemas: ArgumentSchemas,
  provenance: ProvenanceMap = ProvenanceMap.authored(),
  /** Forwarded inputs; source reads identify the aliases of masked arguments. */
  forwardedInputs: readonly MaskedPath[] = [],
  previousMasks: readonly MaskedPath[] = [],
): PersistedEvaluatedDefinition {
  const data = executed.toData();
  const file = {
    ...data,
    tags: values.tagsWithPlaceholders(data.tags ?? {}),
    deferredExpressions: deferredExpressions.map(neededBindings),
  };
  const sourceExpressions = extractExpressions(source.toData());
  const inputAliases = new Set([
    ...Object.keys(source.inputs?.properties ?? {}),
    ...Object.keys(source.globalArguments),
  ]);
  let opaqueInputs = false;
  for (const expression of sourceExpressions) {
    const refs = expressionReferences(expression.celExpression);
    opaqueInputs ||= !refs || refs.opaqueInputs;
    for (const key of refs?.inputs ?? []) inputAliases.add(key);
  }
  const form = toPersistedForm(file, values);
  const { deferredExpressions: persistedDeferred, ...definitionData } =
    form.data;
  // Once the references are in place, so a sentinel in a sensitive field is
  // written as its reference and never masked.
  const plaintextDataAt = (path: MaskedPath) => {
    const at = provenancePath(path);
    const value = readAt(data, path);
    if (typeof value === "string") {
      const text = value;
      for (const record of file.deferredExpressions) {
        if (!text.includes(deferredExpressionReference(record.id))) continue;
        if (hasCapturedPlaintext(record, values)) return true;
      }
    }
    if (!provenance.hasDataAtOrBelow(at)) return false;
    if (typeof value === "string" && !provenance.isWholeDataAt(at)) {
      const text = value;
      return provenance.rangesAt(at).some(([start, end]) =>
        hasUnreferencedData(text.slice(start, end), values)
      );
    }
    return hasUnreferencedData(value, values);
  };
  // Sensitive leaves whose resolved segments are entirely references keep
  // only those reference ranges as data. Raw replay ranges use the original
  // secret lengths and cannot safely be compared with persisted text. A
  // written reference always stands for a value resolved during evaluation,
  // never for an authored vault.get, which stays an expression; the guards
  // read these ranges only to tell the text a reference covers from the
  // text it does not.
  // Sentinels stand in for the reference text they are written as, so the
  // persisted map is exact wherever a sentinel became a reference; a value
  // the search replaced falls to the differing-span rule, and every written
  // reference is marked data either way.
  let persistedProvenance = withWrittenReferenceRanges(
    alignProvenance(
      provenance,
      data,
      definitionData,
      sentinelReferenceTextOf(values.sentinels),
    ),
    definitionData,
    form.writtenReferences,
  );
  // A sensitive leaf the search rewrote keeps only its reference ranges: the
  // differing-span rule marks the authored text between two references data,
  // and the plaintext check below would then mask a value that came from a
  // vault.
  for (const site of argumentSites(schemas, definitionData as DefinitionData)) {
    for (const entry of findSensitiveValues(site.schema, site.args, true)) {
      visitLeaves(entry.value, entry.keys, entry.path, (keys, path, value) => {
        const at = position({ site, keys, path });
        if (typeof value !== "string" || plaintextDataAt(at)) return;
        const refs = form.writtenReferences.filter((ref) =>
          samePath(ref.path, at)
        );
        if (refs.length) {
          persistedProvenance = persistedProvenance.withRanges(
            provenancePath(at),
            referenceRanges(value, refs),
          );
        }
      });
    }
  }
  const masked = maskSensitiveArguments(
    schemas,
    definitionData as DefinitionData,
    form.writtenReferences,
    persistedProvenance,
    plaintextDataAt,
    provenance,
  );
  const maskedPaths = masked.values.map(position);
  if (previousMasks.length && !maskedPaths.length) {
    masked.data = structuredClone(masked.data);
  }
  for (const path of previousMasks) {
    if (!MaskedPathSchema.safeParse(path).success) continue;
    const value = readAt(masked.data, path);
    if (
      plaintextDataAt(path) ||
      (!form.writtenReferences.some((ref) => samePath(ref.path, path)) &&
        isLiteralSecret(value) &&
        !(typeof value === "string" && holdsRuntimeExpression(value)))
    ) {
      maskAt(masked.data, path);
      if (!maskedPaths.some((other) => samePath(path, other))) {
        maskedPaths.push(path);
      }
    }
  }
  if (maskedPaths.length) {
    const opaqueAliases = opaqueInputs || maskedPaths.some(isArgumentRoot);
    for (const inputPath of forwardedInputs) {
      if (!opaqueAliases && !inputAliases.has(String(inputPath.at(-1)))) {
        continue;
      }
      // A whole-input read or transform can consume the forwarded names too.
      const path = opaqueAliases
        ? inputPath.slice(0, inputPath[0] === "methods" ? 3 : 1)
        : inputPath;
      maskAt(masked.data, path);
      if (!maskedPaths.some((other) => samePath(path, other))) {
        maskedPaths.push(path);
      }
    }
    // Historical masks and forwarded aliases may themselves be union tags.
    const stable = maskSensitiveArguments(
      schemas,
      masked.data,
      form.writtenReferences,
      persistedProvenance,
      plaintextDataAt,
      provenance,
    );
    masked.data = stable.data;
    for (const value of stable.values) {
      const path = position(value);
      if (!maskedPaths.some((other) => samePath(path, other))) {
        maskedPaths.push(path);
      }
    }
    // A captured parent scope can hold another copy of the input that was
    // masked above. Do not persist that scope, or replay a partial scope.
    for (const [index, deferred] of persistedDeferred.entries()) {
      const { workflowRunId, ...captured } = deferred.bindings;
      if (!Object.keys(captured).length) continue;
      persistedDeferred[index] = neededBindings({
        ...deferred,
        bindings: workflowRunId === undefined ? {} : { workflowRunId },
      });
      maskedPaths.push(["deferredExpressions", index, "bindings"]);
    }
  }
  const outerMasks = maskedPaths.filter((path) =>
    !maskedPaths.some((other) =>
      other.length < path.length &&
      other.every((key, index) => key === path[index])
    )
  );
  return {
    definition: Definition.fromData(masked.data),
    deferredExpressions: persistedDeferred,
    writtenReferences: form.writtenReferences.filter((reference) =>
      !outerMasks.some((path) =>
        path.every((segment, i) => reference.path[i] === segment)
      )
    ),
    maskedPaths: outerMasks,
    maskedArguments: outerMasks.map(spellPosition),
    persistedProvenance: maskProvenance(persistedProvenance, outerMasks),
  };
}

/**
 * The arguments of an evaluated definition as a run of `method` shows them
 * (the completed event, the method-summary report): every sensitive
 * position of `schemas` that holds data (`provenance`), a literal, or a
 * container whose keys came from data is the mask, by the same walk the
 * evaluated cache uses, so what the cache keeps off disk never reaches the
 * terminal or a report either (swamp-club#3681). A pipeline's raw inputs
 * count as its sensitive output, the global arguments it may consume
 * included. A value made only of runtime expressions stays, since its text
 * names where the secret lives. Only the global arguments and `method`'s
 * arguments are read, as the run shows only those; `data` is not mutated.
 */
export function maskSensitiveArgumentsForDisplay(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  method: string,
  provenance: ProvenanceMap = ProvenanceMap.authored(),
): DefinitionData {
  const masked = maskSensitiveArguments(
    shownSchemas(schemas, method),
    data,
    [],
    provenance,
    (path) => provenance.hasDataAtOrBelow(provenancePath(path)),
    provenance,
  );
  return masked.data;
}

/** The schemas a run of `method` shows: the global arguments and its own. */
function shownSchemas(
  schemas: ArgumentSchemas,
  method: string,
): ArgumentSchemas {
  return {
    globalArguments: schemas.globalArguments,
    // Own properties only, as argumentSites reads them.
    methods: Object.hasOwn(schemas.methods, method)
      ? { [method]: schemas.methods[method] }
      : {},
  };
}

/**
 * Restores a cached evaluated definition for replay.
 *
 * The cache's written
 * references become sentinels the step's bag issues, reading no vault: the
 * raw and executed copies are one sentinel copy, since a typed run holds no
 * value anywhere, and the delivery loads the current value under the
 * principal's current grants (typed-secrets 4.4, design Section 8.2). The
 * cache's `persistedProvenance`, in reference-text coordinates, is aligned
 * onto that copy exactly through the reference text each sentinel stands
 * for, and returned as `provenance` for both copies. A cache written before
 * swamp-club#3681 records provenance only in value coordinates, which no copy
 * in hand can realign, so a typed replay refuses it rather than risk a data
 * range landing on authored text; one with no provenance at all replays as
 * authored, as it always did.
 */
export function rehydrateEvaluatedDefinition(
  cached: {
    definition: Definition;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
    /**
     * See {@link PersistedEvaluatedDefinition.persistedProvenance}. A reader
     * refuses `"unreadable"` before replaying; here it counts as absent.
     */
    persistedProvenance?: ProvenanceMap | "unreadable";
    /** Where data sits in the raw copy, as the cache stores it. */
    provenance?: ProvenanceMap | "unreadable";
  },
  bag: VaultSecretBag,
): {
  definition: Definition;
  executedDefinition: Definition;
  deferredExpressions: DeferredExpression[];
  /** Set in a typed run: the map of both copies, aligned onto them. */
  provenance?: ProvenanceMap;
} {
  {
    const readable = (map: ProvenanceMap | "unreadable" | undefined) =>
      map instanceof ProvenanceMap ? map : undefined;
    return rehydrateEvaluatedDefinitionReferences({
      ...cached,
      persistedProvenance: readable(cached.persistedProvenance),
      provenance: readable(cached.provenance),
    }, bag);
  }
}

/** The typed branch of {@link rehydrateEvaluatedDefinition}. */
function rehydrateEvaluatedDefinitionReferences(
  cached: {
    definition: Definition;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
    persistedProvenance?: ProvenanceMap;
    provenance?: ProvenanceMap;
  },
  bag: VaultSecretBag,
): {
  definition: Definition;
  executedDefinition: Definition;
  deferredExpressions: DeferredExpression[];
  provenance: ProvenanceMap;
} {
  const persisted = cached.definition.toData();
  const file = {
    ...persisted,
    deferredExpressions: [...cached.deferredExpressions],
  };
  const restored = rehydrateReferences(
    file,
    cached.writtenReferences,
    bag,
    cached.definition.name,
  );
  const { deferredExpressions, ...restoredDefinition } = restored;
  const definition = Definition.fromData(restoredDefinition as DefinitionData);
  return {
    definition,
    executedDefinition: definition,
    deferredExpressions,
    provenance: replayProvenance(
      cached,
      persisted,
      restoredDefinition,
      bag,
      `The evaluated cache for "${cached.definition.name}" was written before it recorded where its references sit, so it is not replayed with references. ` +
        `Run without --last-evaluated to evaluate it again; that rewrites the cache.`,
    ),
  };
}

/**
 * The map of a sentinel copy restored from a persisted copy (typed-secrets
 * 4.4): the persisted-coordinate map aligned exactly, through the reference
 * text each sentinel stands for. A cache that holds references and a map in
 * value coordinates only cannot be realigned and is refused with `refusal`;
 * one with no map replays as authored.
 */
export function replayProvenance(
  cached: {
    writtenReferences: readonly WrittenReference[];
    persistedProvenance?: ProvenanceMap;
    provenance?: ProvenanceMap;
  },
  persisted: unknown,
  restored: unknown,
  bag: VaultSecretBag,
  refusal: string,
): ProvenanceMap {
  if (cached.persistedProvenance !== undefined) {
    return alignProvenance(
      cached.persistedProvenance,
      persisted,
      restored,
      undefined,
      sentinelReferenceTextOf(bag.registry),
    );
  }
  if (cached.provenance === undefined || cached.provenance.isAuthored) {
    return ProvenanceMap.authored();
  }
  if (cached.writtenReferences.length === 0) return cached.provenance;
  throw new UserError(refusal);
}

/**
 * Whether a cache written before sensitive values were kept off disk may hold
 * one in plaintext: it predates the format marker and its source read data or
 * step outputs, where sensitive fields are resolved.
 */
export function mayHoldPlaintextSensitiveValues(cache: {
  sensitiveFormat?: number;
  authoredExpressions: ReadonlySet<string>;
}): boolean {
  if (cache.sensitiveFormat !== undefined) return false;
  return [...cache.authoredExpressions].some((expression) =>
    /\bdata\s*\.|\bsteps\s*[.[]/.test(expression)
  );
}

/**
 * Whether a cache or run record was written in a sensitive-value format newer
 * than this swamp's ({@link SENSITIVE_FORMAT_VERSION}). Such a file may hold
 * a sensitive value in a form this swamp does not recognise, as version 2's
 * mask is to a version-1 reader, which would run it as the value
 * (swamp-club#3681); it is not replayed or resumed.
 */
export function isNewerSensitiveFormat(cache: {
  sensitiveFormat?: number;
}): boolean {
  return cache.sensitiveFormat !== undefined &&
    cache.sensitiveFormat > SENSITIVE_FORMAT_VERSION;
}
