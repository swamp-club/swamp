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

import { Definition, type DefinitionData } from "../definitions/definition.ts";
import {
  type DataPath,
  rehydratePersistedForm,
  type RunSensitiveValues,
  toPersistedForm,
  type VaultReader,
  type WrittenReference,
} from "../secrets/mod.ts";
import type { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import type { DeferredExpression } from "./deferred_expression.ts";
import { extractExpressions } from "./expression_parser.ts";

/** An evaluated definition as it is written to the evaluated cache. */
export interface PersistedEvaluatedDefinition {
  definition: Definition;
  deferredExpressions: DeferredExpression[];
  writtenReferences: WrittenReference[];
}

/**
 * Whether a path in a cached definition file carries a value rather than
 * structure: an argument, a deferred expression's binding values, or a
 * place the source definition held an expression.
 */
function cachedValuePath(sourcePaths: readonly string[]) {
  return (path: DataPath): boolean => {
    if (path[0] === "globalArguments") return true;
    if (path[0] === "methods" && path[2] === "arguments") return true;
    if (path[0] === "deferredExpressions" && path[2] === "bindings") {
      return true;
    }
    const dotted = path.map((p) => typeof p === "number" ? `[${p}]` : `.${p}`)
      .join("").replace(/^\./, "");
    return sourcePaths.some((source) =>
      dotted === source || dotted.startsWith(`${source}.`) ||
      dotted.startsWith(`${source}[`)
    );
  };
}

/**
 * Builds what to write to the evaluated cache from the copy that executes:
 * sentinels become the vault references their values came from, recorded
 * sensitive values at value positions do too, and tag values carry
 * placeholders. Nothing sensitive is written in plaintext.
 */
export function persistEvaluatedDefinition(
  executed: Definition,
  deferredExpressions: readonly DeferredExpression[],
  source: Definition,
  values: RunSensitiveValues,
  bag: VaultSecretBag,
): PersistedEvaluatedDefinition {
  const data = executed.toData();
  const file = {
    ...data,
    tags: values.tagsWithPlaceholders(data.tags ?? {}),
    deferredExpressions: [...deferredExpressions],
  };
  const sourcePaths = extractExpressions(source.toData()).map((e) => e.path);
  const form = toPersistedForm(file, values, {
    bag,
    applies: cachedValuePath(sourcePaths),
  });
  const { deferredExpressions: persistedDeferred, ...definitionData } =
    form.data;
  return {
    definition: Definition.fromData(definitionData as DefinitionData),
    deferredExpressions: persistedDeferred,
    writtenReferences: form.writtenReferences,
  };
}

/**
 * Restores a cached evaluated definition for replay: the raw copy for CEL
 * contexts and reports, and the executed copy with data-origin sentinels
 * from the step's bag, exactly as a fresh evaluation would produce.
 */
export async function rehydrateEvaluatedDefinition(
  cached: {
    definition: Definition;
    deferredExpressions: readonly DeferredExpression[];
    writtenReferences: readonly WrittenReference[];
  },
  read: VaultReader,
  values: RunSensitiveValues,
  bag: VaultSecretBag,
): Promise<{
  definition: Definition;
  executedDefinition: Definition;
  deferredExpressions: DeferredExpression[];
}> {
  const file = {
    ...cached.definition.toData(),
    deferredExpressions: [...cached.deferredExpressions],
  };
  const { raw, sanitized } = await rehydratePersistedForm(
    file,
    cached.writtenReferences,
    read,
    values,
    bag,
    // Only arguments carry sentinels in a fresh run; resolveDeep restores
    // nothing else, so every other position gets its real value back.
    (path) =>
      path[0] === "globalArguments" ||
      (path[0] === "methods" && path[2] === "arguments"),
  );
  const { deferredExpressions, ...rawDefinition } = raw;
  const { deferredExpressions: _unused, ...sanitizedDefinition } = sanitized;
  return {
    definition: Definition.fromData(rawDefinition as DefinitionData),
    executedDefinition: Definition.fromData(
      sanitizedDefinition as DefinitionData,
    ),
    deferredExpressions,
  };
}

/**
 * Whether a cache written before sensitive values were kept off disk may hold
 * one in plaintext: it predates the format marker and its source read data or
 * step outputs, where sensitive fields are resolved.
 */
export function mayHoldPlaintextSensitiveValues(cache: {
  sensitiveFormat?: number;
  authoredExpressions: ReadonlySet<string>;
}): boolean {
  if (cache.sensitiveFormat !== undefined) return false;
  return [...cache.authoredExpressions].some((expression) =>
    /\bdata\s*\.|\bsteps\s*[.[]/.test(expression)
  );
}
