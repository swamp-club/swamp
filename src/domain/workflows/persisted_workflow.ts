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
  type DeferredExpression,
  isDeferredExpression,
} from "../expressions/deferred_expression.ts";
import type { ProvenanceMap } from "../expressions/provenance_map.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { quoteShellWord } from "../shell_word.ts";
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
 * The evaluation inputs an evaluated cache records (swamp-club#3583): the
 * inputs themselves, or why they were withheld. They are withheld when any
 * value, nested included, is a known sensitive value: a parent can pass a
 * secret to a nested workflow as an input, and the cache file would carry it
 * in plaintext. A fresh run makes the same choice, so such a cache is not
 * made replayable by running fresh once.
 */
export type RecordedEvaluationInputs =
  | {
    inputs: Record<string, unknown>;
    provenance?: ProvenanceMap;
    inheritedExpressions?: ReadonlySet<string>;
  }
  | { omitted: "sensitive" };

export function recordableEvaluatedInputs(
  inputs: Record<string, unknown>,
  values: RunSensitiveValues,
  origins?: {
    provenance: ProvenanceMap;
    inheritedExpressions?: ReadonlySet<string>;
  },
): RecordedEvaluationInputs {
  return canonicalJson(values.masked(inputs)) === canonicalJson(inputs)
    ? { inputs, ...origins }
    : { omitted: "sensitive" };
}

/** What a `--last-evaluated` run reads of its cache before it starts. */
export interface ReplayableCache {
  workflow: { name: string };
  evaluatedInputs?: Record<string, unknown>;
  evaluatedInputsProvenance?: ProvenanceMap;
  evaluatedInputsOmitted?: "sensitive";
}

/**
 * The inputs a `--last-evaluated` run runs and records with, or why it is
 * refused (swamp-club#3583). The cached steps were resolved with the inputs
 * the cache records, so the run takes those, and a supplied input must equal
 * its recorded value after coercion and merge. A cache that withheld its
 * inputs for a sensitive value is never replayed; one written before inputs
 * were recorded is replayed once the workflow has run fresh. A refusal names
 * keys only: values may be secrets.
 */
export function replayInputs(
  cache: ReplayableCache,
  supplied: Record<string, unknown>,
): { inputs: Record<string, unknown> } | { refusal: string } {
  const name = cache.workflow.name;
  if (cache.evaluatedInputsOmitted !== undefined) {
    return {
      refusal:
        `The evaluated workflow cached for "${name}" was evaluated with an input that held a secret, so its inputs were not recorded and it cannot be replayed. ` +
        `Run the workflow without --last-evaluated.`,
    };
  }
  const recorded = cache.evaluatedInputs;
  if (recorded === undefined) {
    return {
      refusal:
        `The evaluated workflow cached for "${name}" was written before the inputs it was evaluated with were recorded, so it cannot be replayed. ` +
        `Run the workflow once without --last-evaluated, or evaluate it again (swamp workflow evaluate ${
          quoteShellWord(name)
        } --input ...); either rewrites the cache.`,
    };
  }
  if (
    cache.evaluatedInputsProvenance === undefined &&
    extractExpressions(recorded).some((expr) =>
      isDeferredExpression(expr.celExpression)
    )
  ) {
    return {
      refusal:
        `The evaluated workflow cached for "${name}" holds inherited inputs without their provenance, so it cannot be replayed. ` +
        "Run its parent workflow again, or run it without --last-evaluated with explicit inputs.",
    };
  }
  const merged = deepMerge({ ...recorded }, supplied);
  const differing = Object.keys(supplied).filter((key) =>
    !Object.hasOwn(recorded, key) ||
    canonicalJson(merged[key]) !== canonicalJson(recorded[key])
  );
  if (differing.length > 0) {
    const quoted = differing.map((k) => `"${k}"`).join(", ");
    return {
      refusal:
        `The evaluated workflow cached for "${name}" was evaluated with other values for --input ${quoted}, or without them, and its steps run as evaluated. ` +
        `Evaluate it again with these inputs (swamp workflow evaluate ${
          quoteShellWord(name)
        } --input ...), or run it without --last-evaluated.`,
    };
  }
  return { inputs: merged };
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
