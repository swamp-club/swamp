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
import { registerArithmeticOverloads } from "./cel_evaluator.ts";

export const MAX_FILTER_LENGTH = 1024;
export const MAX_AST_DEPTH = 24;
export const MAX_COMPREHENSION_NESTING = 2;
export const MAX_FILTER_COST = 500;

export interface WorkflowRunFilterValidationResult {
  valid: boolean;
  error?: string;
}

interface ASTNode {
  op: string;
  args: unknown;
}

interface MatchesCallInfo {
  isLiteral: boolean;
  pattern?: string;
}

interface ASTMetrics {
  maxDepth: number;
  maxComprehensionNesting: number;
  nodeCount: number;
  weightedCost: number;
  matchesCalls: MatchesCallInfo[];
}

const COMPREHENSION_MACROS = new Set([
  "all",
  "exists",
  "exists_one",
  "map",
  "filter",
]);

const COMPREHENSION_COST_WEIGHT = 10;

function collectASTMetrics(node: ASTNode): ASTMetrics {
  const metrics: ASTMetrics = {
    maxDepth: 0,
    maxComprehensionNesting: 0,
    nodeCount: 0,
    weightedCost: 0,
    matchesCalls: [],
  };
  walkNode(node, 0, 0, metrics);
  return metrics;
}

function walkNode(
  node: ASTNode,
  depth: number,
  comprehensionNesting: number,
  metrics: ASTMetrics,
): void {
  if (!node || typeof node !== "object" || !("op" in node)) return;

  metrics.nodeCount++;
  if (depth > metrics.maxDepth) metrics.maxDepth = depth;
  if (comprehensionNesting > metrics.maxComprehensionNesting) {
    metrics.maxComprehensionNesting = comprehensionNesting;
  }

  const { op, args } = node;

  if (op === "value") {
    metrics.weightedCost++;
    return;
  }

  if (op === "id") {
    metrics.weightedCost++;
    return;
  }

  if (op === "." || op === ".?") {
    metrics.weightedCost++;
    const arr = args as [ASTNode, string];
    walkNode(arr[0], depth + 1, comprehensionNesting, metrics);
    return;
  }

  if (op === "[]" || op === "[?]") {
    metrics.weightedCost++;
    const arr = args as [ASTNode, ASTNode];
    walkNode(arr[0], depth + 1, comprehensionNesting, metrics);
    walkNode(arr[1], depth + 1, comprehensionNesting, metrics);
    return;
  }

  if (op === "call") {
    metrics.weightedCost++;
    const arr = args as [string, ASTNode[]];
    for (const arg of arr[1]) {
      walkNode(arg, depth + 1, comprehensionNesting, metrics);
    }
    return;
  }

  if (op === "rcall") {
    const arr = args as [string, ASTNode, ASTNode[]];
    const methodName = arr[0];
    const receiver = arr[1];
    const callArgs = arr[2];

    if (COMPREHENSION_MACROS.has(methodName)) {
      const newNesting = comprehensionNesting + 1;
      metrics.weightedCost += COMPREHENSION_COST_WEIGHT;
      walkNode(receiver, depth + 1, newNesting, metrics);
      for (const arg of callArgs) {
        walkNode(arg, depth + 1, newNesting, metrics);
      }
      return;
    }

    if (methodName === "matches") {
      metrics.weightedCost++;
      const patternNode = callArgs[0];
      if (
        patternNode && patternNode.op === "value" &&
        typeof patternNode.args === "string"
      ) {
        metrics.matchesCalls.push({
          isLiteral: true,
          pattern: patternNode.args,
        });
      } else {
        metrics.matchesCalls.push({ isLiteral: false });
      }
      walkNode(receiver, depth + 1, comprehensionNesting, metrics);
      for (const arg of callArgs) {
        walkNode(arg, depth + 1, comprehensionNesting, metrics);
      }
      return;
    }

    metrics.weightedCost++;
    walkNode(receiver, depth + 1, comprehensionNesting, metrics);
    for (const arg of callArgs) {
      walkNode(arg, depth + 1, comprehensionNesting, metrics);
    }
    return;
  }

  if (op === "?:") {
    metrics.weightedCost++;
    const arr = args as [ASTNode, ASTNode, ASTNode];
    for (const child of arr) {
      walkNode(child, depth + 1, comprehensionNesting, metrics);
    }
    return;
  }

  if (op === "!_" || op === "-_") {
    metrics.weightedCost++;
    walkNode(args as ASTNode, depth + 1, comprehensionNesting, metrics);
    return;
  }

  if (op === "list") {
    metrics.weightedCost++;
    for (const elem of args as ASTNode[]) {
      walkNode(elem, depth + 1, comprehensionNesting, metrics);
    }
    return;
  }

  if (op === "map") {
    metrics.weightedCost++;
    const entries = args as Array<[ASTNode, ASTNode]>;
    for (const [key, value] of entries) {
      walkNode(key, depth + 1, comprehensionNesting, metrics);
      walkNode(value, depth + 1, comprehensionNesting, metrics);
    }
    return;
  }

  if (Array.isArray(args)) {
    metrics.weightedCost++;
    for (const child of args as unknown[]) {
      if (child && typeof child === "object" && "op" in (child as ASTNode)) {
        walkNode(child as ASTNode, depth + 1, comprehensionNesting, metrics);
      }
    }
    return;
  }

  metrics.weightedCost++;
}

