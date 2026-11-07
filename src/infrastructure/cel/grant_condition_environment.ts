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
import type { ResourceKind } from "../../domain/access/resource_selector.ts";
import type { Action } from "../../domain/access/action.ts";
import {
  type ClientLiteralFinding,
  clientLiteralFinding,
  clientPrefixFinding,
} from "../../domain/access/client.ts";
import {
  BINDING_MACROS,
  CONDITION_FIELDS,
  conditionFieldsUnavailableForActions,
  type ConditionFindingsReader,
  PRINCIPAL_CHECKED_AS,
  referencedConditionFields,
  unguardedTagMessage,
  unknownRunPaths,
} from "../../domain/access/condition_fields.ts";
import type { Effect } from "../../domain/access/effect.ts";
import type {
  ConditionTypeLiteral,
  ConditionTypeLiteralReader,
} from "../../domain/access/grant_spelling.ts";
import { registerArithmeticOverloads } from "./cel_evaluator.ts";

export type { PrincipalContext } from "../../domain/access/principal_context.ts";

export { MAX_AGGREGATE_CONDITIONS } from "../../domain/access/grant_based_access_decision_service.ts";

export const MAX_CONDITION_LENGTH = 1024;
export const MAX_AST_DEPTH = 24;
export const MAX_COMPREHENSION_NESTING = 2;
export const MAX_CONDITION_COST = 500;

export interface GrantConditionValidationResult {
  valid: boolean;
  error?: string;
  warnings?: readonly string[];
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

function createGrantConditionEnvironment(kind: ResourceKind): Environment {
  const env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);

  for (const field of CONDITION_FIELDS[kind]) {
    env.registerVariable(field.name, field.type);
  }

  env.registerVariable("principal", "map");

  return env;
}

const checkEnvironments = new Map<ResourceKind, Environment>();

/** used only to check a condition; decisions evaluate in the untyped environment */
function checkEnvironment(kind: ResourceKind): Environment {
  let env = checkEnvironments.get(kind);
  if (env) return env;
  env = new Environment({ unlistedVariablesAreDyn: false });
  registerArithmeticOverloads(env);
  for (const field of CONDITION_FIELDS[kind]) {
    const checkedAs = field.checkedAs ?? field.type;
    if (typeof checkedAs === "string") {
      env.registerVariable(field.name, checkedAs);
    } else {
      env.registerVariable({ name: field.name, schema: { ...checkedAs } });
    }
  }
  env.registerVariable({
    name: "principal",
    schema: { ...PRINCIPAL_CHECKED_AS },
  });
  checkEnvironments.set(kind, env);
  return env;
}

const FIELD_TYPES_HINT =
  "run.initiator.kind, .id and .sub, principal.sub, client and tag values are strings, run.serveDriven is a bool, and principal.groups and principal.collectives are lists of strings; for example principal.sub == run.initiator.sub";

// each fails at decision time for most strings, whatever the types say
const VALUE_DEPENDENT_CONVERSIONS: ReadonlySet<string> = new Set([
  "bool",
  "double",
  "duration",
  "int",
  "timestamp",
  "uint",
]);

const FIELDS_REFUSED_WHEN_WRITTEN = ["run", "client"];

function namesFieldRefusedWhenWritten(
  node: unknown,
  kind: ResourceKind,
): boolean {
  return referencedConditionFields(node, kind).some((name) =>
    FIELDS_REFUSED_WHEN_WRITTEN.includes(name)
  );
}

/** a dyn() hides from the type check whatever it wraps */
function typeCheckEvasion(
  node: ASTNode,
  kind: ResourceKind,
): string | undefined {
  let found: string | undefined;
  const walk = (current: ASTNode): void => {
    if (found) return;
    if (current.op === "call" && Array.isArray(current.args)) {
      const [name, callArgs] = current.args as [string, unknown];
      if (name === "dyn") {
        found =
          `Condition uses dyn(), which hides the types it needs checked: remove it. ${FIELD_TYPES_HINT}`;
        return;
      }
      if (
        VALUE_DEPENDENT_CONVERSIONS.has(name) &&
        namesFieldRefusedWhenWritten(callArgs, kind)
      ) {
        found =
          `Condition converts a run or client value with ${name}(), which fails at decision time: compare the value as it is. ${FIELD_TYPES_HINT}`;
        return;
      }
    }
    visitChildren(current.args, walk);
  };
  walk(node);
  return found;
}

