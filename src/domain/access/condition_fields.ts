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
 * The variables a grant condition may reference, per resource kind — the one
 * definition both the validation environment and the runtime evaluator use
 * (swamp-club#2675).
 *
 * A resource field describes the resource itself and is always part of the
 * resource a handler authorizes; a deny that needs one the resource does not
 * carry fails closed. A request field describes the request (only method
 * requests have a `methodName`); when absent it is evaluated as its zero
 * value, so a condition on it simply does not match.
 */

import type { ResourceKind } from "./resource_selector.ts";

/** The CEL type a condition variable is declared with. */
export type ConditionFieldType = "string" | "map";

/** Whether a variable describes the resource or the request. */
export type ConditionFieldRole = "resource" | "request";

export interface ConditionField {
  readonly name: string;
  readonly type: ConditionFieldType;
  readonly role: ConditionFieldRole;
  /**
   * False for a variable that is declared but that no handler supplies yet.
   * New grant conditions may not reference it.
   */
  readonly supplied: boolean;
}

function field(
  name: string,
  type: ConditionFieldType,
  role: ConditionFieldRole = "resource",
  supplied = true,
): ConditionField {
  return { name, type, role, supplied };
}

export const CONDITION_FIELDS: Readonly<
  Record<ResourceKind, readonly ConditionField[]>
> = {
  workflow: [
    field("name", "string"),
    field("tags", "map"),
    field("collective", "string", "resource", false),
  ],
  model: [
    field("name", "string"),
    field("modelType", "string"),
    field("tags", "map"),
    field("collective", "string", "resource", false),
    field("methodName", "string", "request"),
  ],
  data: [
    field("name", "string"),
    field("ns", "string"),
    field("tags", "map"),
    field("owner", "map", "resource", false),
  ],
  access: [field("name", "string")],
};

/** The zero value a request field is evaluated as when a request lacks it. */
export function conditionFieldZeroValue(type: ConditionFieldType): unknown {
  return type === "map" ? {} : "";
}

/** The resource fields of `kind` that handlers supply. */
export function suppliedResourceFields(kind: ResourceKind): string[] {
  return CONDITION_FIELDS[kind]
    .filter((f) => f.role === "resource" && f.supplied)
    .map((f) => f.name);
}

/** The comprehension macros whose first argument binds a variable. */
const BINDING_MACROS = new Set([
  "all",
  "exists",
  "exists_one",
  "map",
  "filter",
]);

interface Node {
  op: string;
  args: unknown;
}

function isNode(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "op" in value;
}

/**
 * The condition variables of `kind` that a parsed condition references
 * (the `ast` of a cel-js parse). Names bound by a comprehension macro are
 * excluded, so `tags.exists(owner, ...)` does not reference `owner`.
 */
export function referencedConditionFields(
  ast: unknown,
  kind: ResourceKind,
): string[] {
  const declared = new Set(CONDITION_FIELDS[kind].map((f) => f.name));
  const found = new Set<string>();
  const walk = (node: unknown, bound: ReadonlySet<string>): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, bound);
      return;
    }
    if (!isNode(node)) return;
    if (node.op === "id") {
      const name = node.args;
      if (typeof name === "string" && declared.has(name) && !bound.has(name)) {
        found.add(name);
      }
      return;
    }
    if (node.op === "rcall" && Array.isArray(node.args)) {
      const [method, receiver, callArgs] = node.args as [
        string,
        unknown,
        unknown[],
      ];
      walk(receiver, bound);
      const binder = callArgs?.[0];
      if (
        BINDING_MACROS.has(method) && isNode(binder) && binder.op === "id" &&
        typeof binder.args === "string"
      ) {
        const inner = new Set(bound);
        inner.add(binder.args);
        for (const arg of callArgs.slice(1)) walk(arg, inner);
        return;
      }
      walk(callArgs, bound);
      return;
    }
    if (node.op === "." || node.op === ".?") {
      // The member name is a string, not a variable reference.
      walk((node.args as unknown[])[0], bound);
      return;
    }
    walk(node.args, bound);
  };
  walk(ast, new Set());
  return [...found];
}

/**
 * Thrown by a condition evaluator when a condition references a resource
 * field the resource does not carry. A deny that cannot be evaluated for
 * that reason fails closed.
 */
export class MissingConditionFieldError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(
      `Condition references missing resource field(s): ${fields.join(", ")}`,
    );
    this.name = "MissingConditionFieldError";
  }
}
