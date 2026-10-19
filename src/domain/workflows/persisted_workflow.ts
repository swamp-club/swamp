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

import type { DeferredExpression } from "../expressions/deferred_expression.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import { inputNamesRead } from "../expressions/cel_grammar.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import {
  type DataPath,
  definedEntry,
  rehydratePersistedForm,
  type RunSensitiveValues,
  toPersistedForm,
  type VaultReader,
  type WrittenReference,
} from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SanitizedTaskOverlay } from "./expression_evaluators.ts";
import { Workflow, type WorkflowInput } from "./workflow.ts";

/**
 * The evaluation inputs the evaluated cache may record (swamp-club#3583), or
 * undefined when any of them holds a sensitive value: a parent can pass a
 * secret to a nested workflow as an input, and the cache file would carry it
 * in plaintext. A run replaying a cache without them records none, so a
 * resume refuses any input its finished steps read.
 */
export function recordableEvaluatedInputs(
  inputs: Record<string, unknown>,
  values: RunSensitiveValues,
): Record<string, unknown> | undefined {
  return canonicalJson(values.masked(inputs)) === canonicalJson(inputs)
    ? inputs
    : undefined;
}

/**
 * The inputs an evaluated cache resolved into its steps when it was written:
 * every name read by an expression evaluation substituted. The rest resolve
 * when the cache is replayed, against the replaying run's inputs. A cache that
 * did not record what was substituted counts every authored expression as
 * resolved. `all` when a resolved expression read `inputs` whole, by a
 * computed key, or does not parse.
 */
function inputsResolvedIntoCache(cache: {
  authoredExpressions: ReadonlySet<string>;
  resolvedExpressions?: ReadonlySet<string>;
}): { names: Set<string>; all: boolean } {
  const names = new Set<string>();
  let all = false;
  for (const raw of cache.resolvedExpressions ?? cache.authoredExpressions) {
    for (const { celExpression } of extractExpressions(raw)) {
      const reads = inputNamesRead(celExpression);
      for (const name of reads.names) names.add(name);
      all ||= reads.opaque;
    }
  }
  return { names, all };
}

/**
 * The supplied inputs a run replaying the evaluated cache (`--last-evaluated`)
 * cannot take (swamp-club#3583). Its steps run with the values the cache
 * resolved into them when it was written, so a supplied input those resolved
 * expressions read must equal the value the cache recorded; one it did not
 * record, or any when it recorded none, cannot be checked. Inputs read only by
 * expressions the cache left to resolve at run time are the run's own.
 */
export function inputsConflictingWithCache(
  supplied: Record<string, unknown>,
  cache: {
    authoredExpressions: ReadonlySet<string>;
    resolvedExpressions?: ReadonlySet<string>;
    evaluatedInputs?: Record<string, unknown>;
  },
): string[] {
  const keys = Object.keys(supplied);
  if (keys.length === 0) return [];
  const resolved = inputsResolvedIntoCache(cache);
  const recorded = cache.evaluatedInputs;
  const merged = recorded ? deepMerge({ ...recorded }, supplied) : supplied;
  return keys.filter((key) =>
    (resolved.all || resolved.names.has(key)) &&
    (recorded === undefined || !Object.hasOwn(recorded, key) ||
      canonicalJson(merged[key]) !== canonicalJson(recorded[key]))
  );
}

/**
 * The run inputs a cached evaluated definition resolved that the replaying
 * run holds otherwise (swamp-club#3583). A `--last-evaluated` step runs the
 * definition as cached, with `inputs.*` resolved against the run's inputs it
 * was evaluated with, while the run records its own: a gate checked inside a
 * definition would otherwise pass on one value while the run records another
 * that a later resume acts on. Every run input a resolved expression read must
 * have the same value now, or be absent both times. An input the step
 * supplies itself (`stepInputKeys`) is the step's, evaluated whenever it runs,
 * and not compared. A cache that recorded no inputs cannot be checked, so
 * every such input conflicts.
 */
export function inputsConflictingWithCachedDefinition(
  runInputs: Record<string, unknown>,
  stepInputKeys: readonly string[],
  cache: {
    authoredExpressions: ReadonlySet<string>;
    resolvedExpressions?: ReadonlySet<string>;
    evaluatedInputs?: Record<string, unknown>;
  },
): string[] {
  const resolved = inputsResolvedIntoCache(cache);
  const recorded = cache.evaluatedInputs;
  const stepKeys = new Set(stepInputKeys);
  if (resolved.all && recorded === undefined) {
    // Read whole, and nothing to compare it with.
    return ["*"];
  }
  const names = resolved.all
    ? new Set([...Object.keys(runInputs), ...Object.keys(recorded ?? {})])
    : resolved.names;
  return [...names].filter((name) => {
    if (stepKeys.has(name)) return false;
    if (recorded === undefined) return true;
    const had = Object.hasOwn(recorded, name);
    const has = Object.hasOwn(runInputs, name);
    if (had !== has) return true;
    return had &&
      canonicalJson(runInputs[name]) !== canonicalJson(recorded[name]);
  });
}

/** An evaluated workflow as it is written to the evaluated cache. */
export interface PersistedEvaluatedWorkflow {
  workflow: Workflow;
  deferredExpressions: DeferredExpression[];
  writtenReferences: WrittenReference[];
}

function dotted(path: DataPath): string {
  return path.map((p) => typeof p === "number" ? `[${p}]` : `.${p}`).join("")
    .replace(/^\./, "");
}

/**
 * A forEach step name with every recorded sensitive value replaced by
 * `sensitive-<index>`, the item's position in the iteration: stable across
 * resume, which expands from source again, and never the secret.
 */
