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

import { sensitiveValuesOf } from "../expressions/sensitive_context.ts";
import { forEachNameWithoutSecrets } from "./persisted_workflow.ts";
import { escapeControlCharacters } from "../control_characters.ts";
import {
  type AuthoredExpressions,
  partitionAuthoredAt,
} from "../expressions/expression_evaluation_service.ts";
import {
  containsExpression,
  extractExpressions,
} from "../expressions/expression_parser.ts";
import {
  replaceExpressionSpans,
  scanExpressions,
} from "../expressions/expression_scanner.ts";
import { getLogger } from "@logtape/logtape";
import type { Job } from "./job.ts";
import type { Step } from "./step.ts";
import type { ExpressionContext } from "../expressions/model_resolver.ts";
import type { CelExpressionEvaluator } from "../expressions/cel_runtime.ts";
import { UserError } from "../errors.ts";
import {
  InvalidExpressionError,
  SecretRefusedError,
} from "../expressions/errors.ts";
import { VaultAccessDeniedError } from "../vaults/run_vault_access.ts";
import { keySegment, ProvenanceMap } from "../expressions/provenance_map.ts";
import { spliceOrigin } from "../expressions/splice_origin.ts";

export interface ForEachBinding {
  name: string;
  value: unknown;
  provenance?: ProvenanceMap;
}

export interface ExpandedStep {
  step: Step;
  expandedName: string;
  forEachVar: ForEachBinding;
}

export interface ResolvedStepName {
  name: string;
  hadEvalFailure: boolean;
}

/**
 * when expression evaluation fails the raw expression is preserved and
 * fallbackSuffix appended so iterations stay unique
 */
export function resolveForEachStepName(
  template: string,
  hasExpression: boolean,
  stepContext: Record<string, unknown>,
  celEvaluator: CelExpressionEvaluator,
  fallbackSuffix: string,
  authored: AuthoredExpressions,
  provenance: ProvenanceMap = ProvenanceMap.authored(),
): ResolvedStepName {
  if (hasExpression) {
    let hadEvalFailure = false;
    const resolved = replaceExpressionSpans(template, (span) => {
      if (
        provenance.overlapsData("", span.start, span.end) ||
        partitionAuthoredAt(
            extractExpressions(span.raw),
            authored,
            ProvenanceMap.authored(),
          ).length !== 1
      ) {
        hadEvalFailure = true;
        return span.raw;
      }
      try {
        return String(celEvaluator.evaluate(span.inner, stepContext));
      } catch (error) {
        // a secret refusal, or a read the run's vault access denies, fails the
        // expansion loudly naming the expression instead of falling back to a
        // suffixed raw name; every other failure keeps the fallback
        if (error instanceof SecretRefusedError) throw error;
        if (
          error instanceof InvalidExpressionError &&
          error.cause instanceof VaultAccessDeniedError
        ) throw error;
        hadEvalFailure = true;
        return span.raw;
      }
    });
    return {
      name: hadEvalFailure ? `${resolved}-${fallbackSuffix}` : resolved,
      hadEvalFailure,
    };
  }
  return { name: `${template}-${fallbackSuffix}`, hadEvalFailure: false };
}

/**
 * replaces recorded sensitive values with a stable placeholder so a secret
 * never becomes a step name in memory, logs, events or the run record, and
 * visibly escapes control characters as an authored name does
 */
function nameWithoutSecrets(
  name: string,
  index: number,
  context: ExpressionContext,
): string {
  const values = sensitiveValuesOf(context);
  return escapeControlCharacters(
    values ? forEachNameWithoutSecrets(name, index, values) : name,
  );
}

/**
 * a pass evaluator in a typed run carries prepare, the authorization step
 * synchronous step-name evaluation needs; a plain evaluator has none
 */
export type ForEachEvaluator = CelExpressionEvaluator & {
  prepare?(content: unknown, context: Record<string, unknown>): Promise<void>;
};

export class ForEachExpansionService {
  constructor(private readonly celEvaluator: ForEachEvaluator) {}

