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

import type { z } from "zod";
import type { ModelDefinition } from "./model.ts";
import { extractFieldsWithMetadata } from "./zod_field_metadata.ts";

/**
 * the declaration only silences the dropped-dollar check in model validate;
 * expressions in the field are still validated and evaluated
 */
export function extractForeignTemplateFields(
  schema: z.ZodTypeAny | undefined,
): string[] {
  if (!schema) return [];
  return extractFieldsWithMetadata(
    schema,
    (meta) => meta.foreignTemplate === true,
  ).map((field) => field.path);
}

export function foreignTemplatePathPredicate(
  modelDef: Pick<ModelDefinition, "globalArguments" | "methods">,
): (path: string) => boolean {
  const declared = [
    ...extractForeignTemplateFields(modelDef.globalArguments).map((path) =>
      `globalArguments.${path}`
    ),
    ...Object.entries(modelDef.methods).flatMap(([methodName, method]) =>
      extractForeignTemplateFields(method.arguments).map((path) =>
        `methods.${methodName}.arguments.${path}`
      )
    ),
  ];
  return (path) =>
    declared.some((d) =>
      path === d || path.startsWith(`${d}.`) || path.startsWith(`${d}[`)
    );
}
