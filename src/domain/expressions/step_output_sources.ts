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
 * Where a step context's outputs came from (design/enablers/typed-secrets.md
 * Section 6.1, typed-secrets 4.2). `steps.<name>.outputs` is a flat merge of
 * the attributes of the JSON resources a step wrote, which loses each
 * record's identity and its sensitive-fields tag. The sources keep both: the
 * stored records, in write order, so the typed evaluator can view the
 * outputs through the accessor adapter, with each tagged field a `Secret`,
 * and name a refusal by record without a value.
 *
 * A step context carries its sources under a symbol key, as the expression
 * context carries the run's sensitive values (`sensitive_context.ts`): CEL
 * reads string keys only, `JSON.stringify` drops it, and object spread and
 * `Object.getOwnPropertyDescriptors` copy it. Where a step context must
 * cross a string-keyed copy, the deferred-binding capture, the persisted form
 * below carries the sources as plain data and is re-attached on rebind.
 */

import { z } from "zod";

/**
 * The stored form of one JSON resource a step wrote: what the accessor
 * adapter validates whole and names in a refusal. The attributes are as
 * stored, so a tagged field holds its reference text and no value.
 */
export interface StepOutputRecord {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly namespace: string;
  readonly modelName: string;
  readonly tags: Record<string, string>;
  readonly attributes: Record<string, unknown>;
}

/**
 * One group of records a step's outputs were merged from, at `path` under
 * the step's outputs: empty for a method step's own outputs, the child step
 * name for a workflow step's child outputs. Records are in write order, so
 * a later record wins on a key clash, as the merge decides.
 */
export interface StepOutputGroup {
  readonly path: readonly string[];
  readonly records: readonly StepOutputRecord[];
}

export type StepOutputSources = readonly StepOutputGroup[];

const STEP_OUTPUT_SOURCES: unique symbol = Symbol("swamp.stepOutputSources");

interface CarriesStepOutputSources {
  [STEP_OUTPUT_SOURCES]?: StepOutputSources;
}

/**
 * Attaches the sources a step context's outputs were merged from, or
 * nothing when `sources` is undefined or empty. Returns the context.
 */
export function attachStepOutputSources<T extends object>(
  stepContext: T,
  sources: StepOutputSources | undefined,
): T {
  if (sources !== undefined && sources.length > 0) {
    (stepContext as CarriesStepOutputSources)[STEP_OUTPUT_SOURCES] = sources;
  }
  return stepContext;
}

/** The sources a step context carries, if any. */
export function stepOutputSourcesOf(
  stepContext: unknown,
): StepOutputSources | undefined {
  if (typeof stepContext !== "object" || stepContext === null) {
    return undefined;
  }
  return (stepContext as CarriesStepOutputSources)[STEP_OUTPUT_SOURCES];
}

/** The persisted form of one record: plain data, validated on read. */
export const StepOutputRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  namespace: z.string(),
  modelName: z.string(),
  tags: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), z.unknown()),
});

/** The persisted form of a step context's sources. */
export const StepOutputSourcesSchema = z.array(z.object({
  path: z.array(z.string()),
  records: z.array(StepOutputRecordSchema),
}));

/** The key the persisted form carries the sources under. */
const SOURCES_KEY = "sources";

/** Defines an own enumerable key, so a step named __proto__ stays a key. */
function define(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * A step context as a string-keyed copy can carry it: the context's own
 * keys plus the sources under {@link SOURCES_KEY} when it has any. Built
 * for every entry of `steps`, so a JSON copy of the result keeps the
 * sources.
 */
export function toPersistedStepContexts(
  steps: Record<string, object> | undefined,
): Record<string, Record<string, unknown>> | undefined {
  if (steps === undefined) return undefined;
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(steps)) {
    const context = steps[name] as Record<string, unknown>;
    // String keys only: the symbol has no place in a plain copy.
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(context)) copy[key] = context[key];
    const sources = stepOutputSourcesOf(context);
    if (sources !== undefined) copy[SOURCES_KEY] = sources;
    define(out, name, copy);
  }
  return out;
}

/**
 * The inverse of {@link toPersistedStepContexts}: each entry without its
 * plain sources key, which CEL must not see, and with the sources attached
 * under the symbol. An entry without the key is copied as it is.
 */
export function fromPersistedStepContexts<T extends Record<string, unknown>>(
  steps: Record<string, T> | undefined,
): Record<string, T> | undefined {
  if (steps === undefined) return undefined;
  const out: Record<string, T> = {};
  for (const name of Object.keys(steps)) {
    const { [SOURCES_KEY]: sources, ...context } = steps[name];
    define(
      out,
      name,
      attachStepOutputSources(
        context as T,
        sources === undefined
          ? undefined
          : StepOutputSourcesSchema.parse(sources),
      ),
    );
  }
  return out;
}
