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

import { Environment } from "cel-js";
import type { PrincipalContext } from "../../domain/access/principal_context.ts";
import type { ResourceKind } from "../../domain/access/resource_selector.ts";
import { registerArithmeticOverloads } from "./cel_evaluator.ts";

export type { PrincipalContext } from "../../domain/access/principal_context.ts";

const MAX_CONDITION_LENGTH = 1024;

export interface GrantConditionValidationResult {
  valid: boolean;
  error?: string;
}

const RESOURCE_FIELDS: Record<ResourceKind, string[]> = {
  workflow: ["name", "tags", "collective"],
  model: ["modelType", "collective"],
  data: ["name", "ns", "tags", "owner"],
  access: ["name"],
};

function createGrantConditionEnvironment(kind: ResourceKind): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);

  for (const field of RESOURCE_FIELDS[kind]) {
    env.registerVariable(
      field,
      field === "tags" || field === "owner"
        ? "map"
        : field === "name" || field === "ns" || field === "modelType" ||
            field === "collective"
        ? "string"
        : "dyn",
    );
  }

  env.registerVariable("principal", "map");

  return env;
}

export function validateGrantCondition(
  condition: string,
  resourceKind: ResourceKind,
): GrantConditionValidationResult {
  if (condition.length > MAX_CONDITION_LENGTH) {
    return {
      valid: false,
      error:
        `Condition exceeds maximum length of ${MAX_CONDITION_LENGTH} bytes (got ${condition.length})`,
    };
  }

  const env = createGrantConditionEnvironment(resourceKind);

  try {
    env.parse(condition);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `CEL syntax error: ${message}` };
  }

  const checkResult = env.check(condition);
  if (!checkResult.valid) {
    const message = checkResult.error instanceof Error
      ? checkResult.error.message
      : String(checkResult.error);
    return { valid: false, error: `CEL type error: ${message}` };
  }

  return { valid: true };
}

export function evaluateGrantCondition(
  condition: string,
  resourceKind: ResourceKind,
  resourceFields: Record<string, unknown>,
  principalContext: PrincipalContext,
): boolean {
  const env = createGrantConditionEnvironment(resourceKind);

  const context: Record<string, unknown> = { ...resourceFields };
  context.principal = principalContext;

  const result = env.evaluate(condition, context);
  return result === true;
}
