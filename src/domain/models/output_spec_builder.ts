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
import type { ModelDefinition } from "./model.ts";
import type { OutputSpecInfo } from "../reports/report_context.ts";

/**
 * Converts a Zod schema to JSON Schema, with a manual fallback.
 */
function zodToJsonSchema(schema: z.ZodTypeAny): object {
  try {
    return z.toJSONSchema(schema);
  } catch {
    // Fallback: return a minimal schema object
    return { type: "object" };
  }
}

/**
 * Builds OutputSpecInfo[] from a ModelDefinition's resource and file specs.
 *
 * Used by both the CLI model method run path and the workflow step execution
 * path to populate report context with output spec metadata.
 */
export function buildOutputSpecs(modelDef: ModelDefinition): OutputSpecInfo[] {
  const specs: OutputSpecInfo[] = [];
  if (modelDef.resources) {
    for (const [specName, spec] of Object.entries(modelDef.resources)) {
      specs.push({
        specName,
        kind: "resource",
        description: spec.description,
        schema: zodToJsonSchema(spec.schema),
      });
    }
  }
  if (modelDef.files) {
    for (const [specName, spec] of Object.entries(modelDef.files)) {
      specs.push({
        specName,
        kind: "file",
        description: spec.description,
        contentType: spec.contentType,
      });
    }
  }
  return specs;
}
