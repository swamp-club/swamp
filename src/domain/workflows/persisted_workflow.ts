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
  toPersistedForm,
  type WrittenReference,
} from "../secrets/mod.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import { SanitizedTaskOverlay } from "./expression_evaluators.ts";
import { Workflow, type WorkflowInput } from "./workflow.ts";
import { WorkflowRun } from "./workflow_run.ts";

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
  /**
   * Where data sits in the written workflow, in its own coordinates, so a
   * typed replay can restore references in place of the reference text and
   * align exactly (typed-secrets 4.4). Set when the caller gave the raw
   * copy's map.
   */
  persistedProvenance?: ProvenanceMap;
}

/**
 * A forEach step name with every recorded sensitive value, and in a typed
 * run every sentinel the run issued, replaced by `sensitive-<index>`, the
 * item's position in the iteration: stable across resume, which expands from
 * source again, and never the secret. The sentinel is replaced first, so a
 * recorded value that is a fragment of one cannot break it apart.
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

/**
 * Builds what to write for an evaluated workflow: sentinels in the overlay's
 * sanitized task fields and deferred bindings become vault references;
 * tags and labels carry placeholders.
 */
export function persistEvaluatedWorkflow(
  evaluated: Workflow,
  overlay: SanitizedTaskOverlay | undefined,
  deferredExpressions: readonly DeferredExpression[],
  values: RunSensitiveValues,
  /** Where data sits in `evaluated`, the raw copy (swamp-club#3205). */
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
 * Restores a cached evaluated workflow for replay.
 *
 * In a typed run (the registry carries the option) the cache's written
 * references become sentinels a bag of the run's registry issues, reading
 * no vault: the workflow and the overlay's sanitized task fields are one
 * sentinel copy, the step bags rehome the sentinels with their encodings,
 * and each delivery loads the current value under the principal's current
 * grants (typed-secrets 4.4). The cache's `persistedProvenance` is aligned
 * exactly onto that copy and returned as `provenance`; a cache with
 * references and a value-coordinate map only is refused, and one with no
 * map replays as authored (see `replayProvenance`).
 */
export function rehydrateEvaluatedWorkflow(
  cached: {
    workflow: Workflow;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
    /** See {@link PersistedEvaluatedWorkflow.persistedProvenance}. */
    persistedProvenance?: ProvenanceMap;
    /** Where data sits in the raw copy, as the cache stores it. */
    provenance?: ProvenanceMap;
  },
  values: RunSensitiveValues,
): {
  workflow: Workflow;
  sanitizedTasks?: SanitizedTaskOverlay;
  deferredExpressions: DeferredExpression[];
  /** Set in a typed run: the map of the restored copy, aligned onto it. */
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

/** A written entry's path below `depth`, spelled as provenance maps spell it. */
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
 * Restores a stored run for a typed resume or retry, holding references
 * (typed-secrets 4.4, design Section 8.2): every written reference of the
 * record (inputs, deferred bindings, step errors, approval prompts, assert
 * text, the failure reason) becomes a sentinel a bag of the run's registry
 * issues, reading no vault and recording no value, so the run-start pass
 * binds a reference where the run held one and each remaining step loads
 * the current value at delivery. The record's maps follow the copy: the
 * inputs map is aligned exactly from `persistedInputsProvenance` through the
 * reference text each sentinel stands for; a record written before that map
 * existed fails closed, each input string holding a reference becoming whole
 * data, so the resume continues and no authored span is mistaken for data.
 * A deferred binding that holds a reference is whole data in its own map
 * for the same reason. The run's values are attached. The record's own
 * `writtenReferences` ride along, so {@link WorkflowRun.toPersistedData}
 * writes the run back as it was read.
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