function conditionTypeIssue(
  condition: string,
  ast: ASTNode,
  kind: ResourceKind,
): string | undefined {
  const checked = checkEnvironment(kind).check(condition);
  if (!checked.valid) {
    const [reason] = String(checked.error?.message ?? checked.error).split(
      "\n",
    );
    return `Condition's types cannot evaluate (${reason}): as a deny it refuses whatever it errors on and never fires where it reads false, and as an allow it does not match. ${FIELD_TYPES_HINT}`;
  }
  if (namesFieldRefusedWhenWritten(ast, kind)) {
    const evasion = typeCheckEvasion(ast, kind);
    if (evasion) return evasion;
  }
  if (checked.type !== "bool" && checked.type !== "dyn") {
    return `Condition gives a ${checked.type}, not true or false, so it never matches: as a deny it never fires, and as an allow it does not match. Write a comparison. ${FIELD_TYPES_HINT}`;
  }
  return undefined;
}

function unguardedTagsOf(ast: ASTNode, kind: ResourceKind): string[] {
  if (!referencedConditionFields(ast, kind).includes("tags")) return [];
  const read = new Set<string>();
  const guarded = new Set<string>();
  const isTags = (node: unknown): boolean => isTypeVariable(node, "tags");
  const walk = (node: ASTNode): void => {
    const { op, args } = node;
    if (op === "in" && Array.isArray(args) && isTags(args[1])) {
      const literal = stringValue(args[0]);
      if (literal !== null) guarded.add(literal);
    }
    if (op === "call" && Array.isArray(args) && args[0] === "has") {
      const [target] = args[1] as unknown[];
      if (
        isASTNode(target) && target.op === "." && Array.isArray(target.args) &&
        isTags(target.args[0]) && typeof target.args[1] === "string"
      ) {
        guarded.add(target.args[1]);
      }
      return;
    }
    if (op === "." && Array.isArray(args) && isTags(args[0])) {
      if (typeof args[1] === "string") read.add(args[1]);
      return;
    }
    if (op === "[]" && Array.isArray(args) && isTags(args[0])) {
      const literal = stringValue(args[1]);
      if (literal !== null) read.add(literal);
    }
    visitChildren(args, walk);
  };
  walk(ast);
  return [...read].filter((tag) => !guarded.has(tag));
}

/**
 * reports, never decides, so it reads as nothing for a condition it cannot
 * parse and never throws: a policy load must survive any stored condition
 */
export const readConditionFindings: ConditionFindingsReader = (
  condition,
  kind,
) => {
  if (condition.length > MAX_CONDITION_LENGTH) return { unguardedTags: [] };
  try {
    const parsed = checkEnvironment(kind).parse(condition) as unknown as {
      ast: ASTNode;
    };
    const typeIssue = conditionTypeIssue(condition, parsed.ast, kind);
    return {
      ...(typeIssue ? { typeIssue } : {}),
      unguardedTags: unguardedTagsOf(parsed.ast, kind),
    };
  } catch {
    return { unguardedTags: [] };
  }
};

