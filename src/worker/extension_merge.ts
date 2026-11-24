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

import { wordedError, wordedText } from "../domain/behavior_wording.ts";
import type {
  MethodDefinition,
  ModelDefinition,
  ResourceOutputSpec,
} from "../domain/models/model.ts";
import { ModelType } from "../domain/models/model_type.ts";
import type { DispatchExtensionBundle } from "../domain/remote/protocol.ts";
import type { LoadedExtension } from "./bundle_cache.ts";

export interface ShippedExtension {
  readonly bundle: DispatchExtensionBundle;
  readonly extension: LoadedExtension;
}

/**
 * Returns a copy of the definition with exactly the members serve listed for
 * each add-on; the base definition, which may be the worker's own registry
 * entry for a built-in, is never changed.
 */
export function mergeExtensionMembers(
  modelDef: ModelDefinition,
  modelType: string,
  shipped: readonly ShippedExtension[],
): ModelDefinition {
  if (shipped.length === 0) return modelDef;
  const expectedType = ModelType.create(modelType).normalized;
  const methods: Record<string, MethodDefinition> = { ...modelDef.methods };
  const resources: Record<string, ResourceOutputSpec> = {
    ...(modelDef.resources ?? {}),
  };
  for (const { bundle, extension } of shipped) {
    if (ModelType.create(extension.type).normalized !== expectedType) {
      throw wordedError(
        wordedText((w) =>
          `Add-on bundle '${bundle.fingerprint}' extends ${w.noun} ` +
          `'${extension.type}', not '${modelType}'`
        ),
      );
    }
    const offered: Record<string, unknown> = {};
    for (const record of extension.methods) Object.assign(offered, record);
    for (const name of bundle.methods) {
      if (!Object.hasOwn(offered, name)) {
        throw missingMember("method", name, bundle.fingerprint);
      }
      methods[name] = offered[name] as MethodDefinition;
    }
    for (const name of bundle.resources) {
      if (!extension.resources || !Object.hasOwn(extension.resources, name)) {
        throw missingMember("resource spec", name, bundle.fingerprint);
      }
      resources[name] = extension.resources[name] as ResourceOutputSpec;
    }
  }
  return { ...modelDef, methods, resources };
}

function missingMember(
  label: string,
  name: string,
  fingerprint: string,
): Error {
  return new Error(
    `Add-on bundle '${fingerprint}' has no ${label} '${name}'; orchestrator ` +
      "and worker disagree about the add-on",
  );
}
