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
 * Model type spellings in grants that differ from the spelling types are
 * stored in (swamp-club#3130). A deny matches its type in any spelling; an
 * allow and a condition literal match only as written, so a non-canonical
 * spelling there matches no type. Each finding names the canonical spelling.
 */

import {
  CONTROL_PLANE_MODEL_TYPES,
  normalizeModelTypeName,
} from "../models/control_plane_types.ts";
import { ModelType } from "../models/model_type.ts";
import type { Effect } from "./effect.ts";
import {
  canonicalTypePattern,
  type ResourceKind,
  type ResourceSelector,
  resourceSelectorToString,
} from "./resource_selector.ts";

/**
 * A string literal a grant condition compares with the resource's type:
 * `modelType` on a model, `name` on an access resource. `exact` for `==`,
 * `!=` and `in`, `prefix` for `startsWith`, `fragment` for `endsWith` and
 * `contains`.
 */
export interface ConditionTypeLiteral {
  readonly literal: string;
  readonly match: "exact" | "prefix" | "fragment";
}

/** Reads the type literals of a condition; [] when it cannot be parsed. */
export type ConditionTypeLiteralReader = (
  condition: string,
  kind: ResourceKind,
) => ConditionTypeLiteral[];

export interface GrantSpellingFinding {
  /** Which part of the grant is spelled non-canonically. */
  readonly part: "selector" | "condition";
  /** The spelling as written. */
  readonly written: string;
  /** The spelling types are stored in. */
  readonly canonical: string;
  readonly message: string;
}

export interface SpelledGrant {
  readonly effect: Effect;
  readonly resource: ResourceSelector;
  readonly condition?: string;
}

/** Lowercase, with `::`, `.` and whitespace folded to `/`, nothing trimmed. */
function foldTypeFragment(fragment: string): string {
  return fragment.toLowerCase().replace(/::/g, "/").replace(/\s+/g, "/")
    .replace(/\./g, "/").replace(/\/+/g, "/");
}

function stripAt(value: string): string {
  return value.replace(/^[@/]+/, "");
}

/** Whether a bare prefix (or exact name) names a control-plane type. */
function namesControlPlaneType(bare: string, prefix: boolean): boolean {
  return CONTROL_PLANE_MODEL_TYPES.some((type) =>
    prefix ? type.startsWith(bare) : type === bare
  );
}

/**
 * The canonical form of an access selector pattern that names a
 * control-plane type, or null when it names none. Control-plane records are
 * authorized under the bare type (`swamp/grant`), never with an `@`.
 */
function canonicalAccessPattern(pattern: string): string | null {
  if (pattern === "*") return null;
  const canonical = canonicalTypePattern(pattern);
  if (canonical === null) return null;
  const wildcard = canonical.endsWith("*");
  const bare = stripAt(wildcard ? canonical.slice(0, -1) : canonical);
  if (bare.length === 0 || !namesControlPlaneType(bare, wildcard)) return null;
  return wildcard ? `${bare}*` : bare;
}

function selectorFinding(grant: SpelledGrant): GrantSpellingFinding | null {
  const { kind, pattern } = grant.resource;
  let canonical: string | null = null;
  if (kind === "model") canonical = canonicalTypePattern(pattern);
  if (kind === "access") canonical = canonicalAccessPattern(pattern);
  if (canonical === null || canonical === pattern) return null;
  const written = resourceSelectorToString(grant.resource);
  const canonicalSelector = `${kind}:${canonical}`;
  const message = grant.effect === "deny"
    ? `${written} names types spelled ${canonicalSelector}; the deny matches them in any spelling — write ${canonicalSelector} so the grant reads as it is enforced`
    : kind === "model"
    ? `${written} matches no model type: types are spelled ${canonicalSelector}, so write that to grant on them (as written it matches only model names spelled exactly ${pattern})`
    : `${written} matches no control-plane record: records are spelled ${canonicalSelector}, so write that to grant on them`;
  return { part: "selector", written, canonical: canonicalSelector, message };
}

function canonicalModelTypeLiteral(
  { literal, match }: ConditionTypeLiteral,
): string | null {
  if (match === "fragment") return foldTypeFragment(literal);
  if (match === "prefix") {
    const canonical = canonicalTypePattern(`${literal}*`);
    return canonical === null ? null : canonical.slice(0, -1);
  }
  try {
    return ModelType.create(literal).normalized;
  } catch {
    return null;
  }
}

function canonicalAccessNameLiteral(
  { literal, match }: ConditionTypeLiteral,
): string | null {
  if (match === "fragment") return null;
  if (match === "prefix") {
    const canonical = canonicalAccessPattern(`${literal}*`);
    return canonical === null ? null : canonical.slice(0, -1);
  }
  const bare = normalizeModelTypeName(literal);
  return bare !== null && namesControlPlaneType(bare, false) ? bare : null;
}

function conditionFindings(
  grant: SpelledGrant,
  readTypeLiterals: ConditionTypeLiteralReader,
): GrantSpellingFinding[] {
  const { kind } = grant.resource;
  if (!grant.condition || (kind !== "model" && kind !== "access")) return [];
  const field = kind === "model" ? "modelType" : "name";
  const findings: GrantSpellingFinding[] = [];
  for (const typeLiteral of readTypeLiterals(grant.condition, kind)) {
    const canonical = kind === "model"
      ? canonicalModelTypeLiteral(typeLiteral)
      : canonicalAccessNameLiteral(typeLiteral);
    if (canonical === null || canonical === typeLiteral.literal) continue;
    findings.push({
      part: "condition",
      written: typeLiteral.literal,
      canonical,
      message:
        `condition compares ${field} with ${typeLiteral.literal}, which no type is spelled as; types are spelled ${canonical}`,
    });
  }
  return findings;
}

/**
 * Every non-canonical type spelling in a grant's selector and condition.
 * Without a literal reader only the selector is checked.
 */
export function findGrantSpellingIssues(
  grant: SpelledGrant,
  readTypeLiterals?: ConditionTypeLiteralReader,
): GrantSpellingFinding[] {
  const selector = selectorFinding(grant);
  return [
    ...(selector ? [selector] : []),
    ...(readTypeLiterals ? conditionFindings(grant, readTypeLiterals) : []),
  ];
}