export function forEachNameWithoutSecrets(
  name: string,
  index: number,
  values: RunSensitiveValues,
): string {
  let result = name;
  for (const { value } of values.list()) {
    if (result.includes(value)) {
      result = result.split(value).join(`sensitive-${index}`);
    }
  }
  return result;
}

/**
 * Whether a path is one of the workflow's identifier maps: the workflow's
 * `tags` and `labels`, a job's `labels`, a step's `labels`, and a step's
 * data output override `tags`. Readers match these by exact string and
 * nothing restores them, so they hold placeholders, never secrets or
 * references. A task input that happens to be named `tags` or `labels` is a
 * value like any other and is not one of these.
 */
export function isIdentifierMapPath(path: DataPath): boolean {
  if (path.length === 1) return path[0] === "tags" || path[0] === "labels";
  if (path[0] !== "jobs" || typeof path[1] !== "number") return false;
  if (path.length === 3) return path[2] === "labels";
  if (path[2] !== "steps" || typeof path[3] !== "number") return false;
  if (path.length === 5) return path[4] === "labels";
  return path.length === 7 && path[4] === "dataOutputOverrides" &&
    typeof path[5] === "number" && path[6] === "tags";
}

/** Replaces recorded sensitive values in the identifier maps with placeholders. */
function withTagPlaceholders(
  value: unknown,
  values: RunSensitiveValues,
  path: DataPath = [],
): unknown {
  if (
    isIdentifierMapPath(path) && value !== null && typeof value === "object" &&
    !Array.isArray(value)
  ) {
    return values.tagsWithPlaceholders(value as Record<string, string>);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) =>
      withTagPlaceholders(item, values, [...path, index])
    );
  }
  if (value !== null && typeof value === "object") {
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, item] of Object.entries(value)) {
      definedEntry(
        result,
        key,
        withTagPlaceholders(item, values, [...path, key]),
      );
    }
    return result;
  }
  return value;
}

/** Whether a path sits inside one of the identifier maps. */
function underIdentifierMap(path: DataPath): boolean {
  for (let length = 1; length < path.length; length++) {
    if (isIdentifierMapPath(path.slice(0, length))) return true;
  }
  return false;
}

/**
 * Builds what to write for an evaluated workflow: sentinels in the overlay's
 * sanitized task fields become vault references, recorded values at every
 * position the source held an expression and in deferred bindings do too,
 * and tags and labels carry placeholders.
 */
export function persistEvaluatedWorkflow(
  evaluated: Workflow,
  source: Workflow,
  overlay: SanitizedTaskOverlay | undefined,
  deferredExpressions: readonly DeferredExpression[],
  values: RunSensitiveValues,
): PersistedEvaluatedWorkflow {
  const base = overlay?.sanitizedData ?? evaluated.toData();
  const file = {
    ...(withTagPlaceholders(base, values) as WorkflowInput),
    deferredExpressions: [...deferredExpressions],
  };
  const sourcePaths = extractExpressions(source.toData()).map((e) => e.path);
  const form = toPersistedForm(file, values, {
    applies: (path) => {
      if (path[0] === "deferredExpressions" && path[2] === "bindings") {
        return true;
      }
      if (underIdentifierMap(path)) return false;
      // A step's task arguments, target and platform carry values wherever
      // the step sits, including steps forEach expansion added.
      if (
        path[0] === "jobs" && path[2] === "steps" &&
        ((path[4] === "task" &&
          (path[5] === "inputs" || path[5] === "globalArgs")) ||
          path[4] === "target" || path[4] === "platform")
      ) {
        return true;
      }
      const at = dotted(path);
      return sourcePaths.some((p) =>
        at === p || at.startsWith(`${p}.`) || at.startsWith(`${p}[`)
      );
    },
  });
  const { deferredExpressions: deferred, ...workflowData } = form.data;
  return {
    workflow: Workflow.fromData(workflowData as WorkflowInput),
    deferredExpressions: deferred,
    writtenReferences: form.writtenReferences,
  };
}

/**
 * Restores a cached evaluated workflow for replay: the workflow with real
 * values, and an overlay whose sanitized task fields carry data-origin
 * sentinels, as a fresh evaluation would produce.
 */
export async function rehydrateEvaluatedWorkflow(
  cached: {
    workflow: Workflow;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
  },
  read: VaultReader,
  values: RunSensitiveValues,
): Promise<{
  workflow: Workflow;
  sanitizedTasks?: SanitizedTaskOverlay;
  deferredExpressions: DeferredExpression[];
}> {
  if (cached.writtenReferences.length === 0) {
    return {
      workflow: cached.workflow,
      deferredExpressions: [...cached.deferredExpressions],
    };
  }
  const bag = new VaultSecretBag(values.sentinels);
  const file = {
    ...cached.workflow.toData(),
    deferredExpressions: [...cached.deferredExpressions],
  };
  const { raw, sanitized } = await rehydratePersistedForm(
    file,
    cached.writtenReferences,
    read,
    values,
    bag,
    // A fresh run's overlay sanitizes only step task arguments.
    (path) =>
      path[0] === "jobs" && path[2] === "steps" && path[4] === "task" &&
      (path[5] === "inputs" || path[5] === "globalArgs"),
  );
  const { deferredExpressions, ...rawWorkflow } = raw;
  const { deferredExpressions: _unused, ...sanitizedWorkflow } = sanitized;
  const workflow = Workflow.fromData(rawWorkflow as WorkflowInput);
  return {
    workflow,
    sanitizedTasks: SanitizedTaskOverlay.fromSanitizedData(
      bag,
      sanitizedWorkflow as WorkflowInput,
      workflow,
    ),
    deferredExpressions,
  };
}
