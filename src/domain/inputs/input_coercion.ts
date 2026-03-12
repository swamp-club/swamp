// Swamp, an Automation Framework
// Copyright (C) 2026 System Initiative, Inc.
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

import type {
  InputsSchema,
  JsonSchemaProperty,
} from "../definitions/definition.ts";

/**
 * Coerces string input values to match their declared types in an InputsSchema.
 * Only coerces values that are strings and have a declared type in the schema.
 * Without a schema, values are returned unchanged.
 */
export function coerceInputTypes(
  inputs: Record<string, unknown>,
  schema?: InputsSchema,
): Record<string, unknown> {
  const properties = schema?.properties ?? schema;
  if (!properties) {
    return inputs;
  }

  const result: Record<string, unknown> = { ...inputs };

  for (const [key, value] of Object.entries(result)) {
    if (typeof value !== "string") {
      continue;
    }

    const propSchema = properties[key] as JsonSchemaProperty | undefined;
    if (!propSchema?.type) {
      continue;
    }

    switch (propSchema.type) {
      case "number":
      case "integer": {
        const num = Number(value);
        if (!Number.isNaN(num)) {
          result[key] = propSchema.type === "integer" ? Math.trunc(num) : num;
        }
        break;
      }
      case "boolean": {
        if (value === "true") {
          result[key] = true;
        } else if (value === "false") {
          result[key] = false;
        }
        break;
      }
    }
  }

  return result;
}
