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

import {
  type ModelDefinition,
  modelRegistry,
} from "../../domain/models/model.ts";
import { ModelType } from "../../domain/models/model_type.ts";
import {
  type MethodDescribeData,
  toMethodDescribeData,
  zodToJsonSchema,
} from "../types/schema_helpers.ts";

export interface ModelTypeDetail {
  globalArgumentsSchema?: object;
  methods?: MethodDescribeData[];
}

export function modelTypeDetail(
  modelDef: ModelDefinition | undefined,
): ModelTypeDetail {
  return {
    globalArgumentsSchema: modelDef?.globalArguments
      ? zodToJsonSchema(modelDef.globalArguments)
      : undefined,
    methods: modelDef
      ? Object.entries(modelDef.methods).map(
        ([name, method]) => toMethodDescribeData(name, method),
      )
      : undefined,
  };
}

// resolves through the registry, never a definition repository or the
// auto-resolver, so a lookup neither scans models/ nor installs an extension
export async function createModelTypeDetailLookup(): Promise<
  (type: string) => Promise<ModelTypeDetail>
> {
  await modelRegistry.ensureLoaded();
  return async (type: string): Promise<ModelTypeDetail> => {
    const modelType = ModelType.create(type);
    await modelRegistry.ensureTypeLoaded(modelType);
    return modelTypeDetail(modelRegistry.get(modelType));
  };
}
