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

import { markModelWording, wordedText } from "../behavior_wording.ts";
import type { DefinitionData } from "../definitions/definition.ts";
import type {
  CelExpressionEvaluator,
  CelExpressionValidator,
} from "./cel_runtime.ts";
import { extractDependencies } from "./dependency_extractor.ts";
import { MissingModelDataError } from "./errors.ts";
import type { ExpressionLocation } from "./expression.ts";
import {
  replaceExpressionsTracked,
  type SpliceOrigin,
  type SpliceSanitizer,
} from "./expression_parser.ts";
import type { ExpressionContext } from "./model_resolver.ts";
import { ProvenanceMap } from "./provenance_map.ts";
import {
  attachBindingProvenance,
  bindingProvenanceOf,
  spliceOrigin,
} from "./splice_origin.ts";
import { isSwampExpression, type SwampScope } from "./swamp_namespaces.ts";
import type { FailedExpressions } from "./unresolved_expression_guard.ts";

export interface DefinitionExpressionPassResult {
  data: DefinitionData;
  /**
   * The same splices with sensitive values replaced by sentinels, for the
   * definition that executes. Present only when a sanitizer was given.
   */
  sanitizedData?: DefinitionData;
  failedExpressions: FailedExpressions;
  provenance: ProvenanceMap;
  sanitizedProvenance?: ProvenanceMap;
}

export interface DefinitionPassProvenance {
  raw: ProvenanceMap;
  sanitized: ProvenanceMap;
}

export const AUTHORED_DEFINITION: DefinitionPassProvenance = {
  raw: ProvenanceMap.authored(),
  sanitized: ProvenanceMap.authored(),
};

function underPath(
  sanitizer: SpliceSanitizer,
  prefix: string,
): SpliceSanitizer {
  const full = (path: string) =>
    path === ""
      ? prefix
      : path.startsWith("[")
      ? `${prefix}${path}`
      : `${prefix}.${path}`;
  return {
    whole: (value, path) => sanitizer.whole(value, full(path)),
    embedded: (text, path, value) =>
      sanitizer.embedded(text, full(path), value),
  };
}

function isGlobalArgumentPath(path: string): boolean {
  return path === "globalArguments" || path.startsWith("globalArguments.") ||
    path.startsWith("globalArguments[");
}

/**
 * evaluation is lenient: a failing expression is left in place and recorded in
 * failedExpressions, so it cannot break a method that never uses it; globals
 * are evaluated first and bound as self.globalArguments
 */
