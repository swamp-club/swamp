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

import type { InputsSchema } from "../definitions/definition.ts";
import {
  readSetMap,
  valueContainsExpression as containsAnyExpression,
} from "../expressions/expression_parser.ts";
import { keySegment, ProvenanceMap } from "../expressions/provenance_map.ts";
import { attachBindingProvenance } from "../expressions/splice_origin.ts";
import type { Workflow } from "./workflow.ts";

/**
 * inputs arrive merged (caller, webhook, trigger literals, defaults); a value
 * equal to the workflow's own default or static trigger literal for its key is
 * authored, any other came from the caller and is data
 */
export function workflowInputsProvenance(
  inputs: Record<string, unknown> | undefined,
  workflow: Workflow,
  options: {
    /**
     * The run was started by a webhook. Its `trigger.inputs` are templates
     * resolved against the payload, so only a literal with no expression in
     * it is authored text; for any other run every static literal is.
     */
    webhook?: boolean;
  } = {},
): ProvenanceMap {
  if (!inputs) return ProvenanceMap.authored();
  // Judged by where each value came from, not by whether it holds a whole
  // expression: a fragment from the caller must stay data so two of them
  // cannot join across splices.
  let map = ProvenanceMap.authored();
  for (const [key, value] of Object.entries(inputs)) {
    const authored = authoredValues(
      key,
      workflow.inputs,
      workflow.triggerInputs,
      options.webhook === true,
    );
    map = map.graft(keySegment(key), valueProvenance(value, authored));
  }
  return map;
}

function authoredValues(
  key: string,
  schema: InputsSchema | undefined,
  triggerInputs: Record<string, unknown> | undefined,
  webhook: boolean,
): AuthoredValue[] {
  const values: AuthoredValue[] = [];
  const property = schema?.properties?.[key] as
    | { default?: unknown; properties?: Record<string, unknown> }
    | undefined;
  if (property && Object.hasOwn(property, "default")) {
    values.push({ value: property.default, schema: property });
  } else if (property) {
    values.push({ schema: property });
  }
  // A static trigger literal is authored text. On a webhook run the
  // literal is a template (`${{ webhook.body.x }}`) whose resolved value is
  // the caller's data, so a value equal to the template text earns nothing.
  if (
    triggerInputs && Object.hasOwn(triggerInputs, key) &&
    !(webhook && containsAnyExpression(triggerInputs[key]))
  ) {
    values.push({ value: triggerInputs[key] });
  }
  return values;
}

interface AuthoredValue {
  value?: unknown;
  schema?: { default?: unknown; properties?: Record<string, unknown> };
}

/**
 * authored where equal to an authored value for its position, recursing into
 * properties with schema defaults; otherwise data, an undescribed object whole
 * with its keys, so a record of secrets is masked at the record
 */
function valueProvenance(
  value: unknown,
  authored: AuthoredValue[],
): ProvenanceMap {
  for (const candidate of authored) {
    if (
      Object.hasOwn(candidate, "value") &&
      JSON.stringify(value) === JSON.stringify(candidate.value)
    ) {
      return ProvenanceMap.authored();
    }
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return ProvenanceMap.data();
  }
  const described = authored.some((candidate) =>
    candidate.schema?.properties !== undefined ||
    (candidate.value !== null && typeof candidate.value === "object" &&
      !Array.isArray(candidate.value))
  );
  if (!described) return ProvenanceMap.data();
  let map = ProvenanceMap.authored();
  for (const [key, item] of Object.entries(value)) {
    const nested: AuthoredValue[] = [];
    for (const candidate of authored) {
      const parent = candidate.value;
      if (
        parent !== null && typeof parent === "object" &&
        !Array.isArray(parent) && Object.hasOwn(parent, key)
      ) {
        nested.push({ value: (parent as Record<string, unknown>)[key] });
      }
      const property = candidate.schema?.properties?.[key] as
        | AuthoredValue["schema"]
        | undefined;
      if (property && Object.hasOwn(property, "default")) {
        nested.push({ value: property.default, schema: property });
      } else if (property) {
        nested.push({ schema: property });
      }
    }
    map = map.graft(keySegment(key), valueProvenance(item, nested));
  }
  return map;
}

/**
 * `map` with occurrences of expressions in `vouched` treated as authored even
 * inside data: a resumed run's captured inputs hold a parent's unresolved
 * runtime expressions, which the run's persisted inherited set vouches for.
 */
export function vouchInherited(
  map: ProvenanceMap,
  inputs: Record<string, unknown> | undefined,
  vouched: ReadonlySet<string>,
): ProvenanceMap {
  if (map.isAuthored || !inputs || vouched.size === 0) return map;
  let out = map;
  for (const [key, value] of Object.entries(inputs)) {
    if (!map.hasDataAtOrBelow(keySegment(key))) continue;
    // Everything under the key is data except inherited occurrences.
    out = out.graft(keySegment(key), readSetMap(value, vouched));
  }
  return out;
}

export function attachInputsProvenance<T extends object>(
  context: T,
  inputs: ProvenanceMap,
): T {
  return attachBindingProvenance(context, {
    inputs,
    run: ProvenanceMap.authored().graft("inputs", inputs).withWholeData("tags"),
  });
}
