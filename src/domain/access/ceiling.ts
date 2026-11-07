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

import { z } from "zod";
import { canonicalJson } from "../expressions/expression_references.ts";
import {
  parseResourceSelector,
  type ResourceSelector,
  resourceSelectorMatches,
} from "./resource_selector.ts";
import type { Action } from "./action.ts";

export const CEILING_FORMAT_VERSION = 1;

export const CEILING_ACTIONS = ["approve", "read", "run", "signal"] as const;

export type CeilingAction = typeof CEILING_ACTIONS[number];

export const MAX_CEILING_ENTRIES = 100;

export const MAX_CEILING_SELECTOR_LENGTH = 512;

export interface CeilingEntry {
  readonly actions: readonly CeilingAction[];
  readonly resource: string;
}

export interface CeilingDocument {
  readonly version: typeof CEILING_FORMAT_VERSION;
  readonly ceiling: readonly CeilingEntry[];
}

const CeilingInputSchema = z.object({
  version: z.number(),
  ceiling: z.array(
    z.object({
      actions: z.array(z.string()).min(1),
      resource: z.string(),
    }).strict(),
  ),
}).strict();

function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isCeilingAction(action: string): action is CeilingAction {
  return (CEILING_ACTIONS as readonly string[]).includes(action);
}

function parseSelector(resource: string): ResourceSelector {
  if (resource.length > MAX_CEILING_SELECTOR_LENGTH) {
    throw new Error(
      `Invalid ceiling: a selector is longer than ${MAX_CEILING_SELECTOR_LENGTH} characters`,
    );
  }
  // RFC 8785 has no serialization for a lone surrogate, so no digest could be
  // agreed for one
  if (!resource.isWellFormed()) {
    throw new Error("Invalid ceiling: a selector is not well-formed Unicode");
  }
  const selector = parseResourceSelector(resource);
  if (selector.kind !== "workflow") {
    throw new Error(
      `Invalid ceiling: "${resource}" names ${selector.kind} resources; a ceiling covers only workflow resources`,
    );
  }
  return selector;
}

function selectorCovers(
  outer: ResourceSelector,
  inner: ResourceSelector,
): boolean {
  if (!outer.pattern.endsWith("*")) return outer.pattern === inner.pattern;
  return inner.pattern.startsWith(outer.pattern.slice(0, -1));
}

/**
 * Allow-only and literal: an action is allowed only where an entry names it, so
 * the implications grants have (run implies approve) never apply here.
 */
export class Ceiling {
  readonly #entries: readonly CeilingEntry[];
  readonly #selectors: ReadonlyMap<string, ResourceSelector>;

  private constructor(entries: readonly CeilingEntry[]) {
    this.#entries = entries;
    this.#selectors = new Map(
      entries.map((entry) => [entry.resource, parseSelector(entry.resource)]),
    );
  }

  /** order and duplicates carry no meaning, so equal ceilings get equal bytes */
  static parse(value: unknown): Ceiling {
    const parsed = CeilingInputSchema.safeParse(value);
    if (!parsed.success) {
      throw new Error(
        "Invalid ceiling: expected { version, ceiling: [{ actions, resource }] } with no other keys",
      );
    }
    if (parsed.data.version !== CEILING_FORMAT_VERSION) {
      throw new Error(
        `Invalid ceiling: format version ${parsed.data.version} is not supported`,
      );
    }
    const merged = new Map<string, Set<CeilingAction>>();
    for (const entry of parsed.data.ceiling) {
      const { kind, pattern } = parseSelector(entry.resource);
      const resource = `${kind}:${pattern}`;
      const actions = merged.get(resource) ?? new Set<CeilingAction>();
      for (const action of entry.actions) {
        if (!isCeilingAction(action)) {
          throw new Error(
            `Invalid ceiling: action "${action}" is not allowed; a ceiling can allow only ${
              CEILING_ACTIONS.join(", ")
            }`,
          );
        }
        actions.add(action);
      }
      merged.set(resource, actions);
    }
    if (merged.size > MAX_CEILING_ENTRIES) {
      throw new Error(
        `Invalid ceiling: more than ${MAX_CEILING_ENTRIES} resources`,
      );
    }
    return new Ceiling(
      [...merged.entries()]
        .map(([resource, actions]) => ({
          actions: [...actions].sort(compareCodeUnits),
          resource,
        }))
        .sort((a, b) => compareCodeUnits(a.resource, b.resource)),
    );
  }

  static empty(): Ceiling {
    return new Ceiling([]);
  }

  toDocument(): CeilingDocument {
    return { version: CEILING_FORMAT_VERSION, ceiling: this.#entries };
  }

  canonical(): string {
    return canonicalJson(this.toDocument());
  }

  equals(other: Ceiling): boolean {
    return this.canonical() === other.canonical();
  }

  /** the workflow name is the resolved one, as every grant decision sees it */
  allows(action: Action, workflowName: string): boolean {
    return this.#entries.some((entry) =>
      entry.actions.some((allowed) => allowed === action) &&
      resourceSelectorMatches(
        this.#selectors.get(entry.resource)!,
        workflowName,
      )
    );
  }

  allowsSomewhere(action: Action): boolean {
    return this.#entries.some((entry) =>
      entry.actions.some((allowed) => allowed === action)
    );
  }

  /** whether any workflow a selector matches could be allowed this action */
  overlaps(action: Action, selector: ResourceSelector): boolean {
    return this.#entries.some((entry) => {
      if (!entry.actions.some((allowed) => allowed === action)) return false;
      const own = this.#selectors.get(entry.resource)!;
      return selectorCovers(own, selector) || selectorCovers(selector, own);
    });
  }

  /** selectors allow a wildcard only at the end, so this is exact, not a guess */
  isWithin(wider: Ceiling): boolean {
    return this.#entries.every((entry) =>
      entry.actions.every((action) =>
        wider.#entries.some((outer) =>
          outer.actions.includes(action) &&
          selectorCovers(
            wider.#selectors.get(outer.resource)!,
            this.#selectors.get(entry.resource)!,
          )
        )
      )
    );
  }

  async digest(): Promise<string> {
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(this.canonical()),
    );
    const hex = Array.from(
      new Uint8Array(bytes),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    return `sha256:${hex}`;
  }
}

/** a digest only says a ceiling changed; this says whether it got wider */
export function ceilingWithin(consented: Ceiling, current: Ceiling): boolean {
  return current.isWithin(consented);
}