  async expand(
    job: Job,
    context: ExpressionContext,
    authored: AuthoredExpressions,
    stepProvenance: (step: Step) => ProvenanceMap = () =>
      ProvenanceMap.authored(),
  ): Promise<Map<string, ExpandedStep[]>> {
    const result = new Map<string, ExpandedStep[]>();

    for (const step of job.steps) {
      if (!step.forEach) {
        result.set(step.name, [{
          step,
          expandedName: step.name,
          forEachVar: { name: "", value: undefined },
        }]);
        continue;
      }

      const inExpression = step.forEach.in;
      const itemName = step.forEach.item;

      const first = scanExpressions(inExpression)[0];
      if (!first) {
        throw new UserError(
          `Invalid forEach.in expression: ${inExpression}. Must be in $\{{ }} format.`,
        );
      }

      // Async evaluator so data.* helpers (latest, findByTag, findBySpec,
      // query) that return Promises resolve here before we iterate.
      const stepMap = stepProvenance(step);
      const allowedIn = partitionAuthoredAt(
        extractExpressions(inExpression),
        authored,
        stepMap.subtree("forEach.in"),
      );
      // The one allowed expression must be the one evaluated below.
      if (allowedIn.length !== 1 || allowedIn[0].start !== first.start) {
        throw new UserError("forEach.in must be an authored expression");
      }
      const items = await this.celEvaluator.evaluateAsync(
        first.inner,
        context,
      );
      const itemsProvenance = spliceOrigin(first.inner, context, items).map;

      const nameHasExpression = containsExpression(step.name);
      const expandedSteps: ExpandedStep[] = [];

      if (Array.isArray(items)) {
        for (let index = 0; index < items.length; index++) {
          expandedSteps.push(
            await this.expandArrayItem(
              step,
              context,
              itemName,
              items[index],
              index,
              nameHasExpression,
              authored,
              itemsProvenance.subtree(`[${index}]`),
              stepMap.subtree("name"),
            ),
          );
        }
      } else if (items && typeof items === "object") {
        for (const [index, [key, value]] of Object.entries(items).entries()) {
          expandedSteps.push(
            await this.expandObjectItem(
              step,
              context,
              itemName,
              key,
              value,
              index,
              nameHasExpression,
              authored,
              ProvenanceMap.authored()
                .graft(
                  "key",
                  itemsProvenance.isAuthored
                    ? ProvenanceMap.authored()
                    : ProvenanceMap.data(),
                )
                .graft("value", itemsProvenance.subtree(keySegment(key))),
              stepMap.subtree("name"),
            ),
          );
        }
      } else {
        throw new UserError(
          `forEach.in must evaluate to an array or object, got: ${typeof items}`,
        );
      }

      result.set(step.name, expandedSteps);
    }

    return result;
  }

  private async prepareName(
    step: Step,
    nameHasExpression: boolean,
    stepContext: Record<string, unknown>,
  ): Promise<void> {
    if (!nameHasExpression || this.celEvaluator.prepare === undefined) return;
    await this.celEvaluator.prepare(step.name, stepContext);
  }

  private async expandArrayItem(
    step: Step,
    context: ExpressionContext,
    itemName: string,
    item: unknown,
    index: number,
    nameHasExpression: boolean,
    authored: AuthoredExpressions,
    provenance: ProvenanceMap,
    nameProvenance: ProvenanceMap,
  ): Promise<ExpandedStep> {
    const stepContext = {
      ...context,
      self: { ...context.self, _index: index, [itemName]: item },
    };
    await this.prepareName(step, nameHasExpression, stepContext);

    // Fallback-suffix policy: index for objects (for uniqueness when
    // multiple objects share field values) and for the eval-failure
    // path; raw item value for primitives.
    const fallbackSuffix = nameHasExpression
      ? String(index)
      : (item !== null && typeof item === "object")
      ? String(index)
      : String(item);

    if (!nameHasExpression && item !== null && typeof item === "object") {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' uses index-based naming because item is an object. " +
          "Consider adding a ${{{{ self.{itemName}.<field> }}}} expression to the step name for better observability.",
        { stepName: step.name, itemName },
      );
    }

    const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
      step.name,
      nameHasExpression,
      stepContext,
      this.celEvaluator,
      fallbackSuffix,
      authored,
      nameProvenance,
    );
    if (hadEvalFailure) {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' has expression(s) that failed to evaluate for item at index {index}. " +
          "Appending index to prevent duplicate names. " +
          "Check that the expression references valid properties on self.{itemName}.",
        { stepName: step.name, index, itemName },
      );
    }

    return {
      step,
      expandedName: nameWithoutSecrets(expandedName, index, context),
      forEachVar: { name: itemName, value: item, provenance },
    };
  }

  private async expandObjectItem(
    step: Step,
    context: ExpressionContext,
    itemName: string,
    key: string,
    value: unknown,
    index: number,
    nameHasExpression: boolean,
    authored: AuthoredExpressions,
    provenance: ProvenanceMap,
    nameProvenance: ProvenanceMap,
  ): Promise<ExpandedStep> {
    const objItem = { key, value };
    const stepContext = {
      ...context,
      self: { ...context.self, _index: index, [itemName]: objItem },
    };
    await this.prepareName(step, nameHasExpression, stepContext);

    const { name: expandedName, hadEvalFailure } = resolveForEachStepName(
      step.name,
      nameHasExpression,
      stepContext,
      this.celEvaluator,
      key,
      authored,
      nameProvenance,
    );
    if (hadEvalFailure) {
      getLogger(["swamp", "workflows"]).warn(
        "forEach step '{stepName}' has expression(s) that failed to evaluate for key '{key}'. " +
          "Appending key to prevent duplicate names. " +
          "Check that the expression references valid properties on self.{itemName}.",
        { stepName: step.name, key, itemName },
      );
    }

    return {
      step,
      expandedName: nameWithoutSecrets(expandedName, index, context),
      forEachVar: { name: itemName, value: objItem, provenance },
    };
  }
}
