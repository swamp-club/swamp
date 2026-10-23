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

/**
 * The parts of a Zod v4 definition the field isolation reads.
 */
interface ZodDef {
  type?: string;
  shape?: Record<string, z.ZodTypeAny>;
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
}

function getSchemaDef(schema: z.ZodTypeAny): ZodDef | undefined {
  return (schema as unknown as { _zod?: { def?: ZodDef } })._zod?.def;
}

/**
 * The top-level argument names an arguments schema cannot do without: the
 * keys whose absence makes the arguments fail to parse (swamp-club#3873).
 *
 * Zod's parser decides, not its JSON Schema: which keys `z.toJSONSchema`
 * lists as `required` changes with the Zod version (4.5 started listing
 * `z.preprocess` fields and `.catch()` around a transform), while what the
 * schema accepts does not. Optional, defaulted and `.catch()` fields, and a
 * preprocess that turns a missing value into a valid one, are not required.
 * A field whose parse throws on a missing value is.
 *
 * Deciding this runs the schema's own refinements, transforms and
 * preprocesses against a missing value, as the runtime parse does.
 *
 * Returns an empty list for a value that is not a Zod v4 schema.
 */
export async function requiredArgumentNames(
  schema: z.ZodTypeAny,
): Promise<string[]> {
  const def = getSchemaDef(schema);
  if (!def) return [];
  const accepting = acceptingSide(def);
  if (accepting) return await requiredArgumentNames(accepting);
  if (def.type === "intersection") {
    return [
      ...new Set([
        ...(def.left ? await requiredArgumentNames(def.left) : []),
        ...(def.right ? await requiredArgumentNames(def.right) : []),
      ]),
    ];
  }
  try {
    return missingKeys(await probe(schema));
  } catch {
    // A field threw on its missing value and took the whole parse with it,
    // so judge each field on its own.
    return await isolatedRequiredNames(schema);
  }
}

/**
 * The side of a pipe that takes the step's arguments, when that is its input
 * side. Its output side is fed what the input side produces, and names keys
 * a step never supplies (swamp-club#3681). A pipe whose input is a transform
 * (how `z.preprocess` is built) has no keys of its own on that side, so it
 * is judged whole.
 */
function acceptingSide(def: ZodDef): z.ZodTypeAny | undefined {
  if (def.type !== "pipe" || !def.in) return undefined;
  return getSchemaDef(def.in)?.type === "transform" ? undefined : def.in;
}

/** Parses an empty arguments object, reporting each issue's input. */
function probe(schema: z.ZodTypeAny) {
  return schema.safeParseAsync({}, { reportInput: true });
}

/**
 * The keys a failed probe names: those with an issue over a missing value.
 * An issue whose input is defined comes from a check on an enclosing value
 * — a cross-field rule such as "a or b", whatever issue code it raises —
 * which a step supplying either satisfies, so it is left to the runtime
 * parse.
 */
function missingKeys(
  result: Awaited<ReturnType<typeof probe>>,
): string[] {
  if (result.success) return [];
  const keys = new Set<string>();
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    if (issue.input !== undefined) continue;
    keys.add(key);
  }
  return [...keys];
}

async function isolatedRequiredNames(
  schema: z.ZodTypeAny,
): Promise<string[]> {
  const required = new Set<string>();
  for (const shape of reachableShapes(schema)) {
    for (const [key, field] of Object.entries(shape)) {
      try {
        const result = await probe(z.object({ [key]: field }));
        if (missingKeys(result).includes(key)) required.add(key);
      } catch {
        required.add(key);
      }
    }
  }
  return [...required];
}

/**
 * The object shapes whose fields reach the top level of the arguments: an
 * object, both sides of an intersection, and a pipe's accepting side — or
 * its output side when the input is a transform, as in `z.preprocess`.
 * Anything else (a union, a lazy schema) has no fields to isolate, and the
 * runtime parse reports what it throws.
 */
function reachableShapes(
  schema: z.ZodTypeAny,
): Record<string, z.ZodTypeAny>[] {
  const def = getSchemaDef(schema);
  switch (def?.type) {
    case "object":
      return def.shape ? [def.shape] : [];
    case "intersection":
      return [
        ...(def.left ? reachableShapes(def.left) : []),
        ...(def.right ? reachableShapes(def.right) : []),
      ];
    case "pipe": {
      const side = acceptingSide(def) ?? def.out;
      return side ? reachableShapes(side) : [];
    }
    default:
      return [];
  }
}
