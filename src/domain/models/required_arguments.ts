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
 * Returns an empty list for a value that is not a Zod v4 schema.
 */
export async function requiredArgumentNames(
  schema: z.ZodTypeAny,
): Promise<string[]> {
  if (!getSchemaDef(schema)) return [];
  try {
    return missingKeys(await probe(schema));
  } catch {
    // A field threw on its missing value and took the whole parse with it,
    // so judge each field on its own.
    return await isolatedRequiredNames(schema);
  }
}

/** Parses an empty arguments object, reporting each issue's input. */
function probe(schema: z.ZodTypeAny) {
  return schema.safeParseAsync({}, { reportInput: true });
}

/**
 * The keys a failed probe names. A custom issue whose input is defined is
 * a refinement on an enclosing value — a cross-field rule such as "a or b"
 * that a step supplying either satisfies — so it is left to the runtime
 * parse. A custom issue over a missing value (a `z.custom` field) counts.
 */
function missingKeys(
  result: Awaited<ReturnType<typeof probe>>,
): string[] {
  if (result.success) return [];
  const keys = new Set<string>();
  for (const issue of result.error.issues) {
    const key = issue.path[0];
    if (typeof key !== "string") continue;
    if (issue.code === "custom" && issue.input !== undefined) continue;
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
 * object, both sides of an intersection, and the input side of a pipe — or
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
      if (!def.in) return [];
      const side = getSchemaDef(def.in)?.type === "transform"
        ? def.out
        : def.in;
      return side ? reachableShapes(side) : [];
    }
    default:
      return [];
  }
}
