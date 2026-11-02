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
import {
  alignProvenance,
  indexPath,
  keyPath,
  ProvenanceMap,
  sentinelReferenceTextOf,
} from "../expressions/provenance_map.ts";
import {
  replayProvenance,
  withWrittenReferenceRanges,
} from "../expressions/persisted_evaluation.ts";
import { extractExpressions } from "../expressions/expression_parser.ts";
import { canonicalJson } from "../expressions/expression_references.ts";
import { deepMerge } from "../inputs/input_merge.ts";
import { quoteShellWord } from "../shell_word.ts";
import {
  type DataPath,
  definedEntry,
  rehydrateReferences,
  type RunSensitiveValues,
  SENSITIVE_FORMAT_VERSION,
  toPersistedForm,
  type WrittenReference,
} from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SanitizedTaskOverlay } from "./expression_evaluators.ts";
import { Workflow, type WorkflowInput } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

/**
 * inputs are withheld when any nested value is sensitive: a parent can pass a
 * secret to a nested workflow and the cache file would hold it in plaintext
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

export interface ReplayableCache {
  workflow: { name: string };
  evaluatedInputs?: Record<string, unknown>;
  evaluatedInputsProvenance?: ProvenanceMap;
  evaluatedInputsOmitted?: "sensitive";
}

/**
 * a cache that withheld its inputs as sensitive is never replayed; a refusal
 * names keys only because values may be secrets
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

export interface PersistedEvaluatedWorkflow {
  sensitiveFormat: number;
  workflow: Workflow;
  deferredExpressions: DeferredExpression[];
  writtenReferences: WrittenReference[];
  persistedProvenance?: ProvenanceMap;
}

/**
 * the index is stable across resume and never the secret; the sentinel is
 * replaced first so a recorded value that is a fragment of one cannot break it
 * apart
 */
export function forEachNameWithoutSecrets(
  name: string,
  index: number,
  values: RunSensitiveValues,
): string {
  let result = values.withForEachStandIns(name, index);
  for (const { value } of values.list()) {
    if (result.includes(value)) {
      result = result.split(value).join(`sensitive-${index}`);
    }
  }
  return result;
}

/**
 * identifier maps are matched by exact string and never restored, so they hold
 * placeholders, never secrets or references
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

export function persistEvaluatedWorkflow(
  evaluated: Workflow,
  overlay: SanitizedTaskOverlay | undefined,
  deferredExpressions: readonly DeferredExpression[],
  values: RunSensitiveValues,
  provenance?: ProvenanceMap,
): PersistedEvaluatedWorkflow {
  const base = overlay?.sanitizedData ?? evaluated.toData();
  const file = {
    ...(withTagPlaceholders(base, values) as WorkflowInput),
    deferredExpressions: [...deferredExpressions],
  };
  const form = toPersistedForm(file, values);
  const { deferredExpressions: deferred, ...workflowData } = form.data;
  return {
    workflow: Workflow.fromData(workflowData as WorkflowInput),
    sensitiveFormat: SENSITIVE_FORMAT_VERSION,
    deferredExpressions: deferred,
    writtenReferences: form.writtenReferences,
    ...(provenance
      ? {
        // Sentinels stand in for the reference text they are written as, so
        // the map is exact wherever a sentinel became a reference; a value
        // the search replaced falls to the differing-span rule, and every
        // written reference is marked data either way.
        persistedProvenance: withWrittenReferenceRanges(
          alignProvenance(
            provenance,
            evaluated.toData(),
            workflowData,
            sentinelReferenceTextOf(values.sentinels),
          ),
          workflowData,
          form.writtenReferences,
        ),
      }
      : {}),
  };
}

/**
 * a cache with references and only a value-coordinate map is refused; one with
 * no map replays as authored
 */