export async function evaluateDefinitionExpressions(
  definitionData: DefinitionData,
  expressions: readonly ExpressionLocation[],
  context: ExpressionContext,
  celEvaluator: CelExpressionEvaluator & CelExpressionValidator,
  sanitizer?: SpliceSanitizer,
  /**
   * differs from definitionData when values were sanitized upstream; it holds
   * the same unevaluated expressions, so values evaluated from definitionData
   * apply to it unchanged
   */
  sanitizedBase: DefinitionData = definitionData,
  /**
   * Where data already sits in `definitionData` and `sanitizedBase` (a
   * direct-execution step's routed arguments, say). An expression
   * occurrence overlapping data is neither evaluated nor substituted.
   */
  provenance: DefinitionPassProvenance = AUTHORED_DEFINITION,
  /** Subtrees outside this delivery are neither evaluated nor substituted. */
  skipPath?: (path: string) => boolean,
): Promise<DefinitionExpressionPassResult> {
  expressions = expressions.filter((expr) =>
    !skipPath?.(expr.path) &&
    (expr.start === undefined || expr.end === undefined
      ? !provenance.raw.hasDataAtOrBelow(expr.path)
      : !provenance.raw.overlapsData(expr.path, expr.start, expr.end))
  );
  const failedExpressions = new Map<string, Error>();
  const recordFailure = (raw: string, error: unknown) => {
    failedExpressions.set(
      raw,
      error instanceof Error ? error : new Error(String(error)),
    );
  };
  // A refusal at interpolation is the same pending failure as a refusal in
  // CEL. Check both coordinate views, keeping the raw view's values intact.
  // Handle each occurrence separately: the same container may be allowed as
  // a whole field and refused inside text in another method.
  const rawSanitizer: SpliceSanitizer | undefined = sanitizer && {
    whole: (value, path) => {
      sanitizer.whole(value, path);
      return value;
    },
    embedded: (text, path, value) => {
      sanitizer.embedded(text, path, value);
      return text;
    },
  };
  const declaredInputs = new Set(
    Object.keys(definitionData.inputs?.properties ?? {}),
  );

  const evaluateAll = async (
    batch: readonly ExpressionLocation[],
    ctx: ExpressionContext,
    origins: Map<string, SpliceOrigin>,
  ): Promise<Map<string, unknown>> => {
    const scope: SwampScope = {
      isBound: (root) => (ctx as Record<string, unknown>)[root] !== undefined,
      declaredInputs,
    };
    const values = new Map<string, unknown>();
    for (const expr of batch) {
      const missingModel = findMissingModelDependency(expr.celExpression, ctx);
      if (missingModel) {
        const worded = wordedText((w) =>
          `${w.Noun} ${missingModel.modelRef} has no ${missingModel.type} data`
        );
        failedExpressions.set(
          expr.raw,
          markModelWording(
            new MissingModelDataError(
              worded.text,
              expr.celExpression,
              expr.path,
            ),
            worded.modelText,
          ),
        );
        continue;
      }
      try {
        const value = await celEvaluator.evaluateAsync(expr.celExpression, ctx);
        values.set(expr.raw, value);
        origins.set(expr.raw, spliceOrigin(expr.celExpression, ctx, value));
      } catch (error) {
        // only now is the text classified, so a classification mistake never
        // stops an expression that evaluates from resolving; non-CEL text or
        // CEL for another templating system stays unrecorded
        if (
          !celEvaluator.validate(expr.celExpression).valid ||
          !isSwampExpression(expr.celExpression, scope)
        ) continue;
        // most often an input referenced directly (not inside a conditional
        // branch) that only another method supplies
        recordFailure(expr.raw, error);
      }
    }
    return values;
  };

  const globalOrigins = new Map<string, SpliceOrigin>();
  const globalValues = await evaluateAll(
    expressions.filter((expr) => isGlobalArgumentPath(expr.path)),
    context,
    globalOrigins,
  );
  const globalOriginOf = originLookup(globalOrigins);
  const globals = replaceExpressionsTracked(
    definitionData.globalArguments ?? {},
    globalValues,
    provenance.raw.subtree("globalArguments"),
    globalOriginOf,
    undefined,
    rawSanitizer && underPath(rawSanitizer, "globalArguments"),
    recordFailure,
  );
  const globalArguments = globals.data as Record<string, unknown>;

  const rest = expressions.filter((expr) => !isGlobalArgumentPath(expr.path));
  const restOrigins = new Map<string, SpliceOrigin>();
  const restValues = rest.length === 0
    ? new Map<string, unknown>()
    : await evaluateAll(
      rest,
      context.self ? withEvaluatedGlobals(context, globals) : context,
      restOrigins,
    );
  const restOriginOf = originLookup(restOrigins);
  const skipRest = (path: string) =>
    isGlobalArgumentPath(path) || (skipPath?.(path) ?? false);

  // The same raw text can resolve differently in the two phases
  // (`self.globalArguments.*` does), so each section takes its own values.
  const restSplice = replaceExpressionsTracked(
    definitionData,
    restValues,
    provenance.raw,
    restOriginOf,
    skipRest,
    rawSanitizer,
    recordFailure,
  );
  const data = restSplice.data as DefinitionData;
  const dataProvenance = restSplice.provenance.graft(
    "globalArguments",
    globals.provenance,
  );
  if (!sanitizer) {
    return {
      data: { ...data, globalArguments },
      failedExpressions,
      provenance: dataProvenance,
    };
  }
  const sanitizedGlobals = replaceExpressionsTracked(
    sanitizedBase.globalArguments ?? {},
    globalValues,
    provenance.sanitized.subtree("globalArguments"),
    globalOriginOf,
    undefined,
    underPath(sanitizer, "globalArguments"),
    recordFailure,
  );
  const sanitizedRest = replaceExpressionsTracked(
    sanitizedBase,
    restValues,
    provenance.sanitized,
    restOriginOf,
    skipRest,
    sanitizer,
    recordFailure,
  );
  return {
    data: { ...data, globalArguments },
    sanitizedData: {
      ...(sanitizedRest.data as DefinitionData),
      globalArguments: sanitizedGlobals.data as Record<string, unknown>,
    },
    failedExpressions,
    provenance: dataProvenance,
    sanitizedProvenance: sanitizedRest.provenance.graft(
      "globalArguments",
      sanitizedGlobals.provenance,
    ),
  };
}

function originLookup(
  origins: Map<string, SpliceOrigin>,
): (raw: string) => SpliceOrigin {
  return (raw) => origins.get(raw) ?? { map: ProvenanceMap.data() };
}

/**
 * binds self.globalArguments with their provenance, so an argument that copies
 * a global inherits where its data sits
 */
function withEvaluatedGlobals(
  context: ExpressionContext,
  globals: { data: unknown; provenance: ProvenanceMap },
): ExpressionContext {
  const next: ExpressionContext = {
    ...context,
    self: {
      ...context.self!,
      globalArguments: globals.data as Record<string, unknown>,
    },
  };
  const self = bindingProvenanceOf(context).self ?? ProvenanceMap.authored();
  return attachBindingProvenance(next, {
    self: self.graft("globalArguments", globals.provenance),
  });
}

/**
 * Model data is never conditionally accessed in CEL — member access on a
 * missing model ref is always an error — so skip evaluation and say why.
 */
function findMissingModelDependency(
  celExpression: string,
  ctx: ExpressionContext,
): { modelRef: string; type: "resource" | "file" } | undefined {
  for (const dep of extractDependencies(celExpression)) {
    if (dep.type !== "resource" && dep.type !== "file") continue;
    const modelData = ctx.model[dep.modelRef];
    if (
      !modelData ||
      (dep.type === "resource" && !modelData.resource) ||
      (dep.type === "file" && !modelData.file)
    ) {
      return { modelRef: dep.modelRef, type: dep.type };
    }
  }
  return undefined;
}
