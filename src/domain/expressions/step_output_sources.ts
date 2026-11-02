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
 * steps.<name>.outputs merges attributes, losing identity and sensitive tags,
 * so the stored records are kept in write order under a symbol key CEL cannot
 * read; a persisted form carries them across copies
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

export function attachStepOutputSources<T extends object>(
  stepContext: T,
  sources: StepOutputSources | undefined,
): T {
  if (sources !== undefined && sources.length > 0) {
    (stepContext as CarriesStepOutputSources)[STEP_OUTPUT_SOURCES] = sources;
  }
  return stepContext;
}

export function stepOutputSourcesOf(
  stepContext: unknown,
): StepOutputSources | undefined {
  if (typeof stepContext !== "object" || stepContext === null) {
    return undefined;
  }
  return (stepContext as CarriesStepOutputSources)[STEP_OUTPUT_SOURCES];
}

export const StepOutputRecordSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.number(),
  namespace: z.string(),
  modelName: z.string(),
  tags: z.record(z.string(), z.string()),
  attributes: z.record(z.string(), z.unknown()),
});

export const StepOutputSourcesSchema = z.array(z.object({
  path: z.array(z.string()),
  records: z.array(StepOutputRecordSchema),
}));

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
