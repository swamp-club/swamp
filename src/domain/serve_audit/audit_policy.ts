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

import type { AuditCategory } from "./audit_event.ts";

export type AuditLevel = "none" | "metadata" | "request" | "requestResponse";

export type AuditEventTier = "management" | "data";

export interface AuditPolicyRule {
  readonly category?: AuditCategory;
  readonly action?: string;
  readonly tier?: AuditEventTier;
  readonly level: AuditLevel;
}

const MANAGEMENT_ACTIONS = new Set([
  "audit.query",
  "audit.verify",
  "audit.subscribe",
  "serve.reload",
  "serve.health",
]);

const MANAGEMENT_CATEGORIES = new Set<string>(["system"]);

export function classifyTier(
  action: string,
  category?: string,
): AuditEventTier {
  if (MANAGEMENT_ACTIONS.has(action)) return "management";
  if (category !== undefined && MANAGEMENT_CATEGORIES.has(category)) {
    return "management";
  }
  return "data";
}

export class AuditPolicy {
  readonly #rules: readonly AuditPolicyRule[];
  readonly #defaultLevel: AuditLevel;

  constructor(
    rules: readonly AuditPolicyRule[] = [],
    defaultLevel: AuditLevel = "metadata",
  ) {
    this.#rules = rules;
    this.#defaultLevel = defaultLevel;
  }

  get rules(): readonly AuditPolicyRule[] {
    return this.#rules;
  }

  get defaultLevel(): AuditLevel {
    return this.#defaultLevel;
  }

  evaluate(category: AuditCategory, action: string): AuditLevel {
    const tier = classifyTier(action, category);
    for (const rule of this.#rules) {
      if (rule.category !== undefined && rule.category !== category) continue;
      if (rule.action !== undefined && rule.action !== action) continue;
      if (rule.tier !== undefined && rule.tier !== tier) continue;
      return rule.level;
    }
    return this.#defaultLevel;
  }
}

export const DEFAULT_AUDIT_POLICY = new AuditPolicy([
  { tier: "management", level: "metadata" },
]);
