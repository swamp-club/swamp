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

interface ZodDef {
  type?: string;
  shape?: Record<string, z.ZodTypeAny>;
  left?: z.ZodTypeAny;
  right?: z.ZodTypeAny;
  in?: z.ZodTypeAny;
  out?: z.ZodTypeAny;
  innerType?: z.ZodTypeAny;
}

function getSchemaDef(schema: z.ZodTypeAny): ZodDef | undefined {
  return (schema as unknown as { _zod?: { def?: ZodDef } })._zod?.def;
}

const PASS_THROUGH_WRAPPERS = new Set([
  "optional",
  "nullable",
  "default",
  "readonly",
]);

/**
 * top-level keys whose absence makes the arguments fail to parse, judged by
 * parsing each field alone with its key absent, not by JSON Schema, whose
 * required list varies with the Zod version
 */
export async function requiredArgumentNames(
  schema: z.ZodTypeAny,
): Promise<string[]> {
  return [...await requiredKeys(schema, {})];
}

async function requiredKeys(
  schema: z.ZodTypeAny,
  input: Record<string, unknown>,
): Promise<Set<string>> {
  const def = getSchemaDef(schema);
  switch (def?.type) {
    case "object": {
      const required = new Set<string>();
      for (const [key, field] of Object.entries(def.shape ?? {})) {
        if (await rejectsAbsence(key, field, input)) required.add(key);
      }
      return required;
    }
    case "intersection":
      return new Set([
        ...(def.left ? await requiredKeys(def.left, input) : []),
        ...(def.right ? await requiredKeys(def.right, input) : []),
      ]);
    case "pipe": {
      if (!def.in) return new Set();
      // A pipe from a transform is how z.preprocess is built: the output
      // side takes what the transform makes of the arguments.
      if (getSchemaDef(def.in)?.type !== "transform") {
        return await requiredKeys(def.in, input);
      }
      return def.out
        ? await requiredKeys(def.out, await preprocessed(def.in, input))
        : new Set();
    }
    default:
      if (def?.type && PASS_THROUGH_WRAPPERS.has(def.type) && def.innerType) {
        return await requiredKeys(def.innerType, input);
      }
      return new Set();
  }
}

/**
 * Whether `field` fails, or throws, when the step leaves `key` out. It is
 * parsed alone in a one-field object, so no rule on the enclosing object
 * runs. The probe has no prototype, so a key named like an `Object`
 * method is as absent as any other.
 */
async function rejectsAbsence(
  key: string,
  field: z.ZodTypeAny,
  input: Record<string, unknown>,
): Promise<boolean> {
  const probe: Record<string, unknown> = Object.create(null);
  if (Object.hasOwn(input, key)) probe[key] = input[key];
  try {
    const result = await z.object({ [key]: field }).safeParseAsync(probe);
    return !result.success &&
      result.error.issues.some((issue) => issue.path[0] === key);
  } catch {
    return true;
  }
}

/**
 * What a preprocess makes of `input`. A preprocess that throws, fails or
 * produces something other than an object leaves its fields judged
 * against `input`.
 */
async function preprocessed(
  transform: z.ZodTypeAny,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  try {
    const result = await transform.safeParseAsync(input);
    if (
      result.success && typeof result.data === "object" &&
      result.data !== null && !Array.isArray(result.data)
    ) {
      return result.data as Record<string, unknown>;
    }
  } catch {
    // Judged against the unprocessed input below.
  }
  return input;
}
