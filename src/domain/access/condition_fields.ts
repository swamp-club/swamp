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
 * a resource field describes the resource and a deny needing one it lacks fails
 * closed; a request field is evaluated as its zero value when absent, so a
 * condition on it does not match
 */

import type { Action } from "./action.ts";
import { ABSENT_CLIENT_CONDITION_VALUE } from "./client.ts";
import type { ResourceKind } from "./resource_selector.ts";

export type ConditionFieldType = "string" | "map";

export type ConditionFieldRole = "resource" | "request";

/** a CEL type name, or the members of a variable with named members */
export type ConditionCheckedType = string | Readonly<Record<string, string>>;

export interface ConditionField {
  readonly name: string;
  readonly type: ConditionFieldType;
  readonly role: ConditionFieldRole;
  /**
   * false for a variable declared but not yet supplied by any handler; new
   * grant conditions may not reference it
   */
  readonly supplied: boolean;
  /** the only actions whose decisions can supply it; unset means every action */
  readonly actions?: readonly Action[];
  /** what a request field reads as when absent, instead of its zero value */
  readonly absent?: unknown;
  /**
   * narrower than type, for checking a condition when it is written; a schema
   * wraps values at evaluation, so evaluation never uses it
   */
  readonly checkedAs?: ConditionCheckedType;
}

function field(
  name: string,
  type: ConditionFieldType,
  role: ConditionFieldRole = "resource",
  supplied = true,
): ConditionField {
  return { name, type, role, supplied };
}

const CLIENT_FIELD: ConditionField = {
  ...field("client", "string", "request"),
  absent: ABSENT_CLIENT_CONDITION_VALUE,
};

// a map rather than named members, so "sub" in run.initiator still checks
const RUN_CHECKED_AS = {
  initiator: "map<string, string>",
  serveDriven: "bool",
} as const;

// left out when the run names no usable initiator, so allow and deny fail closed
const RUN_FIELD: ConditionField = {
  ...field("run", "map"),
  actions: ["approve"],
  checkedAs: RUN_CHECKED_AS,
};

const TAGS_FIELD: ConditionField = {
  ...field("tags", "map"),
  checkedAs: "map<string, string>",
};

// email is left out: no decision supplies it, so reading it always errors
export const PRINCIPAL_CHECKED_AS = {
  sub: "string",
  groups: "list<string>",
  collectives: "list<string>",
} as const;

export const CONDITION_FIELDS: Readonly<
  Record<ResourceKind, readonly ConditionField[]>
> = {
  workflow: [
    field("name", "string"),
    TAGS_FIELD,
    field("collective", "string", "resource", false),
    CLIENT_FIELD,
    RUN_FIELD,
  ],
  model: [
    field("name", "string"),
    field("modelType", "string"),
    TAGS_FIELD,
    field("collective", "string", "resource", false),
    field("methodName", "string", "request"),
    CLIENT_FIELD,
  ],
  data: [
    field("name", "string"),
    field("ns", "string"),
    TAGS_FIELD,
    field("owner", "map", "resource", false),
    CLIENT_FIELD,
  ],
  access: [field("name", "string"), CLIENT_FIELD],
  // key is the secret a request names, evaluated as empty when none, so a key
  // condition never fails closed on a request without a key
  vault: [
    field("name", "string"),
    field("key", "string", "request"),
    CLIENT_FIELD,
  ],
};

export function conditionFieldZeroValue(type: ConditionFieldType): unknown {
  return type === "map" ? {} : "";
}

export function conditionFieldAbsentValue(field: ConditionField): unknown {
  return field.absent ?? conditionFieldZeroValue(field.type);
}

export function suppliedResourceFields(kind: ResourceKind): string[] {
  return CONDITION_FIELDS[kind]
    .filter((f) => f.role === "resource" && f.supplied && !f.actions)
    .map((f) => f.name);
}

export const BINDING_MACROS: ReadonlySet<string> = new Set([
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
 * names bound by a comprehension macro are excluded, so tags.exists(owner, ...)
 * does not reference owner
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

const RUN_PATHS = new Set([
  "initiator",
  "initiator.kind",
  "initiator.id",
  "initiator.sub",
  "serveDriven",
]);

/**
 * a typo under run would error at evaluation, and a deny that errors does not
 * fire, so a path the run lacks, or one not written as a dotted path, is named
 */
export function unknownRunPaths(ast: unknown): string[] {
  const unknown = new Set<string>();
  const pathOf = (node: unknown): string[] | null => {
    if (!isNode(node)) return null;
    if (node.op === "id") return node.args === "run" ? [] : null;
    if (node.op === "." || node.op === ".?") {
      const [target, member] = node.args as [unknown, unknown];
      const base = pathOf(target);
      return base === null ? null : [...base, String(member)];
    }
    if (node.op === "[]" || node.op === "[?]") {
      const base = pathOf((node.args as unknown[])[0]);
      return base === null ? null : [...base, "[]"];
    }
    return null;
  };
  const walk = (node: unknown, bound: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child, bound);
      return;
    }
    if (!isNode(node)) return;
    const path = bound ? null : pathOf(node);
    if (path !== null) {
      if (!RUN_PATHS.has(path.join("."))) {
        unknown.add(["run", ...path].join("."));
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
      const binds = BINDING_MACROS.has(method) && isNode(binder) &&
        binder.op === "id" && binder.args === "run";
      walk(binds ? callArgs.slice(1) : callArgs, bound || binds);
      return;
    }
    if (node.op === "." || node.op === ".?") {
      walk((node.args as unknown[])[0], bound);
      return;
    }
    walk(node.args, bound);
  };
  walk(ast, false);
  return [...unknown];
}

/**
 * typeIssue says why the condition's types cannot evaluate; unguardedTags are
 * the tags it reads without checking they exist
 */
export interface ConditionFindings {
  readonly typeIssue?: string;
  readonly unguardedTags: readonly string[];
}

export type ConditionFindingsReader = (
  condition: string,
  kind: ResourceKind,
) => ConditionFindings;

/** a deny refuses when its condition errors, as reading an absent tag does */
export function unguardedTagMessage(tags: readonly string[]): string {
  const [tag] = tags;
  return `Condition reads ${
    tags.map((t) => `tags.${t}`).join(", ")
  } without checking the tag exists, so as a deny it refuses any resource without it: to apply only to tagged resources, write "${tag}" in tags && ...`;
}

/** fields a condition names that a decision on one of these actions cannot supply */
export function conditionFieldsUnavailableForActions(
  ast: unknown,
  kind: ResourceKind,
  actions: readonly Action[],
): { field: string; allowed: readonly Action[]; action: Action }[] {
  const referenced = new Set(referencedConditionFields(ast, kind));
  const unavailable: {
    field: string;
    allowed: readonly Action[];
    action: Action;
  }[] = [];
  for (const f of CONDITION_FIELDS[kind]) {
    if (!f.actions || !referenced.has(f.name)) continue;
    const action = actions.find((a) => !f.actions!.includes(a));
    if (action) {
      unavailable.push({ field: f.name, allowed: f.actions, action });
    }
  }
  return unavailable;
}

/**
 * a deny that cannot be evaluated because the resource lacks a referenced field
 * fails closed
 */
export class MissingConditionFieldError extends Error {
  constructor(readonly fields: readonly string[]) {
    super(
      `Condition references missing resource field(s): ${fields.join(", ")}`,
    );
    this.name = "MissingConditionFieldError";
  }
}