export function rehydrateEvaluatedWorkflow(
  cached: {
    sensitiveFormat?: number;
    workflow: Workflow;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
    persistedProvenance?: ProvenanceMap;
    provenance?: ProvenanceMap;
  },
  values: RunSensitiveValues,
): {
  workflow: Workflow;
  sanitizedTasks?: SanitizedTaskOverlay;
  deferredExpressions: DeferredExpression[];
  provenance?: ProvenanceMap;
} {
  if (cached.writtenReferences.length === 0) {
    return {
      workflow: cached.workflow,
      deferredExpressions: [...cached.deferredExpressions],
    };
  }
  const bag = new VaultSecretBag(values.sentinels);
  {
    const persisted = cached.workflow.toData();
    const restored = rehydrateReferences(
      { ...persisted, deferredExpressions: [...cached.deferredExpressions] },
      cached.writtenReferences,
      bag,
      cached.workflow.name,
      cached.sensitiveFormat ?? 0,
    );
    const { deferredExpressions, ...restoredData } = restored;
    const workflow = Workflow.fromData(restoredData as WorkflowInput);
    return {
      workflow,
      sanitizedTasks: SanitizedTaskOverlay.fromSanitizedData(
        bag,
        restoredData as WorkflowInput,
        workflow,
      ),
      deferredExpressions,
      provenance: replayProvenance(
        cached,
        persisted,
        restoredData,
        bag,
        `The evaluated workflow cached for "${cached.workflow.name}" was written before it recorded where its references sit, so it is not replayed with references. ` +
          `Run the workflow without --last-evaluated to evaluate it again; that rewrites the cache.`,
      ),
    };
  }
}

function provenanceKeyBelow(path: DataPath, depth: number): string {
  return path.slice(depth).reduce<string>(
    (parent, segment) =>
      typeof segment === "number"
        ? indexPath(parent, segment)
        : keyPath(parent, segment),
    "",
  );
}

/**
 * a record written before the inputs map existed fails closed: each input
 * string holding a reference becomes whole data, so no authored span is
 * mistaken for data
 */
export function rehydrateRunReferences(
  run: WorkflowRun,
  values: RunSensitiveValues,
): WorkflowRun {
  const stored = run.toData();
  const writtenReferences = stored.writtenReferences ?? [];
  const bag = new VaultSecretBag(values.sentinels);
  const restored = rehydrateReferences(
    stored,
    writtenReferences,
    bag,
    `run ${run.id}`,
    stored.sensitiveFormat ?? 0,
  );
  const deferredExpressions = (restored.deferredExpressions ?? []).map(
    (entry, index) => {
      const bound = writtenReferences.filter((reference) =>
        reference.path[0] === "deferredExpressions" &&
        reference.path[1] === index && reference.path[2] === "bindings"
      );
      if (bound.length === 0 || entry.provenance === undefined) return entry;
      let map = ProvenanceMap.fromData(entry.provenance);
      for (const reference of bound) {
        map = map.withWholeData(provenanceKeyBelow(reference.path, 3));
      }
      return { ...entry, provenance: map.toData() };
    },
  );
  const rehydrated = WorkflowRun.fromData({ ...restored, deferredExpressions });
  const inputReferences = writtenReferences.filter((reference) =>
    reference.path[0] === "inputs"
  );
  if (inputReferences.length > 0) {
    const persisted = run.persistedInputsProvenance;
    const valueCoordinateMap = run.inputsProvenance;
    if (persisted !== undefined) {
      rehydrated.captureInputsProvenance(alignProvenance(
        persisted,
        stored.inputs ?? {},
        restored.inputs ?? {},
        undefined,
        sentinelReferenceTextOf(values.sentinels),
      ));
    } else if (valueCoordinateMap !== undefined) {
      let map = valueCoordinateMap;
      for (const reference of inputReferences) {
        map = map.withWholeData(provenanceKeyBelow(reference.path, 1));
      }
      rehydrated.captureInputsProvenance(map);
    }
  }
  rehydrated.attachSensitiveValues(values);
  return rehydrated;
}
