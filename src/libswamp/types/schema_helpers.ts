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

import { z } from "zod";
import type {
  FileOutputSpec,
  MethodDefinition,
  ResourceOutputSpec,
} from "../../domain/models/model.ts";

/**
 * Data structure for a data output spec in the describe output.
 */
export interface DataOutputSpecDescribeData {
  specName: string;
  kind: "resource" | "file";
  description?: string;
  schema?: object;
  contentType?: string;
  lifetime?: string;
  garbageCollection?: number | string;
  streaming?: boolean;
  tags?: Record<string, string>;
}

/**
 * Data structure for a method's description.
 */
export interface MethodDescribeData {
  name: string;
  description: string;
  arguments: object;
  dataOutputSpecs?: DataOutputSpecDescribeData[];
}

/**
 * Converts a Zod schema to JSON Schema format.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  return z.toJSONSchema(schema);
}

/**
 * Converts a MethodDefinition to MethodDescribeData for presentation.
 */
export function toMethodDescribeData(
  name: string,
  method: MethodDefinition,
  resources?: Record<string, ResourceOutputSpec>,
  files?: Record<string, FileOutputSpec>,
): MethodDescribeData {
  const resourceSpecs = resources
    ? Object.entries(resources).map(
      ([specName, spec]) => ({
        specName,
        kind: "resource" as const,
        description: spec.description,
        schema: zodToJsonSchema(spec.schema),
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        tags: spec.tags,
      }),
    )
    : [];

  const fileSpecs = files
    ? Object.entries(files).map(
      ([specName, spec]) => ({
        specName,
        kind: "file" as const,
        description: spec.description,
        contentType: spec.contentType,
        lifetime: spec.lifetime,
        garbageCollection: spec.garbageCollection,
        streaming: spec.streaming,
        tags: spec.tags,
      }),
    )
    : [];

  const dataOutputSpecs = [...resourceSpecs, ...fileSpecs];

  return {
    name,
    description: method.description,
    arguments: zodToJsonSchema(method.arguments),
    dataOutputSpecs: dataOutputSpecs.length > 0 ? dataOutputSpecs : undefined,
  };
}
