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

/**
 * only an expression with a direct vault.get call is examined, since only there
 * is a Secret statically known; a type error unrelated to the secret is never
 * reported with a secret code
 */

import type { Environment } from "cel-js";
import { minOf } from "../../domain/array_extrema.ts";
import {
  SECRET_OPERATION_UNSUPPORTED,
  type SecretRefusalCode,
} from "../../domain/expressions/errors.ts";
import {
  analyzeVaultCalls,
  indirectVaultUse,
  type VaultCallAnalysis,
} from "../../domain/expressions/vault_call_syntax.ts";
import { createSecretCheckEnvironment } from "./cel_evaluator.ts";
import { SECRET_TYPE_NAME } from "./cel_js_secret_refusal_inventory.ts";
import { callLocation } from "./cel_vault_namespace.ts";
import { hasContainerComparison } from "./container_comparison.ts";

export interface SecretDiagnostic {
  readonly location: string;
  readonly code: SecretRefusalCode | "invalid_expression";
  readonly reason: string;
}

export const CONTAINER_COMPARISON_REASON =
  "a container comparison (in, or == or != with no scalar literal or null " +
  "operand) in an expression that calls vault.get";

let environment: Environment | undefined;

export function checkEnvironment(): Environment {
  return environment ??= createSecretCheckEnvironment();
}

export function firstLine(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.split("\n")[0];
}

const NAMES_SECRET = new RegExp(`\\b${SECRET_TYPE_NAME}\\b`);

export function namesSecret(reason: string): boolean {
  return NAMES_SECRET.test(reason);
}

/**
 * each checked vault.get is bound as dyn at run time, so a ternary with a
 * Secret branch keeps its meaning; the check cannot type it, so what follows is
 * refused only at run time
 */
export function isTernaryUnification(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "incompatible_ternary_branches" ||
    firstLine(error).startsWith("Ternary branches must have the same type");
}

/**
 * text that does not parse, has no direct vault.get call, or uses vault through
 * an alias yields nothing: the syntax check reports the first, the second has
 * no known secret, the third is refused at run time
 */
export function diagnoseSecretMisuse(
  expression: string,
  location: string,
  embedded = false,
): SecretDiagnostic[] {
  let analysis: VaultCallAnalysis;
  try {
    analysis = analyzeVaultCalls(expression);
  } catch {
    return [];
  }
  const indirect = indirectVaultUse(analysis);
  if (indirect !== undefined) {
    const offset = analysis.calls[0]?.start ??
      analysis.source.originalOffset(analysis.invalidUses[0]?.pos ?? 0);
    return [{
      code: "invalid_expression",
      location: callLocation(expression, offset, location),
      reason: indirect,
    }];
  }
  if (analysis.calls.length === 0) return [];
  const at = callLocation(
    expression,
    minOf(analysis.calls.map((call) => call.start)) ?? 0,
    location,
  );
  const findings: SecretDiagnostic[] = [];
  const checked = checkEnvironment().check(analysis.source.text);
  if (embedded && secretResultKind(analysis.ast) === "container") {
    findings.push({
      location: at,
      code: SECRET_OPERATION_UNSUPPORTED,
      reason: "interpolating a container holding a secret into text",
    });
  }
  if (!checked.valid && !isTernaryUnification(checked.error)) {
    const reason = firstLine(checked.error);
    if (NAMES_SECRET.test(reason)) {
      findings.push({
        location: at,
        code: SECRET_OPERATION_UNSUPPORTED,
        reason,
      });
    }
  }
  if (hasContainerComparison(analysis.ast)) {
    findings.push({
      location: at,
      code: SECRET_OPERATION_UNSUPPORTED,
      reason: CONTAINER_COMPARISON_REASON,
    });
  }
  return findings;
}

/**
 * mixed element types become dyn in the type checker, so its result type alone
 * cannot find these; unknown calls and selections are left to the runtime check
 */
function secretResultKind(value: unknown): "secret" | "container" | undefined {
  if (typeof value !== "object" || value === null || !("op" in value)) {
    return undefined;
  }
  const { op, args: children } = value as { op: unknown; args: unknown };
  if (!Array.isArray(children)) return undefined;
  const args: unknown[] = children;
  if (op === "rcall" && args[0] === "get") {
    const receiver = args[1] as { op?: unknown; args?: unknown } | undefined;
    if (receiver?.op === "id" && receiver.args === "vault") return "secret";
  }
  if (op === "call" && args[0] === "dyn" && Array.isArray(args[1])) {
    return secretResultKind(args[1][0]);
  }
  if (op === "?:") {
    const condition = args[0] as { op?: unknown; args?: unknown } | undefined;
    if (condition?.op === "value" && typeof condition.args === "boolean") {
      return secretResultKind(args[condition.args ? 1 : 2]);
    }
    const branches = args.slice(1).map(secretResultKind);
    return branches.includes("container")
      ? "container"
      : branches.find(Boolean);
  }
  if (op === "list" || op === "map") {
    const items: unknown[] = op === "map" ? args.flat() : args;
    return items.some((item) => secretResultKind(item) !== undefined)
      ? "container"
      : undefined;
  }
  if (op === "+") {
    const operands = args.map(secretResultKind);
    return operands.includes("container")
      ? "container"
      : operands.find(Boolean);
  }
  return undefined;
}
