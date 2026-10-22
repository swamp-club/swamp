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
import { Definition, type DefinitionData } from "../definitions/definition.ts";
import {
  findLiteralSensitiveValues,
  holdsRuntimeExpression,
  isLiteralSecret,
} from "../models/sensitive_field_extractor.ts";
import {
  type DataPath,
  rehydratePersistedForm,
  type RunSensitiveValues,
  SENSITIVE_FORMAT_VERSION,
  toPersistedForm,
  type VaultReader,
  type WrittenReference,
} from "../secrets/mod.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { DeferredExpression } from "./deferred_expression.ts";
import { extractExpressions } from "./expression_parser.ts";
import { indexPath, keyPath } from "./provenance_map.ts";

/**
 * A masked position in a cached definition, as the keys from the file root:
 * `["globalArguments", "apiKey"]`, `["methods", "run", "arguments", "token"]`.
 * The cache records these beside `writtenReferences`, so a replay refuses
 * them even under a later schema that no longer marks the field.
 */
export type MaskedPath = readonly (string | number)[];

/** An evaluated definition as it is written to the evaluated cache. */
export interface PersistedEvaluatedDefinition {
  definition: Definition;
  deferredExpressions: DeferredExpression[];
  writtenReferences: WrittenReference[];
  /** The positions whose literal value became the mask, for the cache. */
  maskedPaths: MaskedPath[];
  /** The same positions spelled as arguments, `globalArguments.apiKey`. */
  maskedArguments: string[];
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
  /** Stores a masked copy of the arguments back in the definition data. */
  replace: (args: Record<string, unknown>) => void;
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
      replace: (args) => {
        data.globalArguments = args;
      },
    });
  }
  for (const [name, method] of Object.entries(data.methods ?? {})) {
    const schema = Object.hasOwn(schemas.methods, name)
      ? schemas.methods[name].arguments
      : undefined;
    if (!schema || !method?.arguments) continue;
    sites.push({
      prefix: ["methods", name, "arguments"],
      schema,
      args: method.arguments,
      replace: (args) => {
        data.methods = {
          ...data.methods,
          [name]: { ...method, arguments: args },
        };
      },
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
 * sensitive container is walked leaf by leaf, so a reference or a pending
 * expression in one leaf leaves only that leaf out. The cache is built
 * before the runtime pass, so an author-written `vault.get` or `env.X`
 * joined to text is still an expression here, holds no secret, and is kept
 * as written; a mixed string an input or a data read produced holds none.
 */
function plaintextValues(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  writtenReferences: readonly WrittenReference[],
  options: PlaintextCheckOptions,
): PlaintextValue[] {
  const found: PlaintextValue[] = [];
  const isPlaintext = (value: unknown): boolean =>
    isLiteralSecret(value) &&
    !(typeof value === "string" && holdsRuntimeExpression(value)) &&
    !(options.allowMask === true && value === SENSITIVE_ARGUMENT_MASK);
  for (const site of argumentSites(schemas, data)) {
    const ofMethod = site.prefix[0] === "methods";
    if (options.method && ofMethod && site.prefix[1] !== options.method.name) {
      continue;
    }
    const replaced = options.method && ofMethod
      ? new Set<string | number>(options.method.replaced ?? [])
      : undefined;
    const referenced = underWrittenReference(site.prefix, writtenReferences);
    for (const entry of findLiteralSensitiveValues(site.schema, site.args)) {
      if (replaced?.has(entry.keys[0])) continue;
      visitLeaves(entry.value, entry.keys, entry.path, (keys, path, value) => {
        if (!referenced(keys) && isPlaintext(value)) {
          found.push({ site, keys, path });
        }
      });
    }
  }
  return found;
}

function spelled({ site, path }: PlaintextValue): string {
  return `${site.prefix.join(".")}.${path}`;
}

function position({ site, keys }: PlaintextValue): MaskedPath {
  return [...site.prefix, ...keys];
}

/** Spells a recorded position the way {@link spelled} spells a found one. */
function spellPosition(path: MaskedPath): string {
  const structural = path[0] === "methods" ? 3 : 1;
  const rest = path.slice(structural).reduce<string>(
    (parent, key) =>
      typeof key === "number" ? indexPath(parent, key) : keyPath(parent, key),
    "",
  );
  return `${path.slice(0, structural).join(".")}.${rest}`;
}

/** Whether a recorded position is one the check covers. */
function recordedInScope(
  path: MaskedPath,
  options: PlaintextCheckOptions,
): boolean {
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
  const replaces = command === "method"
    ? "or, for a method argument, pass it with --input, which replaces the cached one"
    : "or set it as a step input, which replaces the cached method argument";
  return `The evaluated definition cached for "${name}" holds a value for ${
    sensitiveArgumentsSubject(paths)
  } that did not come from a vault, so --last-evaluated cannot replay it. Run the ${command} without --last-evaluated. To replay it later, store the value in a vault and reference it with \${{ vault.get(...) }}; ${replaces}.`;
}

/** Sets the value at `keys` in a structure; a missing parent ends the walk. */
function setAt(
  target: unknown,
  keys: readonly (string | number)[],
  value: unknown,
): void {
  let parent = target;
  for (const key of keys.slice(0, -1)) {
    // A parent already masked is a string by now, and covers this value.
    parent = isContainer(parent)
      ? (parent as Record<string | number, unknown>)[key]
      : undefined;
  }
  const last = keys.at(-1);
  if (isContainer(parent) && last !== undefined) {
    (parent as Record<string | number, unknown>)[last] = value;
  }
}

/** Masks the plaintext sensitive arguments of `data` in place; the values. */
function maskSensitiveArguments(
  schemas: ArgumentSchemas,
  data: DefinitionData,
  writtenReferences: readonly WrittenReference[],
): PlaintextValue[] {
  const values = plaintextValues(schemas, data, writtenReferences, {});
  const masked = new Map<ArgumentSite, Record<string, unknown>>();
  for (const { site, keys } of values) {
    let args = masked.get(site);
    if (!args) {
      args = structuredClone(site.args);
      masked.set(site, args);
    }
    setAt(args, keys, SENSITIVE_ARGUMENT_MASK);
  }
  for (const [site, args] of masked) site.replace(args);
  return values;
}

/**
 * Whether a path in a cached definition file carries a value rather than
 * structure: an argument, a deferred expression's binding values, or a
 * place the source definition held an expression.
 */
function cachedValuePath(sourcePaths: readonly string[]) {
  return (path: DataPath): boolean => {
    if (path[0] === "globalArguments") return true;
    if (path[0] === "methods" && path[2] === "arguments") return true;
    if (path[0] === "deferredExpressions" && path[2] === "bindings") {
      return true;
    }
    // Spelled the way expression extraction spells paths.
    const dotted = path.reduce<string>(
      (parent, p) =>
        typeof p === "number" ? indexPath(parent, p) : keyPath(parent, p),
      "",
    );
    return sourcePaths.some((source) =>
      dotted === source || dotted.startsWith(`${source}.`) ||
      dotted.startsWith(`${source}[`)
    );
  };
}

/**
 * Builds what to write to the evaluated cache from the copy that executes:
 * sentinels become the vault references their values came from, recorded
 * sensitive values at value positions do too, tag values carry placeholders,
 * and any literal still under a sensitive argument path of `schemas` (a
 * value from the run's inputs, or one stored in the source) becomes the
 * mask. Nothing sensitive is written in plaintext, whether it came from a
 * vault, a data read or the run's inputs (swamp-club#3681).
 *
 * Two limits are deliberate. A string that holds a written reference, or an
 * expression still to be resolved at runtime, is left whole, so text joined
 * to either in one sensitive string stays as written (inside a sensitive
 * container, only such leaves are left). And a masked position no longer
 * fits the provenance ranges recorded for it, which is safe only because
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
): PersistedEvaluatedDefinition {
  const data = executed.toData();
  const file = {
    ...data,
    tags: values.tagsWithPlaceholders(data.tags ?? {}),
    deferredExpressions: [...deferredExpressions],
  };
  const sourcePaths = extractExpressions(source.toData()).map((e) => e.path);
  const form = toPersistedForm(file, values, {
    applies: cachedValuePath(sourcePaths),
  });
  const { deferredExpressions: persistedDeferred, ...definitionData } =
    form.data;
  // Once the references are in place, so a sentinel in a sensitive field is
  // written as its reference and never masked.
  const masked = maskSensitiveArguments(
    schemas,
    definitionData as DefinitionData,
    form.writtenReferences,
  );
  return {
    definition: Definition.fromData(definitionData as DefinitionData),
    deferredExpressions: persistedDeferred,
    writtenReferences: form.writtenReferences,
    maskedPaths: masked.map(position),
    maskedArguments: masked.map(spelled),
  };
}

/**
 * Restores a cached evaluated definition for replay: the raw copy for CEL
 * contexts and reports, and the executed copy with data-origin sentinels
 * from the step's bag, exactly as a fresh evaluation would produce.
 */
export async function rehydrateEvaluatedDefinition(
  cached: {
    definition: Definition;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
  },
  read: VaultReader,
  values: RunSensitiveValues,
  bag: VaultSecretBag,
): Promise<{
  definition: Definition;
  executedDefinition: Definition;
  deferredExpressions: DeferredExpression[];
}> {
  const file = {
    ...cached.definition.toData(),
    deferredExpressions: [...cached.deferredExpressions],
  };
  const { raw, sanitized } = await rehydratePersistedForm(
    file,
    cached.writtenReferences,
    read,
    values,
    bag,
    // Only arguments carry sentinels in a fresh run; resolveDeep restores
    // nothing else, so every other position gets its real value back.
    (path) =>
      path[0] === "globalArguments" ||
      (path[0] === "methods" && path[2] === "arguments"),
  );
  const { deferredExpressions, ...rawDefinition } = raw;
  const { deferredExpressions: _unused, ...sanitizedDefinition } = sanitized;
  return {
    definition: Definition.fromData(rawDefinition as DefinitionData),
    executedDefinition: Definition.fromData(
      sanitizedDefinition as DefinitionData,
    ),
    deferredExpressions,
  };
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
