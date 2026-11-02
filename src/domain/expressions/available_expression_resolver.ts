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
  extractExpressions,
  replaceExpressions,
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
  type TrackedSplice,
} from "./expression_parser.ts";
import { sensitiveSpliceSanitizer, type SplicePair } from "./splice_pair.ts";
import { sensitiveValuesOf } from "./sensitive_context.ts";
import { VaultSecretBag } from "../vaults/vault_secret_bag.ts";
import {
  type AuthoredExpressions,
  containsRuntimeExpression,
  partitionAuthoredAt,
} from "./expression_evaluation_service.ts";
import { ProvenanceMap } from "./provenance_map.ts";
import { spliceOrigin } from "./splice_origin.ts";
import { hasStepOutputDependency } from "./dependency_extractor.ts";

export type SyncCelEvaluator = (
  expression: string,
  context: Record<string, unknown>,
) => unknown;

/**
 * an expression that throws is left raw and surfaces later as a clear
 * downstream error, not silent data loss; the deferred kinds must stay in sync
 * with the skip-list in WorkflowExpressionEvaluator.evaluate
 */
export function resolveAvailableExpressions(
  data: unknown,
  context: Record<string, unknown>,
  evaluate: SyncCelEvaluator,
  authored: AuthoredExpressions,
  skipPath?: (path: string) => boolean,
): unknown {
  const values = evaluateAvailable(
    data,
    context,
    evaluate,
    authored,
    ProvenanceMap.authored(),
    new Map(),
    skipPath,
  );
  if (values.size === 0) return data;
  const registry = sensitiveValuesOf(context)?.sentinels;
  return replaceExpressions(
    data,
    values,
    skipPath,
    registry
      ? sensitiveSpliceSanitizer(new VaultSecretBag(registry))
      : undefined,
  );
}

/**
 * an occurrence overlapping data is neither evaluated nor substituted; the
 * result's map records where each spliced value's data now sits
 */
export function resolveAvailableExpressionsTracked(
  data: unknown,
  provenance: ProvenanceMap,
  context: Record<string, unknown>,
  evaluate: SyncCelEvaluator,
  authored: AuthoredExpressions,
  skipPath?: (path: string) => boolean,
): TrackedSplice {
  const origins = new Map<string, SpliceOrigin>();
  const values = evaluateAvailable(
    data,
    context,
    evaluate,
    authored,
    provenance,
    origins,
    skipPath,
  );
  if (values.size === 0) return { data, provenance };
  const registry = sensitiveValuesOf(context)?.sentinels;
  return replaceExpressionsTracked(
    data,
    values,
    provenance,
    (raw) => origins.get(raw) ?? { map: ProvenanceMap.data() },
    skipPath,
    registry
      ? sensitiveSpliceSanitizer(new VaultSecretBag(registry))
      : undefined,
  );
}

export function resolveAvailableExpressionsPair<T>(
  pair: SplicePair<T>,
  context: Record<string, unknown>,
  evaluate: SyncCelEvaluator,
  authored: AuthoredExpressions,
  sanitizer: SpliceSanitizer,
): SplicePair<T> {
  const origins = new Map<string, SpliceOrigin>();
  const values = evaluateAvailable(
    pair.raw,
    context,
    evaluate,
    authored,
    pair.rawProvenance,
    origins,
  );
  if (values.size === 0) return pair;
  return pair.splice(
    values,
    sanitizer,
    undefined,
    (raw) => origins.get(raw) ?? { map: ProvenanceMap.data() },
  );
}

function evaluateAvailable(
  data: unknown,
  context: Record<string, unknown>,
  evaluate: SyncCelEvaluator,
  authored: AuthoredExpressions,
  provenance: ProvenanceMap,
  origins: Map<string, SpliceOrigin>,
  skipPath?: (path: string) => boolean,
): Map<string, unknown> {
  const values = new Map<string, unknown>();
  const locations = partitionAuthoredAt(
    extractExpressions(data, "", skipPath),
    authored,
    provenance,
  );
  if (locations.length === 0) return values;

  for (const { raw, celExpression } of locations) {
    if (values.has(raw)) continue;
    // Deferred to runtime (resolved via the secret bag).
    if (containsRuntimeExpression(celExpression)) continue;
    // Deferred to step execution (upstream step outputs / async data.* helpers).
    if (hasStepOutputDependency(celExpression)) continue;
    try {
      const value = evaluate(celExpression, context);
      values.set(raw, value);
      origins.set(raw, spliceOrigin(celExpression, context, value));
    } catch {
      // Not resolvable against this context yet (e.g. run.* during evaluation)
      // or a bad reference — leave the expression raw.
    }
  }

  return values;
}