export function validateGrantCondition(
  condition: string,
  resourceKind: ResourceKind,
  grant?: { readonly actions: readonly Action[]; readonly effect: Effect },
): GrantConditionValidationResult {
  if (condition.length > MAX_CONDITION_LENGTH) {
    return {
      valid: false,
      error:
        `Condition exceeds maximum length of ${MAX_CONDITION_LENGTH} bytes (got ${condition.length})`,
    };
  }

  const env = createGrantConditionEnvironment(resourceKind);

  let parsed: { ast: ASTNode };
  try {
    parsed = env.parse(condition) as unknown as { ast: ASTNode };
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

  const metrics = collectASTMetrics(parsed.ast);

  if (metrics.maxDepth > MAX_AST_DEPTH) {
    return {
      valid: false,
      error:
        `Condition exceeds maximum AST depth of ${MAX_AST_DEPTH} (got ${metrics.maxDepth})`,
    };
  }

  if (metrics.maxComprehensionNesting > MAX_COMPREHENSION_NESTING) {
    return {
      valid: false,
      error:
        `Condition exceeds maximum comprehension nesting of ${MAX_COMPREHENSION_NESTING} (got ${metrics.maxComprehensionNesting})`,
    };
  }

  if (metrics.weightedCost > MAX_CONDITION_COST) {
    return {
      valid: false,
      error:
        `Condition exceeds maximum cost budget of ${MAX_CONDITION_COST} (estimated ${metrics.weightedCost})`,
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

  if (CONDITION_FIELDS[resourceKind].some((f) => f.name === "run")) {
    const [unknownPath] = unknownRunPaths(parsed.ast);
    if (unknownPath) {
      return {
        valid: false,
        error:
          `Condition names ${unknownPath}, which a run does not have: use run.initiator.kind, run.initiator.id, run.initiator.sub or run.serveDriven`,
      };
    }
  }

  const clientFindings: ClientLiteralFinding[] = [];
  const clientLiterals: ConditionTypeLiteral[] = [];
  collectTypeLiterals(parsed.ast, "client", clientLiterals);
  for (const { literal, match } of clientLiterals) {
    const finding = match === "exact"
      ? clientLiteralFinding(literal)
      : match === "prefix"
      ? clientPrefixFinding(literal)
      : undefined;
    if (finding) clientFindings.push(finding);
  }
  const neverMatches = clientFindings.find((f) => f.kind === "never-matches");
  if (neverMatches) return { valid: false, error: neverMatches.message };

  if (grant) {
    const [unavailable] = conditionFieldsUnavailableForActions(
      parsed.ast,
      resourceKind,
      grant.actions,
    );
    if (unavailable) {
      return {
        valid: false,
        error:
          `Condition names ${unavailable.field}, which a '${unavailable.action}' decision cannot supply: it is available only for ${
            unavailable.allowed.join(", ")
          }`,
      };
    }
  }

  const typeIssue = conditionTypeIssue(condition, parsed.ast, resourceKind);
  if (typeIssue && namesFieldRefusedWhenWritten(parsed.ast, resourceKind)) {
    return { valid: false, error: typeIssue };
  }

  const warnings = clientFindings.map((f) => f.message);
  if (typeIssue) warnings.push(typeIssue);
  if (grant?.effect === "deny") {
    const unguarded = unguardedTagsOf(parsed.ast, resourceKind);
    if (unguarded.length > 0) warnings.push(unguardedTagMessage(unguarded));
  }
  if (
    grant?.effect === "allow" && resourceKind === "vault" &&
    referencedConditionFields(parsed.ast, resourceKind).includes("client")
  ) {
    warnings.push(
      "A vault allow limits this subject's runs to the vaults it is allowed, whatever its condition, and inside a run client reads as direct, so a condition requiring an integration never matches there",
    );
  }
  return warnings.length > 0 ? { valid: true, warnings } : { valid: true };
}

function typeVariable(kind: ResourceKind): string | null {
  if (kind === "model") return "modelType";
  if (kind === "access") return "name";
  return null;
}

function isTypeVariable(node: unknown, variable: string): boolean {
  return isASTNode(node) && node.op === "id" && node.args === variable;
}

function stringValue(node: unknown): string | null {
  return isASTNode(node) && node.op === "value" && typeof node.args === "string"
    ? node.args
    : null;
}

function isASTNode(value: unknown): value is ASTNode {
  return typeof value === "object" && value !== null && "op" in value;
}

const TYPE_LITERAL_METHODS: Record<string, ConditionTypeLiteral["match"]> = {
  startsWith: "prefix",
  endsWith: "fragment",
  contains: "fragment",
};

function collectTypeLiterals(
  node: unknown,
  variable: string,
  out: ConditionTypeLiteral[],
): void {
  if (!isASTNode(node)) return;
  const { op, args } = node;
  if ((op === "==" || op === "!=") && Array.isArray(args)) {
    const [left, right] = args;
    const literal = isTypeVariable(left, variable)
      ? stringValue(right)
      : isTypeVariable(right, variable)
      ? stringValue(left)
      : null;
    if (literal !== null) out.push({ literal, match: "exact" });
  }
  if (op === "in" && Array.isArray(args)) {
    const [left, right] = args;
    if (
      isTypeVariable(left, variable) && isASTNode(right) &&
      right.op === "list" && Array.isArray(right.args)
    ) {
      for (const element of right.args) {
        const literal = stringValue(element);
        if (literal !== null) out.push({ literal, match: "exact" });
      }
    }
  }
  if (op === "rcall" && Array.isArray(args)) {
    const [method, receiver, callArgs] = args as [string, unknown, unknown[]];
    // a comprehension binding this name means its own variable in the body
    const binder = callArgs?.[0];
    if (
      BINDING_MACROS.has(method) && isTypeVariable(binder, variable)
    ) {
      collectTypeLiterals(receiver, variable, out);
      return;
    }
    const match = TYPE_LITERAL_METHODS[method];
    if (match && isTypeVariable(receiver, variable)) {
      const literal = stringValue(callArgs?.[0]);
      if (literal !== null) out.push({ literal, match });
    }
  }
  visitChildren(args, (child) => collectTypeLiterals(child, variable, out));
}

function visitChildren(value: unknown, visit: (node: ASTNode) => void): void {
  if (isASTNode(value)) {
    visit(value);
  } else if (Array.isArray(value)) {
    for (const item of value) visitChildren(item, visit);
  }
}

/**
 * literals are reported, never rewritten; returns [] for a condition that does
 * not parse, which validation reports
 */
export const readConditionTypeLiterals: ConditionTypeLiteralReader = (
  condition,
  kind,
) => {
  const variable = typeVariable(kind);
  if (variable === null || condition.length > MAX_CONDITION_LENGTH) return [];
  let parsed: { ast: ASTNode };
  try {
    parsed = createGrantConditionEnvironment(kind).parse(
      condition,
    ) as unknown as {
      ast: ASTNode;
    };
  } catch {
    return [];
  }
  const out: ConditionTypeLiteral[] = [];
  collectTypeLiterals(parsed.ast, variable, out);
  return out;
};