const CATASTROPHIC_BACKTRACKING_PATTERN =
  /\([^)]*[+*][^)]*\)[+*?]|\(\?:[^)]*[+*][^)]*\)[+*?]/;

function checkRegexComplexity(pattern: string): string | undefined {
  if (CATASTROPHIC_BACKTRACKING_PATTERN.test(pattern)) {
    return `matches() pattern "${pattern}" contains a potentially catastrophic backtracking construct`;
  }
  try {
    new RegExp(pattern);
  } catch {
    return `matches() pattern "${pattern}" is not a valid regular expression`;
  }
  return undefined;
}

const WORKFLOW_RUN_FIELDS: Record<string, string> = {
  workflowName: "string",
  status: "string",
  startedAt: "string",
  completedAt: "string",
  duration: "double",
  instanceId: "string",
  triggerSource: "string",
  failedStep: "string",
  failureReason: "string",
  inputs: "map",
  tags: "map",
};

function createWorkflowRunFilterEnvironment(): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);

  for (const [field, type] of Object.entries(WORKFLOW_RUN_FIELDS)) {
    env.registerVariable(field, type);
  }

  return env;
}

export function validateWorkflowRunFilter(
  filter: string,
): WorkflowRunFilterValidationResult {
  if (filter.length > MAX_FILTER_LENGTH) {
    return {
      valid: false,
      error:
        `Filter exceeds maximum length of ${MAX_FILTER_LENGTH} characters (got ${filter.length})`,
    };
  }

  const env = createWorkflowRunFilterEnvironment();

  let parsed: { ast: ASTNode };
  try {
    parsed = env.parse(filter) as unknown as { ast: ASTNode };
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    return { valid: false, error: `CEL syntax error: ${message}` };
  }

  const checkResult = env.check(filter);
  if (!checkResult.valid) {
    const message = checkResult.error instanceof Error
      ? checkResult.error.message
      : String(checkResult.error);
    return { valid: false, error: `CEL type error: ${message}` };
  }

  const metrics = collectASTMetrics(parsed.ast);

  if (metrics.maxDepth > MAX_AST_DEPTH) {
    return {
      valid: false,
      error:
        `Filter exceeds maximum AST depth of ${MAX_AST_DEPTH} (got ${metrics.maxDepth})`,
    };
  }

  if (metrics.maxComprehensionNesting > MAX_COMPREHENSION_NESTING) {
    return {
      valid: false,
      error:
        `Filter exceeds maximum comprehension nesting of ${MAX_COMPREHENSION_NESTING} (got ${metrics.maxComprehensionNesting})`,
    };
  }

  if (metrics.weightedCost > MAX_FILTER_COST) {
    return {
      valid: false,
      error:
        `Filter exceeds maximum cost budget of ${MAX_FILTER_COST} (estimated ${metrics.weightedCost})`,
    };
  }

  for (const matchesCall of metrics.matchesCalls) {
    if (!matchesCall.isLiteral) {
      return {
        valid: false,
        error:
          "matches() pattern must be a string literal, not a dynamic expression",
      };
    }
    const regexError = checkRegexComplexity(matchesCall.pattern!);
    if (regexError) {
      return { valid: false, error: regexError };
    }
  }

  return { valid: true };
}

export interface WorkflowRunFilterContext {
  workflowName: string;
  status: string;
  startedAt?: string;
  completedAt?: string;
  duration?: number;
  inputs?: Record<string, unknown>;
  tags?: Record<string, string>;
  instanceId?: string;
  triggerSource?: string;
  failedStep?: string;
  failureReason?: string;
}

export function evaluateWorkflowRunFilter(
  filter: string,
  run: WorkflowRunFilterContext,
): boolean {
  const env = createWorkflowRunFilterEnvironment();

  const context: Record<string, unknown> = {
    workflowName: run.workflowName,
    status: run.status,
    startedAt: run.startedAt ?? "",
    completedAt: run.completedAt ?? "",
    duration: run.duration ?? 0,
    inputs: run.inputs ?? {},
    tags: run.tags ?? {},
    instanceId: run.instanceId ?? "",
    triggerSource: run.triggerSource ?? "",
    failedStep: run.failedStep ?? "",
    failureReason: run.failureReason ?? "",
  };

  try {
    const result = env.evaluate(filter, context);
    return result === true;
  } catch {
    return false;
  }
}
